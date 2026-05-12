const express = require('express');
const path = require('path');
const { scanRepos, pushMany } = require('./scanner');

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
    if (!Array.isArray(repos) || repos.length === 0) {
      return res.status(400).json({ ok: false, error: 'repos must be a non-empty array' });
    }
    if (!storage.hasCanonical()) {
      return res.status(400).json({ ok: false, error: 'No canonical saved.' });
    }

    const canonical = storage.readCanonical();
    logger.log('info', `Update started for ${repos.length} repo(s)`);

    const results = pushMany({
      github,
      canonical,
      targets: repos.map((r) => ({ repo: r.repo, defaultBranch: r.defaultBranch || 'main' })),
      logger,
    });

    res.json({ ok: true, results });
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
