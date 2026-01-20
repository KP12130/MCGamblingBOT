# 🎰 DonutSMP Gambling & AFK Bot

A **professional, high-performance integration bot** designed specifically for **DonutSMP**.  
The bot automates **coinflip gambling**, protects house liquidity, and ensures **24/7 uptime** with advanced AFK prevention and auto-reconnect logic.

---

## 🚀 Features

### 🎰 Automated Coinflip Gambling
- Seamless **1v1 coinflip games**
- Runs inside **private Discord threads**
- Clean game flow with minimal manual input

### 💰 Liquidity Protection
- Automatically checks **house balance** using `/bal`
- Prevents games when payout is not guaranteed
- Protects against negative balance scenarios

### 🛡️ AFK Protection
- Built-in **anti-AFK jumping**
- Keeps the Minecraft account online **24/7**

### 📢 Auto-Broadcast System
- Periodic in-game advertisements
- Fully customizable message & interval
- Helps attract new players automatically

### 🔄 Auto-Reconnect
- Handles:
  - Server restarts
  - Unexpected kicks
  - Network disconnects
- Zero-downtime design

### 📊 Smart Currency Parser
Supports common Minecraft money formats:
- `10K`
- `5M`
- `2B`
- `150000`

### ☁️ Cloud-Optimized
- Ready for **Render.com**
- Built-in self-pinging to prevent sleeping
- No manual keep-alive needed

---

## 🛠️ Installation & Setup

### 1️⃣ Prerequisites
- **Node.js v18+**
- **Minecraft account** (Microsoft Auth)
- **Discord Bot Token**
- Access to **DonutSMP**

---

### 2️⃣ Installation

Clone the repository and install dependencies:

git clone https://github.com/yourusername/donutsmp-gambling-bot.git
cd donutsmp-gambling-bot
npm install
3️⃣ Environment Variables
Configure the following environment variables
(e.g. Render.com → Environment Settings):

Key	Description
- DISCORD_TOKEN	Your Discord bot token
- OWNER_ID	Your Discord user ID
- MC_USERNAME	Microsoft account email
- MC_HOST	Minecraft server address (default: donutsmall.net)
- RENDER_EXTERNAL_URL	Render app URL (used for self-pinging)
###🎮 Commands
##👑 Admin Commands (Discord)
#Command	Description
- !startbot	Connects the bot to the Minecraft server
- !stopbot	Safely disconnects and disables auto-reconnect
##👤 User Commands (Discord)
#Command	Description
- !coinflip	Starts a new coinflip session in a private thread
##⚙️ Configuration
- You can customize the bot behavior inside index.js:
```
 const config = {
   houseEdge: 4, // House commission percentage
   broadcastInterval: 5 * 60 * 1000, // 5 minutes
   broadcastMessage: "🎰 Coinflip open! Type !coinflip on Discord to play!"
 };
```
## ⚠️ Important Notice
- This project is for educational purposes only.
- Always comply with DonutSMP rules regarding:

# - Automated bots

# - Gambling mechanics

# - AFK behavior

You are responsible for how you deploy and use this software.

## ❤️ Credits
- Built with passion for the DonutSMP community.
- Designed for stability, automation, and clean integration.
