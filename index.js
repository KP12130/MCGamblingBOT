const { Client, GatewayIntentBits, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ActivityType } = require('discord.js');
const mineflayer = require('mineflayer');
const express = require('express');
const axios = require('axios');

// --- RENDER.COM & WEB SERVER SETUP ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => { res.send('Bot is running!'); });
app.listen(PORT, () => { console.log(`[WEB] Server is listening on port ${PORT}`); });

if (process.env.RENDER_EXTERNAL_URL) {
    setInterval(() => { axios.get(process.env.RENDER_EXTERNAL_URL).catch(() => {}); }, 14 * 60 * 1000);
}

// --- CONFIGURATION ---
const config = {
    ownerId: process.env.OWNER_ID || 'YOUR_DISCORD_ID', 
    logChannelId: process.env.LOG_CHANNEL_ID || 'YOUR_LOG_CHANNEL_ID', 
    mcHost: process.env.MC_HOST || 'donutsmall.net',
    mcUsername: process.env.MC_USERNAME || 'BotEmail@example.com',
    token: process.env.DISCORD_TOKEN || 'YOUR_DISCORD_TOKEN', 
    vouchChannelId: process.env.VOUCH_CHANNEL_ID || 'YOUR_VOUCH_CHANNEL_ID',
    houseEdge: 0.04,
    broadcastEnabled: true,
    broadcastInterval: 300000, 
    broadcastMessage: "[GAMES] Try Coinflip or Dice Roll on our Discord! Type !setup to start."
};

// --- GAME MODULES ---

const Games = {
    CF: {
        name: 'Coinflip',
        emoji: '🪙',
        multiplier: 2,
        async play() {
            const win = Math.random() < 0.5;
            return {
                win,
                result: win ? "✨ Heads" : "💀 Tails"
            };
        }
    },
    DICE: {
        name: 'Dice Roll',
        emoji: '🎲',
        async play(session) {
            const roll = Math.floor(Math.random() * 6) + 1;
            let win = false;
            let multiplier = 2;

            if (session.gameMode === 'OVER') {
                win = roll > 3;
                multiplier = 2;
            } else if (session.gameMode === 'EXACT') {
                win = roll === session.exactNumber;
                multiplier = 6;
            }

            return {
                win,
                multiplier,
                result: `🎲 Rolled: **${roll}**`
            };
        }
    }
};

// --- BOT LOGIC ---

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ]
});

let bot;
let botBalance = 0;
let isBotRunning = false;
let queue = [];
const activeSessions = new Map();
let reconnectTimeout;
let broadcastTimer;

async function logToDiscord(message, isError = false) {
    try {
        const logChannel = await client.channels.fetch(config.logChannelId);
        if (logChannel) {
            const embed = new EmbedBuilder()
                .setTitle(isError ? '⚠️ System Error' : 'ℹ️ System Log')
                .setDescription(message)
                .setColor(isError ? '#ED4245' : '#5865F2')
                .setTimestamp();
            await logChannel.send({ embeds: [embed] });
        }
    } catch (err) {}
}

function updateStatus() {
    if (!client.user) return;
    const activeCount = activeSessions.size + queue.length;
    client.user.setActivity({
        name: `${isBotRunning ? '🟢' : '🔴'} ${activeCount} players | DonutSMP`,
        type: ActivityType.Watching
    });
}

function parseMcAmount(str) {
    if (!str) return 0;
    let amount = parseFloat(str.replace(/[^0-9.]/g, ''));
    const suffix = str.toUpperCase();
    if (suffix.includes('K')) amount *= 1000;
    else if (suffix.includes('M')) amount *= 1000000;
    else if (suffix.includes('B')) amount *= 1000000000;
    return amount;
}

