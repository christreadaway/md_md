const express = require('express');
const path = require('path');
const { scanRepos, pushMany, distributeMany, buildDistributeCommitMessage } = require('./scanner');

const FILENAME_PATTERN = /^[A-Za-z0-9._\-/]+\.md$/;

function validateFilename(name) {
  if (typeof name !== 'string') return 'filename must be a string';
  const trimmed = name.trim();
  if (!trimmed) return 'filename is empty';
  if (trimmed.startsWith('/') || trimmed.includes('..')) return 'filename must be a relative path without ".."';
  if (!FILENAME_PATTERN.test(trimmed)) return 'filename must end with .md and contain only letters, digits, ., _, -, /';
  return null;
}

function normalizeRepoTargets(repos) {
  if (!Array.isArray(repos) || repos.length === 0) {
    return { error: 'repos must be a non-empty array' };
  }
  const targets = [];
  for (let i = 0; i < repos.length; i++) {
    const r = repos[i];
    if (!r || typeof r !== 'object') {
      return { error: `repos[${i}] must be an object` };
    }
    if (typeof r.repo !== 'string' || !r.repo.trim()) {
      return { error: `repos[${i}].repo must be a non-empty string` };
    }
    if (!/^[A-Za-z0-9._\-]+\/[A-Za-z0-9._\-]+$/.test(r.repo.trim())) {
      return { error: `repos[${i}].repo "${r.repo}" must be in owner/name form` };
    }
    targets.push({
      repo: r.repo.trim(),
      defaultBranch: (typeof r.defaultBranch === 'string' && r.defaultBranch.trim()) ? r.defaultBranch.trim() : 'main',
    });
  }
  return { targets };
}

function createApp({ storage, logger, github, publicDir, scanConcurrency = 5 }) {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(express.static(publicDir));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, hasCanonical: storage.hasCanonical() });
  });

  app.get('/api/canonical', (_req, res) => {
    res.json({ content: storage.readCanonical() });
  });

  app.post('/api/canonical', (req, res) => {
    const { content } = req.body || {};
    if (typeof content !== 'string') {
      return res.status(400).json({ ok: false, error: 'content must be a string' });
    }
    if (!content.trim()) {
      return res.status(400).json({ ok: false, error: 'canonical content is empty' });
    }
    storage.writeCanonical(content);
    logger.log('info', 'Canonical saved to disk');
    res.json({ ok: true, bytes: Buffer.byteLength(content, 'utf8') });
  });

  app.get('/api/scan', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    let closed = false;
    req.on('close', () => { closed = true; });
    const send = (data) => {
      if (closed) return;
      try {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch (err) {
        closed = true;
        logger.log('warn', `SSE write failed: ${err.message}`);
      }
    };

    (async () => {
      try {
        if (!storage.hasCanonical()) {
          send({ type: 'error', msg: 'No canonical saved. Enter content and click Save first.' });
          return res.end();
        }
        const canonical = storage.readCanonical();
        github.ensureAuth();
        const user = github.getUser();
        logger.log('info', `Scan started. GitHub user: ${user}`);
        send({ type: 'start', user });

        const repos = github.listRepos(user);
        logger.log('info', `Found ${repos.length} active repos`);
        send({ type: 'count', total: repos.length });

        const results = await scanRepos({
          github,
          canonical,
          repos,
          concurrency: scanConcurrency,
          logger,
          onRepo: (r) => send({ type: 'repo', ...r }),
        });

        send({ type: 'done', results });
        logger.log('info', 'Scan complete');
      } catch (err) {
        logger.log('error', `Scan failed: ${err.message}`);
        send({ type: 'error', msg: err.message });
      } finally {
        try { res.end(); } catch {}
      }
    })();
  });

  app.post('/api/update', (req, res) => {
    const { repos } = req.body || {};
    const normalized = normalizeRepoTargets(repos);
    if (normalized.error) {
      return res.status(400).json({ ok: false, error: normalized.error });
    }
    if (!storage.hasCanonical()) {
      return res.status(400).json({ ok: false, error: 'No canonical saved.' });
    }

    const canonical = storage.readCanonical();
    logger.log('info', `Update started for ${normalized.targets.length} repo(s)`);

    const results = pushMany({
      github,
      canonical,
      targets: normalized.targets,
      logger,
    });

    res.json({ ok: true, results });
  });

  app.get('/api/repos', (_req, res) => {
    try {
      github.ensureAuth();
      const user = github.getUser();
      const repos = github.listRepos(user);
      logger.log('info', `Listed ${repos.length} repos for ${user}`);
      res.json({ ok: true, user, repos });
    } catch (err) {
      logger.log('error', `List repos failed: ${err.message}`);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/distribute', (req, res) => {
    const { filename, content, commitMessage, overwrite, repos } = req.body || {};

    const filenameErr = validateFilename(filename);
    if (filenameErr) {
      return res.status(400).json({ ok: false, error: filenameErr });
    }
    if (typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ ok: false, error: 'content must be a non-empty string' });
    }
    const normalized = normalizeRepoTargets(repos);
    if (normalized.error) {
      return res.status(400).json({ ok: false, error: normalized.error });
    }

    const cleanFilename = filename.trim();
    const cleanMessage = (typeof commitMessage === 'string' && commitMessage.trim())
      ? commitMessage.trim()
      : buildDistributeCommitMessage(cleanFilename);

    logger.log(
      'info',
      `Distribute ${cleanFilename} to ${normalized.targets.length} repo(s) (overwrite=${overwrite ? 'on' : 'off'})`
    );

    const results = distributeMany({
      github,
      filename: cleanFilename,
      content,
      commitMessage: cleanMessage,
      overwrite: !!overwrite,
      targets: normalized.targets,
      logger,
    });

    res.json({ ok: true, filename: cleanFilename, commitMessage: cleanMessage, results });
  });

  app.get('/api/log', (req, res) => {
    const since = parseInt(req.query.since || '0', 10) || 0;
    const entries = logger.getEntriesSince(since);
    const lastId = entries.length ? entries[entries.length - 1].id : since;
    res.json({ entries, lastId, total: logger.size() });
  });

  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    logger.log(status >= 500 ? 'error' : 'warn', `Express error (${status}): ${err.message}`);
    res.status(status).json({ ok: false, error: err.message });
  });

  return app;
}

module.exports = { createApp };
