/**
 * Project discovery: walk the configured roots looking for project markers.
 *
 * Only paths under a configured root are ever returned, and `isPathAllowed`
 * re-checks on session start. That containment is a security property, not a
 * convenience: an authenticated client should not be able to point an agent at
 * an arbitrary directory on the machine.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { join, basename } from 'node:path';
import type { ProjectInfo } from '@agent-rey/shared';
import type { Config } from './config.js';

const PROJECT_MARKERS = [
  '.git',
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'Gemfile',
  'composer.json',
  'CLAUDE.md',
];

interface CacheEntry {
  projects: ProjectInfo[];
  scannedAt: number;
}

const CACHE_TTL_MS = 60_000;

export class ProjectScanner {
  #cache: CacheEntry | null = null;

  constructor(private readonly config: Config) {}

  async list(opts: { refresh?: boolean; lastUsed?: Map<string, number> } = {}): Promise<ProjectInfo[]> {
    const now = Date.now();
    if (!opts.refresh && this.#cache && now - this.#cache.scannedAt < CACHE_TTL_MS) {
      return this.#decorate(this.#cache.projects, opts.lastUsed);
    }

    const found = new Map<string, ProjectInfo>();
    for (const root of this.config.projectRoots) {
      await this.#walk(root, 0, found);
    }

    const projects = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
    this.#cache = { projects, scannedAt: now };
    return this.#decorate(projects, opts.lastUsed);
  }

  #decorate(projects: ProjectInfo[], lastUsed?: Map<string, number>): ProjectInfo[] {
    if (!lastUsed || lastUsed.size === 0) return projects;
    return projects
      .map((p) => {
        const used = lastUsed.get(p.path);
        return used ? { ...p, lastUsedAt: used } : p;
      })
      // Recently used first, then alphabetical — the phone's picker should put
      // what I actually work on at the top.
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || a.name.localeCompare(b.name));
  }

  async #walk(dir: string, depth: number, out: Map<string, ProjectInfo>): Promise<void> {
    if (depth > this.config.scanDepth) return;

    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // Unreadable directory (permissions, junction loop) — skip quietly.
      return;
    }

    const names = new Set(entries.map((e) => e.name));
    const isProject = PROJECT_MARKERS.some((m) => names.has(m));

    if (isProject) {
      const hasGit = names.has('.git');
      const info: ProjectInfo = {
        path: dir,
        name: basename(dir),
        vcs: hasGit ? 'git' : null,
      };
      if (hasGit) {
        const branch = await readGitBranch(dir);
        if (branch) info.branch = branch;
      }
      out.set(dir, info);
      // Do not descend into a project — nested packages in a monorepo are part
      // of that project, not separate ones to pick from.
      return;
    }

    const ignore = new Set(this.config.scanIgnore);
    await Promise.all(
      entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !ignore.has(e.name))
        .map((e) => this.#walk(join(dir, e.name), depth + 1, out)),
    );
  }
}

/**
 * Read the current branch straight from .git/HEAD. Cheaper and more predictable
 * than shelling out to git for every project in a list.
 */
async function readGitBranch(projectPath: string): Promise<string | null> {
  try {
    const headPath = join(projectPath, '.git', 'HEAD');
    const st = await stat(headPath).catch(() => null);
    // A worktree or submodule has .git as a file; skip rather than guess.
    if (!st?.isFile()) return null;
    const head = await readFile(headPath, 'utf8');
    const match = /^ref:\s*refs\/heads\/(.+)$/m.exec(head.trim());
    if (match?.[1]) return match[1];
    // Detached HEAD: show the short sha.
    return head.trim().slice(0, 7) || null;
  } catch {
    return null;
  }
}
