const path = require('path');
const os = require('os');
const { createAppLogger } = require('./lib/logger');
const { createStorage } = require('./lib/storage');
const { createGithubClient } = require('./lib/github');
const { createApp } = require('./lib/app');

const PORT = parseInt(process.env.PORT || '3333', 10);
const DATA_DIR = process.env.CLAUDE_MD_DATA_DIR || path.join(os.homedir(), 'claude-md-updater');
const PUBLIC_DIR = path.join(__dirname, 'public');
const RUN_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const storage = createStorage({ dataDir: DATA_DIR });
storage.ensureDirs();

const logger = createAppLogger({ logsDir: storage.logsDir, runTimestamp: RUN_TIMESTAMP });
const github = createGithubClient();

const app = createApp({ storage, logger, github, publicDir: PUBLIC_DIR });

const server = app.listen(PORT, () => {
  logger.log('info', `claude-md-updater running at http://localhost:${PORT}`);
  logger.log('info', `Canonical path: ${storage.canonicalPath}`);
  logger.log('info', `Log file: ${logger.logFile}`);
});

function shutdown(signal) {
  logger.log('info', `Received ${signal}, shutting down`);
  server.close(() => {
    logger.log('info', 'Server closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  logger.log('error', `uncaughtException: ${err.stack || err.message}`);
});
process.on('unhandledRejection', (reason) => {
  logger.log('error', `unhandledRejection: ${reason}`);
});
