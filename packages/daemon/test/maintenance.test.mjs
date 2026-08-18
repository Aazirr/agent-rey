/**
 * Tests for file pruning.
 *
 * Retention logic deletes data, so it gets tested properly. The rule that matters
 * most is the exemption: a session still in the registry must keep its transcript
 * however old it is, or resuming an old session would find its history gone.
 *
 * Run: node --test --experimental-strip-types packages/daemon/test/maintenance.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneOldFiles } from '../src/maintenance.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_760_000_000_000;

function makeTree() {
  const root = mkdtempSync(join(tmpdir(), 'rey-prune-'));
  const auditDir = join(root, 'audit');
  const logDir = join(root, 'logs');
  mkdirSync(auditDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  return { root, auditDir, logDir };
}

/** Write a file and backdate its mtime by `ageDays`. */
function writeAged(dir, name, ageDays, contents = 'x\n') {
  const full = join(dir, name);
  writeFileSync(full, contents);
  const seconds = (NOW - ageDays * DAY_MS) / 1000;
  utimesSync(full, seconds, seconds);
  return full;
}

test('removes audit files past the retention window and keeps recent ones', async () => {
  const { root, auditDir, logDir } = makeTree();
  try {
    writeAged(auditDir, 'audit-2020-01-01.ndjson', 200);
    writeAged(auditDir, 'audit-2020-02-01.ndjson', 120);
    writeAged(auditDir, 'audit-2025-01-01.ndjson', 10);

    const result = await pruneOldFiles({
      auditDir,
      logDir,
      auditRetentionDays: 90,
      logRetentionDays: 30,
      keepSessionIds: new Set(),
      now: NOW,
    });

    assert.equal(result.auditFilesRemoved, 2);
    assert.equal(existsSync(join(auditDir, 'audit-2025-01-01.ndjson')), true);
    assert.equal(existsSync(join(auditDir, 'audit-2020-01-01.ndjson')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('keeps logs for sessions still in the registry, however old', async () => {
  const { root, auditDir, logDir } = makeTree();
  try {
    writeAged(logDir, 'keep-me.ndjson', 999);
    writeAged(logDir, 'forget-me.ndjson', 999);

    const result = await pruneOldFiles({
      auditDir,
      logDir,
      auditRetentionDays: 90,
      logRetentionDays: 30,
      keepSessionIds: new Set(['keep-me']),
      now: NOW,
    });

    assert.equal(result.logFilesRemoved, 1);
    // The exemption is the whole point: this session is resumable.
    assert.equal(existsSync(join(logDir, 'keep-me.ndjson')), true);
    assert.equal(existsSync(join(logDir, 'forget-me.ndjson')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('retention of 0 disables pruning entirely', async () => {
  const { root, auditDir, logDir } = makeTree();
  try {
    writeAged(auditDir, 'audit-2000-01-01.ndjson', 9000);
    writeAged(logDir, 'ancient.ndjson', 9000);

    const result = await pruneOldFiles({
      auditDir,
      logDir,
      auditRetentionDays: 0,
      logRetentionDays: 0,
      keepSessionIds: new Set(),
      now: NOW,
    });

    assert.equal(result.auditFilesRemoved, 0);
    assert.equal(result.logFilesRemoved, 0);
    assert.equal(readdirSync(auditDir).length, 1);
    assert.equal(readdirSync(logDir).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ignores files that do not match the expected naming', async () => {
  const { root, auditDir, logDir } = makeTree();
  try {
    // Not an audit file — a stray note must not be deleted by our housekeeping.
    writeAged(auditDir, 'notes.txt', 999);
    writeAged(auditDir, 'audit-not-a-date.ndjson', 999);
    writeAged(logDir, 'readme.md', 999);

    const result = await pruneOldFiles({
      auditDir,
      logDir,
      auditRetentionDays: 30,
      logRetentionDays: 30,
      keepSessionIds: new Set(),
      now: NOW,
    });

    assert.equal(result.auditFilesRemoved, 0);
    assert.equal(result.logFilesRemoved, 0);
    assert.equal(existsSync(join(auditDir, 'notes.txt')), true);
    assert.equal(existsSync(join(auditDir, 'audit-not-a-date.ndjson')), true);
    assert.equal(existsSync(join(logDir, 'readme.md')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reports reclaimed bytes', async () => {
  const { root, auditDir, logDir } = makeTree();
  try {
    writeAged(auditDir, 'audit-2020-01-01.ndjson', 200, 'y'.repeat(4096));

    const result = await pruneOldFiles({
      auditDir,
      logDir,
      auditRetentionDays: 90,
      logRetentionDays: 30,
      keepSessionIds: new Set(),
      now: NOW,
    });

    assert.equal(result.auditFilesRemoved, 1);
    assert.ok(result.bytesReclaimed >= 4096, `expected >= 4096, got ${result.bytesReclaimed}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing directories are not an error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'rey-prune-empty-'));
  try {
    const result = await pruneOldFiles({
      auditDir: join(root, 'nope', 'audit'),
      logDir: join(root, 'nope', 'logs'),
      auditRetentionDays: 90,
      logRetentionDays: 30,
      keepSessionIds: new Set(),
      now: NOW,
    });
    assert.deepEqual(result, { auditFilesRemoved: 0, logFilesRemoved: 0, bytesReclaimed: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
