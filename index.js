const { Client, GatewayIntentBits, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ActivityType } = require('discord.js');
const mineflayer = require('mineflayer');
const express = require('express');
const axios = require('axios');

// --- RENDER.COM & WEB SERVER SETUP ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Bot is running!');
});

app.listen(PORT, () => {
    console.log(`[WEB] Server is listening on port ${PORT}`);
});

// Self-ping mechanism to keep Render instance alive
if (process.env.RENDER_EXTERNAL_URL) {
    setInterval(() => {
        axios.get(process.env.RENDER_EXTERNAL_URL)
            .then(() => console.log('[WEB] Self-ping successful'))
            .catch(err => console.error('[WEB] Self-ping failed:', err.message));
    }, 14 * 60 * 1000); // 14 minutes
}

const config = {
    ownerId: process.env.OWNER_ID || 'YOUR_DISCORD_ID', 
    mcHost: process.env.MC_HOST || 'donutsmall.net',
    mcUsername: process.env.MC_USERNAME || 'BotEmail@example.com',
    token: process.env.DISCORD_TOKEN || 'YOUR_DISCORD_TOKEN', 
    houseEdge: 0.04,
    targetServer: null,
    // --- ADVERTISING SETTINGS ---
    broadcastEnabled: true,
    broadcastInterval: 180000, // 3 minutes
    broadcastMessage: "🎰 [COINFLIP] Double your money! 50/50 odds, only 4% fee! Type !coinflip on our Discord! 🎲"
};

// --- LOG FILTERING ---
const ignorePatterns = ['Chunk size', 'partial packet', 'player_info', 'displayName', 'sound_effect'];
const originalWrite = process.stdout.write;
process.stdout.write = function (chunk, encoding, callback) {
    const str = chunk.toString();
    if (ignorePatterns.some(pattern => str.includes(pattern))) return true;
    return originalWrite.apply(process.stdout, arguments);
};

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ]
});

let bot;
let botBalance = 0;
let isBotRunning = false;
let queue = [];
let currentSession = null;
let reconnectTimeout;
let broadcastTimer;

// --- UPDATE DISCORD STATUS ---
function updateStatus() {
    if (!client.user) return;
    const queueLen = queue.length + (currentSession ? 1 : 0);
    client.user.setActivity({
        name: `${queueLen} players in queue | !coinflip`,
        type: ActivityType.Watching
    });
}

// --- AMOUNT PARSER (K, M, B) ---
function parseMcAmount(str) {
    if (!str) return 0;
    let amount = parseFloat(str.replace(/[^0-9.]/g, ''));
    const suffix = str.toUpperCase();
    
    if (suffix.includes('K')) amount *= 1000;
    else if (suffix.includes('M')) amount *= 1000000;
    else if (suffix.includes('B')) amount *= 1000000000;
    
    return amount;
}

