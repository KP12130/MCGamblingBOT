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
    broadcastMessage: "[GAMES] Próbáld ki a Coinflipet vagy a Kockadobást a Discordunkon! !setup a kezdéshez."
};

// --- GAME MODULES (VIRTUAL FILES) ---

const Games = {
    CF: {
        name: 'Coinflip',
        emoji: '🪙',
        multiplier: 2,
        async play() {
            const win = Math.random() < 0.5;
            return {
                win,
                result: win ? "✨ Fej" : "💀 Írás"
            };
        }
    },
    DICE: {
        name: 'Dice Roll',
        emoji: '🎲',
        async play(session) {
            const roll = Math.floor(Math.random() * 6) + 1;
            let win = false;
            let multiplier = 2; // Alapértelmezett

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
                result: `🎲 Dobás: **${roll}**`
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
                .setTitle(isError ? '⚠️ Rendszerhiba' : 'ℹ️ Rendszerüzenet')
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
        name: `${isBotRunning ? '🟢' : '🔴'} ${activeCount} játékos | DonutSMP`,
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
        logToDiscord('✅ **Minecraft Bot csatlakozva!**');
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
            name: `${Games[sessionData.gameType].emoji} ${sessionData.userName}`,
            type: ChannelType.GuildPublicThread,
            autoArchiveDuration: 60,
        });

        // Thread start üzenet törlése
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
            status: 'ASK_NAME',
            gameMode: null
        };

        activeSessions.set(thread.id, session);
        await thread.members.add(session.userId).catch(console.error);

        await thread.send({ 
            content: `Üdvözlünk <@${session.userId}>!`, 
            embeds: [new EmbedBuilder()
                .setTitle(`${Games[session.gameType].name}`)
                .setDescription('Kérlek írd be a pontos Minecraft felhasználóneved!')
                .setColor('#5865F2')] 
        });
        
    } catch (e) {
        processQueue();
    }
}

client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;

    if (msg.author.id === config.ownerId) {
        if (msg.content === '!startbot') { createMCBot(); return msg.reply('🚀 Bot indítása...'); }
        if (msg.content === '!setup') {
            const setupEmbed = new EmbedBuilder().setTitle('🎰 DonutSMP Casino').setDescription('Válassz egy játékot!').setColor('#5865F2');
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('start_queue_CF').setLabel('Coinflip').setEmoji('🪙').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('start_queue_DICE').setLabel('Kockadobás').setEmoji('🎲').setStyle(ButtonStyle.Success)
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
            await msg.reply({ embeds: [new EmbedBuilder().setTitle('Fizetés').setDescription(`Küldd el a tétet a szerveren: \`/pay ${bot.username} <összeg>\`\nIGN: **${session.mcName}**`).setColor('#FEE75C')] });
        } 
        else if (session.status === 'ASK_ROUNDS') {
            const rounds = parseInt(msg.content);
            if (isNaN(rounds) || rounds < 1 || rounds > 10) return msg.reply('Kérlek 1 és 10 közötti számot adj meg!');
            session.rounds = rounds;
            
            if (session.gameType === 'DICE') {
                session.status = 'ASK_DICE_MODE';
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('dice_mode_OVER').setLabel('3 felett (4,5,6) [x1.92]').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('dice_mode_EXACT').setLabel('Pontos szám [x5.76]').setStyle(ButtonStyle.Secondary)
                );
                await msg.reply({ content: 'Válassz játékmódot:', components: [row] });
            } else {
                showConfirmation(msg.channel);
            }
        }
        else if (session.status === 'ASK_EXACT_NUM') {
            const num = parseInt(msg.content);
            if (isNaN(num) || num < 1 || num > 6) return msg.reply('Kérlek 1 és 6 közötti számot írj be!');
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
    await thread.send({ embeds: [new EmbedBuilder().setTitle('💰 Befizetés érkezett!').setDescription(`Összeg: **$${session.receivedAmount.toLocaleString()}**\nHány kört szeretnél játszani? (1-10)`).setColor('#57F287')] });
}

