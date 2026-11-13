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
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { shortHash } from '../util/id.js';
import { deserializeRecord, serializeRecord } from './frontmatter.js';
const DIRS = ['facts', 'episodic', 'persona', 'intentions', 'archive', 'session', 'index'];
const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/**
 * The only pattern a record name may match. `matchSafeName` returns the matched
 * text rather than validating the original string in place: the value that
 * reaches `path.join` is always a fresh string produced by the regex, so no
 * caller-supplied character can ever be part of a path.
 */
const SAFE_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export function matchSafeName(name) {
    const found = name.match(SAFE_NAME_RE);
    return found ? found[0] : null;
}
/** Thrown when a name or path segment would escape the store root. */
export class PathEscapeError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PathEscapeError';
    }
}
function safeSegment(segment) {
    if (SAFE_SEGMENT_RE.test(segment) && segment !== '.' && segment !== '..')
        return segment;
    const cleaned = segment
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^[-.]+|-+$/g, '');
    return cleaned.length > 0 ? cleaned.slice(0, 48) : `g-${shortHash(segment)}`;
}
function groupPath(group) {
    const parts = group
        .split('/')
        .filter((p) => p.length > 0 && p !== '.' && p !== '..')
        .map(safeSegment);
    return parts.length > 0 ? parts.join(path.sep) : 'default';
}
/** Reduce an arbitrary caller value to a single safe filename (no separators). */
function safeFileName(file) {
    const base = path.basename(file);
    if (SAFE_SEGMENT_RE.test(base) && base !== '.' && base !== '..')
        return base;
    const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+/, '');
    return cleaned.length > 0 ? cleaned.slice(0, 48) : `f-${shortHash(file)}`;
}
/** Which top-level directory a record type lives in. */
export function dirForType(type) {
    switch (type) {
        case 'event':
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
    root;
    location = new Map();
    loaded = false;
    constructor(root) {
        if (!root || root.trim().length === 0)
            throw new Error('FileStore requires a root directory');
        this.root = path.resolve(root);
    }
    async init() {
        for (const dir of DIRS) {
            const abs = path.resolve(this.root, dir);
            if (!abs.startsWith(this.root + path.sep)) {
                throw new PathEscapeError(`store dir escapes root: ${dir}`);
            }
            await mkdir(abs, { recursive: true });
        }
    }
    /** Relative path for a record, used for both writing and reporting. */
    relativePathFor(record) {
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
        return path.join(dir, groupPath(record.group), `${safeName}.md`);
    }
    absolutePathFor(record) {
        const relative = this.relativePathFor(record);
        const abs = path.resolve(this.root, relative);
        if (!abs.startsWith(this.root + path.sep)) {
            throw new PathEscapeError(`path escapes store root: ${relative}`);
        }
        return abs;
    }
    async ensureLoaded() {
        if (this.loaded)
            return;
        await this.rebuildLocationMap();
    }
    /** Force a rescan of the tree. Cheap (< 10ms for thousands of files). */
    async rebuildLocationMap() {
        this.location.clear();
        for (const dir of ['facts', 'episodic', 'persona', 'intentions', 'archive']) {
            const abs = path.resolve(this.root, dir);
            if (!abs.startsWith(this.root + path.sep))
                continue;
            await this.walk(abs, dir);
        }
        this.loaded = true;
    }
    async walk(absDir, bucket) {
        let entries;
        try {
            entries = await readdir(absDir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const abs = path.join(absDir, entry.name);
            if (entry.isDirectory()) {
                await this.walk(abs, bucket);
            }
            else if (entry.isFile() && entry.name.endsWith('.md')) {
                const name = entry.name.slice(0, -3);
                // archive/ wins over live paths: an archived record is not live.
                if (bucket === 'archive' || !this.location.has(name)) {
                    this.location.set(name, abs);
                }
            }
        }
    }
    async exists(name) {
        await this.ensureLoaded();
        return this.location.has(name);
    }
    pathOf(name) {
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
    async update(record) {
        await this.ensureLoaded();
        const existing = this.location.get(record.name);
        if (!existing)
            return false;
        const abs = path.resolve(existing);
        if (!abs.startsWith(this.root + path.sep)) {
            throw new PathEscapeError('record location escapes store root');
        }
        await writeFile(abs, serializeRecord(record), 'utf8');
        return true;
    }
    /** Write atomically: temp file then rename, so a crash never leaves half a record. */
    async save(record) {
        const abs = this.absolutePathFor(record);
        await mkdir(path.dirname(abs), { recursive: true });
        const tmp = `${abs}.tmp-${process.pid}`;
        await writeFile(tmp, serializeRecord(record), 'utf8');
        await rename(tmp, abs);
        this.location.set(record.name, abs);
        this.loaded = true;
        return path.relative(this.root, abs);
    }
    async load(name) {
        await this.ensureLoaded();
        const abs = this.location.get(name);
        if (!abs)
            return null;
        return this.loadAt(abs);
    }
    async loadAt(abs) {
        const raw = await readFile(abs, 'utf8');
        return deserializeRecord(raw);
    }
    /** All live (non-archived) records. */
    async loadAll() {
        await this.ensureLoaded();
        const out = [];
        for (const [name, abs] of this.location) {
            if (path.basename(path.dirname(abs)) === 'archive')
                continue;
            try {
                out.push(await this.loadAt(abs));
            }
            catch (err) {
                // A corrupt file must not take down the whole store: skip and keep going.
                process.emitWarning?.(`mnemo: skipping unreadable record ${name}: ${String(err)}`);
            }
        }
        return out;
    }
    async loadArchived() {
        await this.ensureLoaded();
        const out = [];
        for (const [, abs] of this.location) {
            if (path.basename(path.dirname(abs)) !== 'archive')
                continue;
            out.push(await this.loadAt(abs));
        }
        return out;
    }
    /** Move a record into archive/. The file is preserved, not deleted. */
    async archive(record) {
        const safeName = matchSafeName(record.name);
        if (!safeName) {
            throw new PathEscapeError(`record name is not a valid slug: ${record.name}`);
        }
        const fromAbs = path.resolve(this.root, this.relativePathFor(record));
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
        }
        catch {
            // Already archived, or never written: fall back to a fresh write.
            await writeFile(toAbs, serializeRecord(record), 'utf8');
            await rm(fromAbs, { force: true });
        }
        this.location.set(record.name, toAbs);
        return path.relative(this.root, toAbs);
    }
    /** Hard delete. Prefer `archive()`: forgetting should degrade, not vanish. */
    async remove(name) {
        await this.ensureLoaded();
        const abs = this.location.get(name);
        if (!abs)
            return false;
        await rm(abs, { force: true });
        this.location.delete(name);
        return true;
    }
    /** Session-scoped directory for the task canvas and offloaded tool output. */
    sessionDir(sessionId) {
        const abs = path.resolve(this.root, 'session', safeSegment(sessionId));
        if (!abs.startsWith(this.root + path.sep)) {
            throw new PathEscapeError('session dir escapes store root');
        }
        return abs;
    }
    sessionFile(sessionId, file) {
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
    async readSessionFile(sessionId, file) {
        const abs = this.sessionFile(sessionId, file);
        try {
            return await readFile(abs, 'utf8');
        }
        catch {
            return null;
        }
    }
    async writeSessionFile(sessionId, file, content) {
        const abs = this.sessionFile(sessionId, file);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, content, 'utf8');
        return abs;
    }
}
//# sourceMappingURL=file-store.js.map