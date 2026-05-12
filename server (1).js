const express = require('express');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createPatch } = require('diff');
const winston = require('winston');

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = 3333;
const DATA_DIR = path.join(process.env.HOME, 'claude-md-updater');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const CANONICAL_PATH = path.join(DATA_DIR, 'canonical.md');
const RUN_TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const LOG_FILE = path.join(LOGS_DIR, `run-${RUN_TIMESTAMP}.log`);

// ─── Setup dirs ──────────────────────────────────────────────────────────────
fs.mkdirSync(LOGS_DIR, { recursive: true });

// ─── Logger ──────────────────────────────────────────────────────────────────
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) =>
      `[${timestamp}] [${level.toUpperCase()}] ${message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: LOG_FILE }),
  ],
});

// In-memory log buffer for frontend polling
const logBuffer = [];
function log(level, msg) {
  const entry = { level, msg, ts: new Date().toISOString() };
  logBuffer.push(entry);
  if (logBuffer.length > 500) logBuffer.shift();
  logger[level](msg);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function ghExec(cmd) {
  return execSync(cmd, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trim();
}

function getGhUser() {
  return ghExec('gh api user --jq ".login"');
}

function listRepos(user) {
  const json = ghExec(
    `gh repo list ${user} --limit 200 --json nameWithOwner,isArchived,defaultBranchRef`
  );
  return JSON.parse(json)
    .filter((r) => !r.isArchived)
    .map((r) => ({
      nameWithOwner: r.nameWithOwner,
      defaultBranch: r.defaultBranchRef?.name || 'main',
    }));
}

function fetchRemoteClaudeMd(repo) {
  try {
    // gh api returns base64-encoded content
    const json = ghExec(
      `gh api repos/${repo}/contents/CLAUDE.md 2>/dev/null`
    );
    const parsed = JSON.parse(json);
    return Buffer.from(parsed.content, 'base64').toString('utf8');
  } catch {
    return null; // file doesn't exist
  }
}

function pushCanonical(repo, branch, canonical) {
  // Use gh api to create or update the file
  try {
    // Get current SHA if file exists (needed for update)
    let sha = null;
    try {
      const existing = ghExec(`gh api repos/${repo}/contents/CLAUDE.md`);
      sha = JSON.parse(existing).sha;
    } catch {
      // file doesn't exist — create it
    }

    const content = Buffer.from(canonical).toString('base64');
    const message = 'chore: sync CLAUDE.md to canonical [automated]';

    const bodyObj = { message, content, branch };
    if (sha) bodyObj.sha = sha;
    const body = JSON.stringify(bodyObj);

    // Write body to temp file to avoid shell escaping issues
    const tmpFile = path.join(DATA_DIR, '_tmp_body.json');
    fs.writeFileSync(tmpFile, body);

    ghExec(`gh api repos/${repo}/contents/CLAUDE.md --method PUT --input "${tmpFile}"`);
    fs.unlinkSync(tmpFile);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Express app ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// GET /api/canonical — load saved canonical
app.get('/api/canonical', (req, res) => {
  if (fs.existsSync(CANONICAL_PATH)) {
    res.json({ content: fs.readFileSync(CANONICAL_PATH, 'utf8') });
  } else {
    res.json({ content: '' });
  }
});

// POST /api/canonical — save canonical
app.post('/api/canonical', (req, res) => {
  const { content } = req.body;
  fs.writeFileSync(CANONICAL_PATH, content, 'utf8');
  log('info', 'Canonical saved to disk');
  res.json({ ok: true });
});

// GET /api/scan — diff all repos against canonical
app.get('/api/scan', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  (async () => {
    try {
      if (!fs.existsSync(CANONICAL_PATH)) {
        send({ type: 'error', msg: 'No canonical saved. Enter content and click Save first.' });
        res.end();
        return;
      }

      const canonical = fs.readFileSync(CANONICAL_PATH, 'utf8');
      const user = getGhUser();
      log('info', `Scan started. GitHub user: ${user}`);
      send({ type: 'start', user });

      const repos = listRepos(user);
      log('info', `Found ${repos.length} active repos`);
      send({ type: 'count', total: repos.length });

      const results = [];

      for (const repo of repos) {
        const { nameWithOwner, defaultBranch } = repo;
        const current = fetchRemoteClaudeMd(nameWithOwner);

        let status;
        let patch = null;

        if (current === null) {
          status = 'MISSING';
          patch = createPatch('CLAUDE.md', '', canonical, 'no file', 'canonical');
          log('warn', `[${nameWithOwner}] MISSING`);
        } else if (current.trim() === canonical.trim()) {
          status = 'IN_SYNC';
          log('info', `[${nameWithOwner}] IN SYNC`);
        } else {
          status = 'DIFFERENT';
          patch = createPatch('CLAUDE.md', current, canonical, 'current', 'canonical');
          log('warn', `[${nameWithOwner}] DIFFERENT`);
        }

        const result = { repo: nameWithOwner, defaultBranch, status, patch };
        results.push(result);
        send({ type: 'repo', ...result });
      }

      send({ type: 'done', results });
      log('info', 'Scan complete');
    } catch (err) {
      log('error', `Scan failed: ${err.message}`);
      send({ type: 'error', msg: err.message });
    }
    res.end();
  })();
});

// POST /api/update — push canonical to one or all repos
app.post('/api/update', (req, res) => {
  const { repos } = req.body; // array of { repo, defaultBranch }

  if (!fs.existsSync(CANONICAL_PATH)) {
    return res.json({ ok: false, error: 'No canonical saved.' });
  }

  const canonical = fs.readFileSync(CANONICAL_PATH, 'utf8');
  const results = [];

  log('info', `Update started for ${repos.length} repo(s)`);

  for (const { repo, defaultBranch } of repos) {
    log('info', `[${repo}] Pushing to ${defaultBranch}...`);
    const result = pushCanonical(repo, defaultBranch, canonical);
    results.push({ repo, ...result });
    if (result.ok) {
      log('info', `[${repo}] SUCCESS`);
    } else {
      log('error', `[${repo}] FAILED: ${result.error}`);
    }
  }

  res.json({ ok: true, results });
});

// GET /api/log — frontend polls this for live log
app.get('/api/log', (req, res) => {
  const since = parseInt(req.query.since || '0', 10);
  res.json({ entries: logBuffer.slice(since), total: logBuffer.length });
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  log('info', `claude-md-updater running at http://localhost:${PORT}`);
  log('info', `Canonical path: ${CANONICAL_PATH}`);
  log('info', `Log file: ${LOG_FILE}`);
});
