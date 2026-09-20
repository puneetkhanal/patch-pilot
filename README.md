# PatchPilot

**Automated Vulnerability Orchestrator**

PatchPilot is a local-first dashboard for finding, analyzing, and fixing vulnerable dependencies across source repositories. It turns security alerts into a reviewable remediation workflow: triage findings, assess upgrade risk, group compatible fixes, run changes in isolated git worktrees, open pull requests, and monitor CI and review status.

The first implementation adapter targets GitHub Dependabot alerts for JavaScript/npm repositories. The product model is intentionally broader: future ecosystem adapters can add Python (`pip`/Poetry) and Go (`go.mod`) discovery, analysis, and remediation without changing the core issue, work-item, job, worktree, or pull-request workflow.

The main board organizes Dependabot issues into work items. A work item can contain one or more issues, supports drag-and-drop membership while it is a draft, analyzes every member together, and produces one coordinated fix and pull request. **AI auto-group** runs as a visible multi-step job: it refreshes the internal dependency engine for every eligible issue, collects bounded `package.json`, lockfile, import-usage, and dependency-graph evidence, then sends that evidence to Cursor or Gemini for grouping. The v2 planner treats repository text as untrusted data, validates model JSON strictly, repairs one malformed response automatically, safely recovers complete groups from repeated truncation, enforces singleton risk rules and positive compatibility evidence, records server corrections, and atomically replaces eligible draft groups. The UI shows each step (collect issues, dependency analysis, import context, AI grouping, create work items) with live progress. Groups default to at most three issues per work item and are ranked by safety. **Reset work items** clears every work-item record for the selected repository and returns non-terminal members to triage without deleting their Dependabot issue or analysis history. The complete planner contract is in [`AUTO_GROUP_PROMPT_SPECIFICATION.md`](AUTO_GROUP_PROMPT_SPECIFICATION.md).

See [SPECIFICATION.md](SPECIFICATION.md) for the product architecture and the current npm adapter contract.

## Ecosystem support

| Ecosystem | Alert source | Status |
|---|---|---|
| JavaScript / npm | GitHub Dependabot | Supported now |
| Python / pip and Poetry | Pluggable vulnerability source | Planned |
| Go modules | Pluggable vulnerability source | Planned |

## Setup

```bash
cp .env.example .env
npm install
npm run dev
```

Open `http://localhost:4000`.

## Repository discovery

Open **Settings** in the application and enter the parent directory containing your local GitHub clones, for example `/path/to/projects`. The server scans nested folders for git repositories whose `origin` points to GitHub. Selecting a discovered repository automatically fills its local clone path and refreshes its supported vulnerability alerts. The current adapter fetches open npm alerts from GitHub Dependabot.

The root path is stored in the gitignored `.orchestrator-settings.json` file. It can also be supplied initially with:

```text
GITHUB_REPOSITORIES_ROOT=/path/to/projects
```

The preferred GitHub authentication is the GitHub CLI:

```bash
gh auth login
```

The server automatically uses `gh auth token`. Alternatively, provide an explicit token:

```text
GH_TOKEN=<token with repository and Dependabot alert access>
```

The GitHub token stays in the server process and is never returned to the browser.

## Dependency graph and upgrade verification

The **Dependency analysis** page exposes two independent primary tracks:

1. The local deterministic engine reads the selected npm manifest and nearest workspace `package-lock.json`, builds dependency and peer edges, and calculates a 0–100 safety score for each open vulnerability upgrade.
2. AI analysis uses either Cursor (`@cursor/sdk` with Composer 2.5) or Gemini (Google Generative Language API) to inspect repository usage and produce implementation, breaking-change, and verification guidance without replacing the engine's rating.

Each invocation recomputes its inputs. Issues store separate timestamped histories for dependency-engine, AI analysis, codebase safety-verdict, and final-verification runs (up to 20 per track), plus the latest result for each track. Cursor inspects imports, API usage, configuration, and tests with a read-only tool allowlist and local sandbox enabled. Gemini analyzes pre-collected manifests, lockfile excerpts, import grep hits, and heuristic evidence. Final verification always performs a fresh engine analysis and fresh codebase review before asking the selected provider for an independent verdict.

Choose the provider per run in the UI or with a `provider` field (`cursor` or `gemini`) on AI API requests. When omitted, the server prefers Cursor if `CURSOR_API_KEY` is set, otherwise Gemini.

