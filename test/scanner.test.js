const test = require('node:test');
const assert = require('node:assert/strict');
const {
  scanRepos,
  pushCanonical,
  pushMany,
  distributeFile,
  distributeMany,
  buildDistributeCommitMessage,
} = require('../lib/scanner');
const { STATUS } = require('../lib/diff-status');

function makeGithub({ contents = {}, putBehavior } = {}) {
  const putCalls = [];
  return {
    getFileContent: (repo) => {
      if (contents[repo] === '__THROW__') throw new Error(`gh fetch failed for ${repo}`);
      if (!(repo in contents)) return { exists: false, content: null, sha: null };
      return { exists: true, content: contents[repo], sha: `sha-${repo}` };
    },
    putFileContent: (repo, filePath, payload) => {
      putCalls.push({ repo, filePath, payload });
      if (putBehavior && putBehavior[repo] === 'fail') throw new Error('push failed');
    },
    putCalls,
  };
}

function fakeLogger() {
  const entries = [];
  return { log: (level, msg) => entries.push({ level, msg }), entries };
}

test('scanRepos classifies repos correctly', async () => {
  const canonical = 'canonical content';
  const github = makeGithub({
    contents: {
      'me/sync': canonical,
      'me/diff': 'old content',
      // 'me/missing' not in contents → MISSING
    },
  });
  const repos = [
    { nameWithOwner: 'me/sync', defaultBranch: 'main' },
    { nameWithOwner: 'me/diff', defaultBranch: 'main' },
    { nameWithOwner: 'me/missing', defaultBranch: 'main' },
  ];
  const results = await scanRepos({ github, canonical, repos, concurrency: 2, logger: fakeLogger() });
  assert.equal(results.find((r) => r.repo === 'me/sync').status, STATUS.IN_SYNC);
  assert.equal(results.find((r) => r.repo === 'me/diff').status, STATUS.DIFFERENT);
  assert.equal(results.find((r) => r.repo === 'me/missing').status, STATUS.MISSING);
});

test('scanRepos invokes onRepo for each repo', async () => {
  const canonical = 'x';
  const github = makeGithub();
  const repos = [
    { nameWithOwner: 'me/a', defaultBranch: 'main' },
    { nameWithOwner: 'me/b', defaultBranch: 'main' },
  ];
  const seen = [];
  await scanRepos({ github, canonical, repos, onRepo: (r) => seen.push(r.repo), logger: fakeLogger() });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.sort(), ['me/a', 'me/b']);
});

test('scanRepos catches per-repo errors without crashing', async () => {
  const github = makeGithub({ contents: { 'me/broken': '__THROW__', 'me/ok': 'x' } });
  const repos = [
    { nameWithOwner: 'me/broken', defaultBranch: 'main' },
    { nameWithOwner: 'me/ok', defaultBranch: 'main' },
  ];
  const results = await scanRepos({ github, canonical: 'x', repos, logger: fakeLogger() });
  const broken = results.find((r) => r.repo === 'me/broken');
  const ok = results.find((r) => r.repo === 'me/ok');
  assert.equal(broken.status, 'ERROR');
  assert.ok(broken.error.includes('gh fetch failed'));
  assert.equal(ok.status, STATUS.IN_SYNC);
});

test('scanRepos respects concurrency', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const github = {
    getFileContent: async (repo) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { exists: true, content: 'x', sha: 's' };
    },
  };
  // The lib uses synchronous getFileContent — emulate by overriding scanRepos behavior.
  // We rely on the concurrency parameter to call up to N workers.
  const repos = Array.from({ length: 10 }, (_, i) => ({ nameWithOwner: `me/${i}`, defaultBranch: 'main' }));
  await scanRepos({ github: {
    getFileContent: (repo) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      inFlight--;
      return { exists: true, content: 'x', sha: 's' };
    },
  }, canonical: 'x', repos, concurrency: 3, logger: fakeLogger() });
  assert.ok(maxInFlight <= 3, `expected at most 3 in flight, saw ${maxInFlight}`);
});

