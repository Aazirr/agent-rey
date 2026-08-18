# Agent Rey — Architecture

## Purpose

Drive Claude Code sessions on my own machine from my phone. The conversation, the
transcripts, and the working tree never leave the laptop. No Claude Code on web, no
third-party relay.

## What this is not

Agent Rey does **not** remote-control the official `anthropic.claude-code` VSCode panel.
That was the original idea; it is not buildable. Verified against the installed
extension (v2.1.223):

- It contributes 23 commands, all window-management or diff-accept. None sends a prompt
  and none reads a transcript.
- Its conversation UI is a webview owned by that extension. VSCode gives other
  extensions no access to another extension's webview DOM or message channel.
- Its `package.json` declares no public extension API.

The extension is itself only a client: it spawns the `claude` CLI with
`--input-format stream-json --output-format stream-json`. Agent Rey does the same thing,
so it owns its sessions outright and can expose everything the panel keeps private —
prompt submission, interrupt, session listing, multi-project.

## Privacy boundary — stated precisely

What stays local:

- Session transcripts (`~/.claude/projects/`) and Agent Rey's own event logs
- The repository — never uploaded to a cloud sandbox
- All transport between phone and machine, over a private WireGuard mesh

What still leaves the machine: prompts and the file contents Claude reads, to the
Anthropic API — identical to using the official panel today. Agent Rey removes the
cloud-session layer, not the model call. Local inference is out of scope.

## Components

```
┌─ phone ──────────────┐
│  PWA (React)         │
└──────────┬───────────┘
           │ WSS  (tailscale serve → real TLS cert, tailnet-only)
┌──────────▼────────────────────────────────────────────┐
│  reyd — standalone Node daemon                        │
│                                                       │
│   ws server ── auth ── session registry               │
│                            │                          │
│        project scanner     ├── Session (cwd=projA) ──┐ │
│        event log / replay  ├── Session (cwd=projB) ──┤ │
│        audit log           └── Session (cwd=projC) ──┤ │
└──────────┬───────────────────────────────────────────┼─┘
           │ ws (same protocol, localhost)             │ stream-json
┌──────────▼───────────┐                    ┌──────────▼──────────┐
│ VSCode extension     │                    │  claude CLI ×N      │
│ (thin client, P5)    │                    │  via Agent SDK      │
└──────────────────────┘                    └─────────────────────┘
```

### reyd (the daemon)

Owns everything. Runs as a background service independent of VSCode, so sessions survive
editor restarts and I can prompt from my phone with no editor open. This is the reason we
did not build it inside the extension.

Responsibilities:

- One `claude` child process per live session, driven through
  `@anthropic-ai/claude-agent-sdk`
- Session registry: id, project cwd, permission mode, model, status, last activity
- Per-session monotonic event log — in-memory ring buffer plus append-only file on disk
- Project discovery over configured roots
- WS server, token auth
- Audit log of every tool invocation

### Sessions and project folders

A session's root is the SDK's `cwd`, set at session start. This is the key decoupling:
**VSCode's open folder is irrelevant.** One daemon hosts sessions rooted in any number of
project folders simultaneously. Never call `vscode.openFolder` to "switch project" — it
restarts the extension host and would kill sessions.

Project discovery: depth-limited scan of roots listed in config, matching git repos or
package manifests. Results cached with a manual refresh from the phone.

### Permission model

Decided: per-session permission mode, chosen at session start, no per-tool push prompts in
the MVP. See `decisions.md` for rationale and accepted risk.

- Mode is an explicit choice on every session start. It does not persist as a default, so
  an unattended mode is never entered by accident.
- Every tool call is written to the audit log regardless of mode.
- Interrupt is a first-class, always-visible control in the mobile UI — it is the primary
  safeguard when running unattended.
- Config supports a per-project `disallowedTools` list as a hard floor that mode cannot
  override.

### Reconnect and replay

Phones sleep mid-turn; this must be non-lossy or the product is unusable. Every session
event gets a monotonic `seq`. Clients subscribe with `sinceSeq` and the daemon replays the
gap from the ring buffer (falling back to the on-disk log if the client was away long
enough to age out). Streaming continues in the background whether or not a client is
attached — the daemon is the source of truth, never the UI.