// --- MINECRAFT BOT CONTROL ---
function createMCBot() {
    if (bot) {
        bot.removeAllListeners();
        if (broadcastTimer) clearInterval(broadcastTimer);
        try { bot.quit(); } catch(e) {}
    }
    
    console.log('[DEBUG] Connecting to Minecraft...');
    bot = mineflayer.createBot({
        host: config.mcHost,
        username: config.mcUsername,
        auth: 'microsoft',
        version: false,
        checkTimeoutInterval: 90000
    });

    bot.on('spawn', () => {
        console.log('[SUCCESS] Bot spawned in world.');
        isBotRunning = true;
        updateStatus();
        
        setTimeout(() => {
            if (bot && bot._client && typeof bot.chat === 'function') {
                bot.chat('/bal');
            }
        }, 5000);

        const afkInterval = setInterval(() => {
            if (bot && bot.entity) {
                bot.setControlState('jump', true);
                setTimeout(() => bot.setControlState('jump', false), 500);
            } else {
                clearInterval(afkInterval);
            }
        }, 30000);

        if (config.broadcastEnabled) {
            broadcastTimer = setInterval(() => {
                if (isBotRunning && bot && bot._client) {
                    bot.chat(config.broadcastMessage);
                }
            }, config.broadcastInterval);
        }
    });

    bot.on('login', () => {
        clearTimeout(reconnectTimeout);
        console.log('[SUCCESS] Minecraft Bot logged in!');
    });

    bot.on('messagestr', (message) => {
        const cleanMessage = message.replace(/\u00A7[0-9A-FK-OR]/ig, '').trim();
        if (!cleanMessage) return;

        console.log(`[MC-RAW] ${cleanMessage}`);

        if (cleanMessage.toLowerCase().includes('balance') || cleanMessage.includes('$')) {
            const balMatch = cleanMessage.match(/\$([0-9.,]+[KMBkmb]?)/);
            if (balMatch) {
                botBalance = parseMcAmount(balMatch[1]);
                console.log(`[DEBUG] Bot internal balance: $${botBalance}`);
            }
        }

        if (currentSession && currentSession.status === 'WAITING_PAYMENT') {
            const msgLower = cleanMessage.toLowerCase();
            const playerLower = currentSession.mcName.toLowerCase();

            if (msgLower.includes(playerLower) && (msgLower.includes('paid you') || msgLower.includes('received'))) {
                const amountMatch = cleanMessage.match(/\$([0-9.,]+[KMBkmb]?)/);
                if (amountMatch) {
                    const rawAmount = amountMatch[1];
                    const amount = parseMcAmount(rawAmount);
                    
                    if (!isNaN(amount) && amount > 0) {
                        currentSession.receivedAmount = amount;
                        processPayment();
                    }
                }
            }
        }
    });

    bot.on('error', (err) => console.log('[ERROR] MC Error:', err.message));
    bot.on('end', () => {
        isBotRunning = false;
        if (broadcastTimer) clearInterval(broadcastTimer);
        console.log('[DEBUG] MC Bot connection ended.');
        if (!reconnectTimeout && !bot._manualStop) {
            reconnectTimeout = setTimeout(createMCBot, 10000);
        }
    });
}

// --- QUEUE HANDLING ---
async function processQueue() {
    updateStatus();
    if (currentSession || queue.length === 0) return;
    currentSession = queue.shift();

    try {
        const channel = await client.channels.fetch(currentSession.channelId);
        const thread = await channel.threads.create({
            name: `coinflip-${currentSession.userName}`,
            type: ChannelType.PrivateThread
        });
        currentSession.threadId = thread.id;
        await thread.members.add(currentSession.userId);

        const welcomeEmbed = new EmbedBuilder()
            .setTitle('🎰 Coinflip Session')
            .setDescription(`Hello **${currentSession.userName}**!\n\n**Step 1:** Please type your exact Minecraft username!`)
            .setColor('#5865F2');
        await thread.send({ content: `<@${currentSession.userId}>`, embeds: [welcomeEmbed] });
    } catch (e) {
        currentSession = null;
        processQueue();
    }
}

// --- DISCORD COMMANDS ---
client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;

    if (msg.author.id === config.ownerId) {
        if (msg.content === '!startbot') { createMCBot(); return msg.reply('🚀 Bot starting...'); }
        if (msg.content === '!stopbot') {
            if (bot) {
                bot._manualStop = true;
                bot.quit();
                isBotRunning = false;
                return msg.reply('🛑 Bot stopped.');
            }
        }
    }

    if (msg.content === '!coinflip') {
        if (!isBotRunning) return msg.reply('❌ The bot is currently offline.');
        queue.push({ userId: msg.author.id, userName: msg.author.username, channelId: msg.channel.id, status: 'ASK_NAME' });
        msg.reply('✅ You are in queue! Check the private thread created for you.');
        processQueue();
    }

    if (msg.channel.isThread() && currentSession && msg.channel.id === currentSession.threadId) {
        if (msg.author.id !== currentSession.userId) return;

        if (currentSession.status === 'ASK_NAME') {
            currentSession.mcName = msg.content.trim();
            currentSession.status = 'WAITING_PAYMENT';
            msg.reply({ embeds: [new EmbedBuilder().setTitle('Payment').setDescription(`Please pay the bot in-game:\n\`/pay ${bot.username} <amount>\`\n\nIGN: **${currentSession.mcName}**`).setColor('#FEE75C')] });
        } 
        else if (currentSession.status === 'ASK_ROUNDS') {
            const rounds = parseInt(msg.content);
            if (isNaN(rounds) || rounds < 1 || rounds > 10) return msg.reply('Please provide a number between 1 and 10!');
            showConfirmation(msg.channel, rounds);
        }
    }
});

