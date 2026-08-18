/**
 * End-to-end: a real browser driving the real UI against a real daemon.
 *
 * This is the test that was missing after P1 — the reducer had unit tests and the
 * protocol had a smoke test, but nothing proved that login → pick project → send
 * actually works in a browser. Everything here runs against a freshly spawned
 * reyd with a scratch state dir and scratch project root.
 *
 * A session is started without a prompt in most tests: that boots the CLI but
 * makes no model call, so the suite is cheap. Set REY_E2E_AGENT=1 for the test
 * that sends a real prompt and asserts streamed output.
 */

import { test, expect, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PASSWORD = 'e2e-correct-horse-battery';
const PORT = 8811;
const BASE = `http://127.0.0.1:${PORT}`;

let daemon: ChildProcess | null = null;
let scratch: string;
let projectsRoot: string;
let demoProject: string;
let gitProject: string;
let daemonLog = '';

async function startDaemon(): Promise<void> {
  const daemonDir = fileURLToPath(new URL('../../daemon/', import.meta.url));
  daemon = spawn(process.execPath, ['--import', 'tsx', 'src/bin/reyd.ts'], {
    cwd: daemonDir,
    env: {
      ...process.env,
      REY_PASSWORD: PASSWORD,
      REY_PORT: String(PORT),
      // Same state dir across restarts, so device tokens and sessions persist —
      // that persistence is what the restart tests are checking.
      REY_STATE_DIR: join(scratch, 'state'),
      REY_PROJECT_ROOTS: projectsRoot,
      REY_SERVE_WEB: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemon.stdout?.on('data', (d: Buffer) => {
    daemonLog += d.toString();
  });
  daemon.stderr?.on('data', (d: Buffer) => {
    daemonLog += d.toString();
  });

  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`daemon did not start:\n${daemonLog}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function stopDaemon(): Promise<void> {
  const proc = daemon;
  if (!proc) return;
  daemon = null;
  proc.kill('SIGTERM');
  // Wait for the port to actually free, or a restart races the old listener.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE}/health`);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 500));
}

test.beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'rey-e2e-'));
  projectsRoot = join(scratch, 'projects');
  demoProject = join(projectsRoot, 'demo-app');
  mkdirSync(demoProject, { recursive: true });
  writeFileSync(join(demoProject, 'package.json'), '{"name":"demo-app"}\n');
  // A second project so the picker has something to choose between.
  mkdirSync(join(projectsRoot, 'other-lib'), { recursive: true });
  writeFileSync(join(projectsRoot, 'other-lib', 'package.json'), '{"name":"other-lib"}\n');

  // A real git repo with a real uncommitted change, so the Changes sheet has
  // something to show without needing an agent turn.
  gitProject = join(projectsRoot, 'git-repo');
  mkdirSync(gitProject, { recursive: true });
  writeFileSync(join(gitProject, 'package.json'), '{"name":"git-repo"}\n');
  writeFileSync(join(gitProject, 'tracked.txt'), 'alpha\nbravo\ncharlie\n');
  const git = (args: string[]): void => {
    spawnSync('git', args, { cwd: gitProject, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  };
  git(['init', '-q']);
  git(['config', 'user.email', 'e2e@example.com']);
  git(['config', 'user.name', 'E2E']);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'initial']);
  writeFileSync(join(gitProject, 'tracked.txt'), 'alpha\nMODIFIED\ncharlie\n');
  writeFileSync(join(gitProject, 'untracked.txt'), 'brand new\n');

  // Enough projects that the picker must scroll. The layout bug that shipped —
  // the picker collapsing to zero height — only shows up with a long list on a
  // short viewport, so the fixture has to be realistic about size.
  for (let i = 0; i < 20; i++) {
    const bulk = join(projectsRoot, `bulk-project-${String(i).padStart(2, '0')}`);
    mkdirSync(bulk, { recursive: true });
    writeFileSync(join(bulk, 'package.json'), `{"name":"bulk-${i}"}\n`);
  }

  await startDaemon();

  // Confirm the daemon is serving the built bundle, not just the API — otherwise
  // every UI assertion below would fail for a confusing reason.
  if (!/serving PWA from/.test(daemonLog)) {
    throw new Error(`daemon is not serving the PWA. Run \`pnpm --filter @agent-rey/web build\` first.\n${daemonLog}`);
  }
});

