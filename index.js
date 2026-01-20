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

function updateStatus() {
    if (!client.user) return;
    const activeCount = activeSessions.size + queue.length;
    client.user.setActivity({
        name: `${activeCount} players active | DonutSMP`,
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
        if (!reconnectTimeout && !bot?._manualStop) reconnectTimeout = setTimeout(createMCBot, 10000);
    });
}

async function processQueue() {
    updateStatus();
    if (queue.length === 0) return;
    
    const sessionData = queue.shift();
    
    try {
        const channel = await client.channels.fetch(sessionData.channelId);
        
        // Próbáljuk meg nyilvános szálként, mert néha a privát szálak jogosultságai bugosak
        const thread = await channel.threads.create({
            name: `cf-${sessionData.userName}`,
            type: ChannelType.GuildPublicThread, // Publikus szál, de csak az látja aki benne van ha a csatorna rejtett
            autoArchiveDuration: 60,
        });

        const session = {
            ...sessionData,
            threadId: thread.id,
            messagesToDelete: [],
            status: 'ASK_NAME'
        };

        activeSessions.set(thread.id, session);
        
        // Felhasználó kényszerített hozzáadása
        await thread.members.add(session.userId).catch(console.error);

        // Küldünk egy üzenetet, amiben megemlítjük, ez is segít a jogosultságban
        const welcome = await thread.send({ 
            content: `Üdvözöllek <@${session.userId}>!`, 
            embeds: [new EmbedBuilder()
                .setTitle('🎰 Coinflip Játék')
                .setDescription('Kérlek, írd be a pontos Minecraft nevedet!\n\n*Ha még mindig nem tudsz írni, ellenőrizd a csatorna jogosultságait (Send Messages in Threads).*')
                .setColor('#5865F2')] 
        });
        session.messagesToDelete.push(welcome);
        
        try {
            const logChannel = await client.channels.fetch(config.logChannelId);
            if (logChannel) {
                await logChannel.send({
                    content: `🔔 **Új Coinflip indult!**\nFelhasználó: <@${session.userId}> (${session.userName})\nSzál: <#${thread.id}>`
                });
            }
        } catch (logErr) {
            console.error('[HIBA] Log csatorna nem elérhető:', logErr.message);
        }
        
    } catch (e) {
        console.error('[HIBA] Szál létrehozása sikertelen:', e);
        processQueue();
    }
}

client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;

    if (msg.author.id === config.ownerId) {
        if (msg.content === '!startbot') { createMCBot(); return msg.reply('🚀 Bot indul...'); }
        if (msg.content === '!stopbot') { if (bot) { bot._manualStop = true; bot.quit(); isBotRunning = false; return msg.reply('🛑 Bot leállítva.'); } }
        
        if (msg.content === '!setup') {
            const setupEmbed = new EmbedBuilder()
                .setTitle('🎰 DonutSMP Coinflip')
                .setDescription('Kattints az alábbi gombra egy új játék indításához!\n\n**Szabályok:**\n- 50/50 esély\n- 4% jutalék\n- 1-10 kör')
                .setColor('#5865F2');
            
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('start_cf_queue')
                    .setLabel('Játék indítása')
                    .setEmoji('🎲')
                    .setStyle(ButtonStyle.Primary)
            );
            
            await msg.channel.send({ embeds: [setupEmbed], components: [row] });
            await msg.delete().catch(() => {});
            return;
        }
    }

    const session = activeSessions.get(msg.channel.id);
    if (session && msg.author.id === session.userId) {
        session.messagesToDelete.push(msg);

        if (session.status === 'ASK_NAME') {
            session.mcName = msg.content.trim();
            session.status = 'WAITING_PAYMENT';
            const m = await msg.reply({ embeds: [new EmbedBuilder().setTitle('Fizetés').setDescription(`Fizess a botnak a szerveren: \`/pay ${bot.username} <összeg>\`\nIGN: **${session.mcName}**`).setColor('#FEE75C')] });
            session.messagesToDelete.push(m);
        } 
        else if (session.status === 'ASK_ROUNDS') {
            const rounds = parseInt(msg.content);
            if (isNaN(rounds) || rounds < 1 || rounds > 10) return msg.reply('Kérlek 1 és 10 közötti számot adj meg!');
            showConfirmation(msg.channel, rounds);
        }
    }
});

async function processPayment(threadId) {
    const session = activeSessions.get(threadId);
    if (!session) return;
    const thread = await client.channels.fetch(threadId);
    session.status = 'ASK_ROUNDS';
    const m = await thread.send({ embeds: [new EmbedBuilder().setTitle('💰 Befizetés érkezett!').setDescription(`Összeg: **$${session.receivedAmount.toLocaleString()}**\nHány kör legyen? (1-10)`).setColor('#57F287')] });
    session.messagesToDelete.push(m);
}

async function showConfirmation(thread, rounds) {
    const session = activeSessions.get(thread.id);
    if (!session) return;
    let perGame = Math.floor(session.receivedAmount / rounds);
    session.perGame = perGame;
    session.rounds = rounds;
    session.refund = session.receivedAmount - (perGame * rounds);
    bot.chat('/bal');

    const embed = new EmbedBuilder().setTitle('📊 Játék részletei').addFields(
        { name: 'Tét/Kör', value: `$${perGame.toLocaleString()}`, inline: true },
        { name: 'Körök', value: `${rounds}`, inline: true }
    ).setColor('#E67E22');

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('confirm_start').setLabel('Játék indítása').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('cancel_start').setLabel('Visszautalás').setStyle(ButtonStyle.Danger)
    );
    const m = await thread.send({ embeds: [embed], components: [row] });
    session.messagesToDelete.push(m);
}

