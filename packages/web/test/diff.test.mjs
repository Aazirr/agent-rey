/**
 * Tests for the line diff and unified-patch parser.
 *
 * Diff logic is easy to get almost-right: off-by-one line numbers, CRLF making a
 * whole file look changed, a trailing newline inventing a phantom line. All of
 * those are silent in the UI, so they get pinned here.
 *
 * Run: node --experimental-strip-types --test packages/web/test/diff.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  diffLines,
  collapseContext,
  editPairFromTool,
  parseUnifiedPatch,
} from '../src/lib/diff.ts';

test('identical text produces only context lines', () => {
  const { lines, stat } = diffLines('a\nb\nc\n', 'a\nb\nc\n');
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => l.op === 'context'));
  assert.deepEqual({ additions: stat.additions, deletions: stat.deletions }, { additions: 0, deletions: 0 });
});

test('a single changed line is one removal and one addition', () => {
  const { lines, stat } = diffLines('a\nb\nc\n', 'a\nB\nc\n');
  assert.equal(stat.additions, 1);
  assert.equal(stat.deletions, 1);
  assert.deepEqual(
    lines.map((l) => [l.op, l.text]),
    [
      ['context', 'a'],
      ['remove', 'b'],
      ['add', 'B'],
      ['context', 'c'],
    ],
  );
});

test('line numbers track each side independently', () => {
  const { lines } = diffLines('a\nb\n', 'a\nx\ny\nb\n');
  const added = lines.filter((l) => l.op === 'add');
  assert.deepEqual(
    added.map((l) => [l.text, l.newLine]),
    [
      ['x', 2],
      ['y', 3],
    ],
  );
  const last = lines[lines.length - 1];
  // 'b' is line 2 in the old text and line 4 in the new.
  assert.deepEqual([last.op, last.oldLine, last.newLine], ['context', 2, 4]);
});

test('pure insertion and pure deletion', () => {
  const insert = diffLines('', 'a\nb\n');
  assert.equal(insert.stat.additions, 2);
  assert.equal(insert.stat.deletions, 0);

  const del = diffLines('a\nb\n', '');
  assert.equal(del.stat.additions, 0);
  assert.equal(del.stat.deletions, 2);
});

test('CRLF does not make a file look entirely rewritten', () => {
  const { stat } = diffLines('a\r\nb\r\nc\r\n', 'a\nb\nc\n');
  assert.deepEqual({ a: stat.additions, d: stat.deletions }, { a: 0, d: 0 });
});

test('a trailing newline does not invent a phantom line', () => {
  assert.equal(diffLines('a\n', 'a\n').lines.length, 1);
  assert.equal(diffLines('a', 'a').lines.length, 1);
  // Only the trailing-newline difference — no content change to report.
  assert.equal(diffLines('a\n', 'a').stat.additions, 0);
});

test('oversized input is reported as truncated rather than diffed', () => {
  const huge = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join('\n');
  const { lines, stat } = diffLines(huge, `${huge}\nextra`);
  assert.equal(stat.truncated, true);
  assert.equal(lines.length, 0);
});

test('collapseContext keeps changes with surrounding context and reports gaps', () => {
  const oldText = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  const newLines = oldText.split('\n');
  newLines[20] = 'CHANGED';
  const { lines } = diffLines(oldText, newLines.join('\n'));

  const collapsed = collapseContext(lines, 2);
  const gaps = collapsed.filter((l) => l.op === 'gap');
  assert.ok(gaps.length >= 1, 'long unchanged runs must collapse');
  assert.ok(
    collapsed.some((l) => l.op === 'add' && l.text === 'CHANGED'),
    'the change itself must survive collapsing',
  );
  // Far fewer rows than the original, which is the point on a phone.
  assert.ok(collapsed.length < lines.length);
});

test('collapseContext leaves an all-changed diff intact', () => {
  const { lines } = diffLines('a\nb\n', 'x\ny\n');
  const collapsed = collapseContext(lines, 3);
  assert.equal(collapsed.filter((l) => l.op === 'gap').length, 0);
});

test('editPairFromTool reconstructs an Edit before/after', () => {
  const pair = editPairFromTool('Edit', {
    file_path: '/a/b.ts',
    old_string: 'const x = 1;',
    new_string: 'const x = 2;',
  });
  assert.deepEqual(pair, { oldText: 'const x = 1;', newText: 'const x = 2;', path: '/a/b.ts' });
});

test('editPairFromTool treats Write as all additions', () => {
  const pair = editPairFromTool('Write', { file_path: '/a/new.ts', content: 'line one\nline two' });
  assert.equal(pair.oldText, '');
  assert.equal(pair.newText, 'line one\nline two');
});

test('editPairFromTool declines tools with no reconstructable diff', () => {
  assert.equal(editPairFromTool('Bash', { command: 'ls' }), null);
  assert.equal(editPairFromTool('Read', { file_path: '/a/b.ts' }), null);
  assert.equal(editPairFromTool('Edit', { file_path: '/a/b.ts' }), null);
  assert.equal(editPairFromTool('Edit', { old_string: 'x' }), null);
});

test('parseUnifiedPatch splits per file and counts changes', () => {
  const patch = [
    'diff --git a/src/one.ts b/src/one.ts',
    'index 1111111..2222222 100644',
    '--- a/src/one.ts',
    '+++ b/src/one.ts',
    '@@ -1,3 +1,3 @@',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    ' const c = 4;',
    'diff --git a/src/two.ts b/src/two.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/two.ts',
    '@@ -0,0 +1,2 @@',
    '+first',
    '+second',
  ].join('\n');

  const files = parseUnifiedPatch(patch);
  assert.equal(files.length, 2);
  assert.equal(files[0].path, 'src/one.ts');
  assert.deepEqual({ a: files[0].stat.additions, d: files[0].stat.deletions }, { a: 1, d: 1 });
  assert.equal(files[1].path, 'src/two.ts');
  assert.deepEqual({ a: files[1].stat.additions, d: files[1].stat.deletions }, { a: 2, d: 0 });
});

test('parseUnifiedPatch honours hunk line numbers', () => {
  const patch = [
    'diff --git a/f.ts b/f.ts',
    '--- a/f.ts',
    '+++ b/f.ts',
    '@@ -10,2 +10,3 @@',
    ' ten',
    '+inserted',
    ' eleven',
  ].join('\n');

  const [file] = parseUnifiedPatch(patch);
  assert.equal(file.lines[0].oldLine, 10);
  assert.equal(file.lines[1].op, 'add');
  assert.equal(file.lines[1].newLine, 11);
});

test('parseUnifiedPatch ignores binary and rename headers', () => {
  const patch = [
    'diff --git a/img.png b/img.png',
    'index aaa..bbb 100644',
    'Binary files a/img.png and b/img.png differ',
  ].join('\n');
  const [file] = parseUnifiedPatch(patch);
  assert.equal(file.path, 'img.png');
  assert.equal(file.lines.length, 0);
});

test('parseUnifiedPatch on empty input yields no files', () => {
  assert.deepEqual(parseUnifiedPatch(''), []);
});
