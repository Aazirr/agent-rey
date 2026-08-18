/**
 * Agent Rey — VSCode extension.
 *
 * Deliberately thin (docs/decisions.md D-002): it is one more client of the
 * daemon, exactly like the phone, with no agent logic of its own.
 *
 * Scope decision: this extension does NOT reimplement the conversation UI. The
 * PWA already is that, it is tested, and maintaining two transcript renderers
 * would guarantee they drift. What the extension provides is what the phone
 * cannot at the desk — a glance at whether an unattended session is running in
 * one of your repos, one-click interrupt, and a jump into the audit trail — plus
 * a handoff into the real UI for conversation.
 */

import * as vscode from 'vscode';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PermissionMode } from '@agent-rey/shared';
import { DaemonClient, type ClientStatus } from './daemon-client.js';
import { SessionsProvider, SessionNode } from './sessions-tree.js';

const TOKEN_KEY = 'agentRey.deviceToken';

/** Mirrors packages/web/src/lib/modes.ts, phrased as consequences. */
const MODE_CHOICES: ReadonlyArray<{ value: PermissionMode; label: string; detail: string }> = [
  { value: 'default', label: 'Ask me', detail: 'Waits for approval on anything risky. Safest.' },
  { value: 'plan', label: 'Plan only', detail: 'Investigates and proposes, changes nothing.' },
  { value: 'acceptEdits', label: 'Edit files freely', detail: 'Edits without asking; still prompts for commands.' },
  { value: 'auto', label: 'Auto', detail: 'Decides per action which prompts are worth surfacing.' },
  { value: 'dontAsk', label: "Don't ask", detail: 'Suppresses prompts. Runs unsupervised in your working tree.' },
  {
    value: 'bypassPermissions',
    label: 'Bypass all checks',
    detail: 'No permission checks at all, including shell commands.',
  },
];

function daemonUrl(): string {
  const configured = vscode.workspace.getConfiguration('agentRey').get<string>('daemonUrl');
  return (configured?.trim() || 'http://127.0.0.1:8787').replace(/\/+$/, '');
}

