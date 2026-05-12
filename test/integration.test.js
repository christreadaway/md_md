const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createApp } = require('../lib/app');
const { createAppLogger } = require('../lib/logger');
const { createStorage } = require('../lib/storage');

function setup(githubState) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-md-int-'));
  const storage = createStorage({ dataDir });
  storage.ensureDirs();
  const logger = createAppLogger({ logsDir: storage.logsDir, runTimestamp: `int-${Date.now()}` });

  const repos = githubState.repos.slice();
  const fileMap = { ...githubState.files };

  const github = {
    ensureAuth: () => true,
    getUser: () => githubState.user,
    listRepos: () => repos.filter((r) => !r.isArchived).map((r) => ({
      nameWithOwner: r.nameWithOwner, defaultBranch: r.defaultBranch || 'main',
    })),
    getFileContent: (repo) => {
      if (!(repo in fileMap)) return { exists: false, content: null, sha: null };
      return { exists: true, content: fileMap[repo], sha: `sha-${repo}` };
    },
    putFileContent: (repo, _file, payload) => {
      // Simulate writing to the remote
      fileMap[repo] = payload.content;
    },
  };

  const app = createApp({ storage, logger, github, publicDir: dataDir });
  return { storage, logger, github, app, fileMap };
}

function startServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function json(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, json: raw ? JSON.parse(raw) : null });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function sse(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET' }, (res) => {
      const events = [];
      let buf = '';
      res.on('data', (c) => {
        buf += c.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const dataLine = buf.slice(0, idx).split('\n').find((l) => l.startsWith('data: '));
          buf = buf.slice(idx + 2);
          if (dataLine) try { events.push(JSON.parse(dataLine.slice(6))); } catch {}
        }
      });
      res.on('end', () => resolve(events));
    });
    req.on('error', reject);
    req.end();
  });
}

test('full flow: save → scan → update → rescan shows all in sync', async (t) => {
  const ctx = setup({
    user: 'me',
    repos: [
      { nameWithOwner: 'me/repo-a', defaultBranch: 'main' },
      { nameWithOwner: 'me/repo-b', defaultBranch: 'main' },
      { nameWithOwner: 'me/repo-c', defaultBranch: 'main' },
    ],
    files: {
      'me/repo-a': 'canonical text',
      'me/repo-b': 'stale content',
      // me/repo-c missing
    },
  });
  const { server, port } = await startServer(ctx.app);
  t.after(() => server.close());

  // Save canonical
  let r = await json(port, 'POST', '/api/canonical', { content: 'canonical text' });
  assert.equal(r.status, 200);

  // First scan
  const events1 = await sse(port, '/api/scan');
  const repoEvents1 = events1.filter((e) => e.type === 'repo');
  assert.equal(repoEvents1.length, 3);
  const byStatus = (status) => repoEvents1.filter((e) => e.status === status).map((e) => e.repo).sort();
  assert.deepEqual(byStatus('IN_SYNC'), ['me/repo-a']);
  assert.deepEqual(byStatus('DIFFERENT'), ['me/repo-b']);
  assert.deepEqual(byStatus('MISSING'), ['me/repo-c']);

  // Update out-of-sync
  r = await json(port, 'POST', '/api/update', {
    repos: [
      { repo: 'me/repo-b', defaultBranch: 'main' },
      { repo: 'me/repo-c', defaultBranch: 'main' },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.results.length, 2);
  assert.ok(r.json.results.every((x) => x.ok));

  // Rescan — all in sync
  const events2 = await sse(port, '/api/scan');
  const repoEvents2 = events2.filter((e) => e.type === 'repo');
  assert.ok(repoEvents2.every((e) => e.status === 'IN_SYNC'),
    `expected all in sync, got: ${repoEvents2.map((e) => `${e.repo}=${e.status}`).join(', ')}`);

  // Re-running update should now skip all (idempotent)
  r = await json(port, 'POST', '/api/update', {
    repos: [
      { repo: 'me/repo-a', defaultBranch: 'main' },
      { repo: 'me/repo-b', defaultBranch: 'main' },
      { repo: 'me/repo-c', defaultBranch: 'main' },
    ],
  });
  assert.ok(r.json.results.every((x) => x.ok && x.skipped));
});

test('scan handles per-repo errors without failing the whole scan', async (t) => {
  const ctx = setup({
    user: 'me',
    repos: [
      { nameWithOwner: 'me/ok', defaultBranch: 'main' },
      { nameWithOwner: 'me/explode', defaultBranch: 'main' },
    ],
    files: { 'me/ok': 'canonical' },
  });
  // Make 'me/explode' throw
  ctx.github.getFileContent = (repo) => {
    if (repo === 'me/explode') throw new Error('boom');
    return { exists: true, content: 'canonical', sha: 'x' };
  };
  // Rewire app with patched github
  const app2 = createApp({
    storage: ctx.storage, logger: ctx.logger, github: ctx.github,
    publicDir: '/tmp',
  });
  const { server, port } = await startServer(app2);
  t.after(() => server.close());

  await json(port, 'POST', '/api/canonical', { content: 'canonical' });
  const events = await sse(port, '/api/scan');
  const reps = events.filter((e) => e.type === 'repo');
  assert.equal(reps.length, 2);
  const explode = reps.find((e) => e.repo === 'me/explode');
  assert.equal(explode.status, 'ERROR');
  assert.match(explode.error, /boom/);
  const ok = reps.find((e) => e.repo === 'me/ok');
  assert.equal(ok.status, 'IN_SYNC');
  // done event should still fire
  assert.ok(events.some((e) => e.type === 'done'));
});

test('update reports failed repos with errors but succeeds on others', async (t) => {
  const ctx = setup({
    user: 'me',
    repos: [],
    files: { 'me/a': 'old', 'me/b': 'old' },
  });
  ctx.github.putFileContent = (repo) => {
    if (repo === 'me/b') throw new Error('branch protection');
  };
  const app2 = createApp({
    storage: ctx.storage, logger: ctx.logger, github: ctx.github,
    publicDir: '/tmp',
  });
  const { server, port } = await startServer(app2);
  t.after(() => server.close());

  await json(port, 'POST', '/api/canonical', { content: 'new' });
  const r = await json(port, 'POST', '/api/update', {
    repos: [
      { repo: 'me/a', defaultBranch: 'main' },
      { repo: 'me/b', defaultBranch: 'main' },
    ],
  });
  assert.equal(r.status, 200);
  const a = r.json.results.find((x) => x.repo === 'me/a');
  const b = r.json.results.find((x) => x.repo === 'me/b');
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  assert.match(b.error, /branch protection/);
});

test('log endpoint returns proper structure with ids', async (t) => {
  const ctx = setup({ user: 'me', repos: [], files: {} });
  const { server, port } = await startServer(ctx.app);
  t.after(() => server.close());

  ctx.logger.log('info', 'event 1');
  ctx.logger.log('warn', 'event 2');
  const r = await json(port, 'GET', '/api/log?since=0');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.entries));
  assert.ok(r.json.entries.every((e) => typeof e.id === 'number'));
  assert.ok(r.json.entries.every((e) => typeof e.ts === 'string'));
  assert.ok(r.json.entries.every((e) => ['info', 'warn', 'error', 'debug'].includes(e.level)));
  assert.equal(typeof r.json.lastId, 'number');
  assert.equal(typeof r.json.total, 'number');
});
