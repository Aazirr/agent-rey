# Agent Rey — MVP Scope & Roadmap

## The two MVP goals

1. From my phone, pick which project folder on my computer a Claude Code session runs in,
   and switch between them.
2. From my phone, hold a full Claude Code conversation against that folder — mobile-friendly
   UI, streaming output, real edits to my real working tree — with everything executing
   locally.

Success test: leave the house, open the PWA on cellular, start a session in
`~/Projects/foo`, send a prompt, watch it stream, see the commit on my laptop when I get
home. No cloud session, no third-party proxy.

## Status — 2026-08-07

P0 through P4 are built and verified. Both goals work end to end in a real browser: pick a
project folder from the phone, hold a streaming conversation against it, all executing
locally.

| phase | state |
| --- | --- |
| P0 — daemon skeleton | **done** — HTTP + WS, auth, live SDK session verified |
| Auth (added scope) | **done** — password + revocable device sessions |
| P1 — mobile conversation | **done** — verified in a real browser, incl. a live agent turn |
| P2 — projects and sessions | **done** — scanner, registry, resume, containment, picker UI |
| P3 — resilience | **done** — seq log, replay, dedupe, heartbeat, wake-on-visible |
| P4 — deployment | **done** — tailscale serve, autostart task, QR pairing |
| P5 — VSCode extension | **done** — status bar, session tree, controls |

The MVP is complete. Everything below is polish and hardening.

### Tests — 119 across 8 suites

| command | count | what it covers |
| --- | --- | --- |
| `pnpm test` | 104 | daemon wire protocol (39, incl. model list, file reads, git diff and scope fallback), transcript reducer (17), line diff and patch parser (16), pathspec normalisation (10), extension client (9), QR round-trip (7), file pruning (6) |
| `pnpm test:e2e` | 15 | browser tests on a Pixel 7 viewport against a live daemon |
| `pnpm --filter @agent-rey/daemon test:agent` | +7 | live agent turn over the wire, session-scoped diff proven against a hand-dirtied file, and touched-file persistence read back off disk (spends tokens) |
| `REY_E2E_AGENT=1 pnpm test:e2e` | +2 | browser tests that stream a reply and view a file the agent read |

### Bugs the tests found

Worth recording, because in each case the cheaper verification would have missed it:

1. **`import.meta.url` percent-encoding.** Path resolution broke on any home directory with
   a space in it — which is this machine's. Caught by the daemon smoke test before a UI
   existed. Fixed with `fileURLToPath`.
2. **Half-open WebSocket never detected.** The client only reconnected on `onclose`, so a
   phone that loses signal without a clean close left the UI claiming "connected" forever
   while nothing arrived — the single worst failure mode for this product. Found because a
   Playwright `setOffline` test failed to produce the expected banner. Fixed with an
   application-level ping and a 25s silence watchdog (the browser WebSocket API exposes no
   protocol-level pong, so liveness has to be in-band).
3. **The production build did not run at all.** `packages/shared` was consumed as TypeScript
   source, so the compiled daemon emitted `import '@agent-rey/shared'` → resolved to `.ts`
   → `./protocol.js` not found. Dev worked because `tsx` transpiles on the fly. Found only by
   booting `dist/bin/reyd.js` directly, which is exactly what the autostart task does. Fixed
   by making `shared` a properly compiled package with `dist` + `.d.ts`.
4. **`readFile` always returned null.** The SDK's response field is `contents`, not `content`,
   so the file viewer would have shown "could not read" for every file. Caught by reading the
   SDK's type declarations while wiring the feature, then pinned by a smoke-test assertion on
   real file contents.
5. **Starting a session could open the wrong conversation.** The UI opened `sessions[0]` after
   a start, sorted by last activity — so if another session was mid-turn it had newer activity
   and won. Found because two live-agent tests in sequence made the second one read the first
   one's transcript. Fixed with a `sessionCreated` event carrying the actual new session.
6. **You never saw your own messages.** The CLI does not echo the human's prompt on the message
   stream, so the transcript showed only the agent's half of every turn. Found while wiring
   rewind — the anchor was missing because the message itself was. The daemon now emits it
   (D-011), which also fixed a subscribe-ordering bug that dropped events emitted during
   `session.start`.
7. **The daemon rejected WebSockets from the page it had just served.** The origin check
   allowed only configured origins and `localhost`, never same-origin. Reaching the daemon by
   any hostname — which is what happens the moment it sits behind `tailscale serve` — refused
   every WebSocket while login (plain HTTP, not origin-gated) still succeeded, so the app
   showed "no projects found" and reconnected forever. Found on the first real phone
   connection, in under a minute. **No test could have caught it**: all 15 browser tests and
   the whole smoke suite ran against `127.0.0.1`, which the localhost rule allowed. Fixed by
   matching the origin's host against `Host` and `X-Forwarded-Host` (a reverse proxy may
   rewrite `Host` to the loopback it forwards to), and pinned by four regression checks
   including a forged-origin negative.