async function showConfirmation(thread) {
    const session = activeSessions.get(thread.id);
    if (!session) return;
    session.perGame = Math.floor(session.receivedAmount / session.rounds);
    session.refund = session.receivedAmount - (session.perGame * session.rounds);
    bot.chat('/bal');

    const embed = new EmbedBuilder().setTitle('📊 Játék részletei').addFields(
        { name: 'Játék', value: session.gameType === 'CF' ? 'Coinflip' : `Kocka (${session.gameMode === 'OVER' ? '3 Felett' : 'Pontos'})`, inline: true },
        { name: 'Tét/Kör', value: `$${session.perGame.toLocaleString()}`, inline: true },
        { name: 'Körök', value: `${session.rounds}`, inline: true }
    ).setColor('#E67E22');

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('confirm_start').setLabel('Indítás').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('cancel_start').setLabel('Visszautalás').setStyle(ButtonStyle.Danger)
    );
    await thread.send({ embeds: [embed], components: [row] });
}

client.on('interactionCreate', async (int) => {
    if (int.isButton() && int.customId.startsWith('start_queue_')) {
        if (!isBotRunning) return int.reply({ content: '❌ A bot jelenleg nem elérhető.', ephemeral: true });
        const type = int.customId.replace('start_queue_', '');
        if (queue.some(q => q.userId === int.user.id)) return int.reply({ content: '❌ Már benne vagy a sorban!', ephemeral: true });
        
        queue.push({ userId: int.user.id, userName: int.user.username, channelId: int.channel.id, gameType: type });
        await int.reply({ content: `✅ Hozzáadva a ${Games[type].name} sorhoz!`, ephemeral: true });
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
            await int.update({ content: 'Írd be a pontos számot (1-6), amire fogadsz:', components: [] });
        } else {
            showConfirmation(thread);
            await int.update({ content: 'Játékmód kiválasztva: 3 felett', components: [] });
        }
        return;
    }

    if (int.customId === 'cancel_start') {
        bot.chat(`/pay ${session.mcName} ${session.receivedAmount}`);
        return endSession(thread.id);
    }

    if (int.customId === 'confirm_start') {
        if (session.refund > 0) bot.chat(`/pay ${session.mcName} ${session.refund}`);
        await int.update({ content: '🎲 Pörgetés...', components: [] });

        let totalWon = 0;
        for (let i = 1; i <= session.rounds; i++) {
            const gameData = await Games[session.gameType].play(session);
            const currentMultiplier = gameData.multiplier || Games[session.gameType].multiplier;
            
            const res = new EmbedBuilder().setTitle(`${i}/${session.rounds}. kör`).setDescription(gameData.result);
            if (gameData.win) {
                totalWon += (session.perGame * currentMultiplier) * (1 - config.houseEdge);
                res.setColor('#57F287').setFooter({ text: 'NYERTÉL' });
            } else res.setColor('#ED4245').setFooter({ text: 'VESZTETTÉL' });
            
            await thread.send({ embeds: [res] });
            await new Promise(r => setTimeout(r, 1200));
        }

        if (totalWon > 0) {
            const finalWin = Math.floor(totalWon);
            bot.chat(`/pay ${session.mcName} ${finalWin}`);
            bot.chat(`[CASINO] ${session.mcName} nyert $${finalWin.toLocaleString()}-t a ${Games[session.gameType].name} játékon!`);
        } else bot.chat(`[CASINO] ${session.mcName} sajnos vesztett a ${Games[session.gameType].name} játékon.`);

        session.finalProfit = Math.floor(totalWon) - session.receivedAmount;
        
        const vouchRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('vouch_named').setLabel('Vouch (Publikus)').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('vouch_anon').setLabel('Vouch (Anonim)').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('no_vouch').setLabel('Köszönöm, nem').setStyle(ButtonStyle.Danger)
        );
        await thread.send({ content: `🏆 Játék vége! Nyeremény: **$${Math.floor(totalWon).toLocaleString()}**. Hagysz egy vouch-ot?`, components: [vouchRow] });
    }

    if (int.customId.startsWith('vouch_') || int.customId === 'no_vouch') {
        if (int.customId !== 'no_vouch') {
            const isAnon = int.customId === 'vouch_anon';
            const vouchChannel = await client.channels.fetch(config.vouchChannelId);
            const vouchEmbed = new EmbedBuilder()
                .setTitle('⭐ Új Vouch!')
                .setDescription(`${isAnon ? 'Egy névtelen játékos' : `<@${session.userId}>`} játszott: ${Games[session.gameType].name}!`)
                .addFields(
                    { name: 'Tét', value: `$${session.receivedAmount.toLocaleString()}`, inline: true },
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
    logToDiscord('🚀 **Kaszinó Bot online!**');
    createMCBot(); 
    updateStatus(); 
});

client.login(config.token);
