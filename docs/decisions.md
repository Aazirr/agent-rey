# Agent Rey — Decision Log

## D-017 — Isolated Codex frontend worker with explicit account-failure handoff

**Date:** 2026-09-26 · **Status:** accepted

Add `packages/codex-bridge` as a same-user stdio MCP entrypoint. It reuses the pinned
Claude Agent SDK approach rather than controlling the VS Code panel, changing the
running reyd service, or creating a local authentication exemption. It owns separate
sessions and detached Git worktrees; normal Claude account restrictions still apply.

Unlike the general phone agent, this worker has only scoped file tools, no shell or
inherited executable project/user settings. A task is explicitly bounded by turns
and time; interruption preserves work for review instead of presenting it as success.
Codex owns testing, integration and Git operations. Existing D-004/D-015 daemon
policies remain unchanged.

Account failures persist a global circuit across Codex windows/projects. No retry,
account switching, API billing fallback, or silent Codex takeover. The calling Codex
agent must ask whether the user wants to restore Claude access and continue, or
hand the same partial work to Codex. A successful explicit account probe clears the
circuit but does not resume any task. Handed-off tasks cannot resume in Claude.
See `codex-frontend-worker.md` for the operational contract and limitations.

## D-001 — Own the sessions; do not remote-control the official panel

**Date:** 2026-08-07 · **Status:** accepted

The original framing was "mobile UI that controls my VSCode Claude Code window." Rejected
as unbuildable, verified against `anthropic.claude-code` v2.1.223: its 23 contributed
commands cover window management and diff accept/reject only, its conversation UI is a
webview inaccessible to other extensions, and it exposes no public API.

Agent Rey instead spawns `claude` itself via the Agent SDK, exactly as that extension does
internally (`--input-format stream-json --output-format stream-json` confirmed in its
bundle). Consequence: the conversation renders in our UI, not inside Anthropic's panel.
Accepted willingly — owning the session is what makes prompt submission, interrupt, session
listing, and multi-project possible at all.

## D-002 — Standalone daemon, not a VSCode extension

**Date:** 2026-08-07 · **Status:** accepted

Alternative considered: host everything in the extension host. Simpler to ship, direct
access to workspace and diff APIs.

Rejected because closing VSCode would kill every session and a window reload would drop the
phone's connection mid-turn. The point of the product is prompting from a phone while away
from the desk; requiring an editor to be open the whole time undercuts it. Cost accepted: a
background service to install and keep running.

## D-003 — Tailscale for transport

**Date:** 2026-08-07 · **Status:** accepted

LAN-only was rejected — useless away from home, which is exactly when phone access matters.
Cloudflare Tunnel / ngrok rejected because a third party terminating TLS contradicts the
entire motivation.

Tailscale also solves two non-privacy problems for free: `tailscale serve` provides a valid
TLS certificate so the PWA gets a secure context, and the daemon can bind to loopback only,
never exposed on LAN or public internet.

## D-004 — Per-session permission mode, not per-tool approval

**Date:** 2026-08-07 · **Status:** accepted

Chosen over pushing each risky tool call to the phone for a tap. Rationale: an agent that
stalls whenever I'm not looking at my phone defeats the "kick off a task from the train" use
case, which is the main reason the product exists.

Accepted risk: the agent operates unsupervised in a real repository. Compensating controls,
all cheap and all in the MVP —

- Mode is chosen explicitly at every session start and never persists as a default, so an
  unattended mode is never entered by accident
- Interrupt is always visible in the mobile UI; it is the real safeguard
- Every tool call is written to an audit log regardless of mode, via a `PreToolUse` hook
  that always returns `continue: true` — an audit trail, never a gate, because gating here
  would silently contradict the mode chosen
- Per-project `disallowedTools` acts as a hard floor that mode cannot override
- Sessions run in git repos, so changes are recoverable

