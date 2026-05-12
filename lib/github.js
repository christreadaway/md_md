const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const GH_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 16 * 1024 * 1024;

function defaultRunner(args, opts = {}) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    timeout: opts.timeout ?? GH_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function createGithubClient({ runner = defaultRunner, tmpDir = os.tmpdir() } = {}) {
  function ensureAuth() {
    try {
      runner(['auth', 'status']);
      return true;
    } catch (err) {
      const detail = err.stderr?.toString?.() || err.message;
      throw new Error(`gh CLI not authenticated. Run \`gh auth login\`. Detail: ${detail}`);
    }
  }

  function getUser() {
    return runner(['api', 'user', '--jq', '.login']);
  }

  function listRepos(user, { limit = 500 } = {}) {
    const out = runner([
      'repo', 'list', user,
      '--limit', String(limit),
      '--json', 'nameWithOwner,isArchived,defaultBranchRef',
    ]);
    const parsed = JSON.parse(out);
    return parsed
      .filter((r) => !r.isArchived)
      .map((r) => ({
        nameWithOwner: r.nameWithOwner,
        defaultBranch: r.defaultBranchRef?.name || 'main',
      }))
      .sort((a, b) => a.nameWithOwner.localeCompare(b.nameWithOwner));
  }

  function getFileContent(repo, filePath) {
    try {
      const json = runner(['api', `repos/${repo}/contents/${filePath}`]);
      const parsed = JSON.parse(json);
      return {
        exists: true,
        content: Buffer.from(parsed.content, 'base64').toString('utf8'),
        sha: parsed.sha,
      };
    } catch (err) {
      const stderr = err.stderr?.toString?.() || err.message || '';
      if (/HTTP 404/i.test(stderr) || /Not Found/i.test(stderr)) {
        return { exists: false, content: null, sha: null };
      }
      throw new Error(`gh api failed for ${repo}/${filePath}: ${stderr.split('\n')[0]}`);
    }
  }

  function putFileContent(repo, filePath, { content, message, branch, sha }) {
    const body = { message, content: Buffer.from(content).toString('base64'), branch };
    if (sha) body.sha = sha;

    const unique = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const tmpFile = path.join(tmpDir, `claude-md-body-${unique}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(body));

    try {
      runner(['api', `repos/${repo}/contents/${filePath}`, '--method', 'PUT', '--input', tmpFile]);
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  }

  return { ensureAuth, getUser, listRepos, getFileContent, putFileContent };
}

module.exports = { createGithubClient, defaultRunner };
