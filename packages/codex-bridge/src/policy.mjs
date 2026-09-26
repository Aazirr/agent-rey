import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname, sep, basename } from 'node:path';

export function inside(root, target) {
  const rel = relative(root, target);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
const protectedPart = /^(?:\.git|\.env(?:\..*)?|\.claude|\.codex|\.agents|\.mcp\.json|node_modules|\.ssh|\.aws|\.npmrc|\.netrc|credentials?(?:\..*)?|secrets?(?:\..*)?)$/i;
export function validateScope(paths) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 40) throw new Error('Supply 1–40 explicit project-relative frontend files/directories.');
  return paths.map(p => {
    if (typeof p !== 'string' || !p || isAbsolute(p) || /[:*?{}\x00-\x1f]/.test(p)) throw new Error('Scope must use literal relative paths, not globs or absolute paths.');
    const normalized = p.replaceAll('\\', '/').replace(/\/$/, '');
    if (normalized.split('/').some(part => !part || part === '.' || part === '..' || protectedPart.test(part))) throw new Error('Scope contains a protected or ambiguous path.');
    return normalized;
  });
}

export function safePath(root, input, { directory = false } = {}) {
  if (typeof input !== 'string' || input.includes('\0')) throw new Error('Missing/invalid tool path.');
  const original = resolve(root, input);
  // Canonicalize Windows 8.3 spellings without losing evidence of link traversal.
  let ancestor = original;
  const missing = [];
  while (!existsSync(ancestor)) {
    try { if (lstatSync(ancestor).isSymbolicLink()) throw new Error('Linked paths are not available to this worker.'); }
    catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }
    missing.unshift(basename(ancestor));
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error('Invalid path ancestor.');
    ancestor = parent;
  }
  let check = ancestor;
  while (dirname(check) !== check) {
    if (lstatSync(check).isSymbolicLink()) throw new Error('Linked paths are not available to this worker.');
    check = dirname(check);
  }
  const target = resolve(realpathSync.native(ancestor), ...missing);
  if (!inside(root, target)) throw new Error('Path is outside the task worktree.');
  const rel = relative(root, target);
  if (rel.split(sep).some(p => /[:\x00-\x1f]|[. ]$/.test(p) || protectedPart.test(p) || /\.(?:pem|key|p12|pfx)$/i.test(p))) throw new Error('Credential/configuration path is protected.');
  // Reject every link ancestor, including internal links, and Windows junctions.
  let cursor = target;
  while (relative(root, cursor) !== '') {
    if (existsSync(cursor)) {
      if (lstatSync(cursor).isSymbolicLink() || !inside(root, realpathSync.native(cursor))) throw new Error('Linked paths are not available to this worker.');
    }
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error('Invalid path ancestor.');
    cursor = parent;
  }
  if (target === root && !directory) throw new Error('Expected a file path.');
  return target;
}

export function toolDecision(task, name, input) {
  try {
    if (task.kind === 'probe') throw new Error('Account probes cannot use tools.');
    if (!['Read', 'Glob', 'Write', 'Edit'].includes(name)) throw new Error('Only scoped file tools are enabled. Codex runs commands and tests.');
    const root = realpathSync.native(task.worktree);
    if (name === 'Glob') {
      safePath(root, input.path ?? '.', { directory: true });
      if (typeof input.pattern !== 'string' || isAbsolute(input.pattern) || /(^|[/\\])\.\.([/\\]|$)|:/.test(input.pattern)) throw new Error('Glob cannot traverse outside the worktree.');
    } else {
      const target = safePath(root, input.file_path);
      if (name !== 'Read' && !task.allowedPaths.some(p => inside(resolve(root, p), target))) throw new Error('Write is outside the explicitly delegated frontend scope.');
    }
    return { behavior: 'allow', updatedInput: input };
  } catch (e) { return { behavior: 'deny', message: e.message }; }
}

export function claudeEnvironment(source = process.env) {
  // Use the same Windows user's normal Claude login. Do not inherit API keys,
  // provider overrides, Codex secrets, or shell/API billing fallback variables.
  const names = new Set(['path','home','userprofile','appdata','localappdata','systemroot','windir','comspec','pathext','temp','tmp','lang','lc_all','claude_code_git_bash_path','ssl_cert_file','node_extra_ca_certs','https_proxy','http_proxy','no_proxy']);
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => names.has(key.toLowerCase()) && typeof value === 'string'));
}