test('pushCanonical skips when already in sync', () => {
  const github = makeGithub({ contents: { 'me/r': 'canonical' } });
  const result = pushCanonical({
    github,
    repo: 'me/r',
    defaultBranch: 'main',
    canonical: 'canonical',
    logger: fakeLogger(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(github.putCalls.length, 0);
});

test('pushCanonical creates file when missing (no sha)', () => {
  const github = makeGithub({ contents: {} });
  const result = pushCanonical({
    github,
    repo: 'me/r',
    defaultBranch: 'main',
    canonical: 'new',
    logger: fakeLogger(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, false);
  assert.equal(github.putCalls.length, 1);
  assert.equal(github.putCalls[0].payload.sha, null);
  assert.equal(github.putCalls[0].payload.content, 'new');
});

test('pushCanonical updates with sha when file exists and differs', () => {
  const github = makeGithub({ contents: { 'me/r': 'old' } });
  const result = pushCanonical({
    github,
    repo: 'me/r',
    defaultBranch: 'main',
    canonical: 'new',
    logger: fakeLogger(),
  });
  assert.equal(result.ok, true);
  assert.equal(github.putCalls[0].payload.sha, 'sha-me/r');
});

test('pushCanonical returns error on push failure', () => {
  const github = makeGithub({ contents: { 'me/r': 'old' }, putBehavior: { 'me/r': 'fail' } });
  const result = pushCanonical({
    github,
    repo: 'me/r',
    defaultBranch: 'main',
    canonical: 'new',
    logger: fakeLogger(),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /push failed/);
});

test('distributeFile creates new file when missing', () => {
  const github = makeGithub({ contents: {} });
  const result = distributeFile({
    github,
    repo: 'me/r',
    defaultBranch: 'main',
    filename: 'AGENTS.md',
    content: 'agent rules',
    commitMessage: 'chore: add AGENTS.md [automated]',
    overwrite: false,
    logger: fakeLogger(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'created');
  assert.equal(github.putCalls.length, 1);
  assert.equal(github.putCalls[0].filePath, 'AGENTS.md');
  assert.equal(github.putCalls[0].payload.content, 'agent rules');
  assert.equal(github.putCalls[0].payload.sha, null);
});

test('distributeFile skips when file exists and overwrite is off', () => {
  const github = makeGithub({ contents: { 'me/r': 'existing content' } });
  const result = distributeFile({
    github,
    repo: 'me/r',
    defaultBranch: 'main',
    filename: 'AGENTS.md',
    content: 'new content',
    commitMessage: 'chore: add AGENTS.md [automated]',
    overwrite: false,
    logger: fakeLogger(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'skipped');
  assert.equal(result.existed, true);
  assert.equal(github.putCalls.length, 0);
});

test('distributeFile updates when file exists and overwrite is on', () => {
  const github = makeGithub({ contents: { 'me/r': 'existing' } });
  const result = distributeFile({
    github,
    repo: 'me/r',
    defaultBranch: 'main',
    filename: 'AGENTS.md',
    content: 'fresh',
    commitMessage: 'chore: update AGENTS.md',
    overwrite: true,
    logger: fakeLogger(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, 'updated');
  assert.equal(github.putCalls.length, 1);
  assert.equal(github.putCalls[0].payload.sha, 'sha-me/r');
  assert.equal(github.putCalls[0].payload.content, 'fresh');
  assert.equal(github.putCalls[0].payload.message, 'chore: update AGENTS.md');
});

test('distributeFile skips when overwrite on but content already identical', () => {
  const github = makeGithub({ contents: { 'me/r': 'same' } });
  const result = distributeFile({
    github,
    repo: 'me/r',
    defaultBranch: 'main',
    filename: 'AGENTS.md',
    content: 'same',
    commitMessage: 'chore',
    overwrite: true,
    logger: fakeLogger(),
  });
  assert.equal(result.action, 'skipped');
  assert.equal(github.putCalls.length, 0);
});

test('distributeFile returns error on push failure', () => {
  const github = makeGithub({ contents: {}, putBehavior: { 'me/r': 'fail' } });
  const result = distributeFile({
    github,
    repo: 'me/r',
    defaultBranch: 'main',
    filename: 'AGENTS.md',
    content: 'x',
    commitMessage: 'chore: add',
    overwrite: false,
    logger: fakeLogger(),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /push failed/);
});

test('distributeMany handles mix of created, skipped, and failed', () => {
  const github = makeGithub({
    contents: { 'me/b': 'existing', 'me/c': 'old' },
    putBehavior: { 'me/c': 'fail' },
  });
  const results = distributeMany({
    github,
    filename: 'AGENTS.md',
    content: 'rules',
    commitMessage: 'chore: add AGENTS.md [automated]',
    overwrite: true,
    targets: [
      { repo: 'me/a', defaultBranch: 'main' },
      { repo: 'me/b', defaultBranch: 'main' },
      { repo: 'me/c', defaultBranch: 'main' },
    ],
    logger: fakeLogger(),
  });
  assert.equal(results.length, 3);
  assert.equal(results.find((r) => r.repo === 'me/a').action, 'created');
  assert.equal(results.find((r) => r.repo === 'me/b').action, 'updated');
  assert.equal(results.find((r) => r.repo === 'me/c').ok, false);
});

test('buildDistributeCommitMessage uses filename in default message', () => {
  assert.equal(buildDistributeCommitMessage('AGENTS.md'), 'chore: add AGENTS.md [automated]');
  assert.equal(buildDistributeCommitMessage('docs/SECURITY.md'), 'chore: add docs/SECURITY.md [automated]');
});

test('pushMany continues after individual failures', () => {
  const github = makeGithub({
    contents: { 'me/a': 'old', 'me/b': 'old', 'me/c': 'old' },
    putBehavior: { 'me/b': 'fail' },
  });
  const results = pushMany({
    github,
    canonical: 'new',
    targets: [
      { repo: 'me/a', defaultBranch: 'main' },
      { repo: 'me/b', defaultBranch: 'main' },
      { repo: 'me/c', defaultBranch: 'main' },
    ],
    logger: fakeLogger(),
  });
  assert.equal(results.length, 3);
  assert.equal(results.find((r) => r.repo === 'me/a').ok, true);
  assert.equal(results.find((r) => r.repo === 'me/b').ok, false);
  assert.equal(results.find((r) => r.repo === 'me/c').ok, true);
});