/**
 * Delete every session on the daemon.
 *
 * Each test starts a session and nothing stopped them, so a full run drifted
 * toward `maxConcurrentSessions` and would eventually fail the last tests for a
 * reason unrelated to what they assert. One reused token, so cleanup does not
 * inflate the device list that other tests look at.
 */
let cleanupToken: string | null = null;

async function deleteAllSessions(): Promise<void> {
  if (!daemon) return;
  try {
    if (!cleanupToken) {
      const res = await fetch(`${BASE}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD, label: 'e2e-cleanup' }),
      });
      const body = (await res.json()) as { token?: string };
      cleanupToken = body.token ?? null;
    }
    if (!cleanupToken) return;

    // Node 22+ has a global WebSocket, so no extra dependency here.
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('cleanup socket timeout')), 10_000);

      ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', token: cleanupToken, protocolVersion: 1 }));
      ws.onerror = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onmessage = (ev: MessageEvent) => {
        const msg = JSON.parse(String(ev.data)) as {
          t: string;
          code?: string;
          sessions?: Array<{ id: string; status: string }>;
        };
        if (msg.t === 'error' && msg.code === 'unauthorized') {
          // The revocation test may have revoked this device; get a fresh token
          // on the next call rather than failing every subsequent cleanup.
          cleanupToken = null;
          clearTimeout(timer);
          ws.close();
          resolve();
          return;
        }
        if (msg.t === 'hello.ok') {
          // Delete rather than stop: a stopped session still shows in the list, so
          // stopping alone let sessions accumulate across tests and made counts
          // depend on execution order.
          for (const s of msg.sessions ?? []) {
            ws.send(JSON.stringify({ t: 'session.delete', sessionId: s.id }));
          }
          clearTimeout(timer);
          // Give the stops a moment to land before closing the socket.
          setTimeout(() => {
            ws.close();
            resolve();
          }, 700);
        }
      };
    });
  } catch {
    // Cleanup is best effort; never fail a test because teardown was awkward.
  }
}

test.afterEach(async () => {
  await deleteAllSessions();
});

test.afterAll(async () => {
  await stopDaemon();
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* Windows may still hold a log handle; scratch is in tmp */
  }
});

async function signIn(page: Page): Promise<void> {
  await page.goto(BASE);
  await expect(page.getByRole('heading', { name: 'Agent Rey' })).toBeVisible();
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('button', { name: 'New session' })).toBeVisible();
}

test('serves the app shell with a manifest and mobile viewport', async ({ page }) => {
  await page.goto(BASE);
  await expect(page).toHaveTitle('Agent Rey');
  const viewport = await page.locator('meta[name=viewport]').getAttribute('content');
  // viewport-fit=cover is what makes the safe-area insets work on iPhone.
  expect(viewport).toContain('viewport-fit=cover');
  const manifest = await page.locator('link[rel=manifest]').getAttribute('href');
  expect(manifest).toBe('/manifest.webmanifest');
});

test('rejects the wrong password and does not leak into the app', async ({ page }) => {
  await page.goto(BASE);
  await page.getByLabel('Password').fill('definitely-not-it');
  await page.getByRole('button', { name: 'Unlock' }).click();

  await expect(page.getByRole('alert')).toContainText('Wrong password');
  await expect(page.getByRole('button', { name: 'New session' })).toBeHidden();
  // The field is cleared so a shoulder-surfer cannot read a failed attempt back.
  await expect(page.getByLabel('Password')).toHaveValue('');
});

test('signs in and lists discovered projects', async ({ page }) => {
  await signIn(page);
  await expect(page.getByText('demo-app').first()).toBeVisible();
  await expect(page.getByText('other-lib').first()).toBeVisible();
});

test('persists the session across a reload', async ({ page }) => {
  await signIn(page);
  await page.reload();
  // No password prompt the second time — the device token was stored.
  await expect(page.getByRole('button', { name: 'New session' })).toBeVisible();
  await expect(page.getByLabel('Password')).toBeHidden();
});

test('signing out requires the password again', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByLabel('Password')).toBeVisible();
});

test('new session sheet defaults to Ask me and warns about unattended modes', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'New session' }).click();

  const sheet = page.getByRole('dialog', { name: 'New session' });
  await expect(sheet).toBeVisible();

  // The D-004 safeguard: never pre-selected into an unattended mode.
  const mode = sheet.getByLabel('Permission mode');
  await expect(mode).toHaveValue('default');
  await expect(sheet.getByText(/Stops and waits for approval/)).toBeVisible();

  // Choosing an unattended mode must state the consequence and offer a spend cap.
  await mode.selectOption('acceptEdits');
  await expect(sheet.getByText(/Edits without asking/)).toBeVisible();
  await expect(sheet.getByLabel(/Spend limit/)).toBeVisible();

  await mode.selectOption('default');
  await expect(sheet.getByLabel(/Spend limit/)).toBeHidden();
});

test('the project picker survives a small screen and a long list', async ({ page }) => {
  // Regression: `.picker` is a flex child AND a scroll container, so its
  // `min-height: auto` resolves to 0 and flexbox collapsed it to nothing on a
  // small phone. The sheet rendered, the footer worked, nothing overflowed — but
  // there was no way to choose a project. Only a short viewport with a long list
  // reproduces it.
  await signIn(page);

  for (const size of [
    { width: 375, height: 667 }, // iPhone SE
    { width: 375, height: 340 }, // iPhone SE with the keyboard up
  ]) {
    await page.setViewportSize(size);
    await page.getByRole('button', { name: 'New session' }).first().click();
    const sheet = page.getByRole('dialog', { name: 'New session' });
    await expect(sheet).toBeVisible();

    const picker = sheet.locator('.picker');
    const box = await picker.boundingBox();
    expect(box, `picker missing at ${size.width}x${size.height}`).not.toBeNull();
    expect(box!.height, `picker collapsed at ${size.width}x${size.height}`).toBeGreaterThan(40);

    // At least one project must actually be tappable, not merely present.
    const first = sheet.locator('.picker__item').first();
    await expect(first).toBeVisible();
    const itemBox = await first.boundingBox();
    expect(itemBox!.height).toBeGreaterThan(20);

    // The primary action must stay reachable however tight it gets.
    await expect(sheet.getByRole('button', { name: 'Start' })).toBeVisible();

    // Nothing may push the page sideways.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal overflow at ${size.width}x${size.height}`).toBeLessThanOrEqual(1);

    await sheet.getByRole('button', { name: 'Cancel' }).click();
    await expect(sheet).toBeHidden();
  }
});

