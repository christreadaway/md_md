const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createApp } = require('../lib/app');
const { createAppLogger } = require('../lib/logger');
const { createStorage } = require('../lib/storage');

function freshSetup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-md-app-'));
  const storage = createStorage({ dataDir });
  storage.ensureDirs();
  const logger = createAppLogger({ logsDir: storage.logsDir, runTimestamp: `t-${Date.now()}` });
  return { dataDir, storage, logger };
}

function makeGithubMock(opts = {}) {
  return {
    ensureAuth: opts.ensureAuth || (() => true),
    getUser: opts.getUser || (() => 'testuser'),
    listRepos: opts.listRepos || (() => []),
    getFileContent: opts.getFileContent || (() => ({ exists: false, content: null, sha: null })),
    putFileContent: opts.putFileContent || (() => {}),
  };
}

function startTestServer(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

function request(port, options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      ...options,
      headers: {
        ...(options.headers || {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, raw, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function sseRequest(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
    }, (res) => {
      const events = [];
      let buf = '';
      res.on('data', (c) => {
        buf += c.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (dataLine) {
            try { events.push(JSON.parse(dataLine.slice(6))); } catch {}
          }
        }
      });
      res.on('end', () => resolve({ status: res.statusCode, events, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET /api/health returns status', async (t) => {
  const { storage, logger } = freshSetup();
  const app = createApp({ storage, logger, github: makeGithubMock(), publicDir: '/tmp' });
  const { server, port } = await startTestServer(app);
  t.after(() => server.close());

  const r = await request(port, { path: '/api/health', method: 'GET' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.hasCanonical, false);
});

test('GET /api/canonical returns empty when no file saved', async (t) => {
  const { storage, logger } = freshSetup();
  const app = createApp({ storage, logger, github: makeGithubMock(), publicDir: '/tmp' });
  const { server, port } = await startTestServer(app);
  t.after(() => server.close());

  const r = await request(port, { path: '/api/canonical', method: 'GET' });
  assert.equal(r.status, 200);
  assert.equal(r.json.content, '');
});

test('POST /api/canonical saves content', async (t) => {
  const { storage, logger } = freshSetup();
  const app = createApp({ storage, logger, github: makeGithubMock(), publicDir: '/tmp' });
  const { server, port } = await startTestServer(app);
  t.after(() => server.close());

  const r = await request(port, { path: '/api/canonical', method: 'POST' }, { content: 'hello' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.bytes, 5);
  assert.equal(storage.readCanonical(), 'hello');
});

test('POST /api/canonical rejects empty content', async (t) => {
  const { storage, logger } = freshSetup();
  const app = createApp({ storage, logger, github: makeGithubMock(), publicDir: '/tmp' });
  const { server, port } = await startTestServer(app);
  t.after(() => server.close());

  const r = await request(port, { path: '/api/canonical', method: 'POST' }, { content: '   ' });
  assert.equal(r.status, 400);
  assert.equal(r.json.ok, false);
});

test('POST /api/canonical rejects non-string content', async (t) => {
  const { storage, logger } = freshSetup();
  const app = createApp({ storage, logger, github: makeGithubMock(), publicDir: '/tmp' });
  const { server, port } = await startTestServer(app);
  t.after(() => server.close());

  const r = await request(port, { path: '/api/canonical', method: 'POST' }, { content: 123 });
  assert.equal(r.status, 400);
});

test('POST /api/update requires canonical saved', async (t) => {
  const { storage, logger } = freshSetup();
  const app = createApp({ storage, logger, github: makeGithubMock(), publicDir: '/tmp' });
  const { server, port } = await startTestServer(app);
  t.after(() => server.close());

  const r = await request(port, { path: '/api/update', method: 'POST' }, {
    repos: [{ repo: 'me/r', defaultBranch: 'main' }],
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.ok, false);
});

test('POST /api/update rejects empty repos array', async (t) => {
  const { storage, logger } = freshSetup();
  storage.writeCanonical('content');
  const app = createApp({ storage, logger, github: makeGithubMock(), publicDir: '/tmp' });
  const { server, port } = await startTestServer(app);
  t.after(() => server.close());

  const r = await request(port, { path: '/api/update', method: 'POST' }, { repos: [] });
  assert.equal(r.status, 400);
});

test('POST /api/update pushes to repos', async (t) => {
  const { storage, logger } = freshSetup();
  storage.writeCanonical('new content');
  const putCalls = [];
  const app = createApp({
    storage,
    logger,
    github: makeGithubMock({
      getFileContent: () => ({ exists: true, content: 'old', sha: 'abc' }),
      putFileContent: (repo, file, payload) => putCalls.push({ repo, file, payload }),
    }),
    publicDir: '/tmp',
  });
  const { server, port } = await startTestServer(app);
  t.after(() => server.close());

  const r = await request(port, { path: '/api/update', method: 'POST' }, {
    repos: [{ repo: 'me/r', defaultBranch: 'main' }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.results[0].ok, true);
  assert.equal(putCalls.length, 1);
  assert.equal(putCalls[0].payload.content, 'new content');
});

test('POST /api/update skips already-synced repos (idempotent)', async (t) => {
  const { storage, logger } = freshSetup();
  storage.writeCanonical('same');
  const putCalls = [];
  const app = createApp({
    storage,
    logger,
    github: makeGithubMock({
      getFileContent: () => ({ exists: true, content: 'same', sha: 'abc' }),
      putFileContent: (repo, file, payload) => putCalls.push({ repo, file, payload }),
    }),
    publicDir: '/tmp',
  });
  const { server, port } = await startTestServer(app);
  t.after(() => server.close());

  const r = await request(port, { path: '/api/update', method: 'POST' }, {
    repos: [{ repo: 'me/r', defaultBranch: 'main' }],
  });
  assert.equal(r.json.results[0].skipped, true);
  assert.equal(putCalls.length, 0);
});

test('GET /api/scan emits SSE events for each repo', async (t) => {
  const { storage, logger } = freshSetup();
  storage.writeCanonical('canon');
  const app = createApp({
    storage,
    logger,
    github: makeGithubMock({
      getUser: () => 'me',
      listRepos: () => [
        { nameWithOwner: 'me/a', defaultBranch: 'main' },
        { nameWithOwner: 'me/b', defaultBranch: 'main' },
      ],
      getFileContent: (repo) => repo === 'me/a'
        ? { exists: true, content: 'canon', sha: 's1' }
        : { exists: true, content: 'different', sha: 's2' },
    }),
    publicDir: '/tmp',
  });
  const { server, port } = await startTestServer(app);
  t.after(() => server.close());

  const r = await sseRequest(port, '/api/scan');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'text/event-stream');
  const types = r.events.map((e) => e.type);
  assert.ok(types.includes('start'));
  assert.ok(types.includes('count'));
  assert.ok(types.includes('done'));
  const repoEvents = r.events.filter((e) => e.type === 'repo');
  assert.equal(repoEvents.length, 2);
  const a = repoEvents.find((e) => e.repo === 'me/a');
  const b = repoEvents.find((e) => e.repo === 'me/b');
  assert.equal(a.status, 'IN_SYNC');
  assert.equal(b.status, 'DIFFERENT');
});

test('GET /api/scan emits error when canonical missing', async (t) => {
  const { storage, logger } = freshSetup();
  const app = createApp({ storage, logger, github: makeGithubMock(), publicDir: '/tmp' });
  const { server, port } = await startTestServer(app);
  t.after(() => server.close());

  const r = await sseRequest(port, '/api/scan');
  const error = r.events.find((e) => e.type === 'error');
  assert.ok(error, 'expected error event');
  assert.match(error.msg, /No canonical/);
});

test('GET /api/scan emits error when gh auth fails', async (t) => {
  const { storage, logger } = freshSetup();
  storage.writeCanonical('canon');
  const app = createApp({
    storage,
    logger,
    github: makeGithubMock({
      ensureAuth: () => { throw new Error('gh CLI not authenticated. Run `gh auth login`.'); },
    }),
    publicDir: '/tmp',
  });
  const { server, port } = await startTestServer(app);
  t.after(() => server.close());

  const r = await sseRequest(port, '/api/scan');
  const error = r.events.find((e) => e.type === 'error');
  assert.ok(error);
  assert.match(error.msg, /not authenticated/);
});

test('GET /api/log returns entries since ID', async (t) => {
  const { storage, logger } = freshSetup();
  logger.log('info', 'first');
  logger.log('warn', 'second');
  const app = createApp({ storage, logger, github: makeGithubMock(), publicDir: '/tmp' });
  const { server, port } = await startTestServer(app);
  t.after(() => server.close());

  const r = await request(port, { path: '/api/log?since=0', method: 'GET' });
  assert.equal(r.status, 200);
  assert.equal(r.json.entries.length, 2);
  assert.equal(r.json.entries[0].msg, 'first');

  const r2 = await request(port, { path: `/api/log?since=${r.json.entries[0].id}`, method: 'GET' });
  assert.equal(r2.json.entries.length, 1);
  assert.equal(r2.json.entries[0].msg, 'second');
});

test('canonical content with special characters round-trips through HTTP', async (t) => {
  const { storage, logger } = freshSetup();
  const app = createApp({ storage, logger, github: makeGithubMock(), publicDir: '/tmp' });
  const { server, port } = await startTestServer(app);
  t.after(() => server.close());

  const special = '# Header\n\n- bullet with "quotes" & <html>\n- emoji: ☕\n- em-dash: —';
  await request(port, { path: '/api/canonical', method: 'POST' }, { content: special });
  const r = await request(port, { path: '/api/canonical', method: 'GET' });
  assert.equal(r.json.content, special);
});

test('app handles malformed JSON body gracefully', async (t) => {
  const { storage, logger } = freshSetup();
  const app = createApp({ storage, logger, github: makeGithubMock(), publicDir: '/tmp' });
  const { server, port } = await startTestServer(app);
  t.after(() => server.close());

  const r = await request(
    port,
    { path: '/api/canonical', method: 'POST', headers: { 'Content-Type': 'application/json' } },
    '{ not valid json'
  );
  assert.equal(r.status, 400, 'malformed JSON should return 400, not 500');
  assert.equal(r.json.ok, false);
});

test('GET /api/repos returns the user repo list', async (t) => {
  const { storage, logger } = freshSetup();
  const app = createApp({
    storage,
    logger,
    github: makeGithubMock({
      getUser: () => 'me',
      listRepos: () => [
        { nameWithOwner: 'me/a', defaultBranch: 'main' },
        { nameWithOwner: 'me/b', defaultBranch: 'master' },
      ],
    }),
    publicDir: '/tmp',
  });
  const { server, port } = await startTestServer(app);
  t.after(() => server.close());

  const r = await request(port, { path: '/api/repos', method: 'GET' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.user, 'me');
  assert.equal(r.json.repos.length, 2);
  assert.equal(r.json.repos[0].nameWithOwner, 'me/a');
});

test('GET /api/repos surfaces gh auth failure', async (t) => {
  const { storage, logger } = freshSetup();
  const app = createApp({
    storage,
    logger,
    github: makeGithubMock({
      ensureAuth: () => { throw new Error('gh CLI not authenticated. Run `gh auth login`.'); },
    }),
    publicDir: '/tmp',
  });
  const { server, port } = await startTestServer(app);
  t.after(() => server.close());

  const r = await request(port, { path: '/api/repos', method: 'GET' });
  assert.equal(r.status, 500);
  assert.equal(r.json.ok, false);
  assert.match(r.json.error, /not authenticated/);
});

test('POST /api/distribute rejects missing filename', async (t) => {
  const { storage, logger } = freshSetup();
  const app = createApp({ storage, logger, github: makeGithubMock(), publicDir: '/tmp' });
  const { server, port } = await startTestServer(app);
  t.after(() => server.close());

  const r = await request(port, { path: '/api/distribute', method: 'POST' }, {
    content: 'x',
    repos: [{ repo: 'me/r', defaultBranch: 'main' }],
  });
  assert.equal(r.status, 400);
  assert.equal(r.json.ok, false);
});

test('POST /api/distribute rejects filename without .md suffix', async (t) => {
  const { storage, logger } = freshSetup();
  const app = createApp({ storage, logger, github: makeGithubMock(), publicDir: '/tmp' });
  const { server, port } = await startTestServer(app);
  t.after(() => server.close());

  const r = await request(port, { path: '/api/distribute', method: 'POST' }, {
    filename: 'AGENTS.txt',
    content: 'x',
    repos: [{ repo: 'me/r', defaultBranch: 'main' }],
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /\.md/);
});

test('POST /api/distribute rejects path traversal in filename', async (t) => {
  const { storage, logger } = freshSetup();
  const app = createApp({ storage, logger, github: makeGithubMock(), publicDir: '/tmp' });
  const { server, port } = await startTestServer(app);
  t.after(() => server.close());

  const r = await request(port, { path: '/api/distribute', method: 'POST' }, {
    filename: '../escape.md',
    content: 'x',
    repos: [{ repo: 'me/r', defaultBranch: 'main' }],
  });
  assert.equal(r.status, 400);
});

test('POST /api/distribute rejects empty repos array', async (t) => {
  const { storage, logger } = freshSetup();
  const app = createApp({ storage, logger, github: makeGithubMock(), publicDir: '/tmp' });
  const { server, port } = await startTestServer(app);
  t.after(() => server.close());

  const r = await request(port, { path: '/api/distribute', method: 'POST' }, {
    filename: 'AGENTS.md',
    content: 'x',
    repos: [],
  });
  assert.equal(r.status, 400);
});

test('POST /api/distribute pushes a new file to repos', async (t) => {
  const { storage, logger } = freshSetup();
  const putCalls = [];
  const app = createApp({
    storage,
    logger,
    github: makeGithubMock({
      getFileContent: () => ({ exists: false, content: null, sha: null }),
      putFileContent: (repo, file, payload) => putCalls.push({ repo, file, payload }),
    }),
    publicDir: '/tmp',
  });
  const { server, port } = await startTestServer(app);
  t.after(() => server.close());

  const r = await request(port, { path: '/api/distribute', method: 'POST' }, {
    filename: 'AGENTS.md',
    content: 'agent rules',
    repos: [
      { repo: 'me/a', defaultBranch: 'main' },
      { repo: 'me/b', defaultBranch: 'main' },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.filename, 'AGENTS.md');
  assert.equal(r.json.commitMessage, 'chore: add AGENTS.md [automated]');
  assert.equal(r.json.results.length, 2);
  assert.ok(r.json.results.every((res) => res.action === 'created'));
  assert.equal(putCalls.length, 2);
  assert.equal(putCalls[0].file, 'AGENTS.md');
});

test('POST /api/distribute skips existing files when overwrite is off', async (t) => {
  const { storage, logger } = freshSetup();
  const putCalls = [];
  const app = createApp({
    storage,
    logger,
    github: makeGithubMock({
      getFileContent: () => ({ exists: true, content: 'existing', sha: 'sha1' }),
      putFileContent: (repo, file, payload) => putCalls.push({ repo, file, payload }),
    }),
    publicDir: '/tmp',
  });
  const { server, port } = await startTestServer(app);
  t.after(() => server.close());

  const r = await request(port, { path: '/api/distribute', method: 'POST' }, {
    filename: 'AGENTS.md',
    content: 'new content',
    repos: [{ repo: 'me/a', defaultBranch: 'main' }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.results[0].action, 'skipped');
  assert.equal(putCalls.length, 0);
});

test('POST /api/distribute overwrites when flag set', async (t) => {
  const { storage, logger } = freshSetup();
  const putCalls = [];
  const app = createApp({
    storage,
    logger,
    github: makeGithubMock({
      getFileContent: () => ({ exists: true, content: 'existing', sha: 'sha1' }),
      putFileContent: (repo, file, payload) => putCalls.push({ repo, file, payload }),
    }),
    publicDir: '/tmp',
  });
  const { server, port } = await startTestServer(app);
  t.after(() => server.close());

  const r = await request(port, { path: '/api/distribute', method: 'POST' }, {
    filename: 'AGENTS.md',
    content: 'replaced',
    overwrite: true,
    repos: [{ repo: 'me/a', defaultBranch: 'main' }],
  });
  assert.equal(r.json.results[0].action, 'updated');
  assert.equal(putCalls.length, 1);
  assert.equal(putCalls[0].payload.sha, 'sha1');
  assert.equal(putCalls[0].payload.content, 'replaced');
});

test('POST /api/distribute uses custom commit message when provided', async (t) => {
  const { storage, logger } = freshSetup();
  const putCalls = [];
  const app = createApp({
    storage,
    logger,
    github: makeGithubMock({
      getFileContent: () => ({ exists: false, content: null, sha: null }),
      putFileContent: (repo, file, payload) => putCalls.push({ repo, file, payload }),
    }),
    publicDir: '/tmp',
  });
  const { server, port } = await startTestServer(app);
  t.after(() => server.close());

  const r = await request(port, { path: '/api/distribute', method: 'POST' }, {
    filename: 'AGENTS.md',
    content: 'x',
    commitMessage: 'docs: introduce agents guide',
    repos: [{ repo: 'me/a', defaultBranch: 'main' }],
  });
  assert.equal(r.json.commitMessage, 'docs: introduce agents guide');
  assert.equal(putCalls[0].payload.message, 'docs: introduce agents guide');
});

test('POST /api/distribute accepts nested .md paths like docs/AGENTS.md', async (t) => {
  const { storage, logger } = freshSetup();
  const putCalls = [];
  const app = createApp({
    storage,
    logger,
    github: makeGithubMock({
      getFileContent: () => ({ exists: false, content: null, sha: null }),
      putFileContent: (repo, file, payload) => putCalls.push({ repo, file, payload }),
    }),
    publicDir: '/tmp',
  });
  const { server, port } = await startTestServer(app);
  t.after(() => server.close());

  const r = await request(port, { path: '/api/distribute', method: 'POST' }, {
    filename: 'docs/AGENTS.md',
    content: 'x',
    repos: [{ repo: 'me/a', defaultBranch: 'main' }],
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.filename, 'docs/AGENTS.md');
  assert.equal(putCalls[0].file, 'docs/AGENTS.md');
});

test('static files are served from publicDir', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-md-pub-'));
  const publicDir = path.join(dataDir, 'public');
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<h1>hi</h1>');
  const storage = createStorage({ dataDir });
  storage.ensureDirs();
  const logger = createAppLogger({ logsDir: storage.logsDir, runTimestamp: 'static' });
  const app = createApp({ storage, logger, github: makeGithubMock(), publicDir });
  const { server, port } = await startTestServer(app);
  t.after(() => server.close());

  const r = await request(port, { path: '/', method: 'GET' });
  assert.equal(r.status, 200);
  assert.match(r.raw, /<h1>hi<\/h1>/);
});