function stateDir(): string {
  const configured = vscode.workspace.getConfiguration('agentRey').get<string>('stateDir');
  return configured?.trim() || join(homedir(), '.agent-rey');
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const client = new DaemonClient(daemonUrl());
  context.subscriptions.push({ dispose: () => client.dispose() });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'agentRey.openInBrowser';
  context.subscriptions.push(status);

  const provider = new SessionsProvider(client);
  context.subscriptions.push(vscode.window.registerTreeDataProvider('agentRey.sessions', provider));

  function renderStatus(state: ClientStatus): void {
    const sessions = client.sessions.filter((s) => s.status !== 'exited');
    const working = sessions.filter((s) => s.status === 'thinking').length;
    const unattended = sessions.filter((s) =>
      ['acceptEdits', 'bypassPermissions', 'dontAsk'].includes(s.permissionMode),
    ).length;

    switch (state) {
      case 'offline':
        status.text = '$(radio-tower) Rey: offline';
        status.tooltip = `No daemon at ${daemonUrl()}. Start reyd.`;
        status.backgroundColor = undefined;
        break;
      case 'connecting':
        status.text = '$(loading~spin) Rey';
        status.tooltip = 'Connecting to the daemon…';
        status.backgroundColor = undefined;
        break;
      case 'unauthenticated':
        status.text = '$(key) Rey: sign in';
        status.tooltip = 'Run "Agent Rey: Sign in to daemon".';
        status.command = 'agentRey.signIn';
        status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
      case 'online': {
        status.command = 'agentRey.openInBrowser';
        const parts = [`$(radio-tower) Rey: ${sessions.length}`];
        if (working > 0) parts.push(`$(sync~spin) ${working}`);
        status.text = parts.join(' ');
        status.tooltip = [
          `${sessions.length} live session${sessions.length === 1 ? '' : 's'}`,
          working > 0 ? `${working} working` : null,
          // Surfaced prominently: an unattended session acting in a repo while you
          // are not watching is the thing you most want to notice.
          unattended > 0 ? `${unattended} running unattended` : null,
        ]
          .filter(Boolean)
          .join(' · ');
        status.backgroundColor =
          unattended > 0 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
        break;
      }
    }
    status.show();
  }

  client.on('status', renderStatus);
  client.on('sessions', () => renderStatus(client.status));
  client.on('error', (message) => vscode.window.showWarningMessage(`Agent Rey: ${message}`));
  renderStatus('offline');

  /* --------------------------------- auth ---------------------------------- */

  async function signIn(interactive = true): Promise<boolean> {
    if (!(await client.isDaemonReachable())) {
      if (interactive) {
        vscode.window.showErrorMessage(
          `No daemon at ${daemonUrl()}. Start reyd, then try again.`,
        );
      }
      return false;
    }

    const password = await vscode.window.showInputBox({
      prompt: `Password for the Agent Rey daemon at ${daemonUrl()}`,
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'REY_PASSWORD',
    });
    if (!password) return false;

    const result = await client.login(password);
    if (!result.ok) {
      vscode.window.showErrorMessage(`Agent Rey: ${result.message}`);
      return false;
    }

    // SecretStorage, not globalState: this token grants an agent with shell access.
    await context.secrets.store(TOKEN_KEY, result.token);
    client.start(result.token);
    vscode.window.showInformationMessage('Agent Rey: signed in.');
    return true;
  }

  async function ensureConnected(): Promise<boolean> {
    if (client.status === 'online') return true;
    const stored = await context.secrets.get(TOKEN_KEY);
    if (stored) {
      client.start(stored);
      return true;
    }
    return signIn();
  }

  /* -------------------------------- commands ------------------------------- */

  context.subscriptions.push(
    vscode.commands.registerCommand('agentRey.signIn', () => void signIn()),

    vscode.commands.registerCommand('agentRey.signOut', async () => {
      await context.secrets.delete(TOKEN_KEY);
      client.dispose();
      renderStatus('offline');
      provider.refresh();
      vscode.window.showInformationMessage(
        'Agent Rey: signed out here. The device is still listed on the daemon — revoke it from the app if this machine is not yours.',
      );
    }),

    vscode.commands.registerCommand('agentRey.refresh', async () => {
      if (!(await ensureConnected())) return;
      client.reconnect();
      client.refresh();
    }),

    vscode.commands.registerCommand('agentRey.openInBrowser', () => {
      void vscode.env.openExternal(vscode.Uri.parse(daemonUrl()));
    }),

    vscode.commands.registerCommand('agentRey.newSession', async () => {
      if (!(await ensureConnected())) return;

      const projects = await client.requestProjects();
      if (projects.length === 0) {
        vscode.window.showWarningMessage(
          'Agent Rey: no projects found. Check REY_PROJECT_ROOTS on the daemon.',
        );
        return;
      }

      // Default to the folder that is open here, when it is one the daemon allows.
      const openFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const ordered = [...projects].sort((a, b) => {
        const aMatch = openFolder ? Number(a.path === openFolder) : 0;
        const bMatch = openFolder ? Number(b.path === openFolder) : 0;
        return bMatch - aMatch;
      });

      const project = await vscode.window.showQuickPick(
        ordered.map((p) => ({
          label: p.name,
          description: p.path === openFolder ? '$(check) open here' : (p.branch ?? ''),
          detail: p.path,
          project: p,
        })),
        { placeHolder: 'Which project?', matchOnDetail: true },
      );
      if (!project) return;

      // Never pre-selected into an unattended mode; see docs/decisions.md D-004.
      const mode = await vscode.window.showQuickPick(
        MODE_CHOICES.map((m) => ({ label: m.label, detail: m.detail, value: m.value })),
        { placeHolder: 'Permission mode — how much can it do without asking?' },
      );
      if (!mode) return;

      const prompt = await vscode.window.showInputBox({
        prompt: 'First message (optional)',
        placeHolder: 'What should it do?',
        ignoreFocusOut: true,
      });

      client.startSession({
        projectPath: project.project.path,
        permissionMode: mode.value,
        ...(prompt?.trim() ? { prompt: prompt.trim() } : {}),
      });

      const open = await vscode.window.showInformationMessage(
        `Agent Rey: started a session in ${project.project.name}.`,
        'Open app',
      );
      if (open === 'Open app') {
        void vscode.env.openExternal(vscode.Uri.parse(daemonUrl()));
      }
    }),

    vscode.commands.registerCommand('agentRey.interruptSession', (node?: SessionNode) => {
      if (!node) return;
      client.interrupt(node.session.id);
    }),

    vscode.commands.registerCommand('agentRey.stopSession', async (node?: SessionNode) => {
      if (!node) return;
      const confirm = await vscode.window.showWarningMessage(
        `Stop the session in ${node.session.projectName}?`,
        { modal: true },
        'Stop',
      );
      if (confirm === 'Stop') client.stopSession(node.session.id);
    }),

    vscode.commands.registerCommand('agentRey.openSessionProject', async (node?: SessionNode) => {
      if (!node) return;
      // Reveal rather than openFolder: opening a folder restarts the extension
      // host, and the daemon's sessions are independent of what is open here
      // anyway (docs/decisions.md D-005).
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(node.session.projectPath));
    }),

    vscode.commands.registerCommand('agentRey.showAuditLog', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const file = join(stateDir(), 'audit', `audit-${today}.ndjson`);
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch {
        vscode.window.showInformationMessage(
          `Agent Rey: no audit log for today at ${file}. It is created on the first tool call.`,
        );
      }
    }),

    vscode.commands.registerCommand('agentRey.showPairingCode', async () => {
      const panel = vscode.window.createWebviewPanel(
        'agentReyPairing',
        'Agent Rey — Pair a device',
        vscode.ViewColumn.Active,
        { enableScripts: false },
      );
      panel.webview.html = pairingHtml(panel.webview.cspSource, daemonUrl());
    }),
  );

  // React to a changed daemon URL without requiring a reload.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('agentRey.daemonUrl')) client.setDaemonUrl(daemonUrl());
    }),
  );

  // Connect silently if we already have a token; never prompt on startup.
  const existing = await context.secrets.get(TOKEN_KEY);
  if (existing) client.start(existing);
}