test('starts a session in a chosen project and opens the conversation', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'New session' }).click();

  const sheet = page.getByRole('dialog', { name: 'New session' });
  await sheet.getByRole('button', { name: /demo-app/ }).click();
  await sheet.getByRole('button', { name: 'Start' }).click();

  // Conversation view: composer present, project shown in the header.
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await expect(page.getByTestId('transcript')).toBeVisible();
  await expect(page.locator('.topbar__sub')).toContainText('demo-app');

  // Mode is switchable mid-session and reflects what the session was started with.
  await expect(page.getByLabel('Permission mode')).toHaveValue('default');
});

test('the landing page searches projects and does not list sessions', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await signIn(page);

  // 23 projects in the fixture; searching has to be the way through them.
  const list = page.getByTestId('project-list');
  await expect(list.locator('.row')).toHaveCount(23);

  const search = page.getByTestId('project-search');
  await search.fill('git-re');
  await expect(list.locator('.row')).toHaveCount(1);
  await expect(list).toContainText('git-repo');

  await search.fill('bulk');
  await expect(list.locator('.row')).toHaveCount(20);

  await search.fill('nothing-matches-this');
  await expect(list.locator('.row')).toHaveCount(0);
  await expect(page.getByText(/Nothing matches/)).toBeVisible();

  await search.fill('');
  await expect(list.locator('.row')).toHaveCount(23);

  // Start a session, then confirm the landing page reports it on the project row
  // rather than listing the session itself.
  await page.getByRole('button', { name: 'New session' }).click();
  const sheet = page.getByRole('dialog', { name: 'New session' });
  await sheet.getByRole('button', { name: /demo-app/ }).click();
  await sheet.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).click();

  await expect(page.getByTestId('project-list').getByRole('button', { name: /demo-app/ })).toContainText(
    /1 session/,
  );
  await expect(page.getByTestId('session-row')).toHaveCount(0);
});