function createMCBot() {
    if (bot) {
        bot.removeAllListeners();
        if (broadcastTimer) clearInterval(broadcastTimer);
        try { bot.quit(); } catch(e) {}
    }
    
    bot = mineflayer.createBot({
        host: config.mcHost,
        username: config.mcUsername,
        auth: 'microsoft',
        version: false,
        checkTimeoutInterval: 90000
    });

    bot.on('spawn', () => {
        isBotRunning = true;
        logToDiscord('✅ **Minecraft Bot Connected!**');
        updateStatus();
        setTimeout(() => { if (bot?.chat) bot.chat('/bal'); }, 5000);
        setInterval(() => { if (bot?.entity) { bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 500); } }, 30000);
        if (config.broadcastEnabled) {
            broadcastTimer = setInterval(() => { if (isBotRunning && bot?._client) bot.chat(config.broadcastMessage); }, config.broadcastInterval);
        }
    });

    bot.on('messagestr', (message) => {
        const cleanMessage = message.replace(/\u00A7[0-9A-FK-OR]/ig, '').trim();
        
        // Log filter for cleanup
        const ignoreList = ["to use", "click here", "presents", "online", "welcome", "voting", "shop"];
        if (ignoreList.some(term => cleanMessage.toLowerCase().includes(term))) return;

        if (cleanMessage.toLowerCase().includes('balance') || cleanMessage.includes('$')) {
            const balMatch = cleanMessage.match(/\$([0-9.,]+[KMBkmb]?)/);
            if (balMatch) botBalance = parseMcAmount(balMatch[1]);
        }
        
        for (const [threadId, session] of activeSessions.entries()) {
            if (session.status === 'WAITING_PAYMENT') {
                const msgLower = cleanMessage.toLowerCase();
                const playerLower = session.mcName.toLowerCase();
                if (msgLower.includes(playerLower) && (msgLower.includes('paid you') || msgLower.includes('received'))) {
                    const amountMatch = cleanMessage.match(/\$([0-9.,]+[KMBkmb]?)/);
                    if (amountMatch) {
                        session.receivedAmount = parseMcAmount(amountMatch[1]);
                        processPayment(threadId);
                    }
                }
            }
        }
    });

    bot.on('end', () => {
        isBotRunning = false;
        updateStatus();
        if (!bot?._manualStop) {
            clearTimeout(reconnectTimeout);
            reconnectTimeout = setTimeout(createMCBot, 15000); // 15s delay to prevent rate limit
        }
    });
}

async function processQueue() {
    updateStatus();
    if (queue.length === 0) return;
    const sessionData = queue.shift();
    
    try {
        const channel = await client.channels.fetch(sessionData.channelId);
        // Small delay to prevent Discord API rate limit
        await new Promise(r => setTimeout(r, 1000));

        const thread = await channel.threads.create({
            name: `${Games[sessionData.gameType].emoji} ${sessionData.userName}`,
            type: ChannelType.GuildPublicThread,
            autoArchiveDuration: 60,
        });

        setTimeout(async () => {
            try {
                const messages = await channel.messages.fetch({ limit: 5 });
                const threadMsg = messages.find(m => m.type === 18 || (m.flags.has(32) && m.content.includes(thread.id)));
                if (threadMsg) await threadMsg.delete();
            } catch (e) {}
        }, 2000);

        const session = {
            ...sessionData,
            threadId: thread.id,
            status: 'ASK_NAME',
            gameMode: null
        };

        activeSessions.set(thread.id, session);
        await thread.members.add(session.userId).catch(() => {});

        await thread.send({ 
            content: `Welcome <@${session.userId}>!`, 
            embeds: [new EmbedBuilder()
                .setTitle(`${Games[session.gameType].name}`)
                .setDescription('Please type your exact Minecraft username!')
                .setColor('#5865F2')] 
        });
        
    } catch (e) {
        console.error("Queue Error:", e);
        setTimeout(processQueue, 5000);
    }
}

