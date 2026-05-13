const { STATUS, computeStatus, buildPatch } = require('./diff-status');

const COMMIT_MESSAGE = 'chore: sync CLAUDE.md to canonical [automated]';

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const inFlight = [];

  async function next() {
    const index = cursor++;
    if (index >= items.length) return;
    results[index] = await worker(items[index], index);
    return next();
  }

  for (let i = 0; i < Math.min(limit, items.length); i++) {
    inFlight.push(next());
  }
  await Promise.all(inFlight);
  return results;
}

function scanRepos({ github, canonical, repos, concurrency = 5, onRepo = () => {}, logger }) {
  return runWithConcurrency(repos, concurrency, async (repo) => {
    const { nameWithOwner, defaultBranch } = repo;
    try {
      const fileInfo = github.getFileContent(nameWithOwner, 'CLAUDE.md');
      const status = computeStatus(fileInfo.exists ? fileInfo.content : null, canonical);
      const patch = buildPatch(fileInfo.exists ? fileInfo.content : null, canonical, status);
      const result = { repo: nameWithOwner, defaultBranch, status, patch };
      logger?.log(
        status === STATUS.IN_SYNC ? 'info' : status === STATUS.MISSING ? 'warn' : 'warn',
        `[${nameWithOwner}] ${status === STATUS.IN_SYNC ? 'IN SYNC' : status}`
      );
      onRepo(result);
      return result;
    } catch (err) {
      const result = {
        repo: nameWithOwner,
        defaultBranch,
        status: 'ERROR',
        patch: null,
        error: err.message,
      };
      logger?.log('error', `[${nameWithOwner}] ERROR: ${err.message}`);
      onRepo(result);
      return result;
    }
  });
}

function pushCanonical({ github, repo, defaultBranch, canonical, skipIfSynced = true, logger }) {
  try {
    const existing = github.getFileContent(repo, 'CLAUDE.md');

    if (skipIfSynced && existing.exists) {
      const status = computeStatus(existing.content, canonical);
      if (status === STATUS.IN_SYNC) {
        logger?.log('info', `[${repo}] Skip — already in sync`);
        return { ok: true, skipped: true };
      }
    }

    github.putFileContent(repo, 'CLAUDE.md', {
      content: canonical,
      message: COMMIT_MESSAGE,
      branch: defaultBranch,
      sha: existing.sha,
    });
    return { ok: true, skipped: false };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function pushMany({ github, canonical, targets, logger }) {
  const results = [];
  for (const { repo, defaultBranch } of targets) {
    logger?.log('info', `[${repo}] Pushing to ${defaultBranch}...`);
    const result = pushCanonical({ github, repo, defaultBranch, canonical, logger });
    results.push({ repo, defaultBranch, ...result });
    if (result.ok) {
      logger?.log('info', `[${repo}] ${result.skipped ? 'SKIPPED (in sync)' : 'SUCCESS'}`);
    } else {
      logger?.log('error', `[${repo}] FAILED: ${result.error}`);
    }
  }
  return results;
}

function distributeFile({ github, repo, defaultBranch, filename, content, commitMessage, overwrite, logger }) {
  try {
    const existing = github.getFileContent(repo, filename);

    if (existing.exists && !overwrite) {
      logger?.log('info', `[${repo}] Skip ${filename} — already exists (overwrite off)`);
      return { ok: true, action: 'skipped', existed: true };
    }

    if (existing.exists && computeStatus(existing.content, content) === STATUS.IN_SYNC) {
      logger?.log('info', `[${repo}] Skip ${filename} — content identical`);
      return { ok: true, action: 'skipped', existed: true };
    }

    github.putFileContent(repo, filename, {
      content,
      message: commitMessage,
      branch: defaultBranch,
      sha: existing.sha,
    });
    return { ok: true, action: existing.exists ? 'updated' : 'created', existed: existing.exists };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function distributeMany({ github, filename, content, commitMessage, overwrite, targets, logger }) {
  const results = [];
  for (const { repo, defaultBranch } of targets) {
    logger?.log('info', `[${repo}] Distributing ${filename} to ${defaultBranch}...`);
    const result = distributeFile({
      github,
      repo,
      defaultBranch,
      filename,
      content,
      commitMessage,
      overwrite,
      logger,
    });
    results.push({ repo, defaultBranch, ...result });
    if (result.ok) {
      logger?.log(
        'info',
        `[${repo}] ${result.action === 'created' ? 'CREATED' : result.action === 'updated' ? 'UPDATED' : 'SKIPPED'} ${filename}`
      );
    } else {
      logger?.log('error', `[${repo}] FAILED ${filename}: ${result.error}`);
    }
  }
  return results;
}

function buildDistributeCommitMessage(filename) {
  return `chore: add ${filename} [automated]`;
}

module.exports = {
  scanRepos,
  pushCanonical,
  pushMany,
  distributeFile,
  distributeMany,
  buildDistributeCommitMessage,
  COMMIT_MESSAGE,
};