client.on('interactionCreate', async (int) => {
    if (int.isButton() && int.customId === 'start_cf_queue') {
        if (!isBotRunning) return int.reply({ content: '❌ A bot jelenleg nem elérhető.', ephemeral: true });
        
        for (const [threadId, session] of activeSessions.entries()) {
            if (session.userId === int.user.id) {
                try {
                    const existingThread = await client.channels.fetch(threadId);
                    if (existingThread) {
                        return int.reply({ content: '❌ Már van egy futó munkameneted! Nézd meg a szálaidat.', ephemeral: true });
                    }
                } catch (e) {
                    activeSessions.delete(threadId);
                }
            }
        }

        const inQueue = queue.some(q => q.userId === int.user.id);
        if (inQueue) return int.reply({ content: '❌ Már benne vagy a várólistában!', ephemeral: true });

        queue.push({ 
            userId: int.user.id, 
            userName: int.user.username, 
            channelId: int.channel.id
        });
        
        await int.reply({ content: '✅ Hozzáadva a várólistához! Nézd meg a létrehozott szálat.', ephemeral: true });
        processQueue();
        return;
    }

    const session = activeSessions.get(int.channelId);
    if (!int.isButton() || !session || int.user.id !== session.userId) return;
    const thread = int.channel;

    if (int.customId === 'cancel_start') {
        bot.chat(`/pay ${session.mcName} ${session.receivedAmount}`);
        await int.update({ content: 'Visszautalva.', components: [] });
        return endSession(thread.id);
    }

    if (int.customId === 'confirm_start') {
        const totalMaxRisk = (session.perGame * 2) * (1 - config.houseEdge) * session.rounds;
        if (botBalance < totalMaxRisk) {
            bot.chat(`/pay ${session.mcName} ${session.receivedAmount}`);
            await int.update({ content: `❌ Nincs elég egyenlege a botnak ($${Math.floor(totalMaxRisk).toLocaleString()} kellene).`, components: [] });
            return endSession(thread.id);
        }

        if (session.refund > 0) bot.chat(`/pay ${session.mcName} ${session.refund}`);
        await int.update({ content: '🎲 Pörgetés...', components: [] });

        let totalWon = 0;
        for (let i = 1; i <= session.rounds; i++) {
            const win = Math.random() < 0.5;
            const res = new EmbedBuilder().setTitle(`Kör ${i}/${session.rounds}`);
            if (win) {
                totalWon += (session.perGame * 2) * (1 - config.houseEdge);
                res.setDescription('✨ **NYERTÉL**').setColor('#57F287');
            } else res.setDescription('💀 **VESZTETTÉL**').setColor('#ED4245');
            const m = await thread.send({ embeds: [res] });
            session.messagesToDelete.push(m);
            await new Promise(r => setTimeout(r, 1500));
        }

        if (totalWon > 0) {
            const finalWin = Math.floor(totalWon);
            bot.chat(`/pay ${session.mcName} ${finalWin}`);
            bot.chat(`[CF] ${session.mcName} nyert $${finalWin.toLocaleString()}-t!`);
        } else {
            bot.chat(`[CF] ${session.mcName} vesztett. Próbáld újra!`);
        }

        session.finalProfit = Math.floor(totalWon) - session.receivedAmount;
        
        const vouchRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('vouch_named').setLabel('Vouch (Publikus)').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('vouch_anon').setLabel('Vouch (Anonim)').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('no_vouch').setLabel('Köszönöm, nem').setStyle(ButtonStyle.Danger)
        );
        await thread.send({ content: `🏆 Játék vége! Nyeremény: **$${Math.floor(totalWon).toLocaleString()}**. Szeretnél vouch-ot küldeni?`, components: [vouchRow] });
    }

    if (int.customId.startsWith('vouch_') || int.customId === 'no_vouch') {
        if (int.customId !== 'no_vouch') {
            const isAnon = int.customId === 'vouch_anon';
            const vouchChannel = await client.channels.fetch(config.vouchChannelId);
            const vouchEmbed = new EmbedBuilder()
                .setTitle('⭐ Új Vouch!')
                .setDescription(`${isAnon ? 'Egy anonim játékos' : `<@${session.userId}>`} épp befejezett egy játékot!`)
                .addFields(
                    { name: 'Tét', value: `$${session.receivedAmount.toLocaleString()}`, inline: true },
                    { name: 'Eredmény', value: session.finalProfit >= 0 ? `📈 +$${session.finalProfit.toLocaleString()}` : `📉 -$${Math.abs(session.finalProfit).toLocaleString()}`, inline: true }
                )
                .setTimestamp()
                .setColor(session.finalProfit >= 0 ? '#57F287' : '#ED4245');
            await vouchChannel.send({ embeds: [vouchEmbed] });
        }
        await int.update({ content: 'Feldolgozás...', components: [] });
        endSession(thread.id);
    }
});

async function endSession(threadId) {
    const session = activeSessions.get(threadId);
    if (!session) return;
    
    for (const m of session.messagesToDelete) {
        try { await m.delete(); } catch(e) {}
    }
    
    setTimeout(async () => {
        try { 
            const thread = await client.channels.fetch(threadId);
            if (thread) await thread.delete(); 
        } catch(e) {}
        activeSessions.delete(threadId);
        updateStatus();
        processQueue();
    }, 5000);
}

client.on('ready', () => { createMCBot(); updateStatus(); });
client.login(config.token);
