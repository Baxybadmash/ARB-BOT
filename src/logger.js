const winston = require('winston');
const path = require('path');
const fs = require('fs');

const logsDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message }) =>
            `[${timestamp}] [${level.toUpperCase()}] ${message}`)
    ),
    transports: [
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.timestamp({ format: 'HH:mm:ss' }),
                winston.format.printf(({ timestamp, level, message }) =>
                    `[${timestamp}] ${level}: ${message}`)
            )
        }),
        ...(process.env.LOG_TO_FILE === 'true' ? [
            new winston.transports.File({ filename: path.join(logsDir, 'bot.log'), maxsize: 10*1024*1024, maxFiles: 5 }),
            new winston.transports.File({ filename: path.join(logsDir, 'profit.log'), level: 'info', maxsize: 10*1024*1024, maxFiles: 10 })
        ] : [])
    ]
});

module.exports = logger;
