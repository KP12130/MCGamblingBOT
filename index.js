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

// --- GLOBAL ERROR HANDLING (CRITICAL FOR ECONNRESET) ---
process.on('uncaughtException', (err) => {
    console.error('[CRITICAL] Uncaught Exception:', err);
    // Prevents the process from crashing on ECONNRESET or similar network errors
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

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
    broadcastMessage: "[GAMES] Try Coinflip, Dice, Roulette or Blackjack on our Discord! Type !setup to start."
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
    },
    ROULETTE: {
        name: 'Roulette',
        emoji: '🎡',
        async play(session) {
            const rng = Math.random() * 100;
            let resultColor = '';
            let win = false;
            let multiplier = 0;

            if (rng < 10) {
                resultColor = 'GREEN';
                win = session.rouletteChoice === 'GREEN';
                multiplier = 12; // x12-14 adjusted for house edge
            } else if (rng < 55) {
                resultColor = 'RED';
                win = session.rouletteChoice === 'RED';
                multiplier = 2;
            } else {
                resultColor = 'BLACK';
                win = session.rouletteChoice === 'BLACK';
                multiplier = 2;
            }

            const colorEmoji = resultColor === 'RED' ? '🔴' : (resultColor === 'BLACK' ? '⚫' : '🟢');
            return {
                win,
                multiplier,
                result: `${colorEmoji} Result: **${resultColor}**`
            };
        }
    },
    BJ: {
        name: 'Blackjack',
        emoji: '🃏',
        multiplier: 2,
        // BJ uses custom logic handled in interactionCreate for Hit/Stand
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
let manualStop = false;
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
    manualStop = false;
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
        checkTimeoutInterval: 90000,
        hideErrors: true, 
        skipValidation: true
    });

    bot.on('spawn', () => {
        isBotRunning = true;
        logToDiscord('✅ **Minecraft Bot Connected!**');
        updateStatus();
        setTimeout(() => { if (bot?.chat) bot.chat('/bal'); }, 5000);
        
        setInterval(() => { 
            if (isBotRunning && bot?.entity) { 
                bot.setControlState('jump', true); 
                setTimeout(() => bot.setControlState('jump', false), 500); 
            } 
        }, 30000);

        if (config.broadcastEnabled) {
            if (broadcastTimer) clearInterval(broadcastTimer);
            broadcastTimer = setInterval(() => { 
                if (isBotRunning && bot?._client) bot.chat(config.broadcastMessage); 
            }, config.broadcastInterval);
        }
    });

    bot.on('messagestr', (message) => {
        const cleanMessage = message.replace(/\u00A7[0-9A-FK-OR]/ig, '').trim();
        const ignoreList = ["to use", "click here", "presents", "online", "welcome", "voting", "shop", "current", "server"];
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

    bot.on('error', (err) => {
        console.error('Mineflayer Error:', err.code || err);
        if (err.code === 'ECONNRESET') {
            logToDiscord('🔌 Hálózati hiba (ECONNRESET). Újracsatlakozás...');
        }
    });

    bot.on('end', () => {
        isBotRunning = false;
        updateStatus();
        if (broadcastTimer) clearInterval(broadcastTimer);
        if (!manualStop) {
            logToDiscord('🔄 Bot disconnected. Reconnecting in 15s...');
            clearTimeout(reconnectTimeout);
            reconnectTimeout = setTimeout(createMCBot, 15000);
        }
    });
}

async function processQueue() {
    updateStatus();
    if (queue.length === 0) return;
    const sessionData = queue.shift();
    
    try {
        const channel = await client.channels.fetch(sessionData.channelId);
        await new Promise(r => setTimeout(r, 1000));

        const thread = await channel.threads.create({
            name: `${Games[sessionData.gameType].emoji} ${sessionData.userName}`,
            type: ChannelType.GuildPublicThread,
            autoArchiveDuration: 60,
        });

        const session = {
            ...sessionData,
            threadId: thread.id,
            status: 'ASK_NAME',
            gameMode: null,
            rounds: 1
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
        if (msg.content === '!startbot') { manualStop = false; createMCBot(); return msg.reply('🚀 Starting bot...'); }
        if (msg.content === '!stopbot') {
            manualStop = true;
            if (bot) { bot.quit(); isBotRunning = false; }
            clearTimeout(reconnectTimeout);
            updateStatus();
            return msg.reply('🛑 Bot stopped.');
        }
        if (msg.content === '!setup') {
            const setupEmbed = new EmbedBuilder().setTitle('🎰 DonutSMP Casino').setDescription('Select a game!').setColor('#5865F2');
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('start_queue_CF').setLabel('Coinflip').setEmoji('🪙').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('start_queue_DICE').setLabel('Dice Roll').setEmoji('🎲').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId('start_queue_ROULETTE').setLabel('Roulette').setEmoji('🎡').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('start_queue_BJ').setLabel('Blackjack').setEmoji('🃏').setStyle(ButtonStyle.Secondary)
            );
            await msg.channel.send({ embeds: [setupEmbed], components: [row] });
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
            if (isNaN(rounds) || rounds < 1 || (session.gameType === 'BJ' ? rounds > 1 : rounds > 10)) return msg.reply('Invalid round count (BJ is 1 round only)!');
            session.rounds = rounds;
            
            if (session.gameType === 'DICE') {
                session.status = 'ASK_DICE_MODE';
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('dice_mode_OVER').setLabel('Over 3 [x1.92]').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId('dice_mode_EXACT').setLabel('Exact [x5.76]').setStyle(ButtonStyle.Secondary)
                );
                await msg.reply({ content: 'Select mode:', components: [row] });
            } 
            else if (session.gameType === 'ROULETTE') {
                session.status = 'ASK_ROULETTE_COLOR';
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('roulette_RED').setLabel('Red (x2)').setStyle(ButtonStyle.Danger),
                    new ButtonBuilder().setCustomId('roulette_BLACK').setLabel('Black (x2)').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId('roulette_GREEN').setLabel('Green (x12)').setStyle(ButtonStyle.Success)
                );
                await msg.reply({ content: 'Select color:', components: [row] });
            }
            else {
                showConfirmation(msg.channel);
            }
        }
        else if (session.status === 'ASK_EXACT_NUM') {
            const num = parseInt(msg.content);
            if (isNaN(num) || num < 1 || num > 6) return msg.reply('Type 1-6!');
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
    await thread.send({ embeds: [new EmbedBuilder().setTitle('💰 Payment Received!').setDescription(`Amount: **$${session.receivedAmount.toLocaleString()}**\nHow many rounds? (BJ = 1 round)`).setColor('#57F287')] });
}

function getBJValue(hand) {
    let val = 0; let aces = 0;
    hand.forEach(c => {
        if (['J', 'Q', 'K'].includes(c)) val += 10;
        else if (c === 'A') { val += 11; aces++; }
        else val += parseInt(c);
    });
    while (val > 21 && aces > 0) { val -= 10; aces--; }
    return val;
}

function drawBJCard() {
    const cards = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
    return cards[Math.floor(Math.random() * cards.length)];
}

async function showConfirmation(thread) {
    const session = activeSessions.get(thread.id);
    if (!session) return;
    session.perGame = Math.floor(session.receivedAmount / session.rounds);
    session.refund = session.receivedAmount - (session.perGame * session.rounds);

    const embed = new EmbedBuilder().setTitle('📊 Game Details').addFields(
        { name: 'Game', value: session.gameType, inline: true },
        { name: 'Bet/Round', value: `$${session.perGame.toLocaleString()}`, inline: true }
    ).setColor('#E67E22');

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('confirm_start').setLabel('Confirm').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('cancel_start').setLabel('Refund').setStyle(ButtonStyle.Danger)
    );
    await thread.send({ embeds: [embed], components: [row] });
}