8. **A session could not read files in its own project.** On Windows a project root in 8.3
   short form (`C:\Users\FRANZJ~1\...` — what `tmpdir()` returns) is rejected by the CLI's
   permission checks as needing manual approval, so every `Read` was denied and the agent
   burned a turn explaining why. `expandPath` now canonicalises via `realpathSync.native`, and
   `isPathAllowed` canonicalises both sides so two spellings of one directory cannot give two
   different answers to a security check. Fixing it cut the live-agent test pair from 2.6
   minutes to 11 seconds.

## Phases

**P0 — daemon skeleton** ✅
Node service, WS server, token auth, live session driven through the Agent SDK. Verified by
`packages/daemon/test/smoke.mjs`, no UI. Proved the stream-json plumbing before any frontend
existed — which is how the two `import.meta.url` path bugs surfaced in a test rather than on
a phone.

**P1 — mobile conversation** ✅
React PWA, mobile-first. Connect screen (daemon address, a runtime setting so one Vercel
build serves any tailnet), password login, streaming conversation, tool cards collapsed to one
scannable line, permission-mode switch mid-session, always-visible interrupt.

Frontend decisions worth knowing:

- **Transcript is reduced from final `assistant`/`user` messages, not from stream deltas.**
  Deltas only feed a live "typing" buffer that is discarded the moment the real message
  lands. Building the transcript from deltas would mean reimplementing block assembly and
  getting it wrong on every reconnect. Covered by 15 unit tests including replay-idempotency.
- **Reconnect is gapless by construction.** The client tracks the highest applied `seq` per
  session and re-subscribes with it on every reconnect; events at or below that seq are
  dropped, so overlapping live-push and replay cannot duplicate. `visibilitychange`,
  `online`, and `focus` short-circuit the exponential backoff — a user who just unlocked
  their phone should not wait one out.
- **`dvh` and safe-area insets throughout**, so the composer is never under a soft keyboard
  or a home indicator. 16px inputs to stop iOS zooming on focus. 44px minimum touch targets.
- **The mode selector never remembers your last choice.** It resets to "Ask me" on every new
  session and states the consequence of the selected mode inline — D-004's safeguard made
  concrete rather than documented.
- **The model picker is populated by the CLI**, via `session.models` → `supportedModels()`, so
  it lists what the account can actually use instead of a hardcoded set that would rot.
- **The file viewer reads through the session**, not the daemon's own filesystem access. The
  CLI applies the same permissions as the Read tool, so the phone can never see more than the
  agent could. A refused or missing file reports a reason rather than rendering empty.

**P2 — projects and sessions** ✅
Project scanner over configured roots with git branch detection. Session start with explicit
permission-mode selection, session list, resume by agent session id, containment within
`projectRoots`. Multiple concurrent sessions across different folders. Phone-side project
picker with filter.

**P3 — resilience** ✅
Monotonic `seq` per session, ring buffer plus NDJSON disk mirror, `subscribe{sinceSeq}`
replay with honest `truncated` reporting (the UI says it has a gap rather than implying
continuity), `restoreLastSeq` across daemon restarts, interrupt, client-side reconnect with
jittered backoff and seq-based dedupe.

**P4 — real deployment** ✅

- `scripts/setup-tailscale.ps1` — puts `tailscale serve` in front of the loopback-bound
  daemon, giving a real TLS cert on the MagicDNS name. That cert is what makes the PWA
  installable (a service worker needs a secure context), so TLS is a functional requirement
  here, not just a privacy one.
- `scripts/install-service.ps1` — registers reyd as a Scheduled Task at login. A Scheduled
  Task rather than a Windows service because reyd must run **as you**: it inherits Claude
  credentials from `%USERPROFILE%\.claude` and needs your project folders. LocalSystem would
  have neither. The password goes in an ACL-restricted env file that a launcher script reads,
  so it never appears in the task XML or in a running process's command line.
- `scripts/pair.mjs` — prints the daemon URL as a QR code, zero dependencies. It deliberately
  encodes **only the address** — no password, no token. A QR code is shoulder-surfable and
  ends up in screenshots; pairing convenience is not worth putting a credential in an image.
  The hand-rolled encoder is verified against jsQR, an independent decoder, because a QR that
  renders as plausible blocks but does not scan would only be discovered while standing in a
  hallway pointing a phone at a terminal.
- `vercel.json` — build config, SPA rewrites, and security headers. `connect-src` is
  deliberately wide because the daemon's hostname is a runtime setting, not a build constant.

**P5 — VSCode extension** ✅

Thin client, one more consumer of the daemon exactly like the phone. Status bar showing live
session count, a tree view of sessions, new session via quick-pick (defaulting to the folder
open in the editor, when the daemon allows it), inline interrupt and stop, reveal project
folder, and open today's audit log.

**Scope decision: it does not reimplement the conversation UI.** The PWA already is that, it
is tested, and two transcript renderers would drift immediately. What the extension gives you
is what the phone cannot at the desk — noticing that an unattended session is running in one
of your repos (the status bar turns amber and says so), stopping it in one click, and jumping
into the audit trail — plus a handoff into the real UI for actual conversation.

