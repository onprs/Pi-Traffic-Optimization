import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, normalize } from 'node:path';
import { homedir } from 'node:os';
import sharp from 'sharp';
const revision = new URL(import.meta.url).search;
const { ContextArchive, hash, utf8Bytes } = await import(new URL('./archive.mjs' + revision, import.meta.url).href);
const { fingerprint } = await import(new URL('./optimizer.mjs' + revision, import.meta.url).href);

const textOf = (content) => (content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
const READ_TOOLS = new Set(['read', 'agy_read']);
const EDIT_TOOLS = new Set(['edit', 'write', 'agy_edit', 'agy_write']);
const SHELL_TOOLS = new Set(['bash', 'powershell', 'agy_bash']);
const signature = (content) => (content ?? []).flatMap(b => b.type === 'image' ? [b.type, b.mimeType, b.data] : [b.type, b.text ?? JSON.stringify(b)]);
const equal = (a, b) => a?.length === b.length && a.every((v, i) => v === b[i]);
const emptyMetrics = () => ({ toolOutputsArchived: 0, toolBytesProjected: 0, imageBlocksProjected: 0,
  imageBytesAvoided: 0, recallCalls: 0, recallBytesReturned: 0, archiveHits: 0, staleSnapshotHits: 0,
  exactRecallsWithoutToolExecution: 0, toolReexecutionAvoided: null, projectionMs: 0, recallMs: 0,
  thrashingCount: 0, reevictionCount: 0, gcSweeps: 0, gcSkips: 0, failures: 0, compactAttempts: 0,
  emergencyCompactCount: 0, compactFallbacks: 0, estimatedCompactPressureRelieved: 0, archiveMs: 0 });

export class ContextMemory {
  constructor({ directory, config, optimizer, clock = () => Date.now() }) {
    this.config = config;
    this.optimizer = optimizer;
    this.clock = clock;
    this.archive = new ContextArchive(directory, config.contextOptimization.archive);
    this.sessionId = 'ephemeral';
    this.sessionFile = undefined;
    this.cwd = process.cwd();
    this.turn = 0;
    this.calls = new Map();
    this.recallParents = new Map();
    this.children = new Map();
    this.results = new Map();
    this.images = new Map();
    this.versions = new Map();
    this.activeIds = new Set();
    this.metrics = emptyMetrics();
    this.last = {};
    this.working = { activeFiles: {}, recentReads: {}, modifiedFiles: {}, latestCommands: {}, latestTests: {}, hotContextObjects: [], currentTaskObjects: [] };
    this.lastFailure = undefined;
    this.lastEdit = undefined;
    this.lastSweep = 0;
    this.compactSinceProjection = false;
    this.fallbackPending = false;
    this.fallbackInProgress = false;
    this.lastFallbackAt = 0;
    this.forceGC = false;
    this.lastGcTurn = -Infinity;
    this.calibrationFactor = 1;
    this.calibrationModel = undefined;
    this.lastCalibrationSample = undefined;
  }
  get options() { return this.config.contextOptimization; }
  get enabled() { return this.config.enabled && this.options.enabled; }
  saveSessionState() {
    if (!this.archive.db) return;
    this.archive.saveUsage(`session:${this.sessionId}`, {
      lastGcTurn: Number.isFinite(this.lastGcTurn) && this.lastGcTurn >= 0 ? this.lastGcTurn : null,
      calibrationFactor: this.calibrationFactor,
      calibrationModel: this.calibrationModel ?? null,
    });
  }
  onCompact() {
    this.calibrationFactor = 1;
    this.lastCalibrationSample = undefined;
    try { this.saveSessionState(); } catch { /* 故障时忽略辅助状态持久化。 */ }
  }
  observeAssistantMessage(message, { skipCalibration = false } = {}) {
    if (!this.enabled || message?.role !== 'assistant') return;
    if (skipCalibration || message.stopReason === 'aborted' || message.stopReason === 'error') {
      this.lastCalibrationSample = undefined;
      return;
    }
    const usage = message.usage;
    const actualInput = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
    const modelKey = `${message.provider ?? ''}:${message.model ?? ''}`;
    const sample = this.lastCalibrationSample;
    this.lastCalibrationSample = undefined;
    // 过滤多工具并发切片回报的极小分摊样本，避免拉低正常上下文校准系数。
    if (sample && sample.modelKey === modelKey && actualInput > 0 && sample.uncalibratedTokens >= 16384 &&
      actualInput >= sample.uncalibratedTokens * 0.25) {
      const ratio = Math.max(1, Math.min(1.8, actualInput / sample.uncalibratedTokens));
      this.calibrationFactor = this.calibrationFactor === 1 ? ratio : 0.35 * ratio + 0.65 * this.calibrationFactor;
      this.calibrationModel = modelKey;
      try { this.saveSessionState(); } catch { /* 故障时忽略辅助状态持久化。 */ }
    }
  }
  async start(ctx) {
    this.sessionId = ctx.sessionManager?.getSessionId?.() ?? this.sessionId;
    this.sessionFile = ctx.sessionManager?.getSessionFile?.();
    this.cwd = ctx.cwd ?? process.cwd();
    if (!this.enabled) return;
    await this.archive.init();
    this.archive.attach(this.sessionId);
    // 只在启动/分支切换时重建工作状态；投影不扫描整个 session 文件。
    const entries = ctx.sessionManager?.getBranch?.() ?? [];
    this.calls.clear(); this.results.clear(); this.recallParents.clear(); this.children.clear();
    this.working = { activeFiles: {}, recentReads: {}, modifiedFiles: {}, latestCommands: {}, latestTests: {}, hotContextObjects: [], currentTaskObjects: [] };
    this.lastFailure = undefined; this.lastEdit = undefined;
    this.turn = 0;
    for (const e of entries) {
      const m = e.message;
      if (m?.role === 'assistant') {
        this.turn++;
        for (const b of m.content ?? []) if (b.type === 'toolCall') this.calls.set(b.id,
          { input: b.arguments, toolName: b.name, cwd: this.cwd, historical: true, turn: this.turn });
      } else if (m?.role === 'toolResult' && m.toolName !== 'context_recall') {
        try {
          const prior = this.archive.findByCall(this.sessionId, m.toolCallId);
          const imagesMatch = (m.content ?? []).filter(b => b.type === 'image').every(b =>
            prior?.related?.some(e => e.relation === 'contains_image' && e.id === `ctx://image/${hash(Buffer.from(b.data, 'base64'))}`));
          if (imagesMatch && prior?.snapshotHash === hash(textOf(m.content)) && await this.available(prior)) {
            this.results.set(m.toolCallId, { object: prior, signature: signature(m.content) });
            this.updateWorking(prior);
          } else await this.capture(m);
        } catch { this.metrics.failures++; }
      }
    }
    const savedState = this.archive.usage(`session:${this.sessionId}`);
    this.lastGcTurn = Number.isSafeInteger(savedState.lastGcTurn) && savedState.lastGcTurn >= 0 && savedState.lastGcTurn <= this.turn
      ? savedState.lastGcTurn : -Infinity;
    this.calibrationFactor = Number.isFinite(savedState.calibrationFactor) && savedState.calibrationFactor >= 1 && savedState.calibrationFactor <= 1.8
      ? savedState.calibrationFactor : 1;
    this.calibrationModel = typeof savedState.calibrationModel === 'string' ? savedState.calibrationModel : undefined;
    this.lastCalibrationSample = undefined;
  }
  setTurn() { this.turn++; }
  filePath(path, cwd = this.cwd) {
    if (typeof path !== 'string') return undefined;
    path = path.replace(/^@/, '').replace(/[\u00a0\u202f]/g, ' ');
    if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) path = homedir() + path.slice(1);
    return normalize(resolve(cwd, path));
  }
  async version(path, force = false, range) {
    const began = performance.now();
    try {
      const before = await stat(path);
      const tag = `${before.size}:${before.mtimeMs}:${before.ctimeMs}:${before.ino}`;
      if (!force && this.versions.get(path)?.tag === tag) return this.versions.get(path);
      if (!before.isFile() || before.size > this.options.archive.maxFileHashMB * 1048576) return { status: 'unverified', tag };
      const h = createHash('sha256');
      const chunks = range ? [] : undefined;
      for await (const chunk of createReadStream(path)) { h.update(chunk); chunks?.push(chunk); }
      const after = await stat(path);
      if (`${after.size}:${after.mtimeMs}:${after.ctimeMs}:${after.ino}` !== tag) return { status: 'unstable', tag };
      const value = { status: 'verified', hash: h.digest('hex'), tag };
      this.versions.set(path, value);
      if (chunks) {
        const selected = Buffer.concat(chunks).toString('utf8').split('\n')
          .slice(Math.max(0, (range.offset ?? 1) - 1), Math.max(0, (range.offset ?? 1) - 1) + Math.min(range.limit ?? this.options.archive.maxSnapshotProofLines, this.options.archive.maxSnapshotProofLines)).join('\n');
        return { ...value, snapshotText: Buffer.from(selected).subarray(0, this.options.archive.maxSnapshotProofBytes).toString('utf8') };
      }
      return value;
    } catch { return { status: 'unavailable' }; }
    finally { this.metrics.fileValidationMs = (this.metrics.fileValidationMs ?? 0) + performance.now() - began; }
  }
  trimMap(map) {
    const keys = Object.keys(map);
    for (const key of keys.slice(0, Math.max(0, keys.length - this.options.stateLimit))) delete map[key];
  }
  modifiedPaths(toolName, input = {}, details, cwd = this.cwd) {
    const hasDiffs = typeof toolName === 'string' && toolName.startsWith('agy_') && Array.isArray(details?.diffs) && details.diffs.length > 0;
    if (!EDIT_TOOLS.has(toolName) && !hasDiffs) return [];
    const seen = new Set();
    const collect = (raw) => {
      const resolved = this.filePath(raw, cwd);
      if (resolved) seen.add(resolved);
    };
    collect(input?.path);
    collect(details?.path);
    for (const diff of details?.diffs ?? []) collect(diff?.path);
    return [...seen];
  }
  async observeCall(event, ctx) {
    if (!this.enabled || event.toolName === 'context_recall') return;
    const input = structuredClone(event.input ?? {});
    const call = { toolName: event.toolName, input, cwd: ctx.cwd ?? this.cwd,
      parentToolCallId: event.parentToolCallId, startedAt: this.clock(), turn: this.turn };
    const path = this.filePath(input.path, call.cwd);
    if (path && event.toolName === 'read') call.before = await this.version(path, true, input);
    this.calls.set(event.toolCallId, call);
  }
  async observeResult(event, ctx) {
    if (!this.enabled) return;
    if (event.toolName === 'context_recall') {
      if (event.parentToolCallId && event.details?.contextId) {
        const ids = this.recallParents.get(event.parentToolCallId) ?? new Set();
        ids.add(event.details.contextId); this.recallParents.set(event.parentToolCallId, ids);
      }
      return;
    }
    const call = this.calls.get(event.toolCallId) ?? { input: event.input ?? {}, cwd: ctx.cwd ?? this.cwd, historical: true };
    if (event.input) {
      if (event.input.path !== call.input?.path) call.before = undefined;
      call.input = structuredClone(event.input); this.calls.set(event.toolCallId, call);
    }
    const editedPaths = this.modifiedPaths(event.toolName, call.input, event.details, call.cwd);
    if (editedPaths.length && !event.isError) {
      for (const path of editedPaths) {
        this.versions.delete(path);
        this.archive.markStale(path);
        this.working.modifiedFiles[path] = { turn: this.turn, toolCallId: event.toolCallId };
      }
      this.trimMap(this.working.modifiedFiles);
    }
    await this.capture({ ...event, role: 'toolResult', timestamp: this.clock() }, call);
  }

  async capture(message, call = this.calls.get(message.toolCallId) ?? {}, { recallPage = false } = {}) {
    if (!this.enabled || !this.options.archiveToolResults || (message.toolName === 'context_recall' && !recallPage)) return undefined;
    const source = message.toolCallId;
    if (!source || !Array.isArray(message.content)) return undefined;
    const sig = signature(message.content);
    const cached = this.results.get(source);
    if (cached && equal(cached.signature, sig)) return cached.object;
    const began = performance.now();
    const input = call.input ?? {};
    const cwd = call.cwd ?? this.cwd;
    const editedPaths = this.modifiedPaths(message.toolName, input, message.details, cwd);
    const path = this.filePath(input.path ?? message.details?.path ?? message.details?.diffs?.[0]?.path, cwd);
    const command = input.command ?? message.details?.command;
    const query = input.pattern ?? input.query ?? message.details?.query;
    const originalText = textOf(message.content);
    const containsImages = message.content.some(b => b.type === 'image');
    const size = utf8Bytes(originalText);
    if (size > this.options.archive.maxObjectMB * 1048576) {
      this.results.set(source, { signature: sig, object: undefined }); return undefined;
    }
    // 小型文件操作也归档，以便查询历史和建立关系；普通小输出保留原样。
    if (!recallPage && size < this.options.minimumToolResultBytes && !containsImages &&
      !READ_TOOLS.has(message.toolName) && !EDIT_TOOLS.has(message.toolName) && editedPaths.length === 0) return undefined;
    const related = [];
    if (recallPage && message.details?.contextId) related.push({ id: message.details.contextId, relation: 'recalls' });
    if (call.parentToolCallId) related.push({ id: `call:${this.sessionId}:${call.parentToolCallId}`, relation: 'nested_in' });
    for (const id of this.recallParents.get(source) ?? []) related.push({ id, relation: 'recalls' });
    for (const id of this.children.get(source) ?? []) related.push({ id, relation: 'contains_nested_result' });
    const seenSameFile = new Set();
    for (const relatedPath of [path, ...editedPaths]) {
      if (!relatedPath || seenSameFile.has(relatedPath)) continue;
      seenSameFile.add(relatedPath);
      if (this.working.recentReads[relatedPath]) related.push({ id: this.working.recentReads[relatedPath].id, relation: 'same_file' });
    }
    if ((EDIT_TOOLS.has(message.toolName) || editedPaths.length > 0) && this.lastFailure) related.push({ id: this.lastFailure, relation: 'after_failure' });
    if (SHELL_TOOLS.has(message.toolName) && this.lastEdit) related.push({ id: this.lastEdit, relation: 'runs_after_edit' });
    const content = [];
    let imageBytes = 0;
    for (const block of message.content) {
      if (block.type !== 'image') { content.push(block); continue; }
      const image = await this.captureImage(block, { toolName: message.toolName, toolCallId: source, path,
        recallSourceId: recallPage ? message.details?.contextId : undefined });
      content.push({ type: 'archivedImage', id: image.id });
      imageBytes += image.optimizedBytes;
      related.push({ id: image.id, relation: 'contains_image' });
    }
    const structured = message.structuredContent ?? {};
    const hasFullOutput = ['bash', 'powershell'].includes(message.toolName) && typeof structured.output === 'string';
    const fullText = hasFullOutput ? structured.output : originalText;
    if (utf8Bytes(fullText) > this.options.archive.maxObjectMB * 1048576) {
      this.results.set(source, { signature: sig, object: undefined }); return undefined;
    }
    const argsJson = JSON.stringify(input);
    if (utf8Bytes(argsJson) > this.options.archive.maxObjectMB * 1048576) {
      this.results.set(source, { signature: sig, object: undefined }); return undefined;
    }
    const argsBuffer = Buffer.from(argsJson);
    const argumentHash = hash(argsBuffer);
    const argumentsArchived = argsBuffer.length > this.options.archive.maxMetadataArgumentBytes;
    const storedInput = argumentsArchived ? { path: input.path, command: input.command?.slice(0, 1024),
      argumentsArchived: true, argumentBytes: argsBuffer.length } : input;
    const storedStructured = hasFullOutput ? { ...structured, output: undefined, outputArchiveHash: hash(fullText) } : message.structuredContent;
    const blob = Buffer.from(JSON.stringify({ content, structuredContent: storedStructured, details: message.details }));
    const contentHash = hash(blob);
    const id = `ctx://tool/${hash(this.sessionId + ':' + source + ':' + argumentHash + ':' + contentHash)}`;
    let fileHashAtRead = null;
    let snapshotStatus;
    if (message.toolName === 'read' && path) {
      const after = await this.version(path, true);
      const visibleSnapshot = originalText.replace(/\n\n\[(?:Showing [^\n]*|[0-9]+ more lines in file\.[^\n]*)\]$/, '');
      const matchesFile = !containsImages && typeof call.before?.snapshotText === 'string' &&
        call.before.snapshotText.startsWith(visibleSnapshot);
      const matchesImage = containsImages && message.content.filter(b => b.type === 'image')
        .every(b => hash(Buffer.from(b.data, 'base64')) === call.before?.hash);
      if (call.before?.status === 'verified' && after.hash === call.before.hash && (matchesFile || matchesImage)) {
        fileHashAtRead = after.hash; snapshotStatus = 'verified_before_after';
      } else snapshotStatus = call.historical || !call.before ? 'historical_unverified' : 'source_unverified';
      if (call.before) delete call.before.snapshotText;
    } else if (message.toolName === 'agy_read' && path) {
      // AGY 镜像读工具由远端/子进程直接执行，无法做本地调用前后的精确文件校验。
      snapshotStatus = call.historical ? 'historical_unverified' : 'source_unverified';
    }
    const metadata = { id, kind: 'tool', toolName: message.toolName, toolCallId: source,
      createdAt: this.clock(), sourceTimestamp: message.timestamp ?? null,
      sourceTimestampKind: call.historical ? 'session_message' : 'tool_result_observed',
      schemaVersion: 1, historicalRecallPage: recallPage, contentHash, byteSize: size + imageBytes,
      textBytes: size, fullOutputBytes: utf8Bytes(fullText), imageBytes, estimatedTokens: Math.ceil(size / 3) + (containsImages ? 1000 : 0),
      input: storedInput, argumentHash, argumentBlob: argumentsArchived ? argumentHash : undefined,
      isError: Boolean(message.isError), sessionId: this.sessionId, sessionFile: this.sessionFile,
      cwd, path, modifiedPaths: editedPaths.length > 1 || (editedPaths.length === 1 && !EDIT_TOOLS.has(message.toolName)) ? editedPaths : undefined,
      turn: call.turn ?? this.turn, command: command?.slice(0, 1024),
      exitCode: typeof structured.exit_code === 'number' ? structured.exit_code : null,
      durationSeconds: structured.wall_time_seconds ?? (call.startedAt ? (this.clock() - call.startedAt) / 1000 : null),
      range: message.toolName === 'read'
        ? { offset: input.offset ?? 1, limit: input.limit ?? null }
        : message.toolName === 'agy_read'
          ? { offset: Number.isSafeInteger(input.line) && input.line >= 1 ? input.line
            : Number.isSafeInteger(message.details?.line) && message.details.line >= 1 ? message.details.line : 1, limit: null }
          : undefined,
      fileHashAtRead, snapshotHash: hash(originalText), snapshotStatus,
      query, paths: input.paths ?? input.path ?? message.details?.path,
      matchCount: typeof structured.match_count === 'number' ? structured.match_count : null,
      parentToolCallId: call.parentToolCallId, related };
    const searchText = JSON.stringify({ tool: message.toolName, input: storedInput, path }) + '\n' + fullText;
    const buffers = [blob, ...(hasFullOutput ? [Buffer.from(fullText)] : []), ...(argumentsArchived ? [argsBuffer] : [])];
    const object = await this.archive.put(metadata, buffers, searchText);
    this.results.set(source, { object, signature: sig });
    if (call.parentToolCallId) {
      const ids = this.children.get(call.parentToolCallId) ?? new Set();
      ids.add(id); this.children.set(call.parentToolCallId, ids);
    }
    this.metrics.toolOutputsArchived++;
    this.metrics.archiveMs += performance.now() - began;
    this.updateWorking(object);
    return object;
  }

  async available(o) {
    if (!await this.archive.available(o)) return false;
    for (const e of o.related ?? []) if (e.relation === 'contains_image' && !await this.archive.available(this.archive.get(e.id))) return false;
    return true;
  }
  updateWorking(o) {
    const { id, path, toolName, input } = o;
    if (o.isError) this.lastFailure = id;
    const isEdit = EDIT_TOOLS.has(toolName) || (Array.isArray(o.modifiedPaths) && o.modifiedPaths.length > 0);
    const touchedPaths = Array.isArray(o.modifiedPaths) && o.modifiedPaths.length > 0 ? o.modifiedPaths : (path ? [path] : []);
    for (const p of touchedPaths) {
      delete this.working.activeFiles[p];
      this.working.activeFiles[p] = { id, turn: o.turn ?? this.turn };
    }
    if (touchedPaths.length) this.trimMap(this.working.activeFiles);
    if (path && READ_TOOLS.has(toolName)) {
      this.working.recentReads[path] = { id, range: o.range, fileHash: o.fileHashAtRead };
      this.trimMap(this.working.recentReads);
    }
    if (isEdit && touchedPaths.length && !o.isError) {
      this.lastEdit = id;
      for (const p of touchedPaths) {
        this.working.modifiedFiles[p] = { id, turn: o.turn ?? this.turn, toolCallId: o.toolCallId };
      }
      this.trimMap(this.working.modifiedFiles);
    }
    const command = input?.command ?? o.command;
    if (command) {
      this.working.latestCommands[id] = { command: command.slice(0, 256), exitCode: o.exitCode };
      this.trimMap(this.working.latestCommands);
      if (/\b(test|pytest|vitest|ctest|build|cmake|cargo|tsc)\b/i.test(command)) {
        this.working.latestTests[id] = this.working.latestCommands[id]; this.trimMap(this.working.latestTests);
      }
    }
  }
  rememberImage(data, o) {
    this.images.delete(data); this.images.set(data, o);
    let retained = 0;
    for (const key of this.images.keys()) retained += key.length;
    while (retained > this.optimizer.memoryLimitBytes || this.images.size > 256) {
      const first = this.images.keys().next().value;
      retained -= first.length; this.images.delete(first);
    }
  }
  async captureImage(image, source = {}) {
    const old = this.images.get(image.data);
    if (old && await this.available(old)) { this.archive.reference(this.sessionId, old.id); return old; }
    if (image.data.length / 4 * 3 > this.options.archive.maxObjectMB * 1048576 + 2) throw new Error('图片超过归档对象上限，保留原上下文');
    const original = Buffer.from(image.data, 'base64');
    if (!original.length || original.toString('base64') !== image.data) throw new Error('图片编码无效，保留原图');
    const imageHash = hash(original);
    if (source.recallSourceId) {
      const origin = this.archive.get(source.recallSourceId);
      const candidates = origin?.kind === 'image' ? [origin] : (origin?.related ?? [])
        .filter(e => e.relation === 'contains_image').map(e => this.archive.get(e.id)).filter(Boolean);
      const reused = candidates.find(o => o.blobs.includes(imageHash));
      if (reused && await this.available(reused)) {
        this.archive.reference(this.sessionId, reused.id); this.rememberImage(image.data, reused); return reused;
      }
    }
    const id = `ctx://image/${imageHash}`;
    let o = this.archive.get(id);
    if (!o || !await this.available(o)) {
      const { messages } = await this.optimizer.optimizeMessages([{ role: 'user', content: [image] }], this.config,
        { alreadyOptimized: () => Boolean(source.recallSourceId) });
      const optimized = messages[0].content[0];
      const buffer = Buffer.from(optimized.data, 'base64');
      let dimensions = {};
      try { const m = await sharp(buffer).metadata(); dimensions = { width: m.width, height: m.height, hasAlpha: m.hasAlpha }; } catch { /* 原图仍可归档。 */ }
      o = await this.archive.put({ id, kind: 'image', schemaVersion: 1, createdAt: this.clock(), contentHash: imageHash,
        byteSize: original.length, originalBytes: original.length, optimizedBytes: buffer.length,
        originalMimeType: image.mimeType, mimeType: optimized.mimeType, ...dimensions,
        cacheKey: hash(`${imageHash}:${fingerprint(this.config)}`), compressionFingerprint: fingerprint(this.config),
        sessionId: this.sessionId, sessionFile: this.sessionFile, ...source, related: [] },
        [original, buffer], `图片 ${source.path ?? ''} ${source.toolName ?? 'user'} ${dimensions.width ?? '?'}x${dimensions.height ?? '?'}`);
    }
    // 使用原 session 的字符串引用；同时限制新增图片的内存引用数量。
    this.archive.reference(this.sessionId, o.id);
    this.rememberImage(image.data, o);
    return o;
  }
  protected(id) {
    const u = this.archive.usage(id);
    const protectedNow = u.leaseUntilTime > this.clock() || u.leaseUntilTurn > this.turn;
    if (!protectedNow && u.state === 'HOT') { u.state = 'COLD'; this.archive.saveUsage(id, u); }
    return protectedNow;
  }
  pin(id) {
    this.archive.reference(this.sessionId, id);
    const u = this.archive.usage(id);
    u.recallCount++; u.reuseCount++; u.lastRecalled = this.clock(); u.state = 'HOT';
    const turns = Math.min(this.options.maxLeaseTurns, this.options.hotLeaseTurns +
      (u.recallCount - 1) * this.options.reuseLeaseBonusTurns);
    u.leaseUntilTurn = this.turn + turns;
    u.leaseUntilTime = this.clock() + this.options.hotLeaseSeconds * 1000;
    this.archive.saveUsage(id, u);
    return u;
  }
  toolPlaceholder(o) {
    // 一次生成后存入 projections；stale/usage 等动态信息由 recall 返回。
    const meta = { tool: o.toolName, call: o.toolCallId, input: o.input, isError: o.isError,
      bytes: o.byteSize, path: o.path, range: o.range, exitCode: o.exitCode, snapshot: o.snapshotStatus,
      images: o.related?.filter(e => e.relation === 'contains_image').map(e => e.id) };
    // 巨大 write/edit 参数已在原 tool call 中；placeholder 不重复输出。
    if (utf8Bytes(JSON.stringify(meta.input)) > 1024) meta.input = { path: o.path, arguments: '见原工具调用或 metadata recall' };
    return `[已归档 ${o.id}]\n${JSON.stringify(meta)}\n这是历史结果。精确取回：context_recall({id:"${o.id}"})；query/offset/limit 可局部取回。需要当前状态时明确请求 current。`;
  }
  imagePlaceholder(o) {
    return `[已归档图片 ${o.id}] ${o.width ?? '?'}x${o.height ?? '?'} ${o.mimeType} optimized_bytes=${o.optimizedBytes} source=${o.toolName ?? 'user'}；context_recall({id:"${o.id}"}) 可重新查看。`;
  }
  estimate(message) {
    if (!message) return 0;
    if (message.role === 'system') {
      let bytes = 0;
      if (typeof message.content === 'string') bytes += utf8Bytes(message.content);
      else if (Array.isArray(message.content)) {
        let img = 0;
        for (const b of message.content) {
          if (b?.type === 'image') img += 1000;
          else if (typeof b?.text === 'string') bytes += utf8Bytes(b.text);
        }
        if (img) return Math.ceil(bytes / 3) + img;
      }
      for (const section of Object.values(message.sections ?? {})) {
        if (typeof section === 'string') bytes += utf8Bytes(section);
      }
      if (message.toolsAdded) bytes += utf8Bytes(JSON.stringify(message.toolsAdded));
      if (message.toolsRemoved) bytes += utf8Bytes(JSON.stringify(message.toolsRemoved));
      return Math.ceil(bytes / 3);
    }
    if (message.role === 'bashExecution') {
      return Math.ceil((utf8Bytes(message.command ?? '') + utf8Bytes(message.output ?? '')) / 3);
    }
    if (message.role === 'branchSummary' || message.role === 'compactionSummary') {
      return Math.ceil(utf8Bytes(message.summary ?? '') / 3);
    }
    if (typeof message.content === 'string') return Math.ceil(utf8Bytes(message.content) / 3);
    let n = 0;
    for (const b of message.content ?? []) {
      if (!b) continue;
      if (b.type === 'image') n += 1000;
      else if (typeof b.text === 'string') n += Math.ceil(utf8Bytes(b.text) / 3);
      else if (typeof b.thinking === 'string') n += Math.ceil(utf8Bytes(b.thinking) / 3);
      else if (b.type === 'toolCall') n += Math.ceil(utf8Bytes((b.name ?? '') + (b.arguments ? JSON.stringify(b.arguments) : '')) / 3);
      else if (b.arguments) n += Math.ceil(utf8Bytes(JSON.stringify(b.arguments)) / 3);
    }
    return n;
  }
  score(o, age) {
    const u = this.archive.usage(o.id);
    const active = o.path && this.working.activeFiles[o.path];
    const latestTest = Object.keys(this.working.latestTests).at(-1) === o.id;
    // 分数越高越容易驱逐；各项可在 metadata 中解释。
    return Math.log2(Math.max(1, o.byteSize)) + Math.min(age, 100) / 4 -
      u.reuseCount * 4 - (active && this.turn - active.turn <= this.options.keepRecentTurns ? 12 : 0) -
      (latestTest ? 10 : 0) - (o.isError ? 4 : 0) - (o.durationSeconds > 10 ? 5 : 0) + (o.stale ? 2 : 0);
  }

  shouldTriggerGC({ activeTokens, window, activePressure, reclaimableTokens, candidates }) {
    if (!candidates.length || reclaimableTokens <= 0) return { trigger: false, reason: 'none' };
    if (this.forceGC) return { trigger: true, reason: 'forced' };
    const t = this.options.thresholds;
    const g = this.options.gc;
    const share = activeTokens > 0 ? reclaimableTokens / activeTokens : 0;
    const remainingAfterGC = Math.max(0, activeTokens - reclaimableTokens);
    const sinceLastGC = Number.isFinite(this.lastGcTurn) && this.lastGcTurn >= 0 ? Math.max(0, this.turn - this.lastGcTurn) : Infinity;
    const cooldownActive = sinceLastGC < g.cooldownTurns;
    const scale = (tokens, ratio) => Number.isFinite(window) && window > 0 ? Math.min(tokens, Math.round(window * ratio)) : tokens;

    // 低于最小可缓存规模的微型上下文（如独立单元测试）不存在真实缓存惩罚。
    if (activeTokens < Math.min(4096, g.minCacheableTokens)) {
      return { trigger: true, reason: 'small_context' };
    }
    // 极小剩余上下文，或压倒性垃圾占比（>= 70%）且已过最小防抖间隔（>= 2 turns），立即回收。
    if ((remainingAfterGC <= g.minCacheableTokens && share >= 0.5 && sinceLastGC >= 2) ||
        (share >= 0.7 && reclaimableTokens >= scale(16384, 0.15) && sinceLastGC >= 2)) {
      return { trigger: true, reason: 'dominant_garbage' };
    }
    if (activePressure >= t.emergency) {
      const relievesEmergency = Number.isFinite(window) && window > 0 && (remainingAfterGC / window) < t.emergency;
      if (relievesEmergency || (reclaimableTokens >= scale(g.emergencyMinBatchTokens, 0.02) && share >= 0.01)) {
        return { trigger: true, reason: 'emergency' };
      }
      return { trigger: false, reason: 'trivial_savings' };
    }
    if (activePressure >= t.high) {
      if (sinceLastGC >= 2 && reclaimableTokens >= scale(g.highPressureMinBatchTokens, 0.04) && share >= g.highPressureMinBatchShare) {
        return { trigger: true, reason: 'high' };
      }
      return { trigger: false, reason: sinceLastGC < 2 ? 'cooldown' : 'insufficient_batch' };
    }
    if (cooldownActive) return { trigger: false, reason: 'cooldown' };
    if (activePressure >= t.medium) {
      if (reclaimableTokens >= scale(g.minBatchTokens, 0.05) && share >= g.minBatchShare) {
        return { trigger: true, reason: 'medium' };
      }
      return { trigger: false, reason: 'insufficient_batch' };
    }
    if (activePressure >= t.low) {
      if (reclaimableTokens >= scale(g.lowMediumMinBatchTokens, 0.05) && share >= g.lowMediumMinBatchShare) {
        return { trigger: true, reason: 'low_medium' };
      }
      return { trigger: false, reason: 'insufficient_batch' };
    }
    if ((reclaimableTokens >= scale(g.lowPressureMinReclaimTokens, 0.25) && share >= g.lowPressureMinReclaimShare) ||
        (share >= 0.70 && reclaimableTokens >= scale(16384, 0.15))) {
      return { trigger: true, reason: 'low_batch' };
    }
    return { trigger: false, reason: 'cache_preserved' };
  }

  async project(messages, ctx = {}) {
    const began = performance.now();
    if (!this.enabled || !this.options.projection || !this.options.recall) return { messages, stats: {} };
    await this.archive.init();
    const modelKey = ctx.model ? `${ctx.model.provider ?? ''}:${ctx.model.id ?? ''}` : undefined;
    if (modelKey && this.calibrationModel && this.calibrationModel !== modelKey) {
      this.calibrationFactor = 1;
      this.calibrationModel = modelKey;
      this.lastCalibrationSample = undefined;
    }
    const cal = (!modelKey || !this.calibrationModel || this.calibrationModel === modelKey) ? this.calibrationFactor : 1;
    const projectionsMap = this.archive.projectionsForSession(this.sessionId);
    const usageCache = new Map();
    const getUsage = (id) => {
      if (!usageCache.has(id)) usageCache.set(id, this.archive.usage(id));
      return usageCache.get(id);
    };
    const setUsage = (id, data) => {
      usageCache.set(id, data);
      this.archive.saveUsage(id, data);
    };
    const isProtected = (id) => {
      const u = getUsage(id);
      const protectedNow = u.leaseUntilTime > this.clock() || u.leaseUntilTurn > this.turn;
      if (!protectedNow && u.state === 'HOT') {
        const next = { ...u, state: 'COLD' };
        setUsage(id, next);
      }
      return protectedNow;
    };

    const rawEstimates = messages.map(m => this.estimate(m));
    const originalTokens = rawEstimates.reduce((n, x) => n + x, 0);
    const ready = new Map();
    const wholeProjected = new Set();
    const stats = { toolBytesProjected: 0, imageBlocksProjected: 0, imageBytesAvoided: 0,
      projectedObjects: 0, protectedObjects: 0, originalEstimatedTokens: originalTokens };
    const callMap = new Map();
    for (const m of messages) if (m.role === 'assistant') for (const b of m.content ?? []) {
      if (b.type === 'toolCall') callMap.set(b.id, { toolName: b.name, input: b.arguments, historical: true, cwd: this.cwd });
    }
    this.activeIds.clear();
    const pendingRecalls = [];
    const pendingToolResults = [];
    const pendingImages = [];

    // Pass 1：应用已有稳定投影并确保历史对象可归档；先不生成新前缀变更。
    let assistantOrdinal = 0;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === 'assistant') assistantOrdinal++;
      if (m.role === 'toolResult' && m.toolName === 'context_recall') {
        const id = m.details?.contextId;
        if (id && this.archive.get(id)) {
          this.activeIds.add(id); this.archive.reference(this.sessionId, id);
          const lease = m.details?.lease, usage = getUsage(id);
          // canonical 返回页保留成功时的 lease；恢复失败事务丢失的辅助状态。
          if (lease && (lease.leaseUntilTime > usage.leaseUntilTime || lease.leaseUntilTurn > usage.leaseUntilTurn)) {
            setUsage(id, { ...usage, state: 'HOT',
              recallCount: Math.max(usage.recallCount, lease.recallCount), reuseCount: Math.max(usage.reuseCount, lease.reuseCount),
              leaseUntilTime: Math.max(usage.leaseUntilTime, lease.leaseUntilTime), leaseUntilTurn: Math.max(usage.leaseUntilTurn, lease.leaseUntilTurn) });
          }
        }
        const source = `recall:${m.toolCallId}`;
        const prior = projectionsMap.get(source);
        if (prior) {
          const archivedPage = this.archive.get(prior.id);
          if (archivedPage && await this.available(archivedPage)) ready.set(i, [{ type: 'text', text: prior.placeholder }]);
          continue;
        }
        pendingRecalls.push({ i, m, id, source });
        continue;
      }
      if (m.role === 'toolResult') {
        try {
          const source = `tool:${m.toolCallId}`;
          const prior = projectionsMap.get(source);
          const cachedObj = this.results.get(m.toolCallId)?.object;
          const o = (prior && cachedObj?.id === prior.id)
            ? cachedObj
            : await this.capture(m, this.calls.get(m.toolCallId) ?? callMap.get(m.toolCallId));
          if (!o) continue;
          this.activeIds.add(o.id);
          for (const e of o.related ?? []) if (e.relation === 'contains_image') this.activeIds.add(e.id);
          if (prior?.id === o.id && await this.available(o)) {
            ready.set(i, [{ type: 'text', text: prior.placeholder }]); wholeProjected.add(i);
          } else {
            pendingToolResults.push({ i, m, o, source, ordinal: assistantOrdinal });
          }
        } catch { this.metrics.failures++; }
      } else if (['user', 'custom'].includes(m.role) && Array.isArray(m.content)) {
        for (let j = 0; j < m.content.length; j++) if (m.content[j].type === 'image') {
          try {
            const o = await this.captureImage(m.content[j]);
            this.activeIds.add(o.id);
            const source = `image:${m.timestamp ?? i}:${j}:${o.id}`;
            const prior = projectionsMap.get(source);
            if (prior && await this.available(o)) {
              const blocks = ready.get(i) ?? [...m.content];
              blocks[j] = { type: 'text', text: prior.placeholder }; ready.set(i, blocks);
            } else {
              pendingImages.push({ i, j, o, source, ordinal: assistantOrdinal });
            }
          } catch { this.metrics.failures++; }
        }
      }
    }

    // Pass 2：按应用已有投影后的有效 token 计算安全保护尾区。
    const effectiveEstimates = messages.map((m, i) => ready.has(i) ? this.estimate({ role: m.role, content: ready.get(i) }) : rawEstimates[i]);
    let suffix = 0, recentStart = messages.length;
    let recentTurns = 0, imageRecentStart = 0, imageFenceFound = false;
    for (let i = messages.length - 1; i >= 0; i--) {
      suffix += effectiveEstimates[i];
      if (messages[i].role === 'assistant') recentTurns++;
      if (!imageFenceFound && recentTurns >= Math.max(1, this.options.keepRecentTurns)) { imageRecentStart = i; imageFenceFound = true; }
      recentStart = i;
      if (recentTurns >= this.options.keepRecentTurns && suffix >= this.options.keepRecentTokens) break;
    }

    // Pass 3：统一收集未受保护的可回收候选（文本、图片与过期 recall 页）。
    const candidates = [];
    for (const item of pendingRecalls) {
      const { i, m, id, source } = item;
      if (id && isProtected(id)) { stats.protectedObjects++; continue; }
      const pageFence = m.content.some(b => b.type === 'image') ? imageRecentStart : recentStart;
      if (i >= pageFence) continue;
      try {
        const page = await this.capture(m, callMap.get(m.toolCallId), { recallPage: true });
        if (page && await this.available(page)) {
          const placeholder = `[历史 recall 页 ${page.id}] source=${id ?? 'search/workingState'}；此页已保存，context_recall({id:"${page.id}"}) 可精确取回当时返回的内容。`;
          const savingTokens = Math.max(0, effectiveEstimates[i] - this.estimate({ role: 'toolResult', content: [{ type: 'text', text: placeholder }] }));
          if (savingTokens > 0 || utf8Bytes(textOf(m.content)) > utf8Bytes(placeholder)) {
            candidates.push({ i, o: page, source, placeholder, isRecallPage: true, targetId: id ?? page.id,
              savingTokens: Math.max(1, savingTokens), subsumedByWhole: false });
          }
        }
      } catch { this.metrics.failures++; }
    }
    for (const item of pendingToolResults) {
      const { i, m, o, source, ordinal } = item;
      let wholeEligible = false;
      if (i < recentStart && !isProtected(o.id) &&
        !(o.related ?? []).some(e => ['recalls', 'contains_image'].includes(e.relation) && isProtected(e.id)) &&
        o.textBytes >= this.options.minimumToolResultBytes) {
        const placeholder = this.toolPlaceholder(o);
        const savingTokens = Math.max(0, effectiveEstimates[i] - this.estimate({ role: 'toolResult', content: [{ type: 'text', text: placeholder }] }));
        if (savingTokens > 0) {
          wholeEligible = true;
          candidates.push({ i, o, source, placeholder, savingTokens, subsumedByWhole: false });
        }
      }
      const images = (o.related ?? []).filter(e => e.relation === 'contains_image');
      let imageIndex = 0;
      for (let j = 0; j < m.content.length; j++) if (m.content[j].type === 'image') {
        const image = this.archive.get(images[imageIndex++]?.id);
        if (!image || !await this.available(image)) continue;
        const imageSource = `image:tool:${m.toolCallId}:${j}:${image.id}`;
        const imagePrior = projectionsMap.get(imageSource);
        if (imagePrior) {
          if (!wholeProjected.has(i)) {
            const blocks = ready.get(i) ?? [...m.content]; blocks[j] = { type: 'text', text: imagePrior.placeholder }; ready.set(i, blocks);
          }
        } else if (i < imageRecentStart && !isProtected(o.id) && !isProtected(image.id)) {
          const placeholder = this.imagePlaceholder(image);
          const savingTokens = Math.max(1, 1000 - this.estimate({ role: 'toolResult', content: [{ type: 'text', text: placeholder }] }));
          candidates.push({ i, j, o: image, source: imageSource, placeholder, savingTokens, subsumedByWhole: wholeEligible, ordinal });
        }
      }
    }
    for (const item of pendingImages) {
      const { i, j, o, source, ordinal } = item;
      if (i < imageRecentStart && !isProtected(o.id)) {
        const placeholder = this.imagePlaceholder(o);
        const savingTokens = Math.max(1, 1000 - this.estimate({ role: 'user', content: [{ type: 'text', text: placeholder }] }));
        candidates.push({ i, j, o, source, placeholder, savingTokens, subsumedByWhole: false, ordinal });
      }
    }

    // Pass 4：基于真实有效上下文与缓存代价模型决定是否执行批量 GC。
    const uncalibratedActiveTokens = effectiveEstimates.reduce((n, x) => n + x, 0);
    const activeTokens = Math.round(uncalibratedActiveTokens * cal);
    const uncalibratedReclaimable = candidates.reduce((n, c) => n + (c.subsumedByWhole ? 0 : c.savingTokens), 0);
    const reclaimableTokens = Math.round(uncalibratedReclaimable * cal);
    const window = ctx.model?.contextWindow ?? Infinity;
    const activePressure = Number.isFinite(window) && window > 0 ? activeTokens / window : 0;
    const { trigger, reason } = this.shouldTriggerGC({ activeTokens, window, activePressure, reclaimableTokens, candidates });

    if (trigger) {
      for (const item of candidates) {
        if (item.j !== undefined && wholeProjected.has(item.i)) continue;
        if (!await this.available(item.o)) continue;
        if (item.isRecallPage) {
          ready.set(item.i, [{ type: 'text', text: item.placeholder }]);
          const u = getUsage(item.targetId);
          if (u.pageEvictions) this.metrics.reevictionCount++;
          u.pageEvictions = (u.pageEvictions ?? 0) + 1;
          u.state = 'ARCHIVED';
          setUsage(item.targetId, u);
          this.archive.saveProjection(this.sessionId, item.source, item.o.id, item.placeholder);
        } else {
          this.archive.saveProjection(this.sessionId, item.source, item.o.id, item.placeholder);
          if (item.j === undefined) {
            ready.set(item.i, [{ type: 'text', text: item.placeholder }]);
            wholeProjected.add(item.i);
          } else {
            const blocks = ready.get(item.i) ?? [...messages[item.i].content];
            blocks[item.j] = { type: 'text', text: item.placeholder };
            ready.set(item.i, blocks);
          }
          const u = getUsage(item.o.id);
          u.evictionCount++; u.state = 'ARCHIVED';
          setUsage(item.o.id, u);
        }
      }
      this.lastGcTurn = this.turn;
      this.metrics.gcSweeps++;
      this.saveSessionState();
    } else if (candidates.length > 0 && uncalibratedReclaimable > 0) {
      this.metrics.gcSkips++;
    }

    const projected = messages.map((m, i) => {
      const content = ready.get(i);
      if (!content) return m;
      const oldBytes = Array.isArray(m.content) ? utf8Bytes(textOf(m.content)) : 0;
      const newBytes = utf8Bytes(textOf(content));
      if (m.role === 'toolResult') stats.toolBytesProjected += Math.max(0, oldBytes - newBytes);
      const oldImages = (m.content ?? []).filter?.(b => b.type === 'image') ?? [];
      const newImages = content.filter(b => b.type === 'image').length;
      stats.imageBlocksProjected += Math.max(0, oldImages.length - newImages);
      if (!newImages) for (let j = 0; j < oldImages.length; j++) {
        const b = oldImages[j];
        const sourceObject = this.results.get(m.toolCallId)?.object;
        const imageId = sourceObject?.related?.filter(e => e.relation === 'contains_image')[j]?.id;
        const blockIndex = m.content.indexOf(b);
        const placeholderId = content[blockIndex]?.text?.match(/ctx:\/\/image\/[a-f0-9]{64}/)?.[0];
        const object = this.images.get(b.data) ?? this.archive.get(imageId ?? placeholderId);
        if (object) stats.imageBytesAvoided += object.optimizedBytes;
        else stats.imageBytesUnmeasured = (stats.imageBytesUnmeasured ?? 0) + 1;
      }
      stats.projectedObjects++;
      return { ...m, content };
    });
    const projectedUncalibrated = projected.reduce((n, m) => n + this.estimate(m), 0);
    const projectedTokens = Math.round(projectedUncalibrated * cal);
    this.lastCalibrationSample = modelKey ? { modelKey, uncalibratedTokens: projectedUncalibrated } : undefined;
    stats.activeEstimatedTokens = activeTokens;
    stats.projectedEstimatedTokens = projectedTokens;
    stats.reclaimableTokens = reclaimableTokens;
    stats.gcTriggered = trigger;
    stats.gcReason = reason;
    stats.calibrationFactor = Number(cal.toFixed(4));
    stats.turnsSinceLastGC = Number.isFinite(this.lastGcTurn) && this.lastGcTurn >= 0 ? Math.max(0, this.turn - this.lastGcTurn) : null;
    stats.projectionMs = performance.now() - began;
    stats.pressure = activePressure;
    stats.pressureBand = activePressure < this.options.thresholds.low ? 'low' : activePressure < this.options.thresholds.medium
      ? 'medium' : activePressure < this.options.thresholds.high ? 'high' : activePressure < this.options.thresholds.emergency ? 'aggressive' : 'emergency';
    this.metrics.projectionMs += stats.projectionMs;
    for (const k of ['toolBytesProjected', 'imageBlocksProjected', 'imageBytesAvoided']) this.metrics[k] += stats[k];
    if (activePressure >= this.options.thresholds.emergency && projectedTokens / window < this.options.thresholds.emergency) this.metrics.estimatedCompactPressureRelieved++;
    this.last = stats;
    this.compactSinceProjection = false;
    this.forceGC = false;
    this.working.hotContextObjects = [...this.activeIds].filter(id => isProtected(id)).slice(-this.options.stateLimit);
    this.working.currentTaskObjects = [...this.activeIds].slice(-this.options.stateLimit);
    return { messages: projected, stats };
  }

  async snapshotStatus(o) {
    if (!READ_TOOLS.has(o.toolName) || !o.path) return undefined;
    if (!o.fileHashAtRead) {
      return o.stale
        ? { state: 'stale', message: '此文件在本会话读取后已被修改；返回的是历史 snapshot，可指定 view=current 读取当前文件。' }
        : { state: 'unverified', message: '历史 read 的文件 hash 无法验证；此内容仅代表当时返回的 snapshot。' };
    }
    const current = await this.version(o.path);
    const same = current.status === 'verified' && current.hash === o.fileHashAtRead;
    if (current.status === 'verified') { this.archive.markStale(o.path, current.hash); o.stale = !same; }
    return { state: same ? 'current' : current.status === 'verified' ? 'stale' : 'unverified',
      fileHashAtRead: o.fileHashAtRead, currentHash: current.hash,
      message: same ? '文件 hash 未变化，直接返回历史 snapshot。' : current.status === 'verified'
        ? '此 read 属于旧 snapshot。当前文件已经变化。' : '无法确认当前文件状态；返回历史 snapshot。' };
  }

  selectText(text, params) {
    const opts = this.options.recallOptions;
    const lines = text.split('\n');
    const limit = Math.min(params.limit ?? (params.full ? opts.maxPageLines : opts.pageLines), opts.maxPageLines);
    const offset = Math.max(1, params.offset ?? params.lineStart ?? 1);
    const cap = params.full ? opts.maxFullBytes : opts.maxBytes;
    const queryPattern = params.query ? new RegExp(params.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu') : undefined;
    let indices = [];
    if (params.query) {
      const around = Math.min(params.around ?? 4, opts.maxAround);
      let matches = 0;
      for (let i = offset - 1; i < lines.length && matches < opts.maxMatches; i++) if (queryPattern.test(lines[i])) {
        matches++;
        for (let j = Math.max(offset - 1, i - around); j <= Math.min(lines.length - 1, i + around); j++) indices.push(j);
      }
      indices = [...new Set(indices)].slice(0, limit);
    } else {
      const start = params.tail ? Math.max(0, lines.length - Math.min(params.tail, limit)) : offset - 1;
      const end = Math.min(lines.length, params.lineEnd ?? start + (params.head ? Math.min(params.head, limit) : limit));
      indices = Array.from({ length: Math.max(0, Math.min(limit, end - start)) }, (_, i) => start + i);
    }
    const output = []; let used = 0; let nextOffset = null;
    for (const i of indices) {
      let line = `${i + 1}: ${lines[i]}`;
      const size = utf8Bytes(JSON.stringify(line)) + 1;
      if (used + size > cap - 1024) {
        if (!output.length) {
          let byteOffset = Math.max(0, params.byteOffset ?? 0);
          const raw = Buffer.from(lines[i]);
          if (queryPattern && params.byteOffset === undefined) {
            const match = queryPattern.exec(lines[i]);
            if (match) {
              let charStart = Math.max(0, match.index - Math.floor((cap - 1024) / 32));
              if (charStart && /[\uDC00-\uDFFF]/.test(lines[i][charStart])) charStart--;
              byteOffset = utf8Bytes(lines[i].slice(0, charStart));
            }
          }
          if (byteOffset < raw.length && (raw[byteOffset] & 0xc0) === 0x80) throw new Error('byteOffset 必须在 UTF-8 字符边界');
          let end = Math.min(raw.length, byteOffset + Math.floor((cap - 1024) / 2));
          while (end < raw.length && (raw[end] & 0xc0) === 0x80) end--;
          let part = raw.subarray(byteOffset, end).toString('utf8');
          while (utf8Bytes(JSON.stringify(part)) > cap - 1024 && end > byteOffset + 4) {
            end = byteOffset + Math.floor((end - byteOffset) / 2);
            while (end < raw.length && (raw[end] & 0xc0) === 0x80) end--;
            part = raw.subarray(byteOffset, end).toString('utf8');
          }
          const nextLine = i + 1 < lines.length ? i + 2 : null;
          return { text: part, totalLines: lines.length, totalBytes: utf8Bytes(text), nextOffset: end < raw.length ? i + 1 : nextLine,
            nextByteOffset: end < raw.length ? end : null, truncated: end < raw.length || nextLine !== null, longLine: true };
        }
        nextOffset = i + 1; break;
      }
      output.push(line); used += size;
    }
    if (!nextOffset && indices.length && indices.at(-1) < lines.length - 1) nextOffset = indices.at(-1) + 2;
    return { text: output.join('\n'), totalLines: lines.length, totalBytes: utf8Bytes(text),
      returnedLines: output.length, nextOffset, truncated: nextOffset !== null };
  }

  publicMetadata(o) {
    const result = { ...o };
    if (utf8Bytes(JSON.stringify(result.input ?? {})) > 2048) result.input = { path: o.path,
      preview: JSON.stringify(o.input).slice(0, 1024), truncated: true, recallPart: 'arguments' };
    if (result.command?.length > 1024) result.command = result.command.slice(0, 1024);
    if (result.related?.length > this.options.recallOptions.maxSearchLimit) result.related = result.related.slice(0, this.options.recallOptions.maxSearchLimit);
    return result;
  }
  recallResult(content, details, began) {
    const returnedBytes = utf8Bytes(textOf(content)) + content.filter(b => b.type === 'image')
      .reduce((n, b) => n + Buffer.from(b.data, 'base64').length, 0);
    this.metrics.recallBytesReturned += returnedBytes;
    return { content, details: { ...details, returnedBytes, recallMs: performance.now() - began } };
  }
  async recall(params) {
    const began = performance.now();
    if (!this.enabled || !this.options.recall) throw new Error('上下文 recall 已关闭');
    await this.archive.init();
    this.metrics.recallCalls++;
    try {
      if (params.workingState) {
        const encoded = JSON.stringify(this.working), cap = params.full ? this.options.recallOptions.maxFullBytes : this.options.recallOptions.maxBytes;
        const text = utf8Bytes(encoded) <= cap ? encoded : JSON.stringify({ workingStatePage: this.selectText(JSON.stringify(this.working, null, 2), params) });
        return this.recallResult([{ type: 'text', text }], { workingState: true }, began);
      }
      if (!params.id) {
        if (!params.query || !this.options.historySearch) throw new Error('请提供精确 id，或启用历史搜索后提供 query');
        const hits = this.archive.search(params.query, { sessionId: params.allSessions ? undefined : this.sessionId,
          toolName: params.toolName, path: params.path && this.filePath(params.path),
          limit: Math.min(params.limit ?? this.options.recallOptions.searchLimit, this.options.recallOptions.maxSearchLimit),
          offset: Math.max(0, (params.offset ?? 1) - 1) });
        const selected = [];
        for (const o of hits) {
          const item = { id: o.id, kind: o.kind, toolName: o.toolName, path: o.path,
            input: this.publicMetadata(o).input, createdAt: o.createdAt, excerpt: o.excerpt };
          if (utf8Bytes(JSON.stringify([...selected, item])) > this.options.recallOptions.maxBytes - 1024) {
            if (selected.length) break;
            item.input = { recallPart: 'arguments' }; item.path = o.path?.slice(0, 256);
          }
          selected.push(item);
        }
        return this.recallResult([{ type: 'text', text: JSON.stringify({ hits: selected,
          nextOffset: hits.length ? (params.offset ?? 1) + selected.length : null,
          usage: '用返回的稳定 id 精确 recall；FTS 只索引各对象的配置上限内文本。' }) }], { search: true, count: selected.length }, began);
      }
      const o = this.archive.get(params.id);
      if (!o) throw new Error('归档对象不存在；canonical session 仍是原始事实来源');
      this.metrics.archiveHits++;
      this.archive.reference(this.sessionId, o.id);
      const status = await this.snapshotStatus(o);
      if (status?.state === 'stale') this.metrics.staleSnapshotHits++;
      const related = params.related ? this.archive.relationships(o.id, this.options.recallOptions.maxSearchLimit) : undefined;
      if (params.metadataOnly || params.related) {
        const lease = this.pin(o.id);
        const metadata = { ...this.publicMetadata(o), snapshot: status, related, usage: lease };
        const encoded = JSON.stringify(metadata);
        const text = utf8Bytes(encoded) <= this.options.recallOptions.maxBytes ? encoded :
          JSON.stringify({ id: o.id, metadataPage: this.selectText(JSON.stringify(metadata, null, 2), params) });
        return this.recallResult([{ type: 'text', text }], { contextId: o.id, metadataOnly: true, lease }, began);
      }
      let content;
      let page;
      if (o.kind === 'image') {
        if (params.view && params.view !== 'snapshot') throw new Error('current/diff 只支持文本 snapshot；需要当前图片时请读取当前文件');
        const original = params.imageVersion === 'original';
        const expectedBytes = original ? o.originalBytes : o.optimizedBytes;
        if (expectedBytes > this.options.recallOptions.maxImageMB * 1048576) throw new Error('图片超过本次 recall 上限，可调整 recallOptions.maxImageMB');
        const buffer = await this.archive.readBlob(original ? o.blobs[0] : o.blobs[1] ?? o.blobs[0]);
        if (buffer.length > this.options.recallOptions.maxImageMB * 1048576) throw new Error('图片超过本次 recall 上限');
        content = [{ type: 'text', text: `图片 ${o.id}；${original ? '使用保存的原图' : `${o.width ?? '?'}x${o.height ?? '?'}；使用归档的优化版本`}。` },
          { type: 'image', data: buffer.toString('base64'), mimeType: original ? o.originalMimeType : o.mimeType }];
      } else {
        const blob = JSON.parse((await this.archive.readBlob(o.blobs[0])).toString('utf8'));
        const fullText = blob.structuredContent?.outputArchiveHash && o.blobs.includes(blob.structuredContent.outputArchiveHash)
          ? (await this.archive.readBlob(blob.structuredContent.outputArchiveHash)).toString('utf8') : blob.structuredContent?.output;
        let text = ['bash', 'powershell'].includes(o.toolName) && typeof fullText === 'string'
          ? fullText : textOf(blob.content);
        if (params.part === 'arguments') text = o.argumentBlob && o.blobs.includes(o.argumentBlob)
          ? (await this.archive.readBlob(o.argumentBlob)).toString('utf8') : JSON.stringify(o.input, null, 2);
        if (params.part === 'structured') text = JSON.stringify(blob.structuredContent
          ? { ...blob.structuredContent, ...(fullText === undefined ? {} : { output: fullText }) } : blob.details ?? {}, null, 2);
        if (params.view && params.view !== 'snapshot') {
          if (!READ_TOOLS.has(o.toolName) || !o.path) throw new Error('current/diff 仅用于本地文件 read snapshot');
          if (blob.content.some(b => b.type === 'archivedImage')) throw new Error('current/diff 只支持文本 snapshot；需要当前图片时请读取当前文件');
          const currentStat = await stat(o.path);
          if (currentStat.size > this.options.archive.maxFileHashMB * 1048576) throw new Error('当前文件超过安全读取上限');
          const current = (await readFile(o.path, 'utf8')).split('\n');
          const start = (o.range?.offset ?? 1) - 1;
          const section = current.slice(start, start + (o.range?.limit ?? this.options.recallOptions.maxPageLines)).join('\n');
          if (params.view === 'current') text = section;
          else {
            const old = text.split('\n'); const live = section.split('\n');
            text = old.flatMap((line, i) => line === live[i] ? [` ${line}`] : [`-${line}`, ...(live[i] === undefined ? [] : [`+${live[i]}`])])
              .concat(live.slice(old.length).map(line => '+' + line)).join('\n');
          }
        }
        page = this.selectText(text, params);
        const images = params.part && params.part !== 'content' ? [] : blob.content.filter(b => b.type === 'archivedImage');
        const imageOffset = params.imageOffset ?? 0;
        const selectedImages = images.slice(imageOffset, imageOffset + this.options.recallOptions.maxImages);
        page.imageIds = images.map(b => b.id);
        page.nextImageOffset = imageOffset + selectedImages.length < images.length ? imageOffset + selectedImages.length : null;
        content = [{ type: 'text', text: JSON.stringify({ id: o.id, toolName: o.toolName, createdAt: o.createdAt, snapshot: status, view: params.view ?? 'snapshot', ...page }) }];
        for (const block of selectedImages) {
          const image = this.archive.get(block.id);
          if (!image) throw new Error('图片归档缺失；请恢复原 session');
          if (image.optimizedBytes > this.options.recallOptions.maxImageMB * 1048576) throw new Error('图片超过本次 recall 上限；可独立 recall 图片 handle');
          const buffer = await this.archive.readBlob(image.blobs[1] ?? image.blobs[0]);
          if (buffer.length > this.options.recallOptions.maxImageMB * 1048576) throw new Error('图片超过本次 recall 上限');
          content.push({ type: 'image', data: buffer.toString('base64'), mimeType: image.mimeType });
          this.pin(image.id);
        }
      }
      const lease = this.pin(o.id);
      this.metrics.exactRecallsWithoutToolExecution++;
      return this.recallResult(content, { contextId: o.id, snapshot: status, page, lease }, began);
    } catch (error) {
      this.metrics.recallFailures = (this.metrics.recallFailures ?? 0) + 1;
      throw error;
    } finally { this.metrics.recallMs += performance.now() - began; }
  }

  async maintain(force = false) {
    if (!this.enabled || (!force && this.clock() - this.lastSweep < this.options.archive.maintenanceSeconds * 1000)) return;
    this.lastSweep = this.clock();
    return this.archive.collect({ activeIds: this.activeIds, activeSession: this.sessionId, now: this.clock() });
  }
  stats() { return { ...this.metrics, imageCacheHits: this.optimizer.totals.hits,
    imageCacheMisses: this.optimizer.totals.misses, archivedImageReuses: this.optimizer.totals.archiveReuses, imageEncodeMs: this.optimizer.totals.encodeMs,
    archive: this.archive.stats(), lastProjection: this.last, workingState: this.working }; }
  async close() { await this.archive.close(); }
}
