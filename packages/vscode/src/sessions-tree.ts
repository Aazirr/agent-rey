/**
 * Tree view of the daemon's sessions.
 *
 * The point of this view is the thing the phone cannot give you at the desk: a
 * glance at whether an unattended session is running in one of your repos, and a
 * one-click way to stop it. Unattended sessions are called out explicitly rather
 * than shown as just another row.
 */

import * as vscode from 'vscode';
import type { SessionInfo, PermissionMode } from '@agent-rey/shared';
import type { DaemonClient } from './daemon-client.js';

const UNATTENDED: readonly PermissionMode[] = ['acceptEdits', 'bypassPermissions', 'dontAsk'];

export class SessionNode extends vscode.TreeItem {
  constructor(readonly session: SessionInfo) {
    super(session.title ?? session.projectName, vscode.TreeItemCollapsibleState.None);

    const running = session.status !== 'exited';
    const unattended = UNATTENDED.includes(session.permissionMode);

    this.description = [
      session.status === 'thinking' ? 'working' : session.status,
      session.permissionMode,
      session.costUsd ? `$${session.costUsd.toFixed(3)}` : null,
    ]
      .filter(Boolean)
      .join(' · ');

    this.tooltip = new vscode.MarkdownString(
      [
        `**${session.title ?? session.projectName}**`,
        '',
        `- Project: \`${session.projectPath}\``,
        `- Status: ${session.status}`,
        `- Mode: ${session.permissionMode}${unattended ? ' — **runs without asking**' : ''}`,
        session.model ? `- Model: ${session.model}` : '',
        session.costUsd ? `- Spent: $${session.costUsd.toFixed(4)}` : '',
        session.checkpointing ? '- Checkpointing on (changes can be rewound)' : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );

    this.iconPath = new vscode.ThemeIcon(
      session.status === 'thinking'
        ? 'loading~spin'
        : session.status === 'error'
          ? 'error'
          : running
            ? 'debug-start'
            : 'circle-outline',
      unattended && running ? new vscode.ThemeColor('charts.yellow') : undefined,
    );

    // Drives the inline stop/interrupt buttons in package.json's menus.
    this.contextValue = running ? 'reySession.running' : 'reySession.stopped';
  }
}

class MessageNode extends vscode.TreeItem {
  constructor(label: string, icon: string, command?: vscode.Command) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    if (command) this.command = command;
  }
}

export class SessionsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  #emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.#emitter.event;

  constructor(private readonly client: DaemonClient) {
    client.on('sessions', () => this.#emitter.fire());
    client.on('status', () => this.#emitter.fire());
  }

  refresh(): void {
    this.#emitter.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    switch (this.client.status) {
      case 'offline':
        return [
          new MessageNode('Daemon not reachable', 'debug-disconnect'),
          new MessageNode('Retry', 'refresh', {
            command: 'agentRey.refresh',
            title: 'Retry',
          }),
        ];
      case 'connecting':
        return [new MessageNode('Connecting…', 'loading~spin')];
      case 'unauthenticated':
        return [
          new MessageNode('Sign in to the daemon', 'key', {
            command: 'agentRey.signIn',
            title: 'Sign in',
          }),
        ];
      case 'online': {
        const sessions = this.client.sessions;
        if (sessions.length === 0) {
          return [
            new MessageNode('No sessions', 'circle-outline'),
            new MessageNode('New session', 'add', {
              command: 'agentRey.newSession',
              title: 'New session',
            }),
          ];
        }
        return sessions.map((s) => new SessionNode(s));
      }
    }
  }
}
