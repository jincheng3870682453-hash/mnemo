/**
 * FileStore: Markdown files are the source of truth; every index is disposable.
 *
 * Layout
 *   <root>/facts/<group>/<name>.md       fact | preference | skill | hearsay
 *   <root>/episodic/<group>/<name>.md    event
 *   <root>/persona/<name>.md             persona
 *   <root>/intentions/<name>.md          intention
 *   <root>/archive/<name>.md             decayed, still recoverable
 *   <root>/session/<sid>/...             task canvas + offloaded tool output
 *
 * Deleting `<root>/index/` must lose no knowledge. That property is asserted by
 * a test, because it is the whole reason this library does not need a database.
 *
 * Path safety: every dynamic path is built with `path.resolve(root, ...)` and the
 * very next statement re-checks containment against `root + path.sep`. Callers
 * cannot pass a path, only a name — and names are additionally slug-validated.
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { MemoryRecord, MemoryType } from '../types.js';
import { shortHash } from '../util/id.js';
import { deserializeRecord, serializeRecord } from './frontmatter.js';

const DIRS = [
  'facts',
  'episodic',
  'persona',
  'intentions',
  'archive',
  'history',
  'session',
  'index',
] as const;
export type StoreDir = (typeof DIRS)[number];

/** Directories whose `.md` files are records. `history/` is deliberately excluded. */
const RECORD_DIRS = ['facts', 'episodic', 'persona', 'intentions', 'archive'] as const;

const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The only pattern a record name may match. `matchSafeName` returns the matched
 * text rather than validating the original string in place: the value that
 * reaches `path.join` is always a fresh string produced by the regex, so no
 * caller-supplied character can ever be part of a path.
 */
const SAFE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function matchSafeName(name: string): string | null {
  const found = name.match(SAFE_NAME_RE);
  return found ? found[0] : null;
}

/** Thrown when a name or path segment would escape the store root. */
export class PathEscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathEscapeError';
  }
}

function safeSegment(segment: string): string {
  if (SAFE_SEGMENT_RE.test(segment) && segment !== '.' && segment !== '..') return segment;
  const cleaned = segment
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-.]+|-+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 48) : `g-${shortHash(segment)}`;
}

function groupPath(group: string): string {
  const parts = group
    .split('/')
    .filter((p) => p.length > 0 && p !== '.' && p !== '..')
    .map(safeSegment);
  return parts.length > 0 ? parts.join(path.sep) : 'default';
}

/** Reduce an arbitrary caller value to a single safe filename (no separators). */
function safeFileName(file: string): string {
  const base = path.basename(file);
  if (SAFE_SEGMENT_RE.test(base) && base !== '.' && base !== '..') return base;
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+/, '');
  return cleaned.length > 0 ? cleaned.slice(0, 48) : `f-${shortHash(file)}`;
}

/** Which top-level directory a record type lives in. */
export function dirForType(type: MemoryType): StoreDir {
  switch (type) {
    case 'event':
    case 'episode':
      return 'episodic';
    case 'persona':
      return 'persona';
    case 'intention':
      return 'intentions';
    case 'fact':
    case 'preference':
    case 'skill':
    case 'hearsay':
      return 'facts';
  }
}

export class FileStore {
  readonly root: string;
  private location = new Map<string, string>();
  private loaded = false;
  /**
   * Group folding registry, persisted at `<root>/groups.json` — deliberately
   * NOT under `index/`. Deleting `index/` must lose no knowledge, and an alias
   * mapping is knowledge: lose it and the next write to the alias name forks
   * the group again. One level of indirection, one small JSON file.
   */
  private groupAliases = new Map<string, string>();

  constructor(root: string) {
    if (!root || root.trim().length === 0) throw new Error('FileStore requires a root directory');
    this.root = path.resolve(root);
  }

  async init(): Promise<void> {
    for (const dir of DIRS) {
      const abs = path.resolve(this.root, dir);
      if (!abs.startsWith(this.root + path.sep)) {
        throw new PathEscapeError(`store dir escapes root: ${dir}`);
      }
      await mkdir(abs, { recursive: true });
    }
    await this.loadGroupAliases();
    await this.sweepTemp();
  }

  // ------------------------------------------------------------ durability --

