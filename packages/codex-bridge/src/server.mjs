import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Manager, fallbackDecision } from './manager.mjs';

const manager = new Manager();
const server = new McpServer({ name: 'agent-rey-frontend', version: '0.1.0' }, {
  instructions: 'Claude frontend worker for Codex. Read /docs and pass a precise brief. Use isolated scoped tasks; Codex verifies/integrates/commits. If blocked or needsUserDecision is returned, ASK the user: continue with Claude after recovery, or proceed with Codex? Never silently fall back, retry, switch accounts/providers, or reset the circuit. After the user chooses Codex, call rey_handoff_task; preserve partial files. Check status before spawning. Do not take over VS Code sessions.',
});
const taskId = z.string().uuid();
const output = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
function tool(name, description, inputSchema, fn, readOnly = false) {
  server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: !readOnly } }, async args => {
    try { return output(await fn(args)); }
    catch (e) {
      let blocked = false;
      try { blocked = manager.store.circuit().state === 'blocked'; } catch { /* fail closed */ }
      return { ...output({ error: e.message, ...(blocked ? { needsUserDecision: fallbackDecision } : {}) }), isError: true };
    }
  });
}
tool('rey_status', 'Local account circuit and active task. Does NOT call Claude. A blocked account requires asking the user whether to wait/reconnect or let Codex continue.', {}, () => manager.status(), true);
tool('rey_list_tasks', 'List retained frontend tasks across projects, including worktree paths and states.', {}, () => manager.list(), true);
tool('rey_start_frontend_task', 'Start one bounded Claude frontend task in a new detached Git worktree. Requires a clean committed repo and explicit relative writable files/directories. Returns immediately. Never retries blocked accounts.', {
  projectPath: z.string(), title: z.string().min(1).max(160), brief: z.string().min(10).max(30000), allowedPaths: z.array(z.string()).min(1).max(40),
}, args => manager.start(args));
tool('rey_get_task', 'Read task progress; wait up to 20 seconds optionally. On blocked, immediately ask the user the returned recovery/handoff question.', { taskId, waitSeconds: z.number().int().min(0).max(20).default(0) }, async args => {
  const deadline = Date.now() + args.waitSeconds * 1000;
  let task;
  do {
    task = manager.get(args.taskId);
    if (!['starting', 'running'].includes(task.status) || Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (true);
  return task;
}, true);
tool('rey_get_result', 'Read preserved task summary, full Git status and bounded tracked-file diff. New-file contents remain in worktree for Codex inspection.', { taskId }, args => manager.result(args.taskId), true);
tool('rey_send_feedback', 'Explicitly continue an idle Claude-owned task with feedback. If account was blocked, first obtain user choice and a successful rey_check_account. Never resumes a handed-off task.', { taskId, message: z.string().min(1).max(30000) }, args => manager.feedback(args.taskId, args.message));
tool('rey_cancel_task', 'Request cancellation of this task only. Wait for terminal state before Codex touches its files. Does not delete any partial work.', { taskId }, args => manager.cancel(args.taskId));
tool('rey_handoff_task', 'After the user explicitly chooses Codex, transfer the stopped task and preserved worktree to Codex. Prevents later Claude feedback/restart for this task.', { taskId, userConfirmedCodex: z.literal(true) }, args => manager.handoff(args.taskId, args.userConfirmedCodex));
tool('rey_check_account', 'Explicit single tools-disabled Claude request (uses Claude allowance). Run only for initial setup or after the user chooses to retry following account recovery. Success clears the persistent circuit; no tasks auto-resume. Does not bypass restrictions or change accounts.', { userRequestedCheck: z.literal(true) }, () => manager.probe());
await server.connect(new StdioServerTransport());