**Amended 2026-08-07 after SDK verification.** Three SDK capabilities found during
implementation strengthen this materially, and all three are now wired in:

- `sandbox: { enabled: true }` (`REY_SANDBOX`) — containment for tool execution rather than
  trust alone
- ~~`maxBudgetUsd` per session (`REY_DEFAULT_MAX_BUDGET_USD`, overridable per project) — a
  runaway unattended session stops costing money at a known ceiling~~ — withdrawn, see D-015
- `enableFileCheckpointing` + `Query.rewindFiles(userMessageId)` — a real undo of an
  unattended run's file changes, independent of git

This does not eliminate the risk, but it moves the decision from "trust it and read the log
afterwards" to "contain it, cap it, and be able to roll it back". The escalation design
(mode for file edits, push prompt for shell/network) remains the documented fallback if an
unattended session still causes damage these cannot undo.

## D-005 — Session root is the SDK `cwd`, not VSCode's open folder

**Date:** 2026-08-07 · **Status:** accepted

Project switching sets a per-session `cwd` rather than reopening a workspace. Calling
`vscode.openFolder` restarts the extension host and would terminate live sessions; it also
limits the machine to one active project. With `cwd`, one daemon hosts sessions across
arbitrarily many folders at once.

## D-007 — Frontend may be hosted on Vercel; the daemon never is

**Date:** 2026-08-07 · **Status:** accepted

Requested: "this will be deployed on Vercel." Taken as applying to the PWA only, because a
serverless function cannot spawn the local `claude` binary, cannot hold a long-lived
WebSocket, and cannot read this machine's working tree — and if it could, the repo and
conversation would be on someone else's hardware, defeating the project's purpose.

Resolution: Vercel serves the static app shell; the page connects over the tailnet straight
to the local daemon. Both ends are HTTPS so there is no mixed content, and WebSocket
upgrades are not subject to CORS preflight — so the daemon checks `Origin` itself against
`REY_ALLOWED_ORIGINS`.

Accepted tradeoff: a Vercel-hosted page holds the device token, so control of that
deployment means control of the code the phone runs. Mitigated by keeping the daemon able to
serve the PWA itself (`REY_SERVE_WEB=1`), so Vercel is a convenience rather than a
dependency.

## D-008 — Password login with revocable device sessions

**Date:** 2026-08-07 · **Status:** accepted

Requested: password prompt plus sessions, password supplied via environment variable, so a
stranger cannot reach an agent that has full access to the machine.

Implemented as `REY_PASSWORD` → scrypt (N=2^15) hashed at boot, never persisted or logged,
compared with `timingSafeEqual`. Login exchanges it for a device token
`<deviceId>.<expiry>.<HMAC-SHA256>` over a persisted signing secret.

Two decisions worth recording:

- **Server-side device store, not stateless tokens alone.** Verification checks the HMAC
  *and* looks the device up in a persisted store. Stateless tokens would have been less
  code, but revoking one lost phone would have meant rotating the secret and logging out
  every device. Revocability was worth the state.
- **Global lockout, not only per-IP throttling.** Per-source backoff alone is close to
  theatre when an attacker can vary source addresses; the global counter is what actually
  bounds guessing. 10 failures → 15 minute lockout.

Tokens carry a 30-day sliding expiry, renewed past the halfway mark, so a phone in daily use
never hits an expiry wall while an unused device still ages out.

## D-009 — The VSCode extension does not render conversations

**Date:** 2026-08-07 · **Status:** accepted

The original P5 sketch said "webview to continue a session at the desk". Dropped after the PWA
was built and tested: a second transcript renderer would duplicate the reducer, the tool-card
rendering, and the reconnect logic, and the two would drift within weeks.

The extension instead does only what the phone cannot do at the desk:

- surfaces that an unattended session is running in one of your repos — status bar turns amber
  and names the count
- inline interrupt and stop from the session tree
- reveals the project folder, and opens today's audit log in an editor tab
- hands off to the real UI for conversation

