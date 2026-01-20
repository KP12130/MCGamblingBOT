🎰 DonutSMP Gambling & AFK Bot

A professional, high-performance Discord and Minecraft integration bot specifically designed for DonutSMP. This bot manages automated coinflip gambling sessions, tracks house liquidity, and features built-in AFK prevention with auto-broadcasting.

✨ Features

🎰 Automated Coinflip: Seamless 1v1 coinflip gambling through Discord private threads.

💰 Liquidity Protection: Automatically checks if the bot has enough balance (/bal) to cover potential player winnings before starting a game.

🛡️ AFK Protection: Built-in anti-AFK jumping mechanism to stay online 24/7.

📢 Auto-Broadcast: Periodically sends customizable marketing messages in-game to attract players.

🔄 Auto-Reconnect: Robust reconnection logic that handles server restarts or kicks.

📊 Currency Support: Intelligent parser for Minecraft money formats (e.g., 10K, 5M, 2B).

🚀 Cloud Ready: Optimized for hosting on Render.com with self-pinging to prevent sleeping.

🛠️ Installation

1. Prerequisites

Node.js (v18 or higher)

A Minecraft account (Microsoft Auth)

A Discord Bot Token

2. Setup

Clone this repository or download the source code:

npm install


3. Environment Variables (ENV)

Configure the following variables in your hosting environment (e.g., Render.com Dashboard):

Key

Description

DISCORD_TOKEN

Your Discord Bot Token from the Developer Portal.

OWNER_ID

Your personal Discord User ID for admin commands.

MC_USERNAME

Your Microsoft account email address.

MC_HOST

The server address (default: donutsmall.net).

RENDER_EXTERNAL_URL

Your Render.com app URL (for self-ping).

🎮 Commands

Discord Admin Commands

!startbot - Connects the Minecraft bot to the server.

!stopbot - Safely disconnects the bot and stops auto-reconnect.

Discord User Commands

!coinflip - Starts a new gambling session.

⚙️ Configuration

You can fine-tune the bot's behavior in the config object inside index.js:

houseEdge: Adjust the house commission (default: 4%).

broadcastInterval: Change how often the bot advertises in-game.

broadcastMessage: Customize your marketing pitch.

📝 License

This project is for educational purposes. Please ensure you comply with the server rules of DonutSMP when using automated bots.

Built with ❤️ for the DonutSMP community.