client.on('interactionCreate', async (int) => {
    if (int.isButton() && int.customId.startsWith('start_queue_')) {
        const type = int.customId.replace('start_queue_', '');
        queue.push({ userId: int.user.id, userName: int.user.username, channelId: int.channel.id, gameType: type });
        await int.reply({ content: `✅ Added to ${type} queue!`, ephemeral: true });
        processQueue();
        return;
    }

    const session = activeSessions.get(int.channelId);
    if (!int.isButton() || !session || int.user.id !== session.userId) return;
    const thread = int.channel;

    if (int.customId.startsWith('roulette_')) {
        session.rouletteChoice = int.customId.replace('roulette_', '');
        showConfirmation(thread);
        return int.update({ content: `Betting on ${session.rouletteChoice}`, components: [] });
    }

    if (int.customId.startsWith('dice_mode_')) {
        session.gameMode = int.customId.replace('dice_mode_', '');
        if (session.gameMode === 'EXACT') {
            session.status = 'ASK_EXACT_NUM';
            return int.update({ content: 'Type number 1-6:', components: [] });
        }
        showConfirmation(thread);
        return int.update({ content: 'Mode: Over 3', components: [] });
    }

    if (int.customId === 'cancel_start') {
        bot.chat(`/pay ${session.mcName} ${session.receivedAmount}`);
        return endSession(thread.id);
    }

    if (int.customId === 'confirm_start') {
        if (session.refund > 0) bot.chat(`/pay ${session.mcName} ${session.refund}`);
        
        if (session.gameType === 'BJ') {
            session.pHand = [drawBJCard(), drawBJCard()];
            session.dHand = [drawBJCard()];
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('bj_hit').setLabel('Hit').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('bj_stand').setLabel('Stand').setStyle(ButtonStyle.Secondary)
            );
            const bjEmbed = new EmbedBuilder().setTitle('🃏 Blackjack')
                .addFields(
                    { name: 'Your Hand', value: `${session.pHand.join(', ')} (Total: ${getBJValue(session.pHand)})`, inline: true },
                    { name: 'Dealer Hand', value: `${session.dHand.join(', ')}`, inline: true }
                ).setColor('#5865F2');
            return int.update({ embeds: [bjEmbed], components: [row] });
        }

        await int.update({ content: '🎲 Playing...', components: [] });
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
        finishGame(session, totalWon, thread);
    }

    if (int.customId === 'bj_hit') {
        session.pHand.push(drawBJCard());
        const pVal = getBJValue(session.pHand);
        if (pVal > 21) {
            const bustEmbed = new EmbedBuilder().setTitle('💥 BUST!').setDescription(`Hand: ${session.pHand.join(', ')} (${pVal})`).setColor('#ED4245');
            await int.update({ embeds: [bustEmbed], components: [] });
            return finishGame(session, 0, thread);
        }
        const bjEmbed = new EmbedBuilder().setTitle('🃏 Blackjack')
            .addFields(
                { name: 'Your Hand', value: `${session.pHand.join(', ')} (Total: ${pVal})`, inline: true },
                { name: 'Dealer Hand', value: `${session.dHand.join(', ')}`, inline: true }
            ).setColor('#5865F2');
        return int.update({ embeds: [bjEmbed] });
    }

    if (int.customId === 'bj_stand') {
        while (getBJValue(session.dHand) < 17) { session.dHand.push(drawBJCard()); }
        const pVal = getBJValue(session.pHand);
        const dVal = getBJValue(session.dHand);
        let win = false;
        if (dVal > 21 || pVal > dVal) win = true;
        
        const resEmbed = new EmbedBuilder().setTitle(win ? '🏆 YOU WIN!' : '💀 YOU LOSE')
            .addFields(
                { name: 'Your Final', value: `${pVal}`, inline: true },
                { name: 'Dealer Final', value: `${dVal}`, inline: true }
            ).setColor(win ? '#57F287' : '#ED4245');
        await int.update({ embeds: [resEmbed], components: [] });
        const winAmount = win ? (session.perGame * 2) * (1 - config.houseEdge) : 0;
        return finishGame(session, winAmount, thread);
    }

    if (int.customId.startsWith('vouch_') || int.customId === 'no_vouch') {
        if (int.customId !== 'no_vouch') {
            const vouchChannel = await client.channels.fetch(config.vouchChannelId);
            const vouchEmbed = new EmbedBuilder().setTitle('⭐ New Vouch!')
                .setDescription(`${int.customId === 'vouch_anon' ? 'Anon' : `<@${session.userId}>`} played ${session.gameType}!`)
                .addFields({ name: 'Profit', value: `$${session.finalProfit.toLocaleString()}` }).setColor('#57F287');
            await vouchChannel.send({ embeds: [vouchEmbed] });
        }
        endSession(thread.id);
    }
});

async function finishGame(session, totalWon, thread) {
    const finalWin = Math.floor(totalWon);
    if (finalWin > 0) {
        bot.chat(`/pay ${session.mcName} ${finalWin}`);
        bot.chat(`[CASINO] ${session.mcName} won $${finalWin.toLocaleString()}!`);
    }
    session.finalProfit = finalWin - session.receivedAmount;
    const vouchRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('vouch_named').setLabel('Vouch').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('no_vouch').setLabel('Skip').setStyle(ButtonStyle.Danger)
    );
    await thread.send({ content: `Payout: $${finalWin.toLocaleString()}.`, components: [vouchRow] });
}

async function endSession(threadId) {
    try { 
        const thread = await client.channels.fetch(threadId);
        if (thread) { await new Promise(r => setTimeout(r, 1000)); await thread.delete(); }
    } catch(e) {}
    activeSessions.delete(threadId);
    processQueue();
}

client.on('ready', () => { createMCBot(); updateStatus(); });
client.login(config.token);