It authenticates with the same password flow and stores its token in SecretStorage. It gets no
local-process exemption: running on the same machine is not an identity, and an exemption would
let any local process drive an agent with shell access.

`revealFileInOS` rather than `openFolder` for the project command — opening a folder restarts
the extension host, and per D-005 the daemon's sessions are independent of what is open in the
editor anyway.

## D-010 — Bounded retention with a resumability exemption

**Date:** 2026-08-07 · **Status:** accepted

The daemon is meant to run for months. Two resources had no bound: one NDJSON event log per
session, and one audit file per day. Individually small, which is why the problem would have
surfaced as a full disk rather than as a symptom.

Retention is asymmetric on purpose. Audit files keep 90 days, transcripts 30: the audit trail
is the accountability record for unattended sessions (D-004) and is a fraction of the size.

The rule that needed care: **a session still in the registry keeps its event log regardless of
age.** Without that exemption, resuming a months-old session would find its history already
deleted. Pinned by test.

Idle sessions are stopped after 180 minutes by default, reclaiming a CLI process each. Safe
because stopping is reversible — a stopped session resumes with context intact. A session in
`thinking` is never reaped, since it may be part-way through exactly the long unattended task
this product exists to enable.

## D-011 — The daemon emits the user's own message

**Date:** 2026-08-07 · **Status:** accepted

The CLI does not echo the human's prompt on the message stream — only the agent's side of a
turn arrives. So a chat UI built purely from the stream never shows you what you sent.

Rendering it optimistically in the client was rejected: it would not survive a reload or a
reconnect, and the transcript is supposed to be reconstructable from the daemon's event log.
Instead `AgentSession.prompt()` emits a synthetic `user` message through the same `onEvent`
path as everything else, so it is sequenced, logged, replayed, and broadcast like any other
event.

This also exposed an ordering bug: events emitted *during* `session.start` — including the
initial prompt's own message — were already in the log before the starting client was
subscribed, so a live-only subscription dropped them. `session.start` now replays from seq 0
after subscribing.

## D-012 — Rewind UI pulled; the anchor is not reachable

**Date:** 2026-08-07 · **Status:** REVERSED 2026-08-08 — see D-014

> This decision was wrong. The reasoning below is kept because the mistake is
> instructive: an empty result from a bad filter is indistinguishable from an empty
> result from missing data, and I read one as the other and withdrew a feature that
> worked. Superseded by D-014.

`Query.rewindFiles(userMessageId)` plus `enableFileCheckpointing` looked like the real undo
that D-004's unattended modes lean on, and a UI was built for it. It was then removed, because
the anchor cannot be obtained:

- **A uuid the daemon assigns is rejected.** Setting `uuid` on the `SDKUserMessage` we submit
  does not make it a checkpoint key: `rewindFiles` answers
  `{canRewind: false, error: 'No file checkpoint found for this message.'}`. Verified with the
  agent having genuinely written the file (`Read`, `Write` in the tool calls, contents changed
  on disk).
- **The CLI's own uuids are not on the stream.** The only `user` messages emitted are tool
  results, and their uuids are not turn anchors — they fail the same way.
- **`getSessionMessages` returns nothing mid-session.** The obvious remaining source of real
  uuids came back empty for a live session, so there was no anchor to offer.

A "Rewind…" button that always reports "no rewind points" is worse than no button, so the UI
was withdrawn. The protocol messages (`session.rewind`, `session.checkpoints`) and the daemon
methods remain — they are correct, and they will work the moment a valid anchor is obtainable.
`packages/daemon/test/rewind-check.mjs` is kept as the diagnostic that produced this evidence.

**Consequence for D-004.** The compensating controls for unattended sessions are now: sandbox,
the spend ceiling (later withdrawn, D-015), the audit log, per-project `disallowedTools`,
always-visible interrupt, and git. Checkpointing stays enabled (it costs nothing and the capability is real), but rewind
should not be counted as an available safeguard until this is resolved.