### Transport

`tailscale serve https / http://127.0.0.1:<port>` fronts the daemon. This gives a real TLS
certificate on the MagicDNS name, reachable only from my tailnet. Two things it buys
beyond privacy: the PWA gets a secure context (required for service workers and install),
and the daemon itself binds only to loopback so it is never exposed on LAN or public
internet.

### Authentication

Three layers, because a successful login yields an agent with shell access to this machine:

1. **Network** — tailnet-only reachability (D-003). A leaked credential is not usable from
   off my devices.
2. **Password** — `REY_PASSWORD` from the daemon's environment, hashed with scrypt
   (N=2^15) at boot. The plaintext is never persisted or logged. Verified with
   `timingSafeEqual`. Failed logins get per-source exponential backoff plus a global
   lockout after 10 failures, since a password guarding a shell will be guessed at.
   **The password lives only on the daemon** — a Vercel-hosted frontend never sees it.
3. **Device sessions** — login exchanges the password for a token
   `<deviceId>.<expiry>.<HMAC-SHA256>`, signed with a persisted secret. Verification checks
   the HMAC *and* looks the device up in a persisted store, so any single device can be
   revoked server-side without rotating the secret. 30-day sliding expiry, renewed
   automatically past the halfway mark so a phone in daily use never hits a wall.

The WebSocket does nothing until its first frame presents a valid token; an unauthenticated
socket is closed after 10 seconds. `Origin` is checked at upgrade because browsers do not
enforce same-origin on WebSockets — that check is ours to make.

### Where the PWA is hosted

The frontend may be served from Vercel *or* from the daemon itself (`REY_SERVE_WEB`).
Vercel only ever serves the static app shell: the conversation, the code, and the password
all stay on the local daemon, which the page reaches directly over the tailnet. The
tradeoff to be aware of is that a Vercel-hosted page holds the device token, so whoever
controls that deployment controls the code the phone runs — hence the daemon keeping the
ability to self-serve.

### The PWA (`packages/web`)

React + Vite, no router and no state library — there are four top-level phases
(resolving → connect → login → shell) gated on connectivity and auth rather than on URLs,
and a Map of transcripts keyed by session id.

The one piece with real logic is `lib/transcript.ts`, which reduces the verbatim SDK message
stream into renderable items. `system` messages earn a notice from a whitelist rather than
"anything but `init`" (D-016), and the model's thinking sits behind a per-device toggle. It is a pure function of `(state, seq, message)`, which is what
lets a replayed gap be applied through the same path as a live event with no special casing.
Its contract — idempotent, non-mutating, tolerant of unknown message types — is pinned by
unit tests, because a mistake there shows up as duplicated or missing conversation rather
than a crash.

Content comes from final `assistant` / `user` messages; `stream_event` deltas only drive a
transient "typing" buffer that is cleared when the real message arrives. Building the
transcript from deltas would mean reimplementing block assembly, and getting it wrong
specifically on reconnects.

The service worker caches the app shell only. Session data is all live WebSocket, and caching
API responses would risk showing stale session state — worse than showing none. It never
intercepts `/api/*` or `/ws`.

### VSCode extension (`packages/vscode`)

Deliberately thin — one more client of the daemon, exactly like the phone, with no agent logic
of its own. Status bar with live session count (amber when something is running unattended),
tree view of sessions, new-session quick-pick, inline interrupt/stop, reveal project folder,
open today's audit log.

It does **not** render conversations. See D-009: a second transcript renderer would duplicate
the reducer, the tool cards and the reconnect logic, and the two would drift. Conversation
happens in the PWA, which the extension links to.

Authenticates with the same password flow as the phone, token in VSCode SecretStorage. No
local-process exemption — running on this machine is not an identity.

The logic lives in `DaemonClient`, which runs in plain Node and is therefore testable without
a VSCode host. It has the same half-open-socket heartbeat as the browser client, for the same
reason.

### Housekeeping

The daemon is meant to run for months, so both unbounded resources are capped (D-010): idle
sessions are stopped after `REY_SESSION_IDLE_TIMEOUT_MIN` (default 180) to reclaim a CLI
process, and audit/event-log files are pruned on retention windows. A session still in the
registry keeps its event log regardless of age, so resuming an old session never finds its
history deleted. Runs 60s after boot, then every 15 minutes.