test('a project opens its own sessions, and long-press deletes them', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await signIn(page);

  // Start two sessions in the same project so there is something to choose between.
  for (let i = 0; i < 2; i++) {
    await page.getByRole('button', { name: 'New session' }).first().click();
    const sheet = page.getByRole('dialog', { name: 'New session' });
    await sheet.getByRole('button', { name: /demo-app/ }).click();
    await sheet.getByRole('button', { name: 'Start' }).click();
    await expect(page.getByTestId('composer-input')).toBeVisible();
    await page.getByRole('button', { name: 'Back' }).click();
  }

  // Tapping the project must show its sessions, not jump straight to creating one.
  await page.getByTestId('project-list').getByRole('button', { name: /demo-app/ }).click();
  const sheet = page.getByTestId('project-sessions');
  await expect(sheet).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'New session' })).toBeHidden();

  const rows = sheet.getByTestId('session-row');
  await expect(rows).toHaveCount(2);

  // Long-press the first row to enter selection mode.
  const first = rows.first();
  const box = (await first.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(700);
  await page.mouse.up();

  await expect(page.getByText('1 selected')).toBeVisible();

  // A tap in selection mode adds to the selection rather than opening.
  await rows.nth(1).click();
  await expect(page.getByText('2 selected')).toBeVisible();
  await expect(page.getByTestId('composer-input')).toBeHidden();

  await page.getByTestId('delete-selected').click();
  await page.getByTestId('confirm-delete').click();

  // Both are gone from the daemon, not merely hidden.
  await expect(rows).toHaveCount(0, { timeout: 20_000 });
  await expect(sheet).toContainText('No sessions in this project yet');

  await page.getByRole('button', { name: 'Close' }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: 'New session' }).first()).toBeVisible();

  // Gone from the daemon, not just from this page: reopening the project shows
  // nothing, and the row no longer claims any sessions.
  await page.getByTestId('project-list').getByRole('button', { name: /demo-app/ }).click();
  await expect(page.getByTestId('project-sessions')).toContainText('No sessions in this project yet');
});

test('the conversation toolbar fits a narrow phone', async ({ page }) => {
  // Regression: the toolbar was a non-wrapping flex row whose two selects would
  // not shrink, so at 375px it was 497px wide and pushed the "unattended" badge
  // and the Changes button off-screen. The badge is a safety signal — being able
  // to pan to it is not good enough.
  await page.setViewportSize({ width: 375, height: 667 });
  await signIn(page);

  await page.getByRole('button', { name: 'New session' }).first().click();
  const sheet = page.getByRole('dialog', { name: 'New session' });
  await sheet.getByRole('button', { name: /demo-app/ }).click();
  // An unattended mode is the widest case: it adds the badge.
  await sheet.getByLabel('Permission mode').selectOption('acceptEdits');
  await sheet.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByTestId('composer-input')).toBeVisible();

  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const bar = document.querySelector('.modebar');
    return {
      page: doc.scrollWidth - doc.clientWidth,
      bar: bar ? bar.scrollWidth - bar.clientWidth : 0,
    };
  });
  expect(overflow.page, 'page must not scroll sideways').toBeLessThanOrEqual(1);
  expect(overflow.bar, 'toolbar must not overflow its own width').toBeLessThanOrEqual(1);

  // Both controls must be within the viewport, not merely present in the DOM.
  for (const name of ['unattended', 'Changes']) {
    const el = page.getByText(name, { exact: true }).first();
    await expect(el).toBeVisible();
    const box = await el.boundingBox();
    expect(box!.x + box!.width, `${name} is off-screen`).toBeLessThanOrEqual(376);
  }
});

test('composer is reachable and above the fold on a phone viewport', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'New session' }).click();
  const sheet = page.getByRole('dialog', { name: 'New session' });
  await sheet.getByRole('button', { name: /demo-app/ }).click();
  await sheet.getByRole('button', { name: 'Start' }).click();

  const composer = page.getByTestId('composer-input');
  const box = await composer.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  // The composer must be on screen without scrolling, and tall enough to tap.
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);
  expect(box!.height).toBeGreaterThanOrEqual(40);

  const send = page.getByRole('button', { name: 'Send' });
  const sendBox = await send.boundingBox();
  // 44px is the minimum comfortable touch target.
  expect(sendBox!.height).toBeGreaterThanOrEqual(43);
});