## D-014 — Rewind restored; D-012 was a misdiagnosis

**Date:** 2026-08-08 · **Status:** accepted

Rewind works. Verified end to end: an agent rewrote a tracked file, the checkpoint list
returned a usable anchor, and the rewind restored the original contents —
`canRewind: true`, `skippedLinks: 0`, file back to its pre-session state.

**What went wrong in D-012.** Three findings were cited; two were accurate, the third was not.
`getSessionMessages` does return session history for a live session. It returned zero because
`checkpoints()` passed `{ dir: projectPath }`, and the CLI stores that path with whatever
casing its process was launched with — `c:\Users\...` here, against the `C:\Users\...` the
daemon computes. The filter matches exactly, so a case difference silently yields an empty
array. Removing the filter fixes it; the session id alone is unambiguous.

The uuid the daemon assigns to a submitted user message (D-011) *is* honoured by the CLI as a
checkpoint anchor. D-012 concluded the opposite because it could never read the history back
to confirm.

**The lesson worth keeping:** an empty result from a bad filter is indistinguishable from an
empty result from missing data. D-012 treated one as evidence of the other and withdrew a
working feature on the strength of it. A query returning nothing should have prompted "is my
query right?" before "the data does not exist" — especially on Windows, where path casing
varies by how a process was launched.

**Consequence for D-004.** Rewind counts as an available safeguard for unattended sessions
again, alongside sandbox, the audit log, `disallowedTools`, interrupt and git. (The spend
ceiling was on this list until D-015 removed it.)

## D-013 — Review changes with git, since we cannot undo them

**Date:** 2026-08-07 · **Status:** accepted

D-012 removed rewind, which left no way to answer "what did that unattended session actually
do to my code" from the phone. Two views fill the gap, and they are complementary:

- **Inline `Edit` diffs on tool cards.** An `Edit` already carries `old_string` and
  `new_string`, so the diff of what the agent changed costs nothing extra: no round trip, and
  it still renders for sessions that have already ended. A `Write` shows as all-additions
  because the tool input genuinely has no "before".
- **Repo-level diff via git** (`session.diff`). Uncommitted tracked changes plus untracked
  paths, per file. This is the one you open after coming back to an unattended session.

The sheet states plainly that it is read-only and that undoing means using git at the desk.
Offering a revert button would mean the daemon mutating a working tree on a tap, which is a
much larger commitment than reading — and git already does it better.

**Amended 2026-08-07 — the diff defaults to this session's own changes.** Showing the whole
working tree answered the wrong question: "what is uncommitted here" rather than "what did that
unattended session do". They differ exactly when you already had work in progress, which is
when you most need to tell them apart.

Touched files are gathered from the same `PreToolUse` hook that writes the audit log, limited
to mutating tools (`Write`, `Edit`, `NotebookEdit`) — a `Read` tells you nothing about what
changed. They are stored project-relative and handed to git as pathspecs after `--`, so a path
can never be read as an option. A `Whole project` toggle is still there, and a session that has
written nothing falls back to the project view and says so, rather than reporting "nothing
changed" — which would be true but misleading.

Verified with an agent editing one file while a second file was already dirty by hand: session
scope showed only the agent's file, project scope showed both.

The touched set is persisted to `sessions.json` on the first write to each path, so a session
resumed after a daemon restart keeps its scope. Saved per new file rather than batched at
shutdown — the case worth surviving is a crash, and writes are rare enough that the cost is
nothing. Verified by reading the file back off disk after a live turn.

Known limit: only `Write`/`Edit`/`NotebookEdit` are tracked, so files changed by a `Bash`
command the agent ran are invisible to the scoped view. `Whole project` is the honest fallback,
and this is why the toggle stays rather than being an implementation detail.

Constraints on the git integration, since it runs a subprocess:

