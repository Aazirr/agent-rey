/**
 * One agent session: wraps a single `query()` from the Claude Agent SDK.
 *
 * The session's root is the SDK's `cwd`, set once at construction — this is what
 * decouples "which project am I working on" from any editor's open folder
 * (docs/decisions.md D-005).
 *
 * Every message the agent emits is handed to `onEvent` for sequencing and
 * fan-out. This object never talks to a socket; it does not know clients exist.
 * That is deliberate: the daemon keeps running turns whether or not a phone is
 * attached.
 */

import { randomUUID } from 'node:crypto';
import { query, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { isMutatingTool, touchedPathFromToolInput } from './touched-files.js';
import { isProgressNoise } from './event-noise.js';
import type {
  Query,
  SDKMessage,
  Options,
  PreToolUseHookInput,
  HookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import type { PermissionMode, SessionStatus } from '@agent-rey/shared';
import { isUnattendedMode } from '@agent-rey/shared';
import { PromptQueue } from './prompt-queue.js';
import type { AuditLog } from './audit-log.js';

export interface AgentSessionOptions {
  id: string;
  projectPath: string;
  permissionMode: PermissionMode;
  model?: string;
  title?: string;
  /** Hard floor of tools this project forbids regardless of mode. */
  disallowedTools?: string[];
  /** Resume an existing agent session rather than starting fresh. */
  resumeAgentSessionId?: string;
  /**
   * Fork rather than take over when resuming. Used for sessions started elsewhere:
   * another client may still be driving the original, and two processes writing one
   * session would corrupt it.
   */
  forkSession?: boolean;
  /** Files already known to have been written, restored on resume. */
  initialTouchedFiles?: string[];
  enableCheckpointing: boolean;
  sandbox: boolean;
  claudeExecutable?: string;
  audit: AuditLog;
  onEvent: (message: SDKMessage) => void;
  onStatus: (status: SessionStatus) => void;
  /** Called when the agent reports a new cumulative cost. */
  onCost?: (costUsd: number) => void;
  /** Called once the CLI reports the underlying agent session id. */
  onAgentSessionId?: (agentSessionId: string) => void;
  /** Called the first time this session writes to a given project-relative path. */
  onTouchedFile?: (relativePath: string) => void;
  onError: (err: Error) => void;
}

export class AgentSession {
  readonly id: string;
  readonly projectPath: string;

  #queue = new PromptQueue();
  #query: Query | null = null;
  #pump: Promise<void> | null = null;
  #status: SessionStatus = 'starting';
  #permissionMode: PermissionMode;
  #model: string | undefined;
  #costUsd = 0;
  #agentSessionId: string | undefined;
  #stopping = false;
  /**
   * Files this session has written to, gathered from the same PreToolUse hook that
   * writes the audit log. This is what lets the diff be scoped to "what this
   * session changed" rather than "everything uncommitted in the repo" — the two
   * differ whenever you already had work in progress.
   */
  #touchedFiles = new Set<string>();

  constructor(private readonly opts: AgentSessionOptions) {
    this.id = opts.id;
    this.projectPath = opts.projectPath;
    this.#permissionMode = opts.permissionMode;
    this.#model = opts.model;
    for (const f of opts.initialTouchedFiles ?? []) this.#touchedFiles.add(f);
  }

  get status(): SessionStatus {
    return this.#status;
  }
  get permissionMode(): PermissionMode {
    return this.#permissionMode;
  }
  get model(): string | undefined {
    return this.#model;
  }
  get costUsd(): number {
    return this.#costUsd;
  }
  get agentSessionId(): string | undefined {
    return this.#agentSessionId;
  }

  /** Build SDK options. Split out so the safeguards are reviewable in one place. */
  #buildOptions(): Options {
    const o: Options = {
      cwd: this.opts.projectPath,
      permissionMode: this.#permissionMode,
      // Load the user's real CLAUDE.md, settings, and skills — a session started
      // from the phone should behave like one started at the desk.
      settingSources: ['user', 'project', 'local'],
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      // Partial messages give the phone token-by-token streaming instead of
      // whole-message jumps.
      includePartialMessages: true,
      // Checkpointing is what makes `rewindFiles` possible, which is the only
      // real undo for an unattended session (docs/decisions.md D-004).
      enableFileCheckpointing: this.opts.enableCheckpointing,
      hooks: {
        PreToolUse: [{ hooks: [this.#auditHook] }],
      },
      stderr: (data) => this.opts.audit.stderr(this.id, data),
    };

    if (this.#model) o.model = this.#model;
    if (this.opts.title) o.title = this.opts.title;
    if (this.opts.resumeAgentSessionId) o.resume = this.opts.resumeAgentSessionId;
    // Forking leaves the original session untouched, so picking up desk work on
    // the phone cannot corrupt the copy VSCode may still have open.
    if (this.opts.forkSession) o.forkSession = true;
    if (this.opts.claudeExecutable) o.pathToClaudeCodeExecutable = this.opts.claudeExecutable;
    if (this.opts.disallowedTools?.length) o.disallowedTools = this.opts.disallowedTools;
    // No `maxBudgetUsd`. A ceiling does not pause a turn, it kills it mid-work with
    // `error_max_budget_usd` and leaves whatever the agent was doing half-done — on
    // a phone that reads as the session breaking for no reason. Cost stays visible
    // per turn and per session, and interrupt is always one thumb away, so spend is
    // governed by watching and stopping rather than by a tripwire.
    if (this.opts.sandbox) o.sandbox = { enabled: true };
    // bypassPermissions is refused by the CLI unless this is set explicitly.
    if (this.#permissionMode === 'bypassPermissions') o.allowDangerouslySkipPermissions = true;

    return o;
  }

  /**
   * Records every tool call before it runs. Always `continue: true` — this is an
   * audit trail, not a gate. Gating is the permission mode's job, and blocking
   * here would silently contradict the mode the user chose.
   */
  #auditHook = async (input: unknown): Promise<HookJSONOutput> => {
    try {
      const hookInput = input as PreToolUseHookInput;
      this.opts.audit.toolUse({
        sessionId: this.id,
        projectPath: this.opts.projectPath,
        permissionMode: this.#permissionMode,
        toolName: hookInput.tool_name,
        toolInput: hookInput.tool_input,
      });
      this.#recordTouchedFile(hookInput.tool_name, hookInput.tool_input);
    } catch (err) {
      // An audit failure must never break the session.
      this.opts.onError(new Error(`audit hook failed: ${(err as Error).message}`));
    }
    return { continue: true, suppressOutput: true };
  };

  /**
   * Note which files a write-shaped tool call targeted, so the diff can be scoped
   * to this session. New paths are reported so the registry can persist them —
   * otherwise a session resumed after a daemon restart would lose its scope.
   */
  #recordTouchedFile(toolName: string, toolInput: unknown): void {
    if (!isMutatingTool(toolName)) return;
    const rel = touchedPathFromToolInput(this.opts.projectPath, toolInput);
    if (!rel || this.#touchedFiles.has(rel)) return;
    this.#touchedFiles.add(rel);
    this.opts.onTouchedFile?.(rel);
  }

  /** Project-relative paths this session has written to, for scoping a diff. */
  get touchedFiles(): string[] {
    return [...this.#touchedFiles];
  }

  /** Start the CLI and begin pumping messages. Resolves once the query is live. */
  start(initialPrompt?: string): void {
    if (this.#query) throw new Error(`session ${this.id} already started`);

    this.#query = query({ prompt: this.#queue, options: this.#buildOptions() });
    this.#setStatus('idle');

    if (initialPrompt) this.prompt(initialPrompt);

    this.#pump = this.#run().catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      // An abort we asked for is not a failure.
      if (this.#stopping || error.name === 'AbortError') {
        this.#setStatus('exited');
        return;
      }
      this.#setStatus('error');
      this.opts.onError(error);
    });
  }

  async #run(): Promise<void> {
    const q = this.#query;
    if (!q) return;
    for await (const message of q) {
      // Observe first, drop second: progress frames are how we know the session is
      // still working, they just have no place in the log clients read back.
      this.#observe(message);
      if (isProgressNoise(message)) continue;
      this.opts.onEvent(message);
    }
    this.#setStatus('exited');
  }

  /** Derive session state from the message stream so clients get status for free. */
  #observe(message: SDKMessage): void {
    const m = message as { type?: string; subtype?: string; session_id?: string; total_cost_usd?: number };

    if (m.session_id && m.session_id !== this.#agentSessionId) {
      this.#agentSessionId = m.session_id;
      this.opts.onAgentSessionId?.(m.session_id);
    }

    switch (m.type) {
      case 'assistant':
      case 'stream_event':
        this.#setStatus('thinking');
        break;
      case 'result': {
        if (typeof m.total_cost_usd === 'number') {
          this.#costUsd = m.total_cost_usd;
          this.opts.onCost?.(m.total_cost_usd);
        }
        this.#setStatus('idle');
        break;
      }
      default:
        break;
    }
  }

  #setStatus(status: SessionStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.opts.onStatus(status);
  }

  /**
   * Submit a user message.
   *
   * The CLI does not echo the human's prompt back on the message stream — only the
   * agent's side of the turn arrives. So the daemon emits the user message itself,
   * through the same `onEvent` path as everything else. That matters for three
   * reasons: the sender sees their own message, a reconnecting client gets it from
   * the event log rather than losing it, and it carries the uuid that a later
   * rewind uses as its anchor.
   */
  prompt(text: string): void {
    if (!this.#query) throw new Error(`session ${this.id} not started`);
    if (this.#queue.closed) throw new Error(`session ${this.id} is closed to input`);

    const uuid = randomUUID();
    this.#queue.push(text, uuid);
    this.opts.onEvent({
      type: 'user',
      uuid,
      session_id: this.#agentSessionId,
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    } as unknown as SDKMessage);

    this.#setStatus('thinking');
  }

  async interrupt(): Promise<void> {
    if (!this.#query) return;
    this.#setStatus('interrupting');
    try {
      await this.#query.interrupt();
    } finally {
      this.#setStatus('idle');
    }
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!this.#query) throw new Error(`session ${this.id} not started`);
    await this.#query.setPermissionMode(mode);
    this.#permissionMode = mode;
    this.opts.audit.modeChange({ sessionId: this.id, projectPath: this.opts.projectPath, mode });
  }

  async setModel(model?: string): Promise<void> {
    if (!this.#query) throw new Error(`session ${this.id} not started`);
    await this.#query.setModel(model);
    this.#model = model;
  }

  /**
   * Re-send `initialize` after a client-side gap. The SDK redelivers any control
   * requests the CLI is still blocked on, which is exactly the daemon-reattach
   * case this architecture creates.
   */
  async reinitialize(): Promise<void> {
    await this.#query?.reinitialize();
  }

  async rewindFiles(userMessageId: string, dryRun = false): Promise<unknown> {
    if (!this.#query) throw new Error(`session ${this.id} not started`);
    if (!this.opts.enableCheckpointing) {
      throw new Error('file checkpointing is disabled for this session; nothing to rewind to');
    }
    const result = await this.#query.rewindFiles(userMessageId, { dryRun });
    this.opts.audit.rewind({
      sessionId: this.id,
      projectPath: this.opts.projectPath,
      userMessageId,
      dryRun,
    });
    return result;
  }

  /**
   * Read a file through the CLI, which applies the same read permissions as the
   * Read tool. Returns null content when it refused or the file is missing — the
   * caller shows that as a reason rather than an empty view.
   *
   * Note the SDK field is `contents`, not `content`.
   */
  async readFile(path: string): Promise<{
    content: string | null;
    encoding: 'utf-8' | 'base64';
    truncated: boolean;
    absPath?: string;
  }> {
    if (!this.#query) throw new Error(`session ${this.id} not started`);
    const res = await this.#query.readFile(path, { encoding: 'utf-8', maxBytes: 512 * 1024 });
    if (!res) return { content: null, encoding: 'utf-8', truncated: false };
    return {
      content: res.contents,
      encoding: res.encoding ?? 'utf-8',
      truncated: res.truncated === true,
      ...(res.absPath ? { absPath: res.absPath } : {}),
    };
  }

  /**
   * User turns that files can be rewound to.
   *
   * Read from the CLI's own session history rather than from the message stream:
   * the CLI assigns its own message uuids, never emits them on the stream, and
   * `rewindFiles` only accepts those. A uuid the daemon minted is rejected with
   * "No file checkpoint found for this message" — verified empirically.
   */
  async checkpoints(): Promise<Array<{ uuid: string; preview: string; index: number }>> {
    const agentSessionId = this.#agentSessionId;
    if (!agentSessionId) return [];

    // No `dir` filter. The CLI stores the project path with whatever casing the
    // process was launched with (`c:\...` vs `C:\...`), and the filter matches
    // exactly — passing our own path silently returned zero messages and made it
    // look as though session history was unavailable. Filtering by session id
    // alone is unambiguous anyway.
    const messages = await getSessionMessages(agentSessionId);
    const out: Array<{ uuid: string; preview: string; index: number }> = [];

    for (const m of messages) {
      if (m.type !== 'user') continue;
      const text = extractUserText(m.message);
      // Tool results are also 'user' messages; only real prompts are anchors.
      if (!text) continue;
      out.push({ uuid: m.uuid, preview: text.slice(0, 200), index: out.length + 1 });
    }
    return out;
  }

  /** Models this account may select, for the client's model picker. */
  async supportedModels(): Promise<Array<{ value: string; label: string; description?: string }>> {
    if (!this.#query) throw new Error(`session ${this.id} not started`);
    const models = await this.#query.supportedModels();
    return models.map((m) => ({
      value: m.value,
      label: m.displayName,
      ...(m.description ? { description: m.description } : {}),
    }));
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#queue.close();
    try {
      this.#query?.close();
    } catch {
      // close() on an already-dead query is not interesting.
    }
    await this.#pump?.catch(() => undefined);
    this.#setStatus('exited');
  }

  /** True when this session can act without a human answering prompts. */
  get unattended(): boolean {
    return isUnattendedMode(this.#permissionMode);
  }
}

/**
 * Plain text of a user message, or null when it carries none.
 *
 * Tool results arrive as `user` messages too, so "has text content" is what
 * separates a real prompt from machinery.
 */
function extractUserText(message: unknown): string | null {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content)) return null;

  const text = content
    .filter((b): b is { type: string; text: string } => {
      const block = b as { type?: string; text?: unknown };
      return block.type === 'text' && typeof block.text === 'string';
    })
    .map((b) => b.text)
    .join('\n')
    .trim();

  return text || null;
}