It authenticates with the same password flow as the phone and stores the token in VSCode
SecretStorage. It gets no local-process exemption: "runs on the same machine" is not an
identity, and granting one would let any local process drive an agent with shell access.

Its `DaemonClient` runs in plain Node, so the part that can actually be wrong — auth,
connection lifecycle, session tracking, containment — is covered by 9 integration tests
against a real daemon. The UI surface is not tested; that would need a VSCode host.

### Housekeeping (was an open question)

The daemon runs for months, and two resources were unbounded: one event log per session
forever, one audit file per day forever. Neither is large individually, which is exactly why
it would have gone unnoticed until a disk filled.

- `REY_SESSION_IDLE_TIMEOUT_MIN` (default 180) — stops sessions idle that long, reclaiming a
  CLI process each. Safe because a stopped session resumes with its context intact, and a
  session in `thinking` is never reaped — it may be mid-way through a long unattended task.
- `REY_AUDIT_RETENTION_DAYS` (default 90) and `REY_LOG_RETENTION_DAYS` (default 30). Audit
  files outlive transcripts because they are the accountability record for unattended
  sessions, and they are tiny by comparison. Logs for sessions still in the registry are kept
  regardless of age, so resuming an old session never finds its history already deleted. `0`
  disables either.

Pruning runs 60s after boot and every 15 minutes after, and is covered by 6 tests — retention
logic deletes data, so the exemption rules are pinned.

## Out of scope for MVP

- Per-tool approval pushed to the phone — deferred by decision, see `decisions.md`
- Multi-user or multi-machine; single operator, single laptop
- Git operations from the phone beyond viewing diffs
- Mirroring into or out of the official Claude Code panel — architecturally impossible
- Local model inference

## Open questions

Resolved:

- ~~Which roots does the project scanner watch, and how deep?~~ → `REY_PROJECT_ROOTS`,
  `REY_SCAN_DEPTH` (default 3). It is a containment boundary, not just config.
- ~~Does the daemon keep sessions warm indefinitely?~~ → idle timeout, default 180 minutes.
- ~~Log growth?~~ → retention windows with a resumability exemption.
- ~~Reading `~/.claude/projects/*.jsonl` for history?~~ → unnecessary. The SDK exposes
  `listSessions` / `getSessionInfo` / `getSessionMessages` as public API, so nothing depends
  on that file format.

- ~~Model selection from the phone?~~ → done. `session.models` asks the CLI which models the
  account may use, so the picker reflects reality rather than a hardcoded list. Mid-session
  switching works, and the choice persists across a resume.
- ~~Viewing a file the agent changed?~~ → done. Tool cards for `Read`/`Write`/`Edit`/
  `NotebookEdit` offer "View file", which reads through `session.readFile`. The CLI applies the
  same read permissions as the Read tool, so the viewer can never see more than the session
  itself could.

Still open:

- Should the phone surface sessions started at the desk by the official Claude Code
  extension? Technically reachable via `listSessions`, but they are not Agent Rey's sessions
  and could not be resumed into its registry without care.
- No test covers the extension's UI surface; that needs a VSCode integration host. Its
  `DaemonClient` is covered.
- ~~E2E leaks sessions toward the concurrency cap?~~ → fixed. `afterEach` stops every session
  on the daemon, reusing one token so cleanup does not inflate the device list.
- **Rewind is withdrawn, not deferred.** See D-012: the checkpoint anchor cannot be obtained
  from an SDK client. A uuid the daemon assigns is rejected, the CLI's own turn uuids are never
  on the stream, and `getSessionMessages` returns empty mid-session. The UI was built and then
  removed rather than shipping a button that always fails.
- ~~No diff view?~~ → done, two of them (D-013). Inline `Edit` diffs on tool cards, free from
  `old_string`/`new_string`; and a repo-level git diff sheet, which is what you open after
  coming back to an unattended session. Read-only by design — undoing means git at the desk.
- ~~`readFile` truncation renders like an error?~~ → fixed. A clipped read now reports
  `truncated` and shows an info note above the content; only a genuine refusal is an error. "Here
  is most of it" and "you cannot see this" are different answers.
- ~~The repo diff shows the whole working tree?~~ → fixed (D-013 amendment). It now defaults to
  the files *this session* wrote, gathered from the audit hook and passed to git as pathspecs,
  with a `Whole project` toggle and an explicit fallback message when the session has written
  nothing. Verified against an agent editing one file while another was dirty by hand.
- ~~Touched files tracked only in memory?~~ → fixed. Persisted to `sessions.json` on the first
  write to each path, so a session resumed after a daemon restart keeps its diff scope. Saved per
  new file rather than on shutdown, because the point is surviving a crash. Verified by reading
  the file off disk after a live agent turn.
- The VSCode extension has no diff surface, though the editor obviously already does this well.
- The scoped diff cannot know about files changed by a `Bash` command the agent ran — only
  `Write`/`Edit`/`NotebookEdit` are tracked. `Whole project` is the honest fallback there.
