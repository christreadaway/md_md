# CLAUDE.md Manager

Local web app for managing markdown files across your GitHub repos. Two modes:

1. **Sync Canonical** &mdash; keep a single canonical `CLAUDE.md` in sync everywhere. Paste, scan, diff, push.
2. **Distribute File** &mdash; introduce any new `.md` file (e.g., `AGENTS.md`, `SECURITY.md`, `docs/CONTRIBUTING.md`) to a hand-picked set of repos in one shot.

Runs on `http://localhost:3333`. Single-user. No auth. No PRs &mdash; pushes go straight to the default branch.

## Prerequisites

```bash
# GitHub CLI (must be installed and authenticated)
brew install gh
gh auth login

# Socket safe-npm wrapper for secure installs (recommended)
npm install -g @socketsecurity/safe-npm
```

## Setup

```bash
cd /Users/christreadaway/claude-md-updater   # or wherever you cloned this
sfw npm install
npm audit
```

`.npmrc` pins `min-release-age=7` so npm rejects packages published in the last 7 days &mdash; protects against fresh supply-chain attacks.

## Run

```bash
cd /Users/christreadaway/claude-md-updater
npm start
```

Open http://localhost:3333

For development with auto-reload:

```bash
npm run dev
```

## How to Use

The header has two tabs: **Sync Canonical** and **Distribute File**. Pick the mode that fits the job.

### Sync Canonical (one source of truth for CLAUDE.md)

1. **Paste your canonical CLAUDE.md** into the left editor.
2. Click **Save Canonical** (or press `Cmd+S`) &mdash; persists to `~/claude-md-updater/canonical.md`.
3. Click **Scan Repos** &mdash; fetches all your non-archived GitHub repos and diffs each one.
4. Review results:
   - **In Sync** (green) &mdash; matches canonical, nothing to do.
   - **Different** (yellow) &mdash; click the card to see the diff, then Update.
   - **Missing** (red) &mdash; no CLAUDE.md exists, Update will create it.
   - **Error** &mdash; per-repo fetch or push failed; expand the card to see the message.
5. Use the **filter** to find specific repos.
6. Click **Update All Out-of-Sync** to push canonical to every repo that differs &mdash; or click **Update** on individual repo cards.

All pushes go to the default branch of each repo. No branches, no PRs. Pushes that would be no-ops are skipped automatically.

### Distribute File (introduce a new .md to selected repos)

Use this when you want to seed a brand-new file like `AGENTS.md`, `SECURITY.md`, or `docs/CONTRIBUTING.md` into a chosen set of repos.

1. Switch to the **Distribute File** tab. Your repos auto-load the first time.
2. Enter the **Filename** (must end in `.md`; nested paths like `docs/AGENTS.md` are allowed).
3. Optionally enter a custom **Commit Message**. Default is `chore: add <filename> [automated]`.
4. Paste the **file content** into the textarea.
5. Tick the repos you want to receive the file. Use the **filter** plus **Select All** / **Clear** to manage large lists.
6. By default, **existing files are skipped** &mdash; this mode is meant for *new* files. If you want to replace an existing file, tick **Overwrite if exists**.
7. Click **Push to N Repos**. Each repo card updates with **Created**, **Updated**, **Skipped**, or **Error**.

Same rules as canonical sync apply: pushes go straight to the default branch, no PRs, identical content is a no-op.

## Architecture

```
server.js              # entry point — wires modules together
lib/
  app.js               # Express app + route handlers
  github.js            # gh CLI wrapper (mockable)
  scanner.js           # parallel scan + push with concurrency control
  diff-status.js       # status calculation + patch generation
  logger.js            # winston + in-memory buffer for /api/log
  storage.js           # canonical and logs filesystem layout
public/
  index.html           # single-page UI
  styles.css           # dark-themed design system
  app.js               # vanilla JS frontend
test/                  # node:test suite (run with npm test)
```

Each `lib/` module is independently testable. The `github.js` module accepts an injectable `runner` function so tests can mock the `gh` CLI without spawning processes.

## API

All endpoints are local-only.

| Method | Path             | Purpose                                                      |
| ------ | ---------------- | ------------------------------------------------------------ |
| GET    | `/`              | The single-page UI.                                          |
| GET    | `/api/health`    | Liveness + whether canonical is saved.                       |
| GET    | `/api/canonical` | Returns saved canonical content.                             |
| POST   | `/api/canonical` | Saves canonical (rejects empty / non-string).                |
| GET    | `/api/scan`      | SSE stream of per-repo scan results.                         |
| POST   | `/api/update`    | Pushes canonical to `[{repo, defaultBranch}]`; idempotent.   |
| GET    | `/api/repos`     | Returns the user's non-archived repos for the distribute UI. |
| POST   | `/api/distribute`| Pushes `{filename, content}` to `[{repo, defaultBranch}]`. Skips existing files unless `overwrite: true`. |
| GET    | `/api/log`       | Polled log entries (`?since=<id>` for incremental fetch).    |

## Logs

- **Activity log** appears in the bottom panel in real time, polled every 1s.
- **Per-run log files** saved to `~/claude-md-updater/logs/run-YYYY-MM-DDTHH-mm-ss.log`.
- Logs include every gh call result, every status decision, and every push outcome.
- To debug an issue: open the latest log file in `~/claude-md-updater/logs/` and copy/paste relevant lines back into Claude Code.

## Testing

```bash
cd /Users/christreadaway/claude-md-updater
npm test
```

The test suite uses Node's built-in test runner (no extra deps) and covers:

- Diff/status logic for all combinations (in sync / different / missing / whitespace edge cases)
- Logger buffer behavior (ids, capping, level fallback)
- Storage I/O (canonical round-trip, unicode, empty handling)
- GitHub client with mocked `gh` runner (auth, list, get, put, 404 vs other errors, temp-file cleanup)
- Scanner concurrency + per-repo error isolation
- Express endpoints (validation, auth failure surfacing, SSE event sequence)
- Full integration flow (save &rarr; scan &rarr; update &rarr; rescan &rarr; idempotent re-update)

To run a single test file:

```bash
node --test test/diff-status.test.js
```

## Behavior notes

- **Idempotent** &mdash; scanning an already-in-sync repo never triggers a push. Even if you pass an in-sync repo to `/api/update`, the server checks current content and skips.
- **Branch protection** &mdash; if a repo has push protection on `main`, the update will fail and log an error in red. Handle those repos manually or disable protection temporarily.
- **Concurrent scans** &mdash; the scanner queries up to 5 repos in parallel by default.
- **Whitespace tolerance** &mdash; trailing whitespace and `\r\n` vs `\n` differences are treated as in-sync.
- **Safe to re-run** any time your canonical changes.

## Troubleshooting

- **`gh CLI not authenticated`** &rarr; run `gh auth login` and retry.
- **404 for missing repo** &rarr; the scanner correctly treats it as MISSING and shows the create-diff.
- **`HTTP 403 rate limit`** &rarr; gh API has a 5,000/hr authenticated limit. If you exceed it, wait or auth with a token that has more headroom.
- **No repos appear** &rarr; verify `gh repo list <user>` returns repos locally.
- **Empty canonical save rejected** &rarr; expected; save real content first.

Override the data directory or port with env vars:

```bash
CLAUDE_MD_DATA_DIR=/Users/christreadaway/my-canonicals PORT=4444 npm start
```