async function processPayment() {
    const thread = await client.channels.fetch(currentSession.threadId);
    currentSession.status = 'ASK_ROUNDS';
    thread.send({ embeds: [new EmbedBuilder().setTitle('💰 Payment Received!').setDescription(`Amount: **$${currentSession.receivedAmount.toLocaleString()}**\nHow many rounds would you like to play? (1-10)`).setColor('#57F287')] });
}

async function showConfirmation(thread, rounds) {
    let perGame = Math.floor(currentSession.receivedAmount / rounds);
    let totalBet = perGame * rounds;
    let refund = currentSession.receivedAmount - totalBet;

    currentSession.perGame = perGame;
    currentSession.rounds = rounds;
    currentSession.refund = refund;

    bot.chat('/bal');

    const embed = new EmbedBuilder()
        .setTitle('📊 Game Details')
        .addFields(
            { name: 'Bet/Round', value: `$${perGame.toLocaleString()}`, inline: true },
            { name: 'Rounds', value: `${rounds}`, inline: true },
            { name: 'Refund', value: `$${refund.toLocaleString()}`, inline: true }
        ).setColor('#E67E22');

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('confirm_start').setLabel('Start Game').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('cancel_start').setLabel('Refund Me').setStyle(ButtonStyle.Danger)
    );
    await thread.send({ embeds: [embed], components: [row] });
}

client.on('interactionCreate', async (int) => {
    if (!int.isButton() || !currentSession || int.user.id !== currentSession.userId) return;
    const thread = int.channel;

    if (int.customId === 'cancel_start') {
        bot.chat(`/pay ${currentSession.mcName} ${currentSession.receivedAmount}`);
        await int.update({ content: 'Funds refunded.', components: [] });
        return endSession(thread);
    }

    if (int.customId === 'confirm_start') {
        const maxWinPerRound = (currentSession.perGame * 2) * (1 - config.houseEdge);
        const totalMaxRisk = maxWinPerRound * currentSession.rounds;

        if (botBalance < totalMaxRisk) {
            bot.chat(`/pay ${currentSession.mcName} ${currentSession.receivedAmount}`);
            await int.update({ content: `❌ The bot doesn't have enough balance ($${Math.floor(totalMaxRisk).toLocaleString()} needed). Refunded.`, components: [] });
            return endSession(thread);
        }

        if (currentSession.refund > 0) bot.chat(`/pay ${currentSession.mcName} ${currentSession.refund}`);
        await int.update({ content: '🎲 Good luck!', components: [] });

        let totalWon = 0;
        for (let i = 1; i <= currentSession.rounds; i++) {
            const win = Math.random() < 0.5;
            const res = new EmbedBuilder().setTitle(`Round ${i}/${currentSession.rounds}`);
            if (win) {
                const winAmt = (currentSession.perGame * 2) * (1 - config.houseEdge);
                totalWon += winAmt;
                res.setDescription('✨ **YOU WON!**').setColor('#57F287');
            } else {
                res.setDescription('💀 **YOU LOST.**').setColor('#ED4245');
            }
            await thread.send({ embeds: [res] });
            await new Promise(r => setTimeout(r, 1500));
        }

        if (totalWon > 0) {
            const finalWin = Math.floor(totalWon);
            bot.chat(`/pay ${currentSession.mcName} ${finalWin}`);
            // PUBLIC PROOF IN CHAT:
            bot.chat(`🎰 [CF] ${currentSession.mcName} won $${finalWin.toLocaleString()} against the bot! Congrats!`);
        } else {
            bot.chat(`🎰 [CF] ${currentSession.mcName} wasn't lucky this time. Try your luck with !coinflip!`);
        }
        
        await thread.send(totalWon > 0 ? `🏆 Winnings sent: **$${Math.floor(totalWon).toLocaleString()}**` : '💀 Better luck next time!');
        endSession(thread);
    }
});

async function endSession(thread) {
    setTimeout(async () => {
        try { await thread.delete(); } catch(e) {}
        currentSession = null;
        updateStatus();
        processQueue();
    }, 10000);
}

client.on('clientReady', () => {
    console.log(`[SUCCESS] Discord Bot: ${client.user.tag}`);
    updateStatus();
});
client.login(config.token);
