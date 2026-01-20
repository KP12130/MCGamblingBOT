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

if (process.env.RENDER_EXTERNAL_URL) {
    setInterval(() => {
        axios.get(process.env.RENDER_EXTERNAL_URL)
            .then(() => console.log('[WEB] Self-ping successful'))
            .catch(err => console.error('[WEB] Self-ping failed:', err.message));
    }, 14 * 60 * 1000);
}

const config = {
    ownerId: process.env.OWNER_ID || 'YOUR_DISCORD_ID', 
    mcHost: process.env.MC_HOST || 'donutsmall.net',
    mcUsername: process.env.MC_USERNAME || 'BotEmail@example.com',
    token: process.env.DISCORD_TOKEN || 'YOUR_DISCORD_TOKEN', 
    vouchChannelId: process.env.VOUCH_CHANNEL_ID || 'YOUR_VOUCH_CHANNEL_ID',
    houseEdge: 0.04,
    broadcastEnabled: true,
    broadcastInterval: 300000, 
    broadcastMessage: "[COINFLIP] Double your money! 50/50 odds, only 4% fee! Type !coinflip on our Discord!"
};

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

function updateStatus() {
    if (!client.user) return;
    const queueLen = queue.length + (currentSession ? 1 : 0);
    client.user.setActivity({
        name: `${queueLen} players in queue | !coinflip`,
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
        updateStatus();
        setTimeout(() => { if (bot?.chat) bot.chat('/bal'); }, 5000);
        setInterval(() => { if (bot?.entity) { bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 500); } }, 30000);
        if (config.broadcastEnabled) {
            broadcastTimer = setInterval(() => { if (isBotRunning && bot?._client) bot.chat(config.broadcastMessage); }, config.broadcastInterval);
        }
    });

    bot.on('messagestr', (message) => {
        const cleanMessage = message.replace(/\u00A7[0-9A-FK-OR]/ig, '').trim();
        if (cleanMessage.toLowerCase().includes('balance') || cleanMessage.includes('$')) {
            const balMatch = cleanMessage.match(/\$([0-9.,]+[KMBkmb]?)/);
            if (balMatch) botBalance = parseMcAmount(balMatch[1]);
        }
        if (currentSession?.status === 'WAITING_PAYMENT') {
            const msgLower = cleanMessage.toLowerCase();
            const playerLower = currentSession.mcName.toLowerCase();
            if (msgLower.includes(playerLower) && (msgLower.includes('paid you') || msgLower.includes('received'))) {
                const amountMatch = cleanMessage.match(/\$([0-9.,]+[KMBkmb]?)/);
                if (amountMatch) {
                    currentSession.receivedAmount = parseMcAmount(amountMatch[1]);
                    processPayment();
                }
            }
        }
    });

    bot.on('end', () => {
        isBotRunning = false;
        if (!reconnectTimeout && !bot?._manualStop) reconnectTimeout = setTimeout(createMCBot, 10000);
    });
}

async function processQueue() {
    updateStatus();
    if (currentSession || queue.length === 0) return;
    currentSession = queue.shift();
    currentSession.messagesToDelete = [];

    try {
        const channel = await client.channels.fetch(currentSession.channelId);
        const thread = await channel.threads.create({
            name: `coinflip-${currentSession.userName}`,
            type: ChannelType.PrivateThread
        });
        currentSession.threadId = thread.id;
        await thread.members.add(currentSession.userId);

        const welcome = await thread.send({ 
            content: `<@${currentSession.userId}>`, 
            embeds: [new EmbedBuilder().setTitle('🎰 Coinflip Session').setDescription('Hello! Please type your exact Minecraft username!').setColor('#5865F2')] 
        });
        currentSession.messagesToDelete.push(welcome);
    } catch (e) {
        currentSession = null;
        processQueue();
    }
}

client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;

    if (msg.author.id === config.ownerId) {
        if (msg.content === '!startbot') { createMCBot(); return msg.reply('🚀 Bot starting...'); }
        if (msg.content === '!stopbot') { if (bot) { bot._manualStop = true; bot.quit(); isBotRunning = false; return msg.reply('🛑 Stopped.'); } }
    }

    if (msg.content === '!coinflip') {
        if (!isBotRunning) return msg.reply('❌ Bot is offline.');
        queue.push({ userId: msg.author.id, userName: msg.author.username, channelId: msg.channel.id, status: 'ASK_NAME' });
        msg.reply('✅ Added to queue! Check your private thread.');
        processQueue();
    }

    if (msg.channel.isThread() && currentSession?.threadId === msg.channel.id) {
        if (msg.author.id !== currentSession.userId) return;
        currentSession.messagesToDelete.push(msg);

        if (currentSession.status === 'ASK_NAME') {
            currentSession.mcName = msg.content.trim();
            currentSession.status = 'WAITING_PAYMENT';
            const m = await msg.reply({ embeds: [new EmbedBuilder().setTitle('Payment').setDescription(`Pay the bot in-game: \`/pay ${bot.username} <amount>\`\nIGN: **${currentSession.mcName}**`).setColor('#FEE75C')] });
            currentSession.messagesToDelete.push(m);
        } 
        else if (currentSession.status === 'ASK_ROUNDS') {
            const rounds = parseInt(msg.content);
            if (isNaN(rounds) || rounds < 1 || rounds > 10) return msg.reply('1-10 rounds please!');
            showConfirmation(msg.channel, rounds);
        }
    }
});

