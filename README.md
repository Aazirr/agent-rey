# Agent Rey

Drive Claude Code sessions running on your own machine, from your phone.

The conversation, the transcripts, and your working tree stay on the laptop. No cloud
session, no third-party relay holding your code. Prompts and the files Claude reads still go
to the Anthropic API — same as using Claude Code normally; this removes the cloud-session
layer, not the model call.

## Why not just remote-control the VSCode panel

You can't. The official `anthropic.claude-code` extension exposes 23 commands, all window
management and diff accept/reject — none sends a prompt or reads a transcript — and its
conversation UI is a webview no other extension can reach. So Agent Rey spawns `claude`
itself through the Agent SDK, exactly as that extension does internally. Owning the session
is what makes prompt submission, interrupt, session listing, and multi-project possible.

See [docs/decisions.md](docs/decisions.md) D-001.

## Layout

| package | what it is |
| --- | --- |
| `packages/daemon` | **reyd** — the local service. Owns sessions, auth, event log, project scanning. |
| `packages/shared` | Wire protocol types shared by daemon and clients. |
| `packages/web` | Mobile PWA — React + Vite, deployable to Vercel or served by the daemon. |
| `packages/vscode` | VSCode extension — session monitoring and control at the desk. |
| `packages/codex-bridge` | Global Codex MCP frontend worker: isolated worktrees, scoped file edits, account-failure handoff. |

## Delegate frontend work from Codex

The optional [Codex frontend worker](docs/codex-frontend-worker.md) lets Codex give
Claude a scoped UI task, inspect its result and continue the same task with feedback.
It uses separate sessions, not your existing VS Code chat. If Claude is disabled,
logged out or usage-limited, delegation pauses and Codex asks whether to restore
Claude access or continue the preserved work with Codex. Nothing retries or switches
providers automatically. Install once at user level for current/future projects.

## Quick start

```sh
pnpm install
cp .env.example .env      # then set REY_PASSWORD
pnpm --filter @agent-rey/web build   # so the daemon can serve the UI
pnpm dev:daemon
```

Open `http://127.0.0.1:8787` and log in with your `REY_PASSWORD`.

For frontend work, run Vite separately (`pnpm dev:web` on port 5273) and point it at the
daemon — `http://localhost:*` origins are always allowed.

## Put it on your phone

```powershell
.\scripts\install-service.ps1     # password + autostart at login
.\scripts\setup-tailscale.ps1     # HTTPS, tailnet-only
pnpm pair                         # QR code of the daemon URL
```

Full walkthrough and troubleshooting in [docs/deployment.md](docs/deployment.md).

## Use it from VSCode

The extension is a monitoring and control surface, not a second chat UI — conversation stays
in the PWA. It shows live session count in the status bar (amber when something is running
unattended), lists sessions in the Explorer, and gives you interrupt, stop, and a jump to
today's audit log.

```sh
pnpm --filter agent-rey-vscode build
```

Then load `packages/vscode` as an extension (F5 from that folder, or symlink into
`~/.vscode/extensions`) and run **Agent Rey: Sign in to daemon**.

## Reviewing what it did

Two views, because an agent that edits files while you are away needs to be auditable from the
phone:

- **Inline diffs** on `Edit`/`Write` tool cards — reconstructed from the tool input, so they
  cost nothing and still render for finished sessions.
- **Changes** in the conversation toolbar — a git diff per file, plus untracked additions.
  Defaults to **the files this session wrote**, not the whole working tree, so your own
  in-progress work is not attributed to the agent. Toggle to `Whole project` when you want
  everything.

Both are read-only. Undoing means git at the desk; see [D-012](docs/decisions.md) for why
in-app rewind is not available.

### Tests

```sh
pnpm test                                     # 104: daemon 39, reducer 17, diff 16, paths 10, ext 9, QR 7, prune 6
pnpm test:e2e                                 # 15 browser tests on a phone viewport
pnpm --filter @agent-rey/daemon test:agent    # live agent turn + scoped-diff proof (spends tokens)
```

The daemon smoke test spawns a real daemon in a temp directory and drives it over HTTP +
WebSocket: wrong-password rejection, login throttling, unauthenticated socket refusal, forged
and revoked token rejection, cross-origin upgrade rejection, project discovery, path
containment, device listing and revocation.

The e2e suite runs Chromium at a Pixel 7 viewport against a live daemon serving the real
bundle: login, wrong-password handling, token persistence across reload, project picker,
session start, composer reachability above the fold, daemon-loss reconnect, half-open socket
detection, and device revocation signing another browser out. `REY_E2E_AGENT=1` adds a real
prompt and asserts the reply streams in.

Reducer tests pin that replaying the same events is idempotent — the property that makes
reconnect-with-gap-replay safe. QR tests round-trip through jsQR, an independent decoder.

## Configuration

Everything is environment variables, documented in [.env.example](.env.example). The one you
must set is `REY_PASSWORD`.

A few worth understanding:

- `REY_SESSION_IDLE_TIMEOUT_MIN` — stops sessions idle this long (default 180 min) to reclaim
  a CLI process. Safe: a stopped session resumes with context intact, and a session actively
  working is never reaped.
- `REY_AUDIT_RETENTION_DAYS` / `REY_LOG_RETENTION_DAYS` — the daemon runs for months, so both
  are bounded. Audit files keep longer than transcripts because they are the accountability
  record. Logs for still-resumable sessions are kept regardless of age.

- `REY_PROJECT_ROOTS` — the **only** directories a session may run in. `session.start` for
  anything outside them is refused. This is a containment boundary, not a convenience.
- `REY_DEFAULT_PERMISSION_MODE` — stays `default` on purpose. Unattended modes should be a
  deliberate per-session choice, not a daemon-wide assumption.
- `REY_CHECKPOINTING` — on by default; enables rewinding an unattended session's file
  changes.
- `REY_ALLOWED_ORIGINS` — set this to your Vercel URL if you serve the PWA there. Browsers
  don't enforce same-origin on WebSockets, so the daemon checks it.

## Security posture

A successful login yields an agent with shell access to this machine. Three layers:

1. **Network** — `tailscale serve` fronts the daemon; it binds loopback and is not reachable
   off your tailnet.
2. **Password** — `REY_PASSWORD`, scrypt-hashed at boot, never persisted or logged,
   constant-time compared. Per-source exponential backoff plus a global lockout after 10
   failures.
3. **Device sessions** — HMAC-signed tokens backed by a persisted store, so any single phone
   can be revoked without logging out the rest. 30-day sliding expiry.

The password lives only on the daemon. A Vercel-hosted frontend never sees it.

Every tool call is appended to a daily NDJSON audit log in `$REY_STATE_DIR/audit/`,
regardless of permission mode.

## Docs

- [docs/architecture.md](docs/architecture.md) — components, protocol, auth, risks
- [docs/deployment.md](docs/deployment.md) — tailnet setup, autostart, pairing, troubleshooting
- [docs/mvp-scope.md](docs/mvp-scope.md) — phases, status, and the bugs the tests caught
- [docs/decisions.md](docs/decisions.md) — why it is built this way
