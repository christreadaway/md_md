# CLAUDE.md Manager &mdash; Business Spec

## What This Is
A local single-user web app that keeps `CLAUDE.md` (and any other markdown file) consistent across every GitHub repo I own. Two modes:
1. **Sync Canonical** &mdash; one canonical `CLAUDE.md`, scanned and diffed against every repo, pushed in one click to bring everything into alignment.
2. **Distribute File** &mdash; introduce a brand-new markdown file (`AGENTS.md`, `SECURITY.md`, `docs/CONTRIBUTING.md`, etc.) into a hand-picked set of repos in one shot.

## Why It Exists
I run ten-plus active repos and I work with Claude Code daily across all of them. Every repo needs an up-to-date `CLAUDE.md` so Claude has the same context, the same writing voice, the same rules of engagement no matter which project I'm in. Drift across repos is the failure mode: I'd update one `CLAUDE.md`, forget the others, and a week later Claude Code would behave inconsistently because half my repos were running on stale instructions.

The same pattern applies to any cross-repo markdown file. When a new convention shows up (an `AGENTS.md`, a `SECURITY.md`), I want to seed it everywhere in a single action, not nine separate commits.

## Who It's For
Me. Chris Treadaway. Single user, running on my Mac. No auth, no multi-tenant story, no hosting. If the dynamics of this ever change, that's a different product.

## Jobs To Be Done
1. **Keep one source of truth** for `CLAUDE.md` and push that truth out to every repo without ceremony.
2. **See drift at a glance** &mdash; which repos match, which differ, which are missing the file entirely.
3. **Bulk-introduce new markdown conventions** across a selected set of repos in one operation.
4. **Trust the result** &mdash; every action logged, every push idempotent, every failure visible and recoverable.

## Core User Experience
- Single page, two tabs: **Sync Canonical** and **Distribute File**.
- Paste markdown, click scan, see a color-coded grid of every repo's status.
- Click **Update All** or update individual repos. Pushes go straight to the default branch &mdash; no branches, no PRs.
- Activity log streams every action in real time at the bottom of the page. A per-run log file is written to disk for later debugging.

## Business Rules
- Pushes go to the default branch directly. No branch creation, no PR workflow. This is a single-user tool, not a collaboration product.
- Idempotent by design. Pushing canonical to a repo that already matches is a silent no-op.
- Failed pushes (branch protection, rate limits, auth issues) do not crash the run &mdash; they get logged and surfaced per repo so the user can decide what to do.
- Whitespace differences (trailing whitespace, `\r\n` vs `\n`) count as in-sync. The tool isn't pedantic about line endings.
- Distribute mode skips repos where the target file already exists, unless **Overwrite if exists** is explicitly checked.
- Filenames must end in `.md`. The validator rejects anything else &mdash; this tool only touches markdown.
- All filenames must match `[A-Za-z0-9._\-/]+\.md`, must not start with `/`, must not contain `..`. Anything else returns a 400 before any GitHub call is made.

## Value Proposition
- **Time:** Bulk operations across 10+ repos take seconds, not an evening of `git clone`, edit, commit, push, repeat.
- **Consistency:** Claude Code behaves predictably across every project because every `CLAUDE.md` matches the canonical exactly.
- **Confidence:** Every action logged, every push idempotent, every failure visible. I never wonder "did that actually go through?"

## Operating Model
- Runs locally on `http://localhost:3333`. No cloud, no hosting, no shared state.
- Auth piggybacks on `gh` CLI &mdash; if `gh auth login` works, the app works.
- Canonical content saved to `~/claude-md-updater/canonical.md`.
- Per-run logs written to `~/claude-md-updater/logs/run-YYYY-MM-DDTHH-mm-ss.log`.
- No database. No background workers. No scheduled jobs.

## Data Requirements
- `~/claude-md-updater/canonical.md` &mdash; the canonical `CLAUDE.md` content. Persists across sessions.
- `~/claude-md-updater/logs/` &mdash; one log file per run.
- Distribute mode content is in-memory only. Not persisted between sessions. By design &mdash; distribute is meant for one-shot use, not a second source of truth.

## Integrations and Dependencies
- **GitHub CLI (`gh`)** &mdash; must be installed and authenticated before the app runs. All GitHub access flows through `gh`.
- **Node.js 20+** &mdash; runtime.
- **npm packages:** `express`, `diff`, `winston`. Locked at known versions, installed via `sfw npm install` for Socket real-time security protection.
- **`.npmrc` pins `min-release-age=7`** &mdash; rejects packages published in the last 7 days as defense against fresh supply-chain attacks.

## Out of Scope
- Multi-user / multi-tenant. This is a tool for one person.
- Authentication / authorization. Local-only, no users to authenticate.
- Cloud hosting or remote access.
- Branch management or PR creation. Pushes go directly to default branch.
- File types other than `.md`. The validator rejects everything else.
- Bidirectional sync. Canonical is one-way: local &rarr; GitHub. The app does not pull repo `CLAUDE.md` content back into the canonical.
- Scheduled / automated runs. Every action is user-initiated.

## Risks and Mitigations
| Risk | Mitigation |
| --- | --- |
| Stale canonical pushed over a meaningful local edit in a repo | User reviews the diff before pushing. Per-repo Update buttons exist for selective control. |
| Branch protection on `main` blocks the push | Failure logged and surfaced in the repo card. User handles those repos manually. |
| GitHub API rate limits hit during a wide scan | Scanner uses concurrency-controlled parallelism (5 at a time by default). Errors per-repo are isolated, not fatal. |
| Supply-chain attack via a freshly published npm package | `.npmrc` rejects packages newer than 7 days. `sfw npm install` adds Socket real-time protection. |
| Accidental destructive push | Idempotency &mdash; identical content is always a no-op. Whitespace tolerance prevents bogus diffs. |

## Success Criteria
- App loads at `http://localhost:3333` on first `npm start`.
- Canonical editor pre-populates from `~/claude-md-updater/canonical.md` on load.
- Scan correctly classifies every repo as IN SYNC / DIFFERENT / MISSING.
- Update All pushes canonical to every out-of-sync repo, with results confirmable on GitHub.
- Distribute pushes a new file to N selected repos and reports Created / Updated / Skipped / Error per repo.
- Per-run log file written every session.
- Re-running any operation that's already in sync produces zero commits.

## Open Questions
- Do I eventually want a "pull from canonical" mode &mdash; pick a repo, declare it canonical, sync everything else to it? (Today the canonical lives only in the editor.)
- Worth surfacing per-repo last-synced timestamps so I can see drift over time?
- Distribute mode is currently one-shot. Should it remember the last filename / content set for the session in case the user navigates away?