async function processPayment() {
    const thread = await client.channels.fetch(currentSession.threadId);
    currentSession.status = 'ASK_ROUNDS';
    const m = await thread.send({ embeds: [new EmbedBuilder().setTitle('💰 Received!').setDescription(`Amount: **$${currentSession.receivedAmount.toLocaleString()}**\nHow many rounds? (1-10)`).setColor('#57F287')] });
    currentSession.messagesToDelete.push(m);
}

async function showConfirmation(thread, rounds) {
    let perGame = Math.floor(currentSession.receivedAmount / rounds);
    currentSession.perGame = perGame;
    currentSession.rounds = rounds;
    currentSession.refund = currentSession.receivedAmount - (perGame * rounds);
    bot.chat('/bal');

    const embed = new EmbedBuilder().setTitle('📊 Game Details').addFields(
        { name: 'Bet/Round', value: `$${perGame.toLocaleString()}`, inline: true },
        { name: 'Rounds', value: `${rounds}`, inline: true }
    ).setColor('#E67E22');

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('confirm_start').setLabel('Start Game').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('cancel_start').setLabel('Refund').setStyle(ButtonStyle.Danger)
    );
    const m = await thread.send({ embeds: [embed], components: [row] });
    currentSession.messagesToDelete.push(m);
}

client.on('interactionCreate', async (int) => {
    if (!int.isButton() || !currentSession || int.user.id !== currentSession.userId) return;
    const thread = int.channel;

    if (int.customId === 'cancel_start') {
        bot.chat(`/pay ${currentSession.mcName} ${currentSession.receivedAmount}`);
        await int.update({ content: 'Refunded.', components: [] });
        return endSession(thread);
    }

    if (int.customId === 'confirm_start') {
        const totalMaxRisk = (currentSession.perGame * 2) * (1 - config.houseEdge) * currentSession.rounds;
        if (botBalance < totalMaxRisk) {
            bot.chat(`/pay ${currentSession.mcName} ${currentSession.receivedAmount}`);
            await int.update({ content: `❌ Insufficient bot balance ($${Math.floor(totalMaxRisk).toLocaleString()} needed).`, components: [] });
            return endSession(thread);
        }

        if (currentSession.refund > 0) bot.chat(`/pay ${currentSession.mcName} ${currentSession.refund}`);
        await int.update({ content: '🎲 Rolling...', components: [] });

        let totalWon = 0;
        for (let i = 1; i <= currentSession.rounds; i++) {
            const win = Math.random() < 0.5;
            const res = new EmbedBuilder().setTitle(`Round ${i}/${currentSession.rounds}`);
            if (win) {
                totalWon += (currentSession.perGame * 2) * (1 - config.houseEdge);
                res.setDescription('✨ **WIN**').setColor('#57F287');
            } else res.setDescription('💀 **LOSS**').setColor('#ED4245');
            const m = await thread.send({ embeds: [res] });
            currentSession.messagesToDelete.push(m);
            await new Promise(r => setTimeout(r, 1500));
        }

        if (totalWon > 0) {
            const finalWin = Math.floor(totalWon);
            bot.chat(`/pay ${currentSession.mcName} ${finalWin}`);
            // Csak a legszükségesebb üzenetet küldjük a szerverre
            bot.chat(`[CF] ${currentSession.mcName} won $${finalWin.toLocaleString()}!`);
        } else {
            bot.chat(`[CF] ${currentSession.mcName} lost. Try again with !coinflip!`);
        }

        currentSession.finalProfit = Math.floor(totalWon) - currentSession.receivedAmount;
        
        const vouchRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('vouch_named').setLabel('Vouch (Public)').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('vouch_anon').setLabel('Vouch (Anonymous)').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('no_vouch').setLabel('No Thanks').setStyle(ButtonStyle.Danger)
        );
        await thread.send({ content: `🏆 Game Over! Winnings: **$${Math.floor(totalWon).toLocaleString()}**. Would you like to post a vouch?`, components: [vouchRow] });
    }

    if (int.customId.startsWith('vouch_') || int.customId === 'no_vouch') {
        if (int.customId !== 'no_vouch') {
            const isAnon = int.customId === 'vouch_anon';
            const vouchChannel = await client.channels.fetch(config.vouchChannelId);
            const vouchEmbed = new EmbedBuilder()
                .setTitle('⭐ New Vouch!')
                .setDescription(`${isAnon ? 'An Anonymous Player' : `<@${currentSession.userId}>`} just finished a game!`)
                .addFields(
                    { name: 'Bet Amount', value: `$${currentSession.receivedAmount.toLocaleString()}`, inline: true },
                    { name: 'Result', value: currentSession.finalProfit >= 0 ? `📈 +$${currentSession.finalProfit.toLocaleString()}` : `📉 -$${Math.abs(currentSession.finalProfit).toLocaleString()}`, inline: true }
                )
                .setTimestamp()
                .setColor(currentSession.finalProfit >= 0 ? '#57F287' : '#ED4245');
            await vouchChannel.send({ embeds: [vouchEmbed] });
        }
        await int.update({ content: 'Processing...', components: [] });
        endSession(thread);
    }
});

async function endSession(thread) {
    for (const m of currentSession.messagesToDelete) {
        try { await m.delete(); } catch(e) {}
    }
    setTimeout(async () => {
        try { await thread.delete(); } catch(e) {}
        currentSession = null;
        updateStatus();
        processQueue();
    }, 5000);
}

client.on('clientReady', () => { createMCBot(); updateStatus(); });
client.login(config.token);