client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;

    if (msg.author.id === config.ownerId) {
        if (msg.content === '!startbot') { createMCBot(); return msg.reply('🚀 Starting bot...'); }
        if (msg.content === '!setup') {
            const setupEmbed = new EmbedBuilder().setTitle('🎰 DonutSMP Casino').setDescription('Select a game!').setColor('#5865F2');
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('start_queue_CF').setLabel('Coinflip').setEmoji('🪙').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('start_queue_DICE').setLabel('Dice Roll').setEmoji('🎲').setStyle(ButtonStyle.Success)
            );
            await msg.channel.send({ embeds: [setupEmbed], components: [row] });
            await msg.delete().catch(() => {});
            return;
        }
    }

    const session = activeSessions.get(msg.channel.id);
    if (session && msg.author.id === session.userId) {
        if (session.status === 'ASK_NAME') {
            session.mcName = msg.content.trim();
            session.status = 'WAITING_PAYMENT';
            await msg.reply({ embeds: [new EmbedBuilder().setTitle('Payment').setDescription(`Send the bet on the server: \`/pay ${bot.username} <amount>\`\nIGN: **${session.mcName}**`).setColor('#FEE75C')] });
        } 
        else if (session.status === 'ASK_ROUNDS') {
            const rounds = parseInt(msg.content);
            if (isNaN(rounds) || rounds < 1 || rounds > 10) return msg.reply('Please provide a number between 1 and 10!');
            session.rounds = rounds;
            
            if (session.gameType === 'DICE') {
                session.status = 'ASK_DICE_MODE';
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('dice_mode_OVER').setLabel('Over 3 (4,5,6) [x1.92]').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('dice_mode_EXACT').setLabel('Exact Number [x5.76]').setStyle(ButtonStyle.Secondary)
                );
                await msg.reply({ content: 'Select game mode:', components: [row] });
            } else {
                showConfirmation(msg.channel);
            }
        }
        else if (session.status === 'ASK_EXACT_NUM') {
            const num = parseInt(msg.content);
            if (isNaN(num) || num < 1 || num > 6) return msg.reply('Please type a number between 1 and 6!');
            session.exactNumber = num;
            showConfirmation(msg.channel);
        }
    }
});

async function processPayment(threadId) {
    const session = activeSessions.get(threadId);
    if (!session) return;
    const thread = await client.channels.fetch(threadId);
    session.status = 'ASK_ROUNDS';
    await thread.send({ embeds: [new EmbedBuilder().setTitle('💰 Payment Received!').setDescription(`Amount: **$${session.receivedAmount.toLocaleString()}**\nHow many rounds do you want to play? (1-10)`).setColor('#57F287')] });
}

async function showConfirmation(thread) {
    const session = activeSessions.get(thread.id);
    if (!session) return;
    session.perGame = Math.floor(session.receivedAmount / session.rounds);
    session.refund = session.receivedAmount - (session.perGame * session.rounds);
    bot.chat('/bal');

    const embed = new EmbedBuilder().setTitle('📊 Game Details').addFields(
        { name: 'Game', value: session.gameType === 'CF' ? 'Coinflip' : `Dice (${session.gameMode === 'OVER' ? 'Over 3' : 'Exact'})`, inline: true },
        { name: 'Bet/Round', value: `$${session.perGame.toLocaleString()}`, inline: true },
        { name: 'Rounds', value: `${session.rounds}`, inline: true }
    ).setColor('#E67E22');

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('confirm_start').setLabel('Confirm').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('cancel_start').setLabel('Refund').setStyle(ButtonStyle.Danger)
    );
    await thread.send({ embeds: [embed], components: [row] });
}

