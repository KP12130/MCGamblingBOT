const { Client, GatewayIntentBits, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ActivityType, PermissionsBitField } = require('discord.js');
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
    logChannelId: process.env.LOG_CHANNEL_ID || 'YOUR_LOG_CHANNEL_ID', 
    mcHost: process.env.MC_HOST || 'donutsmall.net',
    mcUsername: process.env.MC_USERNAME || 'BotEmail@example.com',
    token: process.env.DISCORD_TOKEN || 'YOUR_DISCORD_TOKEN', 
    vouchChannelId: process.env.VOUCH_CHANNEL_ID || 'YOUR_VOUCH_CHANNEL_ID',
    houseEdge: 0.04,
    broadcastEnabled: true,
    broadcastInterval: 300000, 
    broadcastMessage: "[COINFLIP] Double your money! 50/50 odds, only 4% fee! Type !coinflip on our Discord!"
};

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
    } catch (err) {
        console.error('[CRITICAL] Failed to send Discord log:', err.message);
    }
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
        logToDiscord('✅ **Minecraft Bot successfully connected!**');
        updateStatus();
        setTimeout(() => { if (bot?.chat) bot.chat('/bal'); }, 5000);
        setInterval(() => { 
            if (bot?.entity) { 
                bot.setControlState('jump', true); 
                setTimeout(() => bot.setControlState('jump', false), 500); 
            } 
        }, 30000);
        if (config.broadcastEnabled) {
            broadcastTimer = setInterval(() => { 
                if (isBotRunning && bot?._client) bot.chat(config.broadcastMessage); 
            }, config.broadcastInterval);
        }
    });

    bot.on('messagestr', (message) => {
        const cleanMessage = message.replace(/\u00A7[0-9A-FK-OR]/ig, '').trim();
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

    bot.on('error', (err) => {
        logToDiscord(`❌ **Minecraft Bot error:** \`${err.message}\`\nReconnecting in 10s...`, true);
    });

    bot.on('end', (reason) => {
        isBotRunning = false;
        updateStatus();
        if (!bot?._manualStop) {
            logToDiscord(`🔴 **Minecraft Bot disconnected!**\nReason: \`${reason}\`\nAttempting to reconnect...`);
            clearTimeout(reconnectTimeout);
            reconnectTimeout = setTimeout(createMCBot, 10000);
        }
    });
}

async function processQueue() {
    updateStatus();
    if (queue.length === 0) return;
    const sessionData = queue.shift();
    
    try {
        const channel = await client.channels.fetch(sessionData.channelId);
        const thread = await channel.threads.create({
            name: `cf-${sessionData.userName}`,
            type: ChannelType.GuildPublicThread,
            autoArchiveDuration: 60,
        });

        // Töröljük a Discord automatikus "started a thread" üzenetét
        setTimeout(async () => {
            try {
                const messages = await channel.messages.fetch({ limit: 5 });
                const threadMsg = messages.find(m => m.type === 18 || (m.flags.has(32) && m.content.includes(thread.id)));
                if (threadMsg) await threadMsg.delete();
            } catch (e) {}
        }, 1000);

        const session = {
            ...sessionData,
            threadId: thread.id,
            status: 'ASK_NAME'
        };

        activeSessions.set(thread.id, session);
        await thread.members.add(session.userId).catch(console.error);

        await thread.send({ 
            content: `Welcome <@${session.userId}>!`, 
            embeds: [new EmbedBuilder()
                .setTitle('🎰 Coinflip Game')
                .setDescription('Please type your exact Minecraft username!')
                .setColor('#5865F2')] 
        });
        
    } catch (e) {
        console.error('[ERROR] Failed to create thread:', e);
        processQueue();
    }
}

client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;

    if (msg.author.id === config.ownerId) {
        if (msg.content === '!startbot') { createMCBot(); return msg.reply('🚀 Starting bot...'); }
        if (msg.content === '!stopbot') { if (bot) { bot._manualStop = true; bot.quit(); isBotRunning = false; return msg.reply('🛑 Bot stopped.'); } }
        if (msg.content === '!setup') {
            const setupEmbed = new EmbedBuilder().setTitle('🎰 DonutSMP Coinflip').setDescription('Click the button below to start a new game!').setColor('#5865F2');
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('start_cf_queue').setLabel('Start Game').setEmoji('🎲').setStyle(ButtonStyle.Primary));
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
            await msg.reply({ embeds: [new EmbedBuilder().setTitle('Payment').setDescription(`Pay the bot on the server: \`/pay ${bot.username} <amount>\`\nIGN: **${session.mcName}**`).setColor('#FEE75C')] });
        } 
        else if (session.status === 'ASK_ROUNDS') {
            const rounds = parseInt(msg.content);
            if (isNaN(rounds) || rounds < 1 || rounds > 10) return msg.reply('Please provide a number between 1 and 10!');
            showConfirmation(msg.channel, rounds);
        }
    }
});

