const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createGithubClient } = require('../lib/github');

function makeRunner(responses) {
  const calls = [];
  const runner = (args) => {
    calls.push(args);
    const key = args.join(' ');
    for (const r of responses) {
      if (typeof r.match === 'function' ? r.match(args) : key.includes(r.match)) {
        if (r.throws) {
          const err = new Error(r.throws.message || 'gh error');
          err.stderr = r.throws.stderr || '';
          throw err;
        }
        return r.value;
      }
    }
    throw new Error(`Unexpected gh call: ${key}`);
  };
  runner.calls = calls;
  return runner;
}

test('ensureAuth succeeds when gh auth status passes', () => {
  const runner = makeRunner([{ match: 'auth status', value: 'Logged in' }]);
  const gh = createGithubClient({ runner });
  assert.equal(gh.ensureAuth(), true);
});

test('ensureAuth throws helpful error when gh auth status fails', () => {
  const runner = makeRunner([{ match: 'auth status', throws: { message: 'no token', stderr: 'You are not logged in' } }]);
  const gh = createGithubClient({ runner });
  assert.throws(() => gh.ensureAuth(), /gh CLI not authenticated/);
});

test('getUser returns the login', () => {
  const runner = makeRunner([{ match: 'api user --jq .login', value: 'octocat' }]);
  const gh = createGithubClient({ runner });
  assert.equal(gh.getUser(), 'octocat');
});

test('listRepos excludes archived and sorts alphabetically', () => {
  const data = JSON.stringify([
    { nameWithOwner: 'me/zeta', isArchived: false, defaultBranchRef: { name: 'main' } },
    { nameWithOwner: 'me/alpha', isArchived: false, defaultBranchRef: { name: 'master' } },
    { nameWithOwner: 'me/archived', isArchived: true, defaultBranchRef: { name: 'main' } },
    { nameWithOwner: 'me/nobranch', isArchived: false, defaultBranchRef: null },
  ]);
  const runner = makeRunner([{ match: 'repo list', value: data }]);
  const gh = createGithubClient({ runner });
  const repos = gh.listRepos('me');
  assert.equal(repos.length, 3);
  assert.deepEqual(repos.map((r) => r.nameWithOwner), ['me/alpha', 'me/nobranch', 'me/zeta']);
  assert.equal(repos[1].defaultBranch, 'main', 'falls back to main when no defaultBranchRef');
  assert.equal(repos[0].defaultBranch, 'master');
});

test('getFileContent decodes base64 content', () => {
  const json = JSON.stringify({
    content: Buffer.from('hello world').toString('base64'),
    sha: 'abc123',
  });
  const runner = makeRunner([{ match: 'api repos/me/repo/contents/CLAUDE.md', value: json }]);
  const gh = createGithubClient({ runner });
  const result = gh.getFileContent('me/repo', 'CLAUDE.md');
  assert.equal(result.exists, true);
  assert.equal(result.content, 'hello world');
  assert.equal(result.sha, 'abc123');
});

test('getFileContent returns exists:false on 404', () => {
  const runner = makeRunner([
    { match: 'api repos/me/repo/contents/CLAUDE.md', throws: { stderr: 'gh: HTTP 404: Not Found' } },
  ]);
  const gh = createGithubClient({ runner });
  const result = gh.getFileContent('me/repo', 'CLAUDE.md');
  assert.equal(result.exists, false);
  assert.equal(result.content, null);
  assert.equal(result.sha, null);
});

test('getFileContent throws on non-404 errors (e.g. rate limit)', () => {
  const runner = makeRunner([
    { match: 'api repos/me/repo/contents/CLAUDE.md', throws: { stderr: 'gh: HTTP 403: rate limit exceeded' } },
  ]);
  const gh = createGithubClient({ runner });
  assert.throws(() => gh.getFileContent('me/repo', 'CLAUDE.md'), /rate limit/);
});

test('putFileContent writes a temp file and calls gh api PUT', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-md-put-'));
  let capturedInputPath = null;
  let capturedBody = null;
  const runner = (args) => {
    if (args[0] === 'api' && args.includes('--method') && args.includes('PUT')) {
      const inputIdx = args.indexOf('--input');
      capturedInputPath = args[inputIdx + 1];
      capturedBody = JSON.parse(fs.readFileSync(capturedInputPath, 'utf8'));
      return '';
    }
    throw new Error('Unexpected call: ' + args.join(' '));
  };
  const gh = createGithubClient({ runner, tmpDir: dir });
  gh.putFileContent('me/repo', 'CLAUDE.md', {
    content: 'new content',
    message: 'commit msg',
    branch: 'main',
    sha: 'oldsha',
  });
  assert.equal(capturedBody.message, 'commit msg');
  assert.equal(capturedBody.branch, 'main');
  assert.equal(capturedBody.sha, 'oldsha');
  assert.equal(Buffer.from(capturedBody.content, 'base64').toString(), 'new content');
  assert.equal(fs.existsSync(capturedInputPath), false, 'temp file cleaned up');
});

test('putFileContent cleans up temp file even on error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-md-put-err-'));
  let capturedInputPath = null;
  const runner = (args) => {
    const inputIdx = args.indexOf('--input');
    if (inputIdx >= 0) capturedInputPath = args[inputIdx + 1];
    throw new Error('push failed');
  };
  const gh = createGithubClient({ runner, tmpDir: dir });
  assert.throws(() => gh.putFileContent('me/repo', 'CLAUDE.md', {
    content: 'x', message: 'm', branch: 'main',
  }));
  if (capturedInputPath) {
    assert.equal(fs.existsSync(capturedInputPath), false, 'temp file should be cleaned up');
  }
});

test('putFileContent omits sha when creating a new file', () => {
  let capturedBody = null;
  const runner = (args) => {
    if (args.includes('--input')) {
      const inputIdx = args.indexOf('--input');
      capturedBody = JSON.parse(fs.readFileSync(args[inputIdx + 1], 'utf8'));
      return '';
    }
    throw new Error('unexpected');
  };
  const gh = createGithubClient({ runner });
  gh.putFileContent('me/repo', 'CLAUDE.md', {
    content: 'x', message: 'm', branch: 'main',
  });
  assert.equal('sha' in capturedBody, false);
});
