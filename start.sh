#!/bin/bash
# Start the Solana arb bot with proper nvm environment
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

cd ~/solana-arb-bot
echo "Starting bot with node $(node --version)..."
node src/bot.js