- Only `git`, only read-only subcommands (`rev-parse`, `diff`, `ls-files`).
- Arguments always as an array, never a shell string, so a path cannot become a command.
- `cwd` is re-checked against `projectRoots` at call time even though the session already
  exists — the containment boundary is checked where the command runs, not only where the
  session was created.
- Bounded: 8 MB buffer, 20 s timeout, patch clipped at 512 KB with `truncated` reported.
- No git, or not a repository, is a normal answer with a reason — not an error.

## D-006 — Forward SDK messages verbatim over the wire

**Date:** 2026-08-07 · **Status:** accepted

The daemon wraps SDK messages in an envelope carrying `sessionId` and `seq` but does not
remap their contents to a bespoke schema. Less code, and new SDK message types reach the UI
without a daemon change. Cost: the frontend is coupled to the SDK's message shape, so the
SDK version is pinned.

## D-015 — No spend ceiling; cost is watched, not capped

**Date:** 2026-08-18 · **Status:** accepted

`maxBudgetUsd` is gone — from the SDK options, the protocol, the session record, and the New
session sheet. `REY_DEFAULT_MAX_BUDGET_USD` is no longer read.

Why: the ceiling does not pause a turn, it kills it. Crossing it ends the turn with SDK result
subtype `error_max_budget_usd`, which the phone rendered as "Turn ended with an error · error
max budget usd" with whatever the agent was mid-way through left half-done. On a real session
that reads as the app breaking for no stated reason, and the default of $5 was low enough that
an ordinary afternoon of work tripped it. A tripwire that stops work in an unrecoverable state
is worse than no tripwire.

What governs spend instead: cumulative cost is on the session header and per-turn cost is on
every result line, and interrupt is permanently one tap away (D-004). That is watching and
stopping rather than capping — which is what actually happened in practice anyway, since
recovering from a tripped ceiling meant starting a new session.

Cost accounting itself (`costUsd`, `onCost`, the persisted total) is untouched; only the
enforcement is removed. Sessions persisted with a `maxBudgetUsd` field simply stop being read.

## D-016 — Progress frames are dropped at the daemon

**Date:** 2026-08-18 · **Status:** accepted

The daemon forwards SDK messages verbatim (D-006) but no longer forwards *every* message.
`packages/daemon/src/event-noise.ts` drops per-frame progress before it reaches the event log:
`system/thinking_tokens`, `system/status`, `task_progress`, `hook_progress`,
`session_state_changed`, `tool_progress`, `keep_alive`, and thinking/signature stream deltas.

This fixed two symptoms with one cause. The visible one: the reducer turned every `system`
message whose subtype was not `init` into a transcript notice, and `thinking_tokens` fires on
every thinking frame, so a working session filled the conversation with identical "thinking
tokens" lines. The quiet one: those frames occupy slots in the per-session ring buffer
(`REY_EVENT_BUFFER`, 2000), so a long turn evicted real messages and replayed with the "this
history has a gap" banner — the buffer was being spent on frames nothing renders.

Both ends are now explicit rather than permissive:

- daemon: drop the progress frames listed above. Status is derived *before* the filter, so the
  session still shows as working. Text deltas stay — they are the live typing.
- reducer: `system` subtypes earn a notice from a whitelist (`compact_boundary`,
  `permission_denied`, the two `model_refusal_*`, `informational` above level `info`,
  `notification`) instead of "anything but `init`".

This narrows D-006: message *contents* are still passed through unmapped, and a new SDK message
type still reaches the UI without a daemon change. What changed is that a new *high-frequency*
type no longer floods the log and the transcript by default. The tradeoff is accepted: an
unrecognised type is now judged by whether a human would want to read it.

Thinking blocks from the final assistant message are still delivered and still rendered, but
the conversation hides them behind a "Thinking (n)" toggle, remembered per device. On a
phone-width transcript a long turn's reasoning pushed the answer off screen.
