# Deploying Agent Rey

Two halves that never mix: the **daemon** runs on your machine and is the only thing that
touches your code; the **PWA** is a static bundle that can be served from either the daemon
or Vercel. Nothing in the deployment story puts your repository or your password on someone
else's hardware.

## How access actually works

Worth reading once, because the arrangement is not the usual "app on a host with a password in
its environment", and the difference is easy to get wrong.

**A tailnet** is your own private network of devices. Install Tailscale on the laptop and the
phone, sign both into the same account, and the laptop gets a stable name like
`laptop.tail1a2b.ts.net` that the phone can reach from anywhere — home, cellular, an airport — as
though they shared a router. A device not signed into your tailnet cannot reach that name at all:
it does not resolve and there is no route. Not "reaches it and is refused" — there is nothing
there from outside.

**Two gates, answering different questions:**

| gate | question it answers | what proves it |
| --- | --- | --- |
| Tailnet | can this device reach my daemon at all? | your Tailscale account, once per device |
| Password | should this device get a token? | you typing `REY_PASSWORD`, once per device |

**The flow.** First time on a device: the page loads from Vercel (anyone can do that), finds no
saved token, and shows the password screen. You type it; it goes to the daemon over the tailnet;
the daemon scrypt-compares it and issues a device token, which the browser keeps in
`localStorage`. Every time after, the page sends that token in the first WebSocket frame and the
daemon verifies its HMAC *and* looks the device up in its store. No password prompt — the token
is what "it knows me" means, valid 30 days and renewed while in use.

**A stranger with your Vercel URL** gets a login form that cannot reach anything. Their guesses
go to a hostname that does not resolve for them, so the password is never even tested. The page
is only a client; without tailnet access it is inert. This is why the deployment being public is
not the exposure it appears to be.

**Where this is weak**, so you know rather than discover:

- An unlocked phone with a saved token gets straight in, with no password re-prompt. Revoke it
  from the Devices sheet on another device; the token dies immediately.
- Anyone on your tailnet is already past gate 1 and needs only the password. Do not share a
  tailnet with people you would not give a shell to.
- Skipping Tailscale and exposing the port directly leaves the password as the only gate. The
  daemon warns at startup when it is not bound to loopback.

## 1. Build and install the daemon

```powershell
pnpm install
pnpm build                          # shared → daemon → web, in that order
.\scripts\install-service.ps1
```

The install script prompts for a password (offering a generated one), writes it to
`~\.agent-rey\reyd.env` with an owner-only ACL, and registers a Scheduled Task that starts
reyd at login.

Why a Scheduled Task and not a Windows service: reyd has to run **as you**. It inherits your
Claude credentials from `%USERPROFILE%\.claude` and needs read/write access to your project
folders. A LocalSystem service would have neither.

Why the password lives in a file rather than the task definition: Task Scheduler stores
arguments in plain XML, and a process's command line is readable by any other local process.
The task runs a launcher script; the launcher reads the env file.

Start it and confirm:

```powershell
Start-ScheduledTask -TaskName AgentRey-reyd
curl http://127.0.0.1:8787/health
Get-Content ~\.agent-rey\reyd.out.log -Tail 20
```

## 2. Expose it to your tailnet

```powershell
.\scripts\setup-tailscale.ps1
```

This runs `tailscale serve --bg --https=443 http://127.0.0.1:8787`. Three things it gets you:

- **Reachability from anywhere** you can get on your tailnet, including cellular
- **A real TLS certificate** on the MagicDNS name. This is a functional requirement, not
  just privacy hygiene: a service worker needs a secure context, so without TLS the PWA is
  not installable
- **Loopback binding stays intact** — the daemon itself is never listening on your LAN or
  the public internet. Tailscale is the only path in

Prerequisites: Tailscale installed and signed in, with MagicDNS and HTTPS certificates
enabled for the tailnet (admin console → DNS).

## 3. Pair your phone

```powershell
pnpm pair
```

Prints a QR code of the daemon URL. Scan it, then enter your password.

The QR contains **only the address**. No password, no token. QR codes get photographed,
screenshotted, and shoulder-surfed; a credential in one is a credential you have lost track
of.

## 4. Optional — serve the PWA from Vercel

The daemon serves the PWA itself by default (`REY_SERVE_WEB=1`), which needs no third party
at all. Vercel is worth it only if you want the frontend to auto-update without rebuilding
on the laptop.