client.on('interactionCreate', async (int) => {
    if (int.isButton() && int.customId.startsWith('start_queue_')) {
        if (!isBotRunning) return int.reply({ content: '❌ Bot is currently offline.', ephemeral: true });
        const type = int.customId.replace('start_queue_', '');
        if (queue.some(q => q.userId === int.user.id)) return int.reply({ content: '❌ You are already in queue!', ephemeral: true });
        
        queue.push({ userId: int.user.id, userName: int.user.username, channelId: int.channel.id, gameType: type });
        await int.reply({ content: `✅ Added to ${Games[type].name} queue!`, ephemeral: true });
        processQueue();
        return;
    }

    const session = activeSessions.get(int.channelId);
    if (!int.isButton() || !session || int.user.id !== session.userId) return;
    const thread = int.channel;

    if (int.customId.startsWith('dice_mode_')) {
        session.gameMode = int.customId.replace('dice_mode_', '');
        if (session.gameMode === 'EXACT') {
            session.status = 'ASK_EXACT_NUM';
            await int.update({ content: 'Type the exact number (1-6) you bet on:', components: [] });
        } else {
            showConfirmation(thread);
            await int.update({ content: 'Mode selected: Over 3', components: [] });
        }
        return;
    }

    if (int.customId === 'cancel_start') {
        bot.chat(`/pay ${session.mcName} ${session.receivedAmount}`);
        return endSession(thread.id);
    }

    if (int.customId === 'confirm_start') {
        if (session.refund > 0) bot.chat(`/pay ${session.mcName} ${session.refund}`);
        await int.update({ content: '🎲 Rolling...', components: [] });

        let totalWon = 0;
        for (let i = 1; i <= session.rounds; i++) {
            const gameData = await Games[session.gameType].play(session);
            const currentMultiplier = gameData.multiplier || Games[session.gameType].multiplier;
            
            const res = new EmbedBuilder().setTitle(`Round ${i}/${session.rounds}`).setDescription(gameData.result);
            if (gameData.win) {
                totalWon += (session.perGame * currentMultiplier) * (1 - config.houseEdge);
                res.setColor('#57F287').setFooter({ text: 'WON' });
            } else res.setColor('#ED4245').setFooter({ text: 'LOST' });
            
            await thread.send({ embeds: [res] });
            await new Promise(r => setTimeout(r, 1500));
        }

        if (totalWon > 0) {
            const finalWin = Math.floor(totalWon);
            bot.chat(`/pay ${session.mcName} ${finalWin}`);
            bot.chat(`[CASINO] ${session.mcName} won $${finalWin.toLocaleString()} playing ${Games[session.gameType].name}!`);
        } else bot.chat(`[CASINO] ${session.mcName} lost playing ${Games[session.gameType].name}.`);

        session.finalProfit = Math.floor(totalWon) - session.receivedAmount;
        
        const vouchRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('vouch_named').setLabel('Vouch (Public)').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('vouch_anon').setLabel('Vouch (Anon)').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('no_vouch').setLabel('No thanks').setStyle(ButtonStyle.Danger)
        );
        await thread.send({ content: `🏆 Game Over! Payout: **$${Math.floor(totalWon).toLocaleString()}**. Leave a vouch?`, components: [vouchRow] });
    }

    if (int.customId.startsWith('vouch_') || int.customId === 'no_vouch') {
        if (int.customId !== 'no_vouch') {
            const isAnon = int.customId === 'vouch_anon';
            const vouchChannel = await client.channels.fetch(config.vouchChannelId);
            const vouchEmbed = new EmbedBuilder()
                .setTitle('⭐ New Vouch!')
                .setDescription(`${isAnon ? 'An anonymous player' : `<@${session.userId}>`} played ${Games[session.gameType].name}!`)
                .addFields(
                    { name: 'Bet', value: `$${session.receivedAmount.toLocaleString()}`, inline: true },
                    { name: 'Profit', value: session.finalProfit >= 0 ? `📈 +$${session.finalProfit.toLocaleString()}` : `📉 -$${Math.abs(session.finalProfit).toLocaleString()}`, inline: true }
                )
                .setTimestamp()
                .setColor(session.finalProfit >= 0 ? '#57F287' : '#ED4245');
            await vouchChannel.send({ embeds: [vouchEmbed] });
        }
        endSession(thread.id);
    }
});

async function endSession(threadId) {
    try { 
        const thread = await client.channels.fetch(threadId);
        if (thread) {
            await new Promise(r => setTimeout(r, 1000)); // Delay to avoid RateLimiter
            await thread.delete();
        }
    } catch(e) {}
    activeSessions.delete(threadId);
    updateStatus();
    processQueue();
}

client.on('ready', () => { 
    logToDiscord('🚀 **Casino Bot Online!**');
    createMCBot(); 
    updateStatus(); 
});

client.login(config.token);
