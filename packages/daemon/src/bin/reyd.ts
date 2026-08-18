#!/usr/bin/env node
/**
 * reyd entrypoint.
 *
 * Boot order matters: validate the password before opening a socket, so a
 * misconfigured daemon never accepts a connection it cannot authenticate.
 */

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { Auth, type AuthState } from '../auth.js';
import { AuditLog } from '../audit-log.js';
import { loadConfig } from '../config.js';
import { ProjectScanner } from '../projects.js';
import { SessionRegistry, type RegistryState } from '../session-registry.js';
import { ReyServer } from '../server.js';
import { Store } from '../store.js';

function log(msg: string): void {
  process.stdout.write(`[reyd] ${msg}\n`);
}

function warn(msg: string): void {
  process.stderr.write(`[reyd] ${msg}\n`);
}

async function main(): Promise<void> {
  const { config, warnings } = loadConfig();
  for (const w of warnings) warn(`warning: ${w}`);

  const passwordProblems = Auth.validatePassword(config.password);
  for (const p of passwordProblems) warn(`warning: ${p}`);

  const authStore = new Store<AuthState>(
    join(config.stateDir, 'auth.json'),
    () => ({ signingSecret: '', devices: {} }),
    0o600,
  );
  const registryStore = new Store<RegistryState>(
    join(config.stateDir, 'sessions.json'),
    () => ({ sessions: {} }),
    0o600,
  );

  const audit = new AuditLog(join(config.stateDir, 'audit'));
  const auth = new Auth({ password: config.password, store: authStore });
  const scanner = new ProjectScanner(config);
  const registry = new SessionRegistry(config, registryStore, audit);

  // Prefer a built PWA next to the daemon; fall back to the workspace layout
  // during development.
  // fileURLToPath, not URL.pathname: the latter leaves spaces percent-encoded,
  // which silently breaks any home directory containing one.
  const webCandidates = [
    join(config.stateDir, 'web'),
    fileURLToPath(new URL('../../../web/dist/', import.meta.url)),
  ];
  const webRoot = config.serveWeb ? webCandidates.find((p) => existsSync(join(p, 'index.html'))) : undefined;

  const server = new ReyServer({
    config,
    auth,
    audit,
    registry,
    scanner,
    ...(webRoot ? { webRoot } : {}),
    log,
  });

  await server.listen();
  server.start();

  log(`listening on http://${config.host}:${config.port}`);
  log(`state dir     ${config.stateDir}`);
  log(`project roots ${config.projectRoots.join(', ')}`);
  log(`default mode  ${config.defaultPermissionMode}`);
  log(`checkpointing ${config.enableCheckpointing ? 'on' : 'off'}  sandbox ${config.sandbox ? 'on' : 'off'}`);
  log(webRoot ? `serving PWA from ${webRoot}` : 'not serving a PWA (API only)');
  if (config.allowedOrigins.length > 0) {
    log(`allowed origins ${config.allowedOrigins.join(', ')}`);
  }
  if (!auth.configured) {
    warn('REY_PASSWORD is unset — every login will be refused. Set it and restart.');
  }
  if (config.host !== '127.0.0.1' && config.host !== 'localhost') {
    warn(
      `bound to ${config.host} rather than loopback — make sure this is not reachable from untrusted networks.`,
    );
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} received, shutting down`);
    try {
      await server.close();
      await registry.shutdown();
    } catch (err) {
      warn(`error during shutdown: ${(err as Error).message}`);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  warn(`fatal: ${(err as Error).stack ?? String(err)}`);
  process.exit(1);
});
