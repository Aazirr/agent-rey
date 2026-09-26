# Codex frontend worker

## Contract

Codex can delegate frontend implementation to a separate local Claude Code session.
This is a new stdio MCP entrypoint in `packages/codex-bridge`, using the same
Claude Agent SDK integration as reyd, with an independently pinned runtime.
It does not attach to the official VS Code panel, bypass
reyd authentication, or require/restart the phone daemon. The existing PWA/daemon
does not list these bridge-owned tasks; use `rey_list_tasks` in Codex instead.

Prompts and files Claude reads are sent to Anthropic. The normal same-user Claude
login is used; account access must be verified. No API keys, alternative providers,
token extraction, automatic account switching, or paid API fallback are configured.
Claude's own subscription/extra-usage settings still govern its actual billing.

## Installation and discovery

1. Run `pnpm install` in Agent Rey (Node 22+).
2. Register `node <absolute-repo>/packages/codex-bridge/src/server.mjs` as a user-level
   stdio MCP server named `agent_rey_frontend` in `~/.codex/config.toml`.
3. Install `packages/codex-bridge/skill/SKILL.md` as
   `~/.codex/skills/claude-frontend-worker/SKILL.md`.
4. Restart the Codex MCP connection/app, then check `rey_status`.
5. Explicitly run `rey_check_account` once and wait for its result. This uses allowance.

This applies across current/future repositories without copying files into each.
The default approved parent is the user's `Documents` directory; only an explicitly
selected Git repo is accessed, not every project scanned. New projects need an
initial commit. Projects elsewhere need an explicitly approved parent in
`~/.agent-rey/codex-bridge/config.json` (`allowedProjectRoots`).
Global settings never override project specifications in `/docs`.

### Frontend model

The user-local `~/.agent-rey/codex-bridge/config.json` selects the worker model across
projects. The requested installation uses an exact version, not the moving `opus` alias:

```json
{ "model": "claude-opus-5-5" }
```

The bridge pins Agent SDK 0.3.283 (Claude Code 2.1.283), meeting the
[Opus 5.5 minimum runtime requirement](https://code.claude.com/docs/en/model-config)
of Claude Code 2.1.280. The phone daemon's SDK is unchanged. Config is loaded on each
worker launch, including feedback turns; changing it does not interrupt an active turn
or change the VS Code panel's model. Account/model access is separate from configuration.
Unavailable models still require the explicit recovery-or-Codex decision below.

## Tasks and isolation

- `rey_start_frontend_task` requires a clean committed repo, a concrete brief, and
  literal writable frontend files/directories. Dirty work is rejected, not stashed
  or silently omitted. Worktree starts at recorded HEAD.
- Detached worktrees, prompts, task metadata and account state are retained under
  `~/.agent-rey/codex-bridge`. They are not automatically deleted.
- Exactly one worker globally; other Codex windows receive a busy result. This
  avoids overlapping account checks/recovery and uncontrolled request fan-out.
- Detached worker processes survive MCP reconnects. Abrupt worker death is marked
  interrupted on the next inspection after the 30-second startup grace period.
- Default bound: 24 turns, 15 minutes per run. A stopped/limited turn preserves
  files; explicit feedback is required. Optional local config: `maxTurns` (1–60),
  `timeoutSeconds` (30–1800), `model` (otherwise Claude's default).
- Available agent tools: Read, Glob, Edit, Write. Hooks enforce worktree containment,
  block symlinks/junctions, credential/config paths, and writes outside allowedPaths.
  Shell, subagents, MCP servers and plugin tools are not available. No global/project
  executable settings/skills/hooks are loaded; supply necessary context in the brief.
  This is tool-level confinement, not an OS sandbox against a compromised SDK/runtime.
- Codex installs dependencies/runs tests and browser checks after the worker stops,
  reviews all new and tracked files, integrates changes, updates `/docs`, then commits
  and pushes per the target project's instructions. Claude cannot do these actions.

## Unavailable account: user decision required

Provider authentication, disabled account/organization, billing, rejected usage limits,
unavailable models, transport failures, and provider retry events open a persistent
global circuit. No automatic retries, recurring probes, or startup requests. A usage
reset timestamp, when provided by Claude, blocks checks until then. Rate-limit warnings
that still allow requests are not failures. Ordinary prose mentioning an error is not
treated as provider error metadata.

`rey_get_task` / `rey_status` return `needsUserDecision` on account failure. MCP server
instructions and the installed global skill require Codex to ask:

> Claude is unavailable. Would you like to wait/reconnect and continue with Claude,
> or have Codex continue from the preserved work?

The bridge cannot render Codex chat UI itself; the calling agent presents this prompt.
It never answers it for the user.

- **Claude:** user fixes login/access in the normal Claude interface, then explicitly
  requests `rey_check_account`. Only a successful probe clears the circuit. Existing
  tasks remain stopped until `rey_send_feedback`; no background auto-resume.
- **Codex:** stop/wait if necessary, then `rey_handoff_task(userConfirmedCodex: true)`.
  Codex continues in the saved worktree, inspecting partial changes rather than losing
  or duplicating them. Handed-off tasks cannot subsequently resume in Claude.
- A disabled account is not bypassed. No credentials appear in MCP configuration or
  outputs; provider errors are reduced to sanitized categories.

## Verification

Run `pnpm --filter @agent-rey/codex-bridge test`, plus workspace tests/typechecks.
Unit/integration tests use fake Claude streams and temporary Git repos; they do not
consume Claude allowance. Live authentication/file editing are separate checks, never
implied by passing mocks. The installed config is user-local, not committed credentials.
