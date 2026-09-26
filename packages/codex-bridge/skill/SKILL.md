---
name: claude-frontend-worker
description: Delegate substantial frontend implementation to the user's local Claude Code through Agent Rey, with Codex coordinating review and integration. Use when the user asks to use Claude for frontend work or when splitting substantial frontend work would help. Handle unavailable Claude accounts by asking the user before choosing recovery or Codex takeover.
---

# Claude frontend worker

Use the user-level `agent_rey_frontend` MCP tools. This is an external Claude Code
worker, not the official VS Code conversation or a native Codex subagent.

1. Read the target project's `/docs` and applicable instructions. Announce delegation
   and keep small/self-contained edits local when delegation adds no value. A request
   to explain/review is not authorization to implement or send project data to a worker.
2. Call `rey_status`. On `blocked`/`needsUserDecision`, **ask the user**: “Claude is
   unavailable. Wait/reconnect and continue with Claude, or proceed with Codex?” Use
   the available user-question UI or a plain question and stop delegation until answered.
   Never silently fall back, switch accounts/providers, auto-probe, or keep retrying.
3. If available, prepare a brief with task intent, relevant docs, approved visual anchors,
   API contracts, acceptance criteria, and literal allowed frontend paths. Include any
   necessary style guidance explicitly: global/project executable Claude settings,
   skills and hooks are intentionally not inherited.
4. Call `rey_start_frontend_task` with the absolute clean Git repo root. Dirty work must
   be preserved and resolved deliberately, not auto-stashed/discarded. A new repo needs
   an initial commit. Never edit the task's worktree while Claude owns a running turn.
5. Wait via `rey_get_task` (bounded waits up to 20 seconds), communicating meaningful
   progress. Read `rey_get_result`; inspect untracked files as well as the diff. The
   worker has no shell: Codex runs dependencies/tests/browser checks after it stops.
6. Send focused `rey_send_feedback` if necessary. Integrate deliberately; update the
   project's `docs/development-phases.md` checklists and follow its commit/push rules.
   Do not include unrelated changes. Worktrees are retained; do not delete without scope.

## Claude unavailable mid-task

Ask the same choice immediately. Do not drop existing work or start the task over.

- User chooses Claude: let them fix account access normally. Only at their request run
  `rey_check_account(userRequestedCheck: true)`, which consumes a small Claude request.
  Wait for success, then continue the preserved task with explicit feedback. A successful
  check clears the account circuit but never automatically resumes tasks.
- User chooses Codex: if still running, `rey_cancel_task` and wait for terminal state.
  Call `rey_handoff_task(userConfirmedCodex: true)`, inspect its saved worktree/brief,
  and continue from the partial implementation. Do not restart Claude on handed-off tasks.
  If delegation was blocked before a task was created, simply continue locally with
  Codex after that choice; there is no task ID or worktree to hand off.
- User chooses to wait: leave task paused; no background check unless separately requested.

`rey_list_tasks` recovers tasks across Codex restarts/projects. `rey_status` is local-only.
If tools are missing, explain that the global MCP connection needs restart; don't claim
Claude ran or auto-install another integration. No API keys or VS Code token extraction.
Full architecture and recovery contract live in Agent Rey's `docs/codex-frontend-worker.md`.