test('losing the daemon shows the reconnect banner, and it recovers when the daemon returns', async ({
  page,
}) => {
  await signIn(page);
  await expect(page.getByRole('button', { name: 'New session' })).toBeVisible();

  await stopDaemon();
  // The banner must say the session keeps running on the daemon — a silent stall
  // would read as a finished turn.
  await expect(page.getByRole('status')).toContainText(/Reconnecting/, { timeout: 20_000 });

  await startDaemon();
  await expect(page.getByRole('status')).toBeHidden({ timeout: 40_000 });
  // Still authenticated: the device token survived the daemon restart.
  await expect(page.getByRole('button', { name: 'New session' })).toBeVisible();
});

test('a half-open socket is detected by the heartbeat, not left claiming to be connected', async ({
  page,
  context,
}) => {
  // Regression test for a bug this suite found: `setOffline` does not close an
  // open WebSocket, so relying on `onclose` alone left the UI reporting
  // "connected" indefinitely while nothing arrived. The client now pings and
  // treats prolonged silence as death.
  test.setTimeout(120_000);

  await signIn(page);
  await expect(page.getByRole('button', { name: 'New session' })).toBeVisible();

  await context.setOffline(true);
  // DEAD_AFTER_MS is 25s, so allow comfortably more than that.
  await expect(page.getByRole('status')).toContainText(/Reconnecting|failed/, { timeout: 60_000 });

  await context.setOffline(false);
  await expect(page.getByRole('status')).toBeHidden({ timeout: 40_000 });
});

test('a revoked device is signed out', async ({ page, browser }) => {
  await signIn(page);

  // Second device, so there is something revocable from the first.
  const other = await browser.newContext({ ...devicesFallback() });
  const otherPage = await other.newPage();
  await signIn(otherPage);

  await page.getByRole('button', { name: 'Devices' }).click();
  const sheet = page.getByRole('dialog', { name: 'Devices' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('this device')).toBeVisible();

  const revoke = sheet.getByRole('button', { name: 'Revoke' }).first();
  await expect(revoke).toBeVisible();
  await revoke.click();

  // The revoked context loses access; it may land on login or show the expiry banner.
  await expect(
    otherPage.getByLabel('Password').or(otherPage.getByText(/Session expired/)),
  ).toBeVisible({ timeout: 30_000 });

  await other.close();
});

test('session survives a reload and is resumable from the list', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'New session' }).click();
  const sheet = page.getByRole('dialog', { name: 'New session' });
  await sheet.getByRole('button', { name: /demo-app/ }).click();
  await sheet.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByTestId('composer-input')).toBeVisible();

  await page.reload();
  // The daemon owns the session, so it survives the client restarting. The landing
  // page no longer lists sessions, so it is reached through its project.
  const projectRow = page.getByTestId('project-list').getByRole('button', { name: /demo-app/ });
  await expect(projectRow).toContainText(/1 session/);
  await projectRow.click();
  await page.getByTestId('project-sessions').getByTestId('session-row').first().click();
  await expect(page.getByTestId('composer-input')).toBeVisible();
});

test('offers a model picker sourced from the CLI', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'New session' }).click();
  const sheet = page.getByRole('dialog', { name: 'New session' });
  await sheet.getByRole('button', { name: /demo-app/ }).click();
  await sheet.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByTestId('composer-input')).toBeVisible();

  // The list comes from the running CLI, not a hardcoded array, so it appears
  // only once the session has initialised.
  const picker = page.getByLabel('Model');
  await expect(picker).toBeVisible({ timeout: 60_000 });
  const options = await picker.locator('option').allTextContents();
  expect(options.length).toBeGreaterThan(1);
  expect(options[0]).toBe('Default model');
});

