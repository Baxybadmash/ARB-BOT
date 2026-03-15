@echo off
title Solana Flashloan Arb Bot

:: UPDATE THIS PATH to where you saved the bot
cd /d "C:\solana-arb-bot"

:: Wait 30 seconds after boot for internet
timeout /t 30 /nobreak

:RESTART
echo [%date% %time%] Starting Solana Arb Bot...
node src/bot.js
echo [%date% %time%] Bot stopped. Restarting in 10 seconds...
timeout /t 10 /nobreak
goto RESTART
