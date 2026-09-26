// Local operator/diagnostic client. Default is read-only; --check-account spends
// a single bounded request. --start-smoke <repo> uses a dedicated test repo only.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const client = new Client({ name: 'rey-bridge-check', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], env: { ...process.env }, stderr: 'inherit' });
try {
  await client.connect(transport);
  const command = process.argv[2];
  const args = command === '--check-account' ? { name: 'rey_check_account', arguments: { userRequestedCheck: true } }
    : command === '--task' ? { name: 'rey_get_result', arguments: { taskId: process.argv[3] } }
    : command === '--start-smoke' ? { name: 'rey_start_frontend_task', arguments: { projectPath: process.argv[3], title: 'Scoped frontend smoke test', brief: 'Read docs/spec.md. Change only src/status.html to a semantic responsive HTML card with heading Ready and a button labelled Continue. Use inline CSS, no dependencies. Do not run commands.', allowedPaths: ['src/status.html'] } }
    : { name: 'rey_status', arguments: {} };
  const result = await client.callTool(args);
  console.log(result.content?.[0]?.text ?? JSON.stringify(result));
  if (result.isError) process.exitCode = 1;
} finally { await client.close(); }
