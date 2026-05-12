# CLAUDE.md Manager

Local web app to keep `CLAUDE.md` in sync across all your GitHub repos. Paste your canonical content, scan to see what's different, push in one click.

## Prerequisites

```bash
# GitHub CLI — must be installed and authenticated
brew install gh
gh auth login

# Socket CLI for secure npm installs
npm install -g @socketsecurity/safe-npm
```

## Setup

```bash
mkdir -p ~/claude-md-updater
cd ~/claude-md-updater

# Copy all project files here (server.js, package.json, .npmrc, public/)
# Then install deps:
sfw npm install

npm audit
```

## Run

```bash
cd ~/claude-md-updater
node server.js
```

Open http://localhost:3333

## How to Use

1. **Paste your canonical CLAUDE.md** into the left editor
2. Click **Save Canonical** — persists to `~/claude-md-updater/canonical.md`
3. Click **Scan Repos** — fetches all your non-archived GitHub repos and diffs each one
4. Review results:
   - **In Sync** (green) — matches canonical, nothing to do
   - **Different** (yellow) — click the card to see the diff, then Update
   - **Missing** (red) — no CLAUDE.md exists, Update will create it
5. Click **Update All Out-of-Sync** to push canonical to every repo that differs
   — or click **Update** on individual repo cards

All pushes go directly to `main` (or the repo's default branch). No branches, no PRs.

## Logs

- Activity log is visible in the bottom panel in real time
- Per-run log files saved to `~/claude-md-updater/logs/run-YYYYMMDD-HHMMSS.log`

## Notes

- **Idempotent** — scanning an already-in-sync repo never triggers a push
- **Branch protection** — if a repo has push protection on main, the update will fail and log an error. Handle those repos manually or disable protection temporarily
- Safe to re-run any time your canonical changes