```sh
vercel --prod
```

**Vercel needs no environment variables.** Every `REY_*` setting belongs to the daemon. The
frontend reads exactly one build-time constant (`import.meta.env.PROD`, a Vite substitution) and
nothing else, so there is nothing to configure and nothing baked into the bundle. The daemon's
address is a runtime setting in `localStorage` — that is what lets one deployment serve any
tailnet.

Dashboard settings that do matter:

| setting | value | why |
| --- | --- | --- |
| Root Directory | *(empty — repo root)* | monorepo; the build also needs `packages/shared` |
| Framework Preset | Other | `vercel.json` sets `framework: null`; auto-detecting Vite would override the build command |
| Install / Build | *(from `vercel.json`)* | leave the dashboard fields blank |

`installCommand` uses `--frozen-lockfile`, so **`pnpm-lock.yaml` must be committed** or the
install fails before the build starts.

The build command is `pnpm --filter @agent-rey/web... build` — note the `...`, which means "and
its dependencies". Without it the build fails on a clean checkout: `@agent-rey/shared` is a
compiled package, and `packages/shared/dist` does not exist until it is built. A local
`pnpm -r build` hides this because it resolves dependency order for you.

Then tell the daemon to accept that origin, in `~\.agent-rey\reyd.env`:

```
REY_ALLOWED_ORIGINS=https://your-app.vercel.app
```

This is required — without it the page loads but every WebSocket is rejected at upgrade. Browsers
do not apply same-origin policy to WebSocket connections, so the daemon checks `Origin` itself,
and that check is what stops any site you happen to visit from reaching your daemon. Use the
exact origin with no trailing slash; add preview URLs comma-separated if you use them.

**What Vercel does and does not see.** It serves the static app shell — HTML, JS, CSS. It
never sees your password (typed in the browser, sent to the daemon), your conversations, or
your code; those go over the tailnet directly to your machine. The daemon's address is not
baked into the build either, so one deployment works for any tailnet.

**The tradeoff.** A Vercel-hosted page holds your device token in `localStorage`, so whoever
controls that deployment controls the code your phone runs. That is a real if narrow
escalation path, and it is why the daemon keeps the ability to self-serve. If it bothers you,
set `REY_SERVE_WEB=1` and skip this section.

## Operating notes

**Revoke a lost phone** from the Devices sheet in the app. It signs that device out
immediately without affecting others and without rotating the signing secret. Sessions it
started keep running on the daemon — stop those separately if that is what you want.

**Rotate the password** by editing `~\.agent-rey\reyd.env` and restarting the task. Existing
device tokens survive a password change by design: the password authenticates a *new* device,
tokens authenticate known ones. To invalidate every device, delete `~\.agent-rey\auth.json`
and restart.

**Audit what an unattended session did** in `~\.agent-rey\audit\audit-YYYY-MM-DD.ndjson` —
every tool call, with the permission mode in effect, regardless of mode.

**Undo an unattended session's file changes** with rewind, which works when
`REY_CHECKPOINTING=1` (the default). Git remains the backstop.

## Troubleshooting

| symptom | cause |
| --- | --- |
| Login always fails with "no REY_PASSWORD set" | the task is running without the env file loaded; check `reyd.out.log` |
| Phone shows "Could not reach the daemon" | not on the tailnet, or `tailscale serve` is not configured — run `tailscale serve status` |
| WebSocket connects then immediately closes | `REY_ALLOWED_ORIGINS` does not include the origin serving the PWA |
| Logs in fine, then "no projects found" and endless reconnecting | WebSocket upgrades are being refused. Check the log for `Rejected WebSocket from disallowed origin`. Login is plain HTTP and is not origin-gated, which is why it succeeds while everything else fails. Same-origin is allowed automatically; a *different* origin (a Vercel deployment) must be in `REY_ALLOWED_ORIGINS` |
| "No projects found" | `REY_PROJECT_ROOTS` points somewhere that does not exist, or nothing under it has a project marker |
| PWA will not install | served over plain HTTP; a secure context is required, so finish step 2 |
| Daemon starts in dev but not from the task | run `pnpm build` — the task runs compiled `dist`, not `tsx` |
| Vercel build: `Cannot find module '@agent-rey/shared'` | the build command lost its `...` suffix, so the shared package was never built |
| Vercel install fails immediately | `pnpm-lock.yaml` is not committed, and `--frozen-lockfile` requires it |