  /**
   * Write-then-rename. The rename is the commit point: a crash before it leaves
   * a `.tmp-*` orphan that `sweepTemp` collects, never a half-written record.
   */
  private async atomicWrite(abs: string, data: string): Promise<void> {
    const tmp = `${abs}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    await writeFile(tmp, data, 'utf8');
    await rename(tmp, abs);
  }

  /**
   * Collect orphaned temp files from crashed writes. Only files older than a
   * minute are touched, so a concurrently running writer never loses its
   * in-flight temp. Cheap enough to run on every open.
   */
  private async sweepTemp(): Promise<void> {
    let entries;
    try {
      entries = await readdir(this.root, { recursive: true, withFileTypes: false });
    } catch {
      return;
    }
    const now = Date.now();
    for (const rel of entries) {
      if (!/\.tmp-\d+(-[0-9a-f]+)?$/.test(String(rel))) continue;
      const abs = path.resolve(this.root, String(rel));
      if (!abs.startsWith(this.root + path.sep)) continue;
      try {
        const st = await stat(abs);
        if (now - st.mtimeMs > 60_000) await rm(abs, { force: true });
      } catch {
        // Already gone, or momentarily busy: the next open sweeps again.
      }
    }
  }

  // ---------------------------------------------------------- group folding --

  /**
   * Canonical registry key for a group name. Case-insensitive and
   * separator-agnostic on purpose: `userTone`, `usertone` and `USER_TONE`
   * all collapse to one key, so a folded group cannot be re-forked by case
   * alone. (Case-folding applies to the *key* only; the stored canonical
   * path keeps whatever casing `groupPath` produced.)
   */
  private static foldKey(group: string): string {
    return groupPath(group).split(path.sep).join('/').toLowerCase();
  }

  private groupsFile(): string {
    return path.resolve(this.root, 'groups.json');
  }

  private async loadGroupAliases(): Promise<void> {
    this.groupAliases.clear();
    let raw: string;
    try {
      raw = await readFile(this.groupsFile(), 'utf8');
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, string>;
      for (const [alias, canonical] of Object.entries(parsed ?? {})) {
        const a = FileStore.foldKey(alias);
        const c = groupPath(String(canonical)).split(path.sep).join('/');
        if (a && c && a !== c.toLowerCase()) this.groupAliases.set(a, c);
      }
    } catch (err) {
      process.emitWarning?.(`mnemo: ignoring unreadable groups.json: ${String(err)}`);
    }
  }

  private async persistGroupAliases(): Promise<void> {
    const out: Record<string, string> = {};
    for (const [alias, canonical] of this.groupAliases) out[alias] = canonical;
    await this.atomicWrite(this.groupsFile(), `${JSON.stringify(out, null, 2)}\n`);
  }

  /**
   * Follow alias -> canonical until the name is not itself an alias. Returns a
   * '/'-separated slug (safe to feed back into `groupPath`). The loop is
   * bounded so a hand-edited groups.json can never send us in circles.
   */
  resolveGroup(group: string): string {
    let current = groupPath(group).split(path.sep).join('/');
    for (let hops = 0; hops < 8; hops++) {
      const next = this.groupAliases.get(current.toLowerCase());
      if (!next || next === current) return current;
      current = next;
    }
    return current;
  }

  /**
   * Fold `alias` into `canonical`. Writes to the alias name land in the
   * canonical directory from now on; existing files move only when the caller
   * asks for it (see `moveGroup`).
   */
  async registerGroupAlias(alias: string, canonical: string): Promise<void> {
    const a = FileStore.foldKey(alias);
    const c = groupPath(canonical).split(path.sep).join('/');
    if (!a || !c) throw new PathEscapeError('group alias resolves to an empty path');
    if (a === c.toLowerCase()) {
      throw new Error(`group alias is a no-op: "${alias}" already resolves to "${c}"`);
    }
    this.groupAliases.set(a, c);
    await this.persistGroupAliases();
  }

  /** Alias map as plain JSON, for inspection and debugging. */
  groupAliasMap(): Record<string, string> {
    return Object.fromEntries(this.groupAliases);
  }

  /** Live records per group, sorted by size — the fragmentation view. */
  async groupsInfo(): Promise<Array<{ group: string; count: number; aliases: string[] }>> {
    await this.ensureLoaded();
    const counts = new Map<string, number>();
    for (const abs of this.location.values()) {
      const rel = path.relative(this.root, abs).split(path.sep).join('/');
      const m = rel.match(/^(facts|episodic)\/(.+)\/[^/]+\.md$/);
      if (!m) continue;
      const group = m[2];
      counts.set(group, (counts.get(group) ?? 0) + 1);
    }
    const result: Array<{ group: string; count: number; aliases: string[] }> = [];
    for (const [group, count] of counts) {
      const aliases: string[] = [];
      for (const [alias, canonical] of this.groupAliases) {
        if (canonical === group) aliases.push(alias);
      }
      result.push({ group, count, aliases: aliases.sort() });
    }
    return result.sort((a, b) => b.count - a.count || a.group.localeCompare(b.group));
  }

  /**
   * Physically move every record from group `from` into `to`. A file whose name
   * already exists in the target is left in place and reported — renaming it
   * would silently fork a record identity, and identities are the whole map.
   */
  async moveGroup(
    from: string,
    to: string,
  ): Promise<{ moved: string[]; conflicts: string[] }> {
    await this.ensureLoaded();
    const moved: string[] = [];
    const conflicts: string[] = [];
    // `from` is the PHYSICAL directory that exists on disk (the alias name the
    // files were written under), never resolved through the map — after
    // registration the map would just send us to the canonical dir and the
    // move would silently do nothing. `to` resolves: folding `to` into
    // something else moves files to the final home.
    const fromDirName = groupPath(from);
    const toDirName = groupPath(this.resolveGroup(to));
    if (!fromDirName || !toDirName || fromDirName === toDirName) {
      return { moved, conflicts };
    }
    for (const bucket of ['facts', 'episodic'] as const) {
      const fromDir = path.resolve(this.root, bucket, fromDirName);
      const toDir = path.resolve(this.root, bucket, toDirName);
      if (!fromDir.startsWith(this.root + path.sep) || !toDir.startsWith(this.root + path.sep)) {
        continue;
      }
      let files: string[];
      try {
        files = (await readdir(fromDir)).filter((f) => f.endsWith('.md'));
      } catch {
        continue;
      }
      if (files.length === 0) continue;
      await mkdir(toDir, { recursive: true });
      for (const file of files) {
        const fromAbs = path.resolve(fromDir, file);
        const toAbs = path.resolve(toDir, file);
        let exists = false;
        try {
          await stat(toAbs);
          exists = true;
        } catch {
          exists = false;
        }
        if (exists) {
          conflicts.push(path.relative(this.root, fromAbs).split(path.sep).join('/'));
          continue;
        }
        await rename(fromAbs, toAbs);
        const name = file.slice(0, -3);
        const mapped = this.location.get(name);
        if (mapped && path.resolve(mapped) === fromAbs) {
          this.location.set(name, toAbs);
        }
        moved.push(path.relative(this.root, toAbs).split(path.sep).join('/'));
      }
      // Leave the emptied directory in place: empty dirs are harmless and rm
      // on a directory the walk may still hold a handle into is not worth it.
    }
    return { moved, conflicts };
  }

  /** Relative path for a record, used for both writing and reporting. */
  relativePathFor(record: Pick<MemoryRecord, 'name' | 'type' | 'group'>): string {
    // `safeName` is a fresh string produced by SAFE_NAME_RE, never the caller's
    // input, so it cannot carry a separator or a traversal segment.
    const safeName = matchSafeName(record.name);
    if (!safeName) {
      throw new PathEscapeError(`record name is not a valid slug: ${record.name}`);
    }
    const dir = safeSegment(dirForType(record.type));
    if (dir === 'persona' || dir === 'intentions') {
      return path.join(dir, `${safeName}.md`);
    }
    // Group folding happens here so every path the store ever builds — writes
    // and reports alike — agrees on where an aliased group really lives.
    const folded = this.resolveGroup(record.group ?? '');
    return path.join(dir, groupPath(folded), `${safeName}.md`);
  }

  absolutePathFor(record: Pick<MemoryRecord, 'name' | 'type' | 'group'>): string {
    const relative = this.relativePathFor(record);
    const abs = path.resolve(this.root, relative);
    if (!abs.startsWith(this.root + path.sep)) {
      throw new PathEscapeError(`path escapes store root: ${relative}`);
    }
    return abs;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.rebuildLocationMap();
  }

  /** Force a rescan of the tree. Cheap (< 10ms for thousands of files). */
  async rebuildLocationMap(): Promise<void> {
    this.location.clear();
    for (const dir of RECORD_DIRS) {
      const abs = path.resolve(this.root, dir);
      if (!abs.startsWith(this.root + path.sep)) continue;
      await this.walk(abs, dir);
    }
    this.loaded = true;
  }

  private async walk(absDir: string, bucket: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        await this.walk(abs, bucket);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const name = entry.name.slice(0, -3);
        // archive/ wins over live paths: an archived record is not live.
        if (bucket === 'archive' || !this.location.has(name)) {
          this.location.set(name, abs);
        }
      }
    }
  }

  async exists(name: string): Promise<boolean> {
    await this.ensureLoaded();
    return this.location.has(name);
  }

  pathOf(name: string): string | undefined {
    return this.location.get(name);
  }

  /**
   * Write an existing record back in place.
   *
   * Unlike `save`, this never constructs a path: it writes to the location
   * already discovered by the directory scan. That makes an update incapable of
   * creating a file anywhere new, which is both faster and one less surface to
   * reason about. Callers that may be creating a record should use `save`.
   */
  async update(record: MemoryRecord): Promise<boolean> {
    await this.ensureLoaded();
    const existing = this.location.get(record.name);
    if (!existing) return false;
    const abs = path.resolve(existing);
    if (!abs.startsWith(this.root + path.sep)) {
      throw new PathEscapeError('record location escapes store root');
    }
    // Atomic: consolidation and reinforcement rewrite existing records far more
    // often than they create new ones, so this — not `save` — is the write that
    // most needs the temp-and-rename treatment.
    await this.atomicWrite(abs, serializeRecord(record));
    return true;
  }

  /** Write atomically: temp file then rename, so a crash never leaves half a record. */
  async save(record: MemoryRecord): Promise<string> {
    const abs = this.absolutePathFor(record);
    await mkdir(path.dirname(abs), { recursive: true });
    await this.atomicWrite(abs, serializeRecord(record));
    this.location.set(record.name, abs);
    this.loaded = true;
    return path.relative(this.root, abs);
  }

  async load(name: string): Promise<MemoryRecord | null> {
    await this.ensureLoaded();
    const abs = this.location.get(name);
    if (!abs) return null;
    return this.loadAt(abs);
  }

  async loadAt(abs: string): Promise<MemoryRecord> {
    const raw = await readFile(abs, 'utf8');
    return deserializeRecord(raw);
  }

  /** All live (non-archived) records. */
  async loadAll(): Promise<MemoryRecord[]> {
    await this.ensureLoaded();
    const out: MemoryRecord[] = [];
    for (const [name, abs] of this.location) {
      if (path.basename(path.dirname(abs)) === 'archive') continue;
      try {
        out.push(await this.loadAt(abs));
      } catch (err) {
        // A corrupt file must not take down the whole store: skip and keep going.
        process.emitWarning?.(`mnemo: skipping unreadable record ${name}: ${String(err)}`);
      }
    }
    return out;
  }

  async loadArchived(): Promise<MemoryRecord[]> {
    await this.ensureLoaded();
    const out: MemoryRecord[] = [];
    for (const [, abs] of this.location) {
      if (path.basename(path.dirname(abs)) !== 'archive') continue;
      out.push(await this.loadAt(abs));
    }
    return out;
  }

  /** Move a record into archive/. The file is preserved, not deleted. */
  async archive(record: MemoryRecord): Promise<string> {
    const safeName = matchSafeName(record.name);
    if (!safeName) {
      throw new PathEscapeError(`record name is not a valid slug: ${record.name}`);
    }
    // Prefer the discovered location: with group folding in play, a record may
    // physically live in the canonical directory while its record.group still
    // says the alias. The map never lies; `relativePathFor` can.
    const discovered = this.location.get(record.name);
    const fromAbs = discovered
      ? path.resolve(discovered)
      : path.resolve(this.root, this.relativePathFor(record));
    if (!fromAbs.startsWith(this.root + path.sep)) {
      throw new PathEscapeError('archive source escapes store root');
    }
    const toAbs = path.resolve(this.root, 'archive', `${safeName}.md`);
    if (!toAbs.startsWith(this.root + path.sep)) {
      throw new PathEscapeError('archive target escapes store root');
    }
    await mkdir(path.dirname(toAbs), { recursive: true });
    try {
      await rename(fromAbs, toAbs);
    } catch {
      // Already archived, or never written: fall back to a fresh write.
      await this.atomicWrite(toAbs, serializeRecord(record));
      await rm(fromAbs, { force: true });
    }
    this.location.set(record.name, toAbs);
    return path.relative(this.root, toAbs);
  }

  // ---------------------------------------------------------------- history --

  /**
   * Preserve the current state of a record before it is rewritten.
   *
   * Merging and superseding both destroy information: the old body is replaced.
   * Consolidation is the least-proven mechanism in this library, so it should be
   * *reversible*, not merely switchable. Every destructive rewrite takes one of
   * these first, which is what makes `restore()` honest.
   */
  async snapshot(record: MemoryRecord, at: Date): Promise<string> {
    const safeName = matchSafeName(record.name);
    if (!safeName) throw new PathEscapeError(`record name is not a valid slug: ${record.name}`);
    const version = at.toISOString().replace(/[:.]/g, '-');
    const dir = path.resolve(this.root, 'history', safeName);
    if (!dir.startsWith(this.root + path.sep)) {
      throw new PathEscapeError('history dir escapes store root');
    }
    await mkdir(dir, { recursive: true });
    const abs = path.resolve(dir, `${version}.md`);
    if (!abs.startsWith(dir + path.sep)) {
      throw new PathEscapeError('history file escapes history dir');
    }
    await this.atomicWrite(abs, serializeRecord(record));
    return path.relative(this.root, abs);
  }

  /** Versions kept for a record, newest first. */
  async historyVersions(name: string): Promise<string[]> {
    const safeName = matchSafeName(name);
    if (!safeName) return [];
    const dir = path.resolve(this.root, 'history', safeName);
    if (!dir.startsWith(this.root + path.sep)) return [];
    try {
      const entries = await readdir(dir);
      return entries
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.slice(0, -3))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  /** Read one preserved version, by the id returned from `historyVersions`. */
  async readVersion(name: string, version: string): Promise<string | null> {
    const safeName = matchSafeName(name);
    if (!safeName) return null;
    const dir = path.resolve(this.root, 'history', safeName);
    if (!dir.startsWith(this.root + path.sep)) return null;
    const abs = path.resolve(dir, `${safeSegment(version)}.md`);
    if (!abs.startsWith(dir + path.sep)) return null;
    try {
      return await readFile(abs, 'utf8');
    } catch {
      return null;
    }
  }

  /** Hard delete. Prefer `archive()`: forgetting should degrade, not vanish. */  async remove(name: string): Promise<boolean> {
    await this.ensureLoaded();
    const abs = this.location.get(name);
    if (!abs) return false;
    await rm(abs, { force: true });
    this.location.delete(name);
    return true;
  }

  /** Session-scoped directory for the task canvas and offloaded tool output. */
  sessionDir(sessionId: string): string {
    const abs = path.resolve(this.root, 'session', safeSegment(sessionId));
    if (!abs.startsWith(this.root + path.sep)) {
      throw new PathEscapeError('session dir escapes store root');
    }
    return abs;
  }

  private sessionFile(sessionId: string, file: string): string {
    const dir = path.resolve(this.root, 'session', safeSegment(sessionId));
    if (!dir.startsWith(this.root + path.sep)) {
      throw new PathEscapeError('session dir escapes store root');
    }
    const abs = path.resolve(dir, safeFileName(file));
    if (!abs.startsWith(dir + path.sep)) {
      throw new PathEscapeError('session file escapes session dir');
    }
    return abs;
  }

  async readSessionFile(sessionId: string, file: string): Promise<string | null> {
    const abs = this.sessionFile(sessionId, file);
    try {
      return await readFile(abs, 'utf8');
    } catch {
      return null;
    }
  }

  async writeSessionFile(sessionId: string, file: string, content: string): Promise<string> {
    const abs = this.sessionFile(sessionId, file);
    await mkdir(path.dirname(abs), { recursive: true });
    // Offloaded tool output can be large; losing half of it to a crash is worse
    // than losing nothing, and the caller has no way to tell.
    await this.atomicWrite(abs, content);
    return abs;
  }
}
