# CLAUDE.md Manager — PRD v1.1

## What This Is
A local Node.js web app that manages markdown files across your GitHub repos. It has two modes:
1. **Sync Canonical** &mdash; define a canonical `CLAUDE.md`, diff it against every repo, push to bring out-of-sync repos into alignment in one click.
2. **Distribute File** &mdash; introduce any new `.md` file (e.g., `AGENTS.md`, `SECURITY.md`, `docs/CONTRIBUTING.md`) to a hand-picked set of repos in one shot.

## Who It's For
Chris Treadaway, running locally on Mac. Single user, no auth needed.

## User Stories
- As a developer, I want to type (or paste) my canonical CLAUDE.md content into a text editor so I have one source of truth
- As a developer, I want to see which repos match, which differ, and which are missing CLAUDE.md entirely
- As a developer, I want to push my canonical content to all out-of-sync repos at once, or repo by repo
- As a developer, I want a log of every action taken so I can debug failures

## Core Features

### 1. Canonical Editor
- Full-height textarea for entering/editing the canonical CLAUDE.md content
- "Save Canonical" button — persists to `~/claude-md-updater/canonical.md` on disk
- On app load, pre-populates from saved canonical if it exists

### 2. Repo Scanner
- "Scan Repos" button — calls GitHub CLI to list all non-archived repos
- For each repo, fetches the current CLAUDE.md content via `gh api`
- Computes status per repo:
  - IN SYNC — content matches canonical exactly
  - DIFFERENT — file exists but content differs
  - MISSING — no CLAUDE.md found
- Shows repo count summary: X in sync, Y different, Z missing

### 3. Diff View
- Each out-of-sync repo shows a unified diff (current vs canonical)
- MISSING repos show "no file" on left side

### 4. Update Controls
- "Update All Out-of-Sync" button — pushes canonical to all DIFFERENT + MISSING repos
- Per-repo "Update" button for selective updates
- Each update: commits directly to default branch (main), no new branch, no PR
- Commit message: `chore: sync CLAUDE.md to canonical [automated]`

### 5. Distribute File (one-shot multi-repo add)
- Mode toggle at top of UI: "Sync Canonical" | "Distribute File"
- Filename input &mdash; must end in `.md`, nested paths like `docs/AGENTS.md` allowed
- Content textarea &mdash; not persisted between sessions (one-shot use)
- Commit message input &mdash; defaults to `chore: add {filename} [automated]`, user-editable
- Repo picker &mdash; checkbox list of all non-archived repos, with filter + Select All / Clear
- "Overwrite if exists" toggle &mdash; default OFF (skip repos where file already exists)
- "Push to N Repos" button &mdash; one-shot bulk push
- Per-repo result badges: Created / Updated / Skipped / Error
- Identical content is always a no-op even with Overwrite on

### 6. Activity Log
- Scrollable log panel at bottom of UI
- Every action logged: scan start/end, per-repo status, push success/fail
- Errors shown in red
- Log also written to `~/claude-md-updater/logs/run-YYYYMMDD-HHMMSS.log`

## Business Rules
- Idempotent: pushing canonical to an already-in-sync repo is a no-op
- If a repo push fails (e.g. branch protection), log error and continue &mdash; do not crash
- Canonical content stored at `~/claude-md-updater/canonical.md`
- App runs on `http://localhost:3333`

### Distribute File validation
- Filenames must match `[A-Za-z0-9._\-/]+\.md` and must not start with `/` or contain `..` &mdash; rejected with 400
- Every repo target must be a non-empty string in `owner/name` form &mdash; rejected with 400
- Content must be a non-empty string &mdash; rejected with 400
- Validation applies on both `/api/update` and `/api/distribute` so malformed payloads cannot reach the GitHub client

### Race safety
- Double-clicking the push button is a no-op &mdash; second invocation returns immediately
- During an in-flight distribute push, the filename input, content textarea, commit-message input, overwrite toggle, Select All / Clear / Reload buttons, and every repo checkbox are disabled
- Manual Reload during a push is blocked
- On a successful repo reload, selections and per-repo status badges for repos that disappeared (renamed/archived) are dropped so the &ldquo;N selected&rdquo; pill never lies

## Tech Stack
- Backend: Node.js + Express
- Frontend: Single HTML page served by Express — vanilla JS
- GitHub access: GitHub CLI (`gh`) — must be authenticated before running
- Diff: `diff` npm package
- No database — canonical stored as flat file, logs as flat files

## Logging Infrastructure
- All backend actions logged via `winston`
- Log format: `[TIMESTAMP] [LEVEL] [REPO] message`
- Per-run log file: `~/claude-md-updater/logs/run-YYYYMMDD-HHMMSS.log`
- Frontend activity log panel polls `/api/log` for real-time display

## Data Requirements
- `~/claude-md-updater/canonical.md` — source of truth
- `~/claude-md-updater/logs/` — timestamped log files per run
- No other persistent state

## Dependencies
- `gh` GitHub CLI (authenticated)
- Node packages: `express`, `diff`, `winston`

## Out of Scope
- Multi-user support
- Branch management or PR creation
- Modifying any file that does not end in `.md` (the validator rejects other extensions)
- Web hosting &mdash; local only

## Security & NPM Hygiene (Applied to This Project)
- Use `sfw npm install` for all installs
- Run `npm audit` before running
- Add `min-release-age=7` to `.npmrc`

## Success Criteria
- App loads at localhost:3333
- Canonical editor pre-populates from saved file on load
- Scan correctly identifies IN SYNC / DIFFERENT / MISSING across all repos
- Update pushes canonical directly to main, confirmed in GitHub
- Log file written after each session
- Safe to re-run — no duplicate commits if already in sync
