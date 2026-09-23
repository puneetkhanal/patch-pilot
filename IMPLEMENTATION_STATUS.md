# Implementation status

## Implemented

- Persistent Settings dialog for the local repositories root
- Automatic nested discovery of local clones with GitHub origins
- Multi-repository selector that fills the clone path and refreshes alerts automatically, with manual `owner/repo` fallback
- Automatic GitHub authentication through `gh auth token`, with optional `GH_TOKEN` override
- npm-only Dependabot alert ingestion, cursor-based Link pagination, stable grouping, and missing-alert closure
- State-preserving issue upsert, guarded workflow transitions, notes, and atomic JSON persistence
- Lockfile-aware heuristic analysis with dependency graph nodes and edges
- Configurable per-issue and background bulk AI analysis through `@cursor/sdk` and Composer 2.5, with read-only repository tools, local sandboxing, and progress polling
- Work items containing 1-10 Dependabot issues, drag-and-drop draft membership, an unassigned pool, and analyze-all/fix-all/one-PR actions
- Confirmed repository-wide work-item reset across every work-item status, returning active members to triage while retaining their issue and analysis records
- AI auto-created work items using the overall dependency graph and complete issue list, with an editable prompt, configurable maximum (default 3), persisted safety ranking, and server-side normalization of model output
- Persisted asynchronous fix jobs with streamed logs and issue/batch lifecycle updates
- Single-alert npm remediation in isolated git worktrees
- Multi-alert npm batch remediation with one install pass per manifest directory
- Ad-hoc package updates
- Branch push and GitHub PR creation/reuse
- Open PR dashboard with check-run, commit-status, and review state
- Managed worktree listing and removal
- Cursor cloud-agent Slack review requests using Cursor-managed MCP OAuth sessions
- Complete local UI with grouped upgrades as the default view, individual issues, AI analysis, PRs, worktrees, and package updates
- Production TypeScript build and static asset serving
- Unit tests for workflow, slugs, npm filtering, state preservation, batching, lockfile analysis, and child-process job lifecycle
- HTTP integration tests for app bootstrapping, repository discovery, scanning, transitions, batching, background analysis, PR status, state export, and static UI serving
- Opt-in real-GitHub end-to-end coverage for scanning open alerts, Gemini work-item auto-grouping, Cursor skill remediation, publishing and verifying a pull request, and cleaning up the testbed
- Opt-in real-Slack end-to-end coverage through a Cursor cloud agent and Cursor-managed Slack MCP OAuth

## Configurable integration points

- Cursor SDK with the fixed Composer 2.5 model provides repository-aware AI analysis and work-item grouping; an OpenAI-compatible endpoint is used only for final independent verification.
- Slack review messages run through a restricted Cursor skill on a cloud agent with a configured Slack MCP server/tool; Cursor owns the OAuth session.
- Jira remains a future integration and has no version 1 configuration surface.
- Registry authentication, code generation, and organization-specific verification use executable remediation hooks.

## Verification

- `npm test` — 25 test files and 98 tests passed, with the opt-in live GitHub and Slack E2E tests skipped by default
- `npm run build` — passed
- `bash -n scripts/remediation/*.sh` — passed
- `node --check` for JavaScript helpers and application modules — passed
- `npm run audit:identifiers` — passed
- `npm run test:e2e:github` — dedicated testbed flow covers Gemini auto-grouping and Cursor skill remediation; temporary PR and branch cleanup verified
- `npm run test:e2e:slack` — opt-in dedicated-channel command added; live execution requires Cursor/Slack credentials and explicit external-send confirmation

Live GitHub, LLM, and Slack calls require operator credentials and were not executed with synthetic credentials.
