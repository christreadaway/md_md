const fs = require('fs');
const path = require('path');
const winston = require('winston');

function createAppLogger({ logsDir, runTimestamp }) {
  fs.mkdirSync(logsDir, { recursive: true });
  const logFile = path.join(logsDir, `run-${runTimestamp}.log`);
  // Pre-create the file so callers can rely on its existence even before first async write.
  try { fs.closeSync(fs.openSync(logFile, 'a')); } catch {}

  const winstonLogger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.printf(({ timestamp, level, message }) =>
        `[${timestamp}] [${level.toUpperCase()}] ${message}`
      )
    ),
    transports: [
      new winston.transports.Console(),
      new winston.transports.File({ filename: logFile }),
    ],
  });

  const buffer = [];
  const MAX_BUFFER = 1000;

  function log(level, msg) {
    const entry = {
      level,
      msg,
      ts: new Date().toISOString(),
      id: buffer.length === 0 ? 1 : buffer[buffer.length - 1].id + 1,
    };
    buffer.push(entry);
    while (buffer.length > MAX_BUFFER) buffer.shift();
    if (winstonLogger[level]) winstonLogger[level](msg);
    else winstonLogger.info(msg);
  }

  function getEntriesSince(sinceId) {
    if (!sinceId) return buffer.slice();
    return buffer.filter((e) => e.id > sinceId);
  }

  function size() {
    return buffer.length;
  }

  function clear() {
    buffer.length = 0;
  }

  return { log, getEntriesSince, size, clear, logFile };
}

module.exports = { createAppLogger };