## Wire protocol (draft)

Client → daemon:

| message | payload |
| --- | --- |
| `hello` | `{ token, clientId }` |
| `projects.list` | `{ refresh?: boolean }` |
| `sessions.list` | — |
| `session.start` | `{ projectPath, permissionMode, model? }` |
| `session.resume` | `{ sessionId }` |
| `session.prompt` | `{ sessionId, text }` |
| `session.interrupt` | `{ sessionId }` |
| `session.stop` | `{ sessionId }` |
| `subscribe` | `{ sessionId, sinceSeq }` |

Daemon → client:

| message | payload |
| --- | --- |
| `hello.ok` | `{ daemonVersion, sessions }` |
| `projects` | `{ projects: [{ path, name, vcs, lastUsed }] }` |
| `session.created` | `{ sessionId, projectPath, permissionMode }` |
| `event` | `{ sessionId, seq, message }` — `message` is the SDK message, passed through |
| `session.status` | `{ sessionId, status }` |
| `error` | `{ code, message, sessionId? }` |

SDK messages are forwarded verbatim rather than remapped to a custom schema. Less code, and
new SDK message types surface in the UI without a daemon change.

Verbatim in content, not in volume: `src/event-noise.ts` drops per-frame progress
(`thinking_tokens`, `status`, `task_progress`, `hook_progress`, `session_state_changed`,
`tool_progress`, `keep_alive`, thinking/signature deltas) before it reaches the event log.
Nothing renders those frames, and leaving them in both spammed the transcript and evicted real
messages from the ring buffer — D-016. Status is derived before the filter, so a working
session still reads as working.

## SDK verification (done)

Verified against `@anthropic-ai/claude-agent-sdk@0.3.223`, pinned exactly. Every
assumption above held, and four capabilities changed the design for the better:

| capability | why it matters here |
| --- | --- |
| `sandbox: SandboxSettings` | tool calls can run sandboxed — a real containment layer for unattended sessions |
| ~~`maxBudgetUsd`, `taskBudget`~~ | a per-session spend ceiling — wired in, then removed: it kills a turn mid-work rather than pausing it (D-015) |
| `enableFileCheckpointing` + `Query.rewindFiles()` | genuine undo of an unattended run's file changes, keyed by user message |
| `Query.reinitialize()` | documented for "reattaching to a daemon whose ring buffer evicted frames during a disconnect" — the SDK anticipates exactly this architecture |

Also confirmed: `listSessions` / `getSessionInfo` / `getSessionMessages` are public, so
reading history never requires parsing `~/.claude/projects/*.jsonl`; `Query.readFile()`
exists "for the remote sidebar viewer", which is what the phone's file view is; and the SDK
ships a vendored `claude` binary per platform as an optional dependency
(`claude.exe`, 268 MB on win32-x64), so there is no dependency on a `claude` on `PATH`.

Streaming input mode is mandatory rather than optional: `interrupt()`,
`setPermissionMode()`, and `setModel()` only exist there. Hence `PromptQueue`.

## Known risks

| risk | mitigation |
| --- | --- |
| Unattended mode makes unwanted repo changes | sandbox + file checkpointing with `rewindFiles`; interrupt always visible; audit log of every tool call; per-project `disallowedTools` floor; work in a git repo |
| An unattended session runs up a bill | no spend ceiling by design (D-015); per-turn and cumulative cost are on screen, interrupt is one tap away |
| An authenticated client points an agent at an arbitrary directory | `session.start` re-checks containment within `projectRoots`; verified by smoke test |
| Password brute force | scrypt + `timingSafeEqual`, per-source exponential backoff, global lockout, tailnet-only reachability |
| Agent SDK API drift | SDK pinned to an exact version; the wrapper is one file (`agent-session.ts`) |
| Daemon crash loses live turns | NDJSON event log per session; `restoreLastSeq` continues the seq series; resume by stored agent session id |
| Token leak = full shell on my machine | tailnet-only reachability; per-device revocation; 30-day sliding expiry |
| Vercel-hosted frontend is compromised | daemon can self-serve the PWA (`REY_SERVE_WEB`); password never leaves the daemon |
