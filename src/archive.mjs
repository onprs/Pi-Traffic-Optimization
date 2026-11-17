import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, readFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const hash = (v) => createHash('sha256').update(v).digest('hex');
export const utf8Bytes = (s) => Buffer.byteLength(s, 'utf8');
const validId = /^ctx:\/\/(tool|image)\/[a-f0-9]{64}$/;
const parse = (row) => {
  if (!row) return undefined;
  try {
    const o = JSON.parse(row.metadata);
    if (!validId.test(o.id) || !['tool', 'image'].includes(o.kind) || !o.id.startsWith(`ctx://${o.kind}/`) ||
      !/^[a-f0-9]{64}$/.test(o.contentHash) || !Number.isFinite(o.createdAt) ||
      !Array.isArray(o.blobs) || !o.blobs.length || o.contentHash !== o.blobs[0] || !o.blobs.every(b => /^[a-f0-9]{64}$/.test(b))) return undefined;
    if (o.kind === 'tool' && (typeof o.toolName !== 'string' || typeof o.toolCallId !== 'string')) return undefined;
    if (o.kind === 'image' && (!Number.isFinite(o.originalBytes) || o.originalBytes < 0 ||
      !Number.isFinite(o.optimizedBytes) || o.optimizedBytes < 0 || typeof o.mimeType !== 'string')) return undefined;
    return o;
  } catch { return undefined; }
};

// blob 先 fsync + 原子 rename，再提交索引。未提交的 blob 不会产生可投影 handle。
export class ContextArchive {
  constructor(directory, options) {
    this.directory = directory;
    this.options = options;
    this.db = undefined;
    this.pending = new Map();
    this.writes = Promise.resolve();
    this.verifiedBlobs = new Map();
    this.initializing = undefined;
    this.owner = randomUUID();
    this.references = new Set();
    this.sessions = new Set();
  }