async function processPayment(threadId) {
    const session = activeSessions.get(threadId);
    if (!session) return;
    const thread = await client.channels.fetch(threadId);
    session.status = 'ASK_ROUNDS';
    await thread.send({ embeds: [new EmbedBuilder().setTitle('💰 Payment Received!').setDescription(`Amount: **$${session.receivedAmount.toLocaleString()}**\nHow many rounds? (1-10)`).setColor('#57F287')] });
}

async function showConfirmation(thread, rounds) {
    const session = activeSessions.get(thread.id);
    if (!session) return;
    session.perGame = Math.floor(session.receivedAmount / rounds);
    session.rounds = rounds;
    session.refund = session.receivedAmount - (session.perGame * rounds);
    bot.chat('/bal');

    const embed = new EmbedBuilder().setTitle('📊 Game Details').addFields(
        { name: 'Bet/Round', value: `$${session.perGame.toLocaleString()}`, inline: true },
        { name: 'Rounds', value: `${rounds}`, inline: true }
    ).setColor('#E67E22');

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('confirm_start').setLabel('Confirm Start').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('cancel_start').setLabel('Refund').setStyle(ButtonStyle.Danger)
    );
    await thread.send({ embeds: [embed], components: [row] });
}

client.on('interactionCreate', async (int) => {
    if (int.isButton() && int.customId === 'start_cf_queue') {
        if (!isBotRunning) return int.reply({ content: '❌ Bot is currently offline.', ephemeral: true });
        const inQueue = queue.some(q => q.userId === int.user.id);
        if (inQueue) return int.reply({ content: '❌ Already in queue!', ephemeral: true });
        queue.push({ userId: int.user.id, userName: int.user.username, channelId: int.channel.id });
        await int.reply({ content: '✅ Added to queue!', ephemeral: true });
        processQueue();
        return;
    }

    const session = activeSessions.get(int.channelId);
    if (!int.isButton() || !session || int.user.id !== session.userId) return;
    const thread = int.channel;

    if (int.customId === 'cancel_start') {
        bot.chat(`/pay ${session.mcName} ${session.receivedAmount}`);
        return endSession(thread.id);
    }

    if (int.customId === 'confirm_start') {
        const totalMaxRisk = (session.perGame * 2) * (1 - config.houseEdge) * session.rounds;
        if (botBalance < totalMaxRisk) {
            bot.chat(`/pay ${session.mcName} ${session.receivedAmount}`);
            return endSession(thread.id);
        }

        if (session.refund > 0) bot.chat(`/pay ${session.mcName} ${session.refund}`);
        await int.update({ content: '🎲 Rolling...', components: [] });

        let totalWon = 0;
        for (let i = 1; i <= session.rounds; i++) {
            const win = Math.random() < 0.5;
            const res = new EmbedBuilder().setTitle(`Round ${i}/${session.rounds}`);
            if (win) {
                totalWon += (session.perGame * 2) * (1 - config.houseEdge);
                res.setDescription('✨ **WON**').setColor('#57F287');
            } else res.setDescription('💀 **LOST**').setColor('#ED4245');
            await thread.send({ embeds: [res] });
            await new Promise(r => setTimeout(r, 1200));
        }

        if (totalWon > 0) {
            const finalWin = Math.floor(totalWon);
            bot.chat(`/pay ${session.mcName} ${finalWin}`);
            bot.chat(`[CF] ${session.mcName} won $${finalWin.toLocaleString()}!`);
        } else bot.chat(`[CF] ${session.mcName} lost. Try again!`);

        session.finalProfit = Math.floor(totalWon) - session.receivedAmount;
        
        const vouchRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('vouch_named').setLabel('Vouch (Public)').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('vouch_anon').setLabel('Vouch (Anon)').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('no_vouch').setLabel('No thanks').setStyle(ButtonStyle.Danger)
        );
        await thread.send({ content: `🏆 Game finished! Win: **$${Math.floor(totalWon).toLocaleString()}**. Leave a vouch?`, components: [vouchRow] });
    }

    if (int.customId.startsWith('vouch_') || int.customId === 'no_vouch') {
        if (int.customId !== 'no_vouch') {
            const isAnon = int.customId === 'vouch_anon';
            const vouchChannel = await client.channels.fetch(config.vouchChannelId);
            const vouchEmbed = new EmbedBuilder()
                .setTitle('⭐ New Vouch!')
                .setDescription(`${isAnon ? 'An anonymous player' : `<@${session.userId}>`} just finished a game!`)
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
        if (thread) await thread.delete(); 
    } catch(e) {}
    activeSessions.delete(threadId);
    updateStatus();
    processQueue();
}

client.on('ready', () => { 
    logToDiscord('🚀 **Bot is online and ready!**');
    createMCBot(); 
    updateStatus(); 
});

client.login(config.token);