test('shows uncommitted project changes, per file', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'New session' }).click();
  const sheet = page.getByRole('dialog', { name: 'New session' });
  await sheet.getByRole('button', { name: /git-repo/ }).click();
  await sheet.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByTestId('composer-input')).toBeVisible();

  await page.getByRole('button', { name: 'Changes' }).click();
  const diffSheet = page.getByTestId('project-diff');
  await expect(diffSheet).toBeVisible();

  // Defaults to this session's own changes. This session has written nothing, so
  // it must fall back to the project view and say so rather than claiming the repo
  // is clean.
  await expect(diffSheet.getByRole('button', { name: 'This session' })).toHaveClass(/--active/);
  await expect(diffSheet).toContainText(/has not written any files yet/, { timeout: 45_000 });

  await diffSheet.getByRole('button', { name: 'Whole project' }).click();
  await expect(diffSheet.getByRole('button', { name: 'Whole project' })).toHaveClass(/--active/);

  // The changed tracked file is listed with a stat, and the untracked file is
  // called out separately — it has no patch but it is still new work.
  await expect(diffSheet.getByRole('button', { name: /tracked\.txt/ })).toBeVisible({ timeout: 45_000 });
  await expect(diffSheet).toContainText('untracked.txt');

  await diffSheet.getByRole('button', { name: /tracked\.txt/ }).click();
  const diff = page.getByTestId('diff-view');
  await expect(diff).toBeVisible();
  // Both sides of the change must be present, with the gutter signs.
  await expect(diff).toContainText('MODIFIED');
  await expect(diff).toContainText('bravo');
});

test('says so plainly when a project is not a git repo', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'New session' }).click();
  const sheet = page.getByRole('dialog', { name: 'New session' });
  await sheet.getByRole('button', { name: /demo-app/ }).click();
  await sheet.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByTestId('composer-input')).toBeVisible();

  await page.getByRole('button', { name: 'Changes' }).click();
  await expect(page.getByTestId('project-diff')).toContainText(/not a git repository|git is not installed/, {
    timeout: 45_000,
  });
});

test('views a file the agent read', async ({ page }) => {
  // Needs a real turn: the "View file" action lives on a tool card, and a tool
  // card only exists once the agent has actually called a tool.
  test.skip(process.env['REY_E2E_AGENT'] !== '1', 'set REY_E2E_AGENT=1 to spend tokens on a live turn');
  test.setTimeout(180_000);

  await signIn(page);
  await page.getByRole('button', { name: 'New session' }).click();
  const sheet = page.getByRole('dialog', { name: 'New session' });
  await sheet.getByRole('button', { name: /demo-app/ }).click();
  await sheet.getByLabel(/First message/).fill('Read package.json and tell me the name field.');
  await sheet.getByRole('button', { name: 'Start' }).click();

  const transcript = page.getByTestId('transcript');
  const readCard = transcript.locator('.tool', { hasText: 'Read' }).first();
  await expect(readCard).toBeVisible({ timeout: 150_000 });

  await readCard.locator('.tool__header').click();
  await readCard.getByRole('button', { name: 'View file' }).click();

  const viewer = page.getByTestId('file-viewer');
  await expect(viewer).toBeVisible({ timeout: 30_000 });
  // The daemon read the real file off disk, so its contents must be present.
  await expect(viewer).toContainText('demo-app');
});

test('sends a prompt and streams a reply', async ({ page }) => {
  test.skip(process.env['REY_E2E_AGENT'] !== '1', 'set REY_E2E_AGENT=1 to spend tokens on a live turn');
  test.setTimeout(180_000);

  await signIn(page);
  await page.getByRole('button', { name: 'New session' }).click();
  const sheet = page.getByRole('dialog', { name: 'New session' });
  await sheet.getByRole('button', { name: /demo-app/ }).click();
  await sheet.getByLabel(/First message/).fill('Reply with exactly the word: pong');
  await sheet.getByRole('button', { name: 'Start' }).click();

  const transcript = page.getByTestId('transcript');
  await expect(transcript).toContainText(/pong/i, { timeout: 150_000 });
  // A completed turn reports its cost. With no spend ceiling (D-015), this line and the
  // session total are how spend stays legible.
  await expect(transcript.locator('.result')).toContainText(/Turn complete/, { timeout: 30_000 });
});

/** Playwright's device descriptors are not importable per-test; keep it simple. */
function devicesFallback(): { viewport: { width: number; height: number }; userAgent: string } {
  return {
    viewport: { width: 412, height: 915 },
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Mobile Safari/537.36',
  };
}