  async init() {
    if (this.db) return;
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      const { DatabaseSync } = await import('node:sqlite');
      await mkdir(join(this.directory, 'blobs'), { recursive: true, mode: 0o700 });
      const db = new DatabaseSync(join(this.directory, 'index.sqlite'));
      try {
        const version = db.prepare('PRAGMA user_version').get().user_version;
        if (version > 1) throw new Error('归档 schema 版本较新，保留原上下文');
        db.exec(`PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
          CREATE TABLE IF NOT EXISTS session_owners (session TEXT, owner TEXT, pid INTEGER, PRIMARY KEY(session,owner));
          CREATE TABLE IF NOT EXISTS object_sessions (id TEXT, session TEXT, PRIMARY KEY(id,session));
          CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS objects (id TEXT PRIMARY KEY, kind TEXT, session TEXT, tool TEXT,
            call_id TEXT, path TEXT, created INTEGER, content_hash TEXT, metadata TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS object_session ON objects(session, call_id);
          CREATE INDEX IF NOT EXISTS object_path ON objects(path);
          CREATE INDEX IF NOT EXISTS object_hash ON objects(content_hash);
          CREATE TABLE IF NOT EXISTS object_blobs (id TEXT, hash TEXT, PRIMARY KEY(id,hash));
          CREATE TABLE IF NOT EXISTS edges (source TEXT, target TEXT, relation TEXT, PRIMARY KEY(source,target,relation));
          CREATE TABLE IF NOT EXISTS usage (id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS projections (session TEXT, source TEXT, id TEXT, placeholder TEXT,
            PRIMARY KEY(session,source));
          CREATE TABLE IF NOT EXISTS object_search (id TEXT PRIMARY KEY, index_id TEXT NOT NULL);
          CREATE VIRTUAL TABLE IF NOT EXISTS history USING fts5(id UNINDEXED, text, tokenize='unicode61');
          INSERT OR IGNORE INTO object_search SELECT o.id,o.id FROM objects o JOIN history h ON h.id=o.id;`);
        if (!db.prepare('PRAGMA table_info(session_owners)').all().some(c => c.name === 'pid')) db.exec('ALTER TABLE session_owners ADD COLUMN pid INTEGER');
        db.exec('PRAGMA user_version=1');
        this.db = db;
      } catch (e) { db.close(); throw e; }
    })();
    try { await this.initializing; } finally { this.initializing = undefined; }
  }

  blobPath(key) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('归档 blob hash 无效');
    return join(this.directory, 'blobs', key + '.blob');
  }

  async writeBlob(buffer) {
    if (buffer.length > this.options.maxObjectMB * 1048576) throw new Error('对象超过归档上限，保留原上下文');
    const key = hash(buffer);
    const destination = this.blobPath(key);
    try {
      if ((await stat(destination)).size === buffer.length && await this.verifyBlob(key)) return { hash: key, bytes: buffer.length };
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const used = this.stats().allocatedBytes;
    if (used + buffer.length > this.options.maxSizeMB * 1048576) throw new Error('归档容量不足，保留原上下文');
    const temporary = destination + '.' + randomUUID() + '.tmp';
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(buffer);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, destination);
    } finally {
      await handle?.close();
      await rm(temporary, { force: true });
    }
    return { hash: key, bytes: buffer.length };
  }

  get(id) {
    if (!validId.test(id ?? '')) return undefined;
    return parse(this.db?.prepare('SELECT metadata FROM objects WHERE id=?').get(id));
  }

  async put(metadata, buffers, text = '') {
    await this.init();
    if (!validId.test(metadata.id)) throw new Error('归档 ID 无效');
    const existing = this.get(metadata.id);
    if (existing && await this.available(existing)) return existing;
    const inFlight = this.pending.get(metadata.id);
    if (inFlight) return inFlight;
    const operation = this.writes.then(() => this.transaction(async () => {
      const blobs = [];
      this.db.exec('SAVEPOINT archive_object');
      try {
        for (const buffer of buffers) blobs.push(await this.writeBlob(buffer));
        const object = { ...metadata, blobs: blobs.map(b => b.hash), archivePath: this.blobPath(blobs[0].hash),
          indexedChars: Math.min(text.length, this.options.maxIndexChars) };
        if (!parse({ metadata: JSON.stringify(object) })) throw new Error('归档 metadata 无效');
        this.db.prepare('DELETE FROM object_blobs WHERE id=?').run(object.id);
        this.db.prepare('DELETE FROM edges WHERE source=?').run(object.id);
        for (const blob of blobs) {
          this.db.prepare('INSERT OR IGNORE INTO blobs VALUES (?,?)').run(blob.hash, blob.bytes);
          this.db.prepare('INSERT OR IGNORE INTO object_blobs VALUES (?,?)').run(object.id, blob.hash);
        }
        this.db.prepare('INSERT OR REPLACE INTO objects VALUES (?,?,?,?,?,?,?,?,?)').run(object.id,
          object.kind, object.sessionId ?? '', object.toolName ?? '', object.toolCallId ?? '',
          object.path ?? '', object.createdAt, object.contentHash, JSON.stringify(object));
        const indexedText = text.slice(0, this.options.maxIndexChars);
        const indexId = hash(indexedText);
        if (!this.db.prepare('SELECT 1 FROM history WHERE id=?').get(indexId))
          this.db.prepare('INSERT INTO history VALUES (?,?)').run(indexId, indexedText);
        this.db.prepare('INSERT OR REPLACE INTO object_search VALUES (?,?)').run(object.id, indexId);
        for (const edge of object.related ?? []) this.db.prepare('INSERT OR IGNORE INTO edges VALUES (?,?,?)')
          .run(object.id, edge.id, edge.relation);
        this.db.prepare('INSERT OR IGNORE INTO object_sessions VALUES (?,?)').run(object.id, object.sessionId ?? '');
        if (object.toolCallId) this.db.prepare('UPDATE OR IGNORE edges SET target=? WHERE target=?')
          .run(object.id, `call:${object.sessionId}:${object.toolCallId}`);
        if (this.stats().allocatedBytes > this.options.maxSizeMB * 1048576) throw new Error('归档与索引容量不足，保留原上下文');
        this.db.exec('RELEASE archive_object');
        return object;
      } catch (e) {
        this.db.exec('ROLLBACK TO archive_object');
        for (const blob of blobs) {
          try { if (!this.db.prepare('SELECT 1 FROM blobs WHERE hash=?').get(blob.hash) && !this.metadataReferencesBlob(blob.hash)) await rm(this.blobPath(blob.hash), { force: true }); }
          catch { /* 故障时保留未确认的文件，交给维护清理。 */ }
        }
        throw e;
      }
    }));
    this.writes = operation.catch(() => {});
    this.pending.set(metadata.id, operation);
    try { return await operation; } finally { this.pending.delete(metadata.id); }
  }

  async transaction(operation) {
    // 文件写入和清理共用 SQLite 写锁，避免另一个进程删除正在提交的 blob。
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = await operation(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); this.references.clear(); this.sessions.clear(); throw e; }
  }
  async verifyBlob(key, knownStat) {
    const path = this.blobPath(key);
    const info = knownStat ?? await stat(path);
    const tag = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    if (this.verifiedBlobs.get(key) === tag) return true;
    const data = await readFile(path);
    if (hash(data) !== key) return false;
    this.verifiedBlobs.set(key, tag);
    return true;
  }
  async available(object) {
    if (!object?.blobs?.length) return false;
    const indexed = this.get(object.id);
    if (!indexed || indexed.contentHash !== object.contentHash || JSON.stringify(indexed.blobs) !== JSON.stringify(object.blobs)) return false;
    try {
      for (const key of object.blobs) {
        const file = await stat(this.blobPath(key));
        const expected = this.db.prepare('SELECT bytes FROM blobs WHERE hash=?').get(key);
        if (!file.isFile() || !expected || file.size !== expected.bytes || !await this.verifyBlob(key, file)) return false;
      }
      return true;
    } catch { return false; }
  }

  metadataReferencesBlob(key) {
    // 索引不完整时保留文件；只删除可以证明没有 metadata 引用的 blob。
    if (this.db.prepare('SELECT 1 FROM objects WHERE NOT json_valid(metadata) LIMIT 1').get()) return true;
    if (this.db.prepare("SELECT 1 FROM objects WHERE json_type(metadata,'$.blobs') IS NOT 'array' LIMIT 1").get()) return true;
    return Boolean(this.db.prepare("SELECT 1 FROM objects o,json_each(o.metadata,'$.blobs') b WHERE b.value=? LIMIT 1").get(key));
  }
  async readBlob(key) {
    const data = await readFile(this.blobPath(key));
    if (hash(data) !== key) throw new Error('归档校验失败；可从 canonical session 恢复');
    return data;
  }

  usage(id) {
    const row = this.db?.prepare('SELECT data FROM usage WHERE id=?').get(id);
    return row ? JSON.parse(row.data) : { recallCount: 0, reuseCount: 0, evictionCount: 0,
      lastRecalled: 0, leaseUntilTurn: 0, leaseUntilTime: 0, state: 'WARM' };
  }
  saveUsage(id, data) { this.db.prepare('INSERT OR REPLACE INTO usage VALUES (?,?)').run(id, JSON.stringify(data)); }
  projection(session, source) { return this.db?.prepare('SELECT * FROM projections WHERE session=? AND source=?').get(session, source); }
  projectionsForSession(session) {
    const map = new Map();
    for (const row of this.db?.prepare('SELECT source, id, placeholder FROM projections WHERE session=?').all(session) ?? []) {
      map.set(row.source, row);
    }
    return map;
  }
  saveProjection(session, source, id, placeholder) {
    this.db.prepare('INSERT OR REPLACE INTO projections VALUES (?,?,?,?)').run(session, source, id, placeholder);
  }
  markStale(path, currentHash) {
    for (const row of this.db?.prepare("SELECT metadata FROM objects WHERE path=? AND kind='tool' AND tool='read'").all(path) ?? []) {
      const o = parse(row);
      if (!o) continue;
      const stale = currentHash ? o.fileHashAtRead !== currentHash : true;
      if (Boolean(o.stale) !== stale) {
        o.stale = stale;
        this.db.prepare('UPDATE objects SET metadata=? WHERE id=?').run(JSON.stringify(o), o.id);
      }
    }
  }
  attach(session) {
    if (this.sessions.has(session)) return;
    this.db.prepare('INSERT OR REPLACE INTO session_owners VALUES (?,?,?)').run(session, this.owner, process.pid);
    this.sessions.add(session);
  }
  reference(session, id) {
    this.attach(session);
    const key = session + ':' + id;
    if (this.references.has(key)) return;
    this.db.prepare('INSERT OR IGNORE INTO object_sessions VALUES (?,?)').run(id, session);
    this.references.add(key);
  }
  findByCall(session, call) {
    return parse(this.db?.prepare("SELECT metadata FROM objects WHERE session=? AND call_id=? AND kind='tool' ORDER BY created DESC LIMIT 1").get(session, call));
  }
  findByHash(contentHash, limit = 10) {
    return (this.db?.prepare('SELECT metadata FROM objects WHERE content_hash=? LIMIT ?').all(contentHash, limit) ?? []).map(parse);
  }
  relationships(id, limit = 20) {
    return this.db.prepare('SELECT source,target,relation FROM edges WHERE source=? OR target=? LIMIT ?').all(id, id, limit);
  }
  search(query, { sessionId, toolName, path, limit = 10, offset = 0 } = {}) {
    // 将用户词转成字面 FTS 查询，禁止注入 FTS 运算符；BM25 排序由 SQLite 完成。
    const words = String(query).match(/[\p{L}\p{N}_]+/gu)?.slice(0, 24);
    if (!words?.length) return [];
    const match = words.map(w => '"' + w + '"').join(' OR ');
    return this.db.prepare(`SELECT o.metadata, snippet(history,1,'[',']','…',24) AS excerpt, bm25(history) AS rank
      FROM history JOIN object_search s ON s.index_id=history.id JOIN objects o ON o.id=s.id WHERE history MATCH ?
      AND (?='' OR o.session=?) AND (?='' OR o.tool=?) AND (?='' OR o.path=?) ORDER BY rank,o.created DESC,o.id LIMIT ? OFFSET ?`)
      .all(match, sessionId ?? '', sessionId ?? '', toolName ?? '', toolName ?? '', path ?? '', path ?? '', limit, offset)
      .map(row => ({ ...parse(row), excerpt: row.excerpt, rank: row.rank })).filter(o => o.id);
  }
  list(sessionId, limit = 20) {
    return (this.db?.prepare('SELECT metadata FROM objects WHERE session=? ORDER BY created DESC LIMIT ?').all(sessionId, limit) ?? []).map(parse);
  }
  stats() {
    if (!this.db) return { objects: 0, blobBytes: 0, blobs: 0, indexBytes: 0, allocatedBytes: 0 };
    const blobs = this.db.prepare('SELECT COUNT(*) AS blobs, COALESCE(SUM(bytes),0) AS blobBytes FROM blobs').get();
    const indexBytes = this.db.prepare('PRAGMA page_count').get().page_count * this.db.prepare('PRAGMA page_size').get().page_size;
    return { objects: this.db.prepare('SELECT COUNT(*) AS n FROM objects').get().n,
      ...blobs, indexBytes, allocatedBytes: blobs.blobBytes + indexBytes };
  }

  async collect({ activeIds = new Set(), activeSession, now = Date.now() } = {}) {
    await this.init();
    const operation = this.writes.then(() => this.collectLocked({ activeIds, activeSession, now }));
    this.writes = operation.catch(() => {});
    const result = await operation;
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE); PRAGMA incremental_vacuum(256);');
    return result;
  }
  async collectLocked({ activeIds, activeSession, now }) {
    const before = this.stats();
    let removed = 0;
    await this.transaction(async () => {
      const cutoff = now - this.options.retentionDays * 86400000;
      const liveSessions = new Set();
      for (const owner of this.db.prepare('SELECT session,pid FROM session_owners').all()) {
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) { liveSessions.add(owner.session); continue; }
        try { process.kill(owner.pid, 0); liveSessions.add(owner.session); }
        catch (e) { if (e.code === 'EPERM') liveSessions.add(owner.session); }
      }
      // 活跃 session 和引用中的对象不删除；容量不足时停止新增归档，安全回退。
      const rows = this.db.prepare('SELECT metadata FROM objects WHERE created<? AND session<>?').all(cutoff, activeSession ?? '');
      for (const row of rows) {
        const o = parse(row);
        if (!o) continue;
        if (activeIds.has(o.id) || this.usage(o.id).leaseUntilTime > now ||
          this.db.prepare('SELECT session FROM object_sessions WHERE id=?').all(o.id).some(row => liveSessions.has(row.session))) continue;
        for (const table of ['objects', 'object_blobs', 'usage', 'object_search', 'object_sessions', 'projections']) {
          this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(o.id);
        }
        this.db.prepare('DELETE FROM edges WHERE source=? OR target=?').run(o.id, o.id);
        removed++;
      }
      this.db.prepare('DELETE FROM history WHERE id NOT IN (SELECT index_id FROM object_search)').run();
    });
    // metadata 删除先提交；文件清理失败时不会恢复指向已删除文件的记录。
    await this.transaction(async () => {
      const unknownReferences = this.db.prepare('SELECT 1 FROM objects WHERE NOT json_valid(metadata) LIMIT 1').get() ||
        this.db.prepare("SELECT 1 FROM objects WHERE json_type(metadata,'$.blobs') IS NOT 'array' LIMIT 1").get();
      const referenced = unknownReferences ? undefined : new Set(this.db.prepare("SELECT b.value FROM objects o,json_each(o.metadata,'$.blobs') b").all().map(r => r.value));
      const protectedBlob = key => !referenced || referenced.has(key);
      for (const row of this.db.prepare('SELECT hash FROM blobs WHERE hash NOT IN (SELECT hash FROM object_blobs)').all()) {
        if (protectedBlob(row.hash)) continue;
        await rm(this.blobPath(row.hash), { force: true });
        this.db.prepare('DELETE FROM blobs WHERE hash=?').run(row.hash);
      }
      // 恢复失败事务/进程中断遗留的 blob。活跃写入期间不处理孤立文件。
      if (!this.pending.size) for (const name of await readdir(join(this.directory, 'blobs'))) {
        const match = /^([a-f0-9]{64})\.blob$/.exec(name);
        const indexed = match && (this.db.prepare('SELECT 1 FROM blobs WHERE hash=?').get(match[1]) || protectedBlob(match[1]));
        const path = join(this.directory, 'blobs', name);
        if (!indexed && (/^[a-f0-9]{64}\.blob$/.test(name) || /^[a-f0-9]{64}\.blob\.[a-f0-9-]+\.tmp$/.test(name)) &&
          now - (await stat(path)).mtimeMs > 86400000) await rm(path, { force: true });
      }
    });
    return { removed, before, after: this.stats() };
  }

  async close() {
    await this.writes;
    await Promise.allSettled([...this.pending.values()]);
    try { this.db?.prepare('DELETE FROM session_owners WHERE owner=?').run(this.owner); } catch { /* 故障时仍应释放连接。 */ }
    this.db?.close();
    this.db = undefined;
    this.verifiedBlobs.clear(); this.references.clear(); this.sessions.clear();
  }
}