Configure Cursor AI analysis with:

```text
CURSOR_API_KEY=...
```

The Cursor model is fixed to `composer-2.5` and cannot be overridden by environment configuration.

Configure Gemini AI analysis with:

```text
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.6-flash
```

The Cursor SDK requires Node.js 22.13 or later. Graph analysis itself is offline and requires neither Cursor nor Gemini.

The default AI analysis prompt is available and editable on the AI analysis page. Browser edits are stored locally and sent with the analysis request; API keys remain server-side. `AI_UPGRADE_PROMPT_TEMPLATE` can set the server default.

### LLM analysis

Configure an OpenAI-compatible chat-completions endpoint:

```text
LLM_API_KEY=...
LLM_MODEL=...
LLM_BASE_URL=https://api.openai.com/v1
```

`LLM_API_KEY` and `LLM_MODEL` are used only for final independent verification when the Cursor provider is selected. When Gemini is selected for a run, final verification uses `GEMINI_API_KEY` instead. Keys stay in the server process and are never returned to the browser.

## Local remediation

Enter the absolute path to the selected repository clone in the UI, or configure:

```text
ORCHESTRATOR_DEFAULT_PROJECT_PATH=/path/to/clone
```

Fix jobs use `git`, `gh`, Node.js, and npm. Worktrees are created beside the clone under `.dependabot-worktrees`. Optional pre-install and post-lockfile hooks are configured with `REMEDIATION_PRE_INSTALL_SCRIPT` and `REMEDIATION_POST_BUMP_HOOK`.

For Dependabot alerts reported against `package-lock.json` or `npm-shrinkwrap.json`, remediation updates the sibling `package.json` and then regenerates the lockfile with npm. A fix is not considered successful unless its branch contains a commit beyond the remote base branch, and pull-request creation performs the same preflight check before contacting GitHub.

### Agent-assisted fix skills

**Run fix** always starts with a fresh dependency-engine analysis and runs in an isolated worktree. The dialog then lets the user choose one of these workflows:

- **Built-in dependency update** performs the deterministic manifest/lockfile update without an AI coding agent.
- **Codex skill** runs a discovered skill through the official `@openai/codex-sdk` after the dependency update.
- **Claude skill** runs a discovered skill through a configured Claude CLI command.
- **Cursor skill** runs a discovered skill through `@cursor/sdk`.

The selected provider and skill are stored separately on the fix job and on the issue's latest remediation state. The execution order is: fresh engine analysis → isolated worktree → deterministic package bump/install → selected skill → configured validation hook → stage and commit. The agent never owns the commit or push step.

Skills are discovered by provider from:

```text
.agents/skills/<skill>/SKILL.md   # Codex
.claude/skills/<skill>/SKILL.md   # Claude
.cursor/skills/<skill>/SKILL.md   # Cursor
```

PatchPilot includes `.agents/skills/dependency-security-fix/SKILL.md` for Codex testing. Codex is enabled by default and uses the local Codex login or `CODEX_API_KEY`; the runner uses `workspace-write`, disables approval prompts, and disables tool network access. Claude remains disabled until explicitly enabled, and Cursor requires `CURSOR_API_KEY`.

```text
CODEX_FIX_ENABLED=true
CODEX_FIX_MODEL=
CLAUDE_FIX_ENABLED=false
CLAUDE_FIX_COMMAND=claude
CURSOR_API_KEY=
FIX_AGENT_SKILLS_ROOT=/optional/project/root
```

The server only accepts provider/skill pairs found in its registry. Disabled providers are visible but cannot be selected, and arbitrary skill paths are rejected.

## Slack MCP

To enable review requests:

```text
SLACK_MCP_URL=https://example.com/mcp
SLACK_MCP_TOOL=send_message
SLACK_DEFAULT_CHANNEL=#security-reviews
```

The client uses MCP initialize and `tools/call` over Streamable HTTP. The selected PR titles, URLs, check state, and review state are formatted into the tool's `text` argument.

## Commands

```bash
npm test
npm run test:unit
npm run test:integration
npm run build
npm start
npm run audit:identifiers
```

`npm run build` emits `dist/server.js`; `npm start` serves the compiled API and the static web UI.

## Security

Tokens remain server-side. Hook paths are trusted operator configuration. `.tracker-state.json`, `.env*`, reports, worktrees, and build output are gitignored. State imports are shape-validated and persistence uses serialized atomic writes.
