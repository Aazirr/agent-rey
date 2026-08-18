/**
 * Tests for turning a tool call's target path into a git pathspec.
 *
 * Every branch here is a way to get the scoped diff quietly wrong: an absolute
 * path, a relative one, a path escaping the project, or a Windows separator git
 * will not match. A wrong answer does not throw — it just shows you the wrong
 * changes, which is worse.
 *
 * Run: node --test --experimental-strip-types packages/daemon/test/touched-files.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, sep } from 'node:path';
import { isMutatingTool, toProjectRelative, touchedPathFromToolInput } from '../src/touched-files.ts';

const PROJECT = join(sep === '\\' ? 'C:\\work' : '/work', 'proj');

test('only mutating tools are tracked', () => {
  assert.equal(isMutatingTool('Write'), true);
  assert.equal(isMutatingTool('Edit'), true);
  assert.equal(isMutatingTool('NotebookEdit'), true);
  // A Read tells you nothing about what changed; including it would make the
  // scoped diff no narrower than the unscoped one.
  assert.equal(isMutatingTool('Read'), false);
  assert.equal(isMutatingTool('Bash'), false);
  assert.equal(isMutatingTool('Grep'), false);
});

test('an absolute path inside the project becomes relative', () => {
  assert.equal(toProjectRelative(PROJECT, join(PROJECT, 'src', 'index.ts')), 'src/index.ts');
});

test('a relative path is resolved against the project', () => {
  assert.equal(toProjectRelative(PROJECT, 'src/index.ts'), 'src/index.ts');
  assert.equal(toProjectRelative(PROJECT, './src/index.ts'), 'src/index.ts');
});

test('separators are normalised to forward slashes for git', () => {
  const result = toProjectRelative(PROJECT, join(PROJECT, 'a', 'b', 'c.ts'));
  assert.equal(result, 'a/b/c.ts');
  assert.ok(!result.includes('\\'), 'git pathspecs must not contain backslashes');
});

test('a path outside the project is refused', () => {
  // Would either match nothing or widen the diff — both wrong.
  assert.equal(toProjectRelative(PROJECT, join(PROJECT, '..', 'other', 'x.ts')), null);
  assert.equal(toProjectRelative(PROJECT, '../escape.ts'), null);
  assert.equal(toProjectRelative(PROJECT, sep === '\\' ? 'C:\\elsewhere\\x.ts' : '/elsewhere/x.ts'), null);
});

test('the project root itself is refused', () => {
  // relative() gives '' — not a file, and as a pathspec it would mean everything.
  assert.equal(toProjectRelative(PROJECT, PROJECT), null);
});

test('non-string and empty inputs are refused', () => {
  assert.equal(toProjectRelative(PROJECT, undefined), null);
  assert.equal(toProjectRelative(PROJECT, null), null);
  assert.equal(toProjectRelative(PROJECT, ''), null);
  assert.equal(toProjectRelative(PROJECT, 42), null);
  assert.equal(toProjectRelative(PROJECT, { path: 'x' }), null);
});

test('a nested path traversing back inside is still accepted', () => {
  assert.equal(toProjectRelative(PROJECT, 'src/../lib/y.ts'), 'lib/y.ts');
});

test('touchedPathFromToolInput reads the field each tool uses', () => {
  assert.equal(touchedPathFromToolInput(PROJECT, { file_path: 'src/a.ts' }), 'src/a.ts');
  assert.equal(touchedPathFromToolInput(PROJECT, { notebook_path: 'nb/b.ipynb' }), 'nb/b.ipynb');
  assert.equal(touchedPathFromToolInput(PROJECT, { path: 'c.ts' }), 'c.ts');
});

test('touchedPathFromToolInput tolerates malformed input', () => {
  assert.equal(touchedPathFromToolInput(PROJECT, {}), null);
  assert.equal(touchedPathFromToolInput(PROJECT, undefined), null);
  assert.equal(touchedPathFromToolInput(PROJECT, { file_path: '' }), null);
  assert.equal(touchedPathFromToolInput(PROJECT, { content: 'no path here' }), null);
});
