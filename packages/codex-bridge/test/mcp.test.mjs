import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Store, classifyFailure } from '../src/store.mjs';

test('real stdio MCP handshake, tool discovery, no-call status, validation', async () => {
  const state = mkdtempSync(join(tmpdir(), 'rey-mcp-test-'));
  const client = new Client({ name: 'bridge-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], env: { ...process.env, REY_BRIDGE_STATE_DIR: state }, stderr: 'pipe' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 9);
    assert.ok(tools.tools.some(t => t.name === 'rey_handoff_task'));
    const status = await client.callTool({ name: 'rey_status', arguments: {} });
    assert.equal(JSON.parse(status.content[0].text).account.state, 'unknown');
    const invalid = await client.callTool({ name: 'rey_check_account', arguments: { userRequestedCheck: false } });
    assert.equal(invalid.isError, true);
    new Store(state).trip(classifyFailure('authentication_failed'));
    const blocked = await client.callTool({ name: 'rey_status', arguments: {} });
    assert.equal(JSON.parse(blocked.content[0].text).needsUserDecision.required, true);
    const start = await client.callTool({ name: 'rey_start_frontend_task', arguments: { projectPath: state, title: 'Must not run', brief: 'An unavailable account must not run', allowedPaths: ['src'] } });
    assert.equal(start.isError, true);
    assert.deepEqual(JSON.parse(start.content[0].text).needsUserDecision.choices, ['Continue with Claude after account recovery', 'Proceed with Codex instead']);
  } finally { await client.close(); }
});