export function deactivate(): void {
  // Everything is registered in context.subscriptions.
}

/**
 * Pairing panel. Scripts are disabled and the URL is HTML-escaped: this panel
 * shows an address, so it has no reason to execute anything.
 */
function pairingHtml(cspSource: string, url: string): string {
  const safe = url.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none'; style-src ${cspSource} 'unsafe-inline';" />
    <style>
      body { font-family: var(--vscode-font-family); padding: 24px; line-height: 1.6; }
      code { background: var(--vscode-textCodeBlock-background); padding: 2px 6px; border-radius: 4px; }
      .note { color: var(--vscode-descriptionForeground); font-size: 0.9em; }
      pre { background: var(--vscode-textCodeBlock-background); padding: 12px; border-radius: 6px; overflow-x: auto; }
    </style>
  </head>
  <body>
    <h2>Pair a device</h2>
    <p>Daemon address on this machine:</p>
    <p><code>${safe}</code></p>
    <p>
      That loopback address only works on this computer. To reach it from your phone, put it behind
      Tailscale and use the QR helper, which prints a scannable code in your terminal:
    </p>
    <pre>.\\scripts\\setup-tailscale.ps1
pnpm pair</pre>
    <p class="note">
      The QR code contains only the address — never your password or a token. You still type the
      password on the phone.
    </p>
  </body>
</html>`;
}
