import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Type } from 'typebox';
import { loadNativeModule } from './module-loader.mjs';
const percent = (part: number, total: number) => total ? `${(part / total * 100).toFixed(1)}%` : '0.0%';
const header = (headers: Headers, key: string) => headers.get(key) ?? '';
const STATUS_KEY = '00-traffic-optimization';

export default async function (pi: ExtensionAPI) {
  // 一次 reload 使用同一源码版本；全部本地依赖共用版本参数。
  const runtimeFiles = ['optimizer.mjs', 'configuration.mjs', 'context-memory.mjs', 'archive.mjs', 'reporting.mjs', 'profile.mjs', 'transport.mjs'];
  const digest = createHash('sha256');
  for (const file of runtimeFiles) digest.update(file).update(readFileSync(join(import.meta.dirname, file)));
  const revision = digest.digest('hex');
  const [{ ImageOptimizer }, { normalizeConfiguration }, { ContextMemory }, , { TrafficReporter },
    { analyzePayload, isDirectPayloadApi, isProviderPayload, sourcesFromContext, mib }, { observeRequests }] = await Promise.all(runtimeFiles.map(file =>
      loadNativeModule(pathToFileURL(join(import.meta.dirname, file)).href + '?runtime=' + revision)));
  const toMiB = (value: number) => `${mib(value)} MiB`;
  const readConfig = (path: string) => {
    try { return normalizeConfiguration(JSON.parse(readFileSync(path, 'utf8'))); }
    catch { return normalizeConfiguration(); }
  };
  // 用户数据放在 Pi 配置目录，避免 npm 包更新时覆盖配置、归档和报告。
  const dataDir = join(getAgentDir(), 'traffic-optimization');
  const configPath = process.env.PI_TRAFFIC_OPT_CONFIG_PATH ?? join(dataDir, 'config.json');
  const cacheDir = process.env.PI_TRAFFIC_OPT_CACHE_DIR;
  const optimizer = new ImageOptimizer(cacheDir ? { cacheDir } : {});
  let enabled = readConfig(configPath).enabled;
  const directory = process.env.PI_TRAFFIC_OPT_REPORT_DIR ??
    join(dataDir, 'reports', `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`);
  const memory = new ContextMemory({
    directory: process.env.PI_TRAFFIC_OPT_ARCHIVE_DIR ?? join(dataDir, 'archive'),
    config: readConfig(configPath), optimizer,
  });
  const reporter = new TrafficReporter(directory, readConfig(configPath).reporting, () => memory.stats());
  let projectionStats: any;
  let uploadedBytes = 0;
  let currentBytes = 0;
  let originalImageBytes = 0;
  let sentImageBytes = 0;
  const seen = new Set<string>();
  const hashes = new Map<string, string>();
  const knownImageMetrics = new Map<string, { originalBytes: number; optimizedBytes: number }>();
  const waiting: any[] = [];
  let context: ReturnType<typeof sourcesFromContext> | undefined;
  let imageStats: { originalBytes: number; optimizedBytes: number } | undefined;
  let imageMetrics: Map<string, { originalBytes: number; optimizedBytes: number }> | undefined;
  let reusedRecallImageHashes: Set<string> | undefined;
  let lastDirectMeta: any;
  let candidate: any;
  let pendingAcpDirect: any;
  let pendingAcpUpstreamFallback: any;
  let pendingAcpContinuation: any;
  let pendingAcpGc = false;
  let acpProjectionDesynced = false;
  let lastAcpSessionId: string | undefined;
  let stopObservation: (() => void) | undefined;

  const resetTransientState = () => {
    context = undefined;
    imageStats = undefined;
    imageMetrics = undefined;
    reusedRecallImageHashes = undefined;
    lastDirectMeta = undefined;
    projectionStats = undefined;
    candidate = undefined;
    pendingAcpDirect = undefined;
    pendingAcpUpstreamFallback = undefined;
    pendingAcpContinuation = undefined;
    pendingAcpGc = false;
    acpProjectionDesynced = false;
    lastAcpSessionId = undefined;
    waiting.length = 0;
  };

  const readResponseHeader = (headers: Record<string, string> | undefined, name: string): string | undefined => {
    if (!headers || typeof headers !== 'object') return undefined;
    if (typeof headers[name] === 'string') return headers[name];
    const target = name.toLowerCase();
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === target && typeof value === 'string') return value;
    }
    return undefined;
  };

  const updateStatus = (ui: { setStatus: (key: string, text: string | undefined) => void } | undefined) => {
    ui?.setStatus(STATUS_KEY, `累计上传 ${toMiB(uploadedBytes)} | 当前 ${toMiB(currentBytes)} | 图片压缩率 ${percent(originalImageBytes - sentImageBytes, originalImageBytes)}`);
  };

  const setEnabled = (next: boolean) => {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ ...readConfig(configPath), enabled: next }, null, 2) + '\n', { mode: 0o600 });
    enabled = next;
    memory.config = { ...readConfig(configPath), enabled: next };
    registerRecall();
    if (!next) {
      resetTransientState();
      knownImageMetrics.clear();
    } else {
      installObservation();
    }
  };

  const save = (record?: any) => reporter.changed(record);

  const recordRequest = ({
    request, endpoint, headers, body, wireBytes, transport,
    initialStatus = null, initialContextTokens = null, enqueueWaiting = true,
  }: any) => {
    const started = performance.now();
    const payload = JSON.parse(body);
    if (!isProviderPayload(request.api, payload)) return;
    const result = analyzePayload(request.api, payload, request.context, seen, hashes, body);
    const record = {
      timestamp: new Date().toISOString(), request_id: reporter.count + 1,
      tool_bytes_projected: request.projectionStats?.toolBytesProjected ?? 0,
      image_blocks_projected: request.projectionStats?.imageBlocksProjected ?? 0,
      image_bytes_avoided: request.projectionStats?.imageBytesAvoided ?? 0,
      projection_ms: request.projectionStats?.projectionMs ?? 0,
      provider: request.provider, model: request.model, api: request.api,
      endpoint, transport, context_tokens: initialContextTokens,
      estimated_context_tokens: request.estimated_context_tokens,
      candidate_payload_bytes: request.bytes,
      text_bytes: result.user_text_bytes + result.assistant_text_bytes,
      content_encoding: header(headers, 'content-encoding'),
      content_length: header(headers, 'content-length') || null,
      response_status: initialStatus, download_bytes: null, ...result,
      json_payload_bytes: result.total_payload_bytes, total_payload_bytes: wireBytes,
      profile_ms: Math.round((performance.now() - started) * 10) / 10,
    };
    reporter.add(record);
    if (enqueueWaiting) {
      waiting.length = 0;
      waiting.push(record);
    }
    uploadedBytes += record.total_payload_bytes;
    currentBytes = record.total_payload_bytes;
    if (result.image_count > 0) {
      if (request.imageMetrics?.size || knownImageMetrics.size) {
        for (const image of result.images) {
          if (image.tool_name === 'context_recall' && request.reusedImageHashes?.has(image.image_hash)) {
            originalImageBytes += image.decoded_bytes;
            sentImageBytes += image.decoded_bytes;
            continue;
          }
          const matched = request.imageMetrics?.get(image.image_hash) ?? knownImageMetrics.get(image.image_hash);
          originalImageBytes += matched?.originalBytes ?? image.decoded_bytes;
          sentImageBytes += matched?.optimizedBytes ?? image.decoded_bytes;
        }
      } else {
        originalImageBytes += request.imageStats?.originalBytes ?? 0;
        sentImageBytes += request.imageStats?.optimizedBytes ?? 0;
      }
    }
    save();
    updateStatus(request.ui);
    return record;
  };

  // 将桥接层从只读本地会话快照还原的真实上游全量请求统计记入流量报告与状态栏。
  const recordUpstreamSnapshot = ({
    snapshot, meta, status = 200, enqueueWaiting = true,
  }: { snapshot: any; meta: any; status?: number | null; enqueueWaiting?: boolean }) => {
    const started = performance.now();
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    const system_bytes = num(snapshot.system_bytes);
    const user_text_bytes = num(snapshot.user_text_bytes);
    const assistant_text_bytes = num(snapshot.assistant_text_bytes);
    const tool_call_bytes = num(snapshot.tool_call_bytes);
    const tool_result_bytes = num(snapshot.tool_result_bytes);
    const image_payload_bytes = num(snapshot.image_payload_bytes);
    const image_decoded_bytes = num(snapshot.image_decoded_bytes);
    const tool_schema_bytes = num(snapshot.tool_schema_bytes);
    const opaque_reasoning_bytes = num(snapshot.opaque_reasoning_bytes);
    const other_bytes = num(snapshot.other_bytes);
    const sumParts = system_bytes + user_text_bytes + assistant_text_bytes + tool_call_bytes +
      tool_result_bytes + image_payload_bytes + tool_schema_bytes + other_bytes;
    const total_payload_bytes = Math.max(sumParts, num(snapshot.total_payload_bytes));
    const json_payload_bytes = Math.max(sumParts, num(snapshot.json_payload_bytes) || total_payload_bytes);
    const adjustedOther = other_bytes + Math.max(0, json_payload_bytes - sumParts);
    const images = (Array.isArray(snapshot.images) ? snapshot.images : [])
      .filter((img: any) => img && typeof img.image_hash === 'string' && typeof img.mime_type === 'string')
      .map((img: any) => {
        const repeated = seen.has(img.image_hash);
        seen.add(img.image_hash);
        const decoded = num(img.decoded_bytes);
        const b64 = num(img.base64_bytes) || Math.ceil(decoded / 3) * 4;
        return {
          image_hash: img.image_hash,
          mime_type: img.mime_type,
          decoded_bytes: decoded,
          base64_bytes: b64,
          image_payload_bytes: num(img.image_payload_bytes) || b64,
          source_type: typeof img.source_type === 'string' ? img.source_type : 'unknown',
          repeated,
          tool_name: typeof img.tool_name === 'string' ? img.tool_name : '',
        };
      });
    const results = (Array.isArray(snapshot.results) ? snapshot.results : [])
      .filter((item: any) => item && typeof item.tool_name === 'string')
      .map((item: any) => ({
        tool_name: item.tool_name,
        text_bytes: num(item.text_bytes),
        image_bytes: num(item.image_bytes),
      }));

    const record = {
      timestamp: new Date().toISOString(), request_id: reporter.count + 1,
      tool_bytes_projected: meta?.projectionStats?.toolBytesProjected ?? 0,
      image_blocks_projected: meta?.projectionStats?.imageBlocksProjected ?? 0,
      image_bytes_avoided: meta?.projectionStats?.imageBytesAvoided ?? 0,
      projection_ms: meta?.projectionStats?.projectionMs ?? 0,
      provider: meta?.provider ?? 'antigravity',
      model: meta?.model ?? 'unknown',
      api: meta?.api ?? 'antigravity-acp',
      endpoint: meta?.baseUrl || 'acp://antigravity-cli',
      transport: 'acp-upstream',
      context_tokens: null,
      estimated_context_tokens: meta?.estimated_context_tokens ?? null,
      candidate_payload_bytes: total_payload_bytes,
      text_bytes: user_text_bytes + assistant_text_bytes,
      content_encoding: '',
      content_length: null,
      response_status: status,
      download_bytes: null,
      system_bytes, user_text_bytes, assistant_text_bytes, tool_call_bytes, tool_result_bytes,
      image_payload_bytes, image_decoded_bytes, tool_schema_bytes,
      other_bytes: adjustedOther, opaque_reasoning_bytes,
      text_content_utf8_bytes: num(snapshot.text_content_utf8_bytes),
      image_count: images.length,
      images,
      results,
      json_payload_bytes,
      total_payload_bytes,
      profile_ms: Math.round((performance.now() - started) * 10) / 10,
    };
    reporter.add(record);
    if (enqueueWaiting) {
      waiting.length = 0;
      waiting.push(record);
    }
    uploadedBytes += record.total_payload_bytes;
    currentBytes = record.total_payload_bytes;
    if (images.length > 0) {
      for (const image of images) {
        if (image.tool_name === 'context_recall' && meta?.reusedImageHashes?.has(image.image_hash)) {
          originalImageBytes += image.decoded_bytes;
          sentImageBytes += image.decoded_bytes;
          continue;
        }
        const matched = meta?.imageMetrics?.get(image.image_hash) ?? knownImageMetrics.get(image.image_hash);
        originalImageBytes += matched?.originalBytes ?? image.decoded_bytes;
        sentImageBytes += matched?.optimizedBytes ?? image.decoded_bytes;
      }
    }
    save();
    updateStatus(meta?.ui);
    return record;
  };

  const commitPendingAcpFallback = (statusOverride?: number | null) => {
    const item = pendingAcpUpstreamFallback ?? pendingAcpDirect;
    pendingAcpUpstreamFallback = undefined;
    pendingAcpDirect = undefined;
    if (!item) return undefined;
    const status = statusOverride !== undefined ? statusOverride : (item.initialStatus ?? null);
    return recordRequest({
      request: item.request,
      endpoint: item.endpoint,
      headers: new Headers(),
      body: item.body,
      wireBytes: item.wireBytes,
      transport: item.transport,
      initialStatus: status,
      enqueueWaiting: !item.isAux,
    });
  };

  // 收集本次消息上下文中由 context_recall 复用的已优化图片哈希，避免重复计入图片压缩率统计。
  const collectReusedRecallImageHashes = (messages: any[]) => {
    const hashesSet = new Set<string>();
    for (const message of messages) {
      if (message?.role !== 'toolResult' || message.toolName !== 'context_recall' || !message.details?.contextId) continue;
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type === 'image' && typeof block.data === 'string') {
          try { hashesSet.add(createHash('sha256').update(block.data, 'base64').digest('hex')); } catch { /* 忽略无效 base64。 */ }
        }
      }
    }
    return hashesSet;
  };

  // 提取 antigravity-acp 活跃轮次中待通过宿主 MCP 回传的末尾工具结果（兼容工具边界 steer 切入时的末尾用户消息）。
  const extractAcpMcpToolResults = (messages: any[]) => {
    const results: any[] = [];
    let end = messages.length - 1;
    let hasTrailingUser = false;
    while (end >= 0 && messages[end]?.role === 'user') {
      hasTrailingUser = true;
      end--;
    }
    for (let i = end; i >= 0; i--) {
      const message = messages[i];
      if (message?.role !== 'toolResult') break;
      if (typeof message.toolCallId === 'string' && message.toolCallId.startsWith('agy_mcp_')) {
        const content = (Array.isArray(message.content) ? message.content : []).map((block: any) => {
          if (block?.type === 'image') {
            return { type: 'image', data: block.data, mimeType: block.mimeType };
          }
          return { type: 'text', text: typeof block?.text === 'string' ? block.text : '' };
        });
        results.unshift({
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          isError: Boolean(message.isError),
          content,
        });
      }
    }
    return { results, hasTrailingUser };
  };

  const installObservation = () => {
    if (stopObservation) return;
    stopObservation = observeRequests({
      getCandidate: () => enabled ? candidate : undefined,
      onRequest: ({ candidate: request, endpoint, headers, body, wireBytes, transport }: any) =>
        recordRequest({ request, endpoint, headers, body, wireBytes, transport }),
      onResponse: (record: any, status: number) => {
        record.response_status = status;
        save(record);
      },
    });
  };

  const registerRecall = () => pi.registerTool({
    name: 'context_recall', label: '上下文取回',
    description: '从本地归档精确取回历史工具结果、文件 snapshot 或图片。优先用 ctx:// handle；query 单独使用时做 FTS5/BM25 历史搜索。默认返回有界分页，可用 query + around 取错误附近内容；full 仍受分页上限保护。',
    promptSnippet: '精确取回 ctx:// 历史工具结果和图片',
    promptGuidelines: ['已有 ctx:// handle 的历史结果优先 context_recall，避免重复 read 或重复执行命令。只有明确需要当前状态才运行原工具。',
      '历史文件 snapshot 的 stale 状态以 recall 返回的文件 hash 校验为准；view=current 或 diff 读取当前本地文件。'],
    exposure: enabled && memory.options.enabled && memory.options.recall ? 'direct' : 'hidden',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    executionMode: 'sequential',
    parameters: Type.Object({
      id: Type.Optional(Type.String()), query: Type.Optional(Type.String({ maxLength: 1000 })),
      offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1 })),
      lineStart: Type.Optional(Type.Integer({ minimum: 1 })), lineEnd: Type.Optional(Type.Integer({ minimum: 1 })),
      head: Type.Optional(Type.Integer({ minimum: 1 })), tail: Type.Optional(Type.Integer({ minimum: 1 })),
      byteOffset: Type.Optional(Type.Integer({ minimum: 0 })), around: Type.Optional(Type.Integer({ minimum: 0 })),
      workingState: Type.Optional(Type.Boolean()),
      part: Type.Optional(Type.Union([Type.Literal('content'), Type.Literal('arguments'), Type.Literal('structured')])),
      imageVersion: Type.Optional(Type.Union([Type.Literal('optimized'), Type.Literal('original')])),
      imageOffset: Type.Optional(Type.Integer({ minimum: 0 })),
      full: Type.Optional(Type.Boolean()), metadataOnly: Type.Optional(Type.Boolean()), related: Type.Optional(Type.Boolean()),
      view: Type.Optional(Type.Union([Type.Literal('snapshot'), Type.Literal('current'), Type.Literal('diff')])),
      toolName: Type.Optional(Type.String()), path: Type.Optional(Type.String()), allSessions: Type.Optional(Type.Boolean()),
    }),
    execute: async (_id, params, signal) => {
      signal?.throwIfAborted();
      return await memory.recall(params);
    },
  });
  registerRecall();

  pi.registerCommand('traffic-opt', {
    description: '流量优化：图片压缩、上下文归档与上传统计',
    getArgumentCompletions: (prefix) => {
      const options = ['开', '关', '状态', '统计', '清理缓存', '上下文', 'archive', 'recall', 'gc'];
      const matches = options.filter((option) => option.startsWith(prefix.trim()));
      return matches.length ? matches.map((option) => ({ value: option, label: option })) : null;
    },
    handler: async (args, ctx) => {
      const option = args.trim().toLowerCase();
      if (option === '' || option === 'on' || option === 'off' || option === '开' || option === '关') {
        const next = option === '' ? !enabled : option === 'on' || option === '开';
        try {
          setEnabled(next);
          if (!next) await reporter.flush();
          else { reporter.start(); await memory.start(ctx); }
        }
        catch { ctx.ui.notify('流量优化配置保存失败', 'error'); return; }
      } else if (option === 'clear-cache' || option === '清理缓存') {
        try { await optimizer.clearCache(); ctx.ui.notify('图片缓存已清理', 'info'); }
        catch { ctx.ui.notify('图片缓存清理失败', 'error'); }
      } else if (option === 'stats' || option === '统计') {
        await reporter.flush();
        ctx.ui.notify(`累计上传 ${toMiB(uploadedBytes)}，当前 ${toMiB(currentBytes)}，图片压缩率 ${percent(originalImageBytes - sentImageBytes, originalImageBytes)}；图片 ${optimizer.totals.images}，缓存命中 ${optimizer.totals.hits}；归档 ${memory.archive.stats().objects}，recall ${memory.metrics.recallCalls}，gc ${memory.metrics.gcSweeps}/${memory.metrics.gcSkips}，thrashing ${memory.metrics.thrashingCount}；报告 ${directory}`, 'info');
      } else if (option === '上下文' || option === 'context') {
        ctx.ui.notify(JSON.stringify(memory.stats(), null, 2), 'info');
      } else if (option === 'archive') {
        try { await memory.archive.init(); ctx.ui.notify(JSON.stringify(memory.archive.list(memory.sessionId), null, 2), 'info'); }
        catch { ctx.ui.notify('归档暂时不可用，原会话保留完整内容', 'warning'); }
      } else if (option.startsWith('recall ')) {
        try { const r = await memory.recall({ id: args.trim().slice(7), metadataOnly: true }); ctx.ui.notify((r.content[0] as any).text, 'info'); }
        catch (error) { ctx.ui.notify(String(error), 'warning'); }
      } else if (option === 'gc') {
        memory.forceGC = true;
        try { ctx.ui.notify(JSON.stringify(await memory.maintain(true)), 'info'); }
        catch { ctx.ui.notify('归档清理失败，继续保留原数据', 'warning'); }
      } else if (option !== 'status' && option !== '状态') {
        ctx.ui.notify('用法：/traffic-opt 开 | 关 | 状态 | 统计 | 清理缓存 | 上下文 | archive | recall <id> | gc', 'warning');
        return;
      }
      if (ctx.hasUI) updateStatus(ctx.ui);
    },
  });

  pi.on('session_start', async (_event, ctx) => {
    resetTransientState();
    if (enabled) { installObservation(); reporter.start(); }
    try { await memory.start(ctx); } catch { memory.metrics.failures++; }
    if (ctx.hasUI) updateStatus(ctx.ui);
  });
  pi.on('session_tree', async (_event, ctx) => {
    resetTransientState();
    try { await memory.start(ctx); } catch { memory.metrics.failures++; }
  });
  pi.on('model_select', () => {
    resetTransientState();
  });
  pi.on('turn_start', () => { memory.setTurn(); });
  pi.on('tool_call', async (event, ctx) => {
    try { await memory.observeCall(event, ctx); } catch { memory.metrics.failures++; }
  });
  pi.on('tool_result', async (event, ctx) => {
    try { await memory.observeResult(event, ctx); } catch { memory.metrics.failures++; }
    // 只观察，绝不返回替换 canonical tool result。
  });
  pi.on('context_with_system', async (event, ctx) => {
    if (!enabled) return;
    imageStats = undefined; imageMetrics = undefined; projectionStats = undefined; pendingAcpContinuation = undefined; pendingAcpGc = false;
    const isDirectModel = Boolean(ctx?.model && isDirectPayloadApi(ctx.model.api));
    if (!isDirectModel) acpProjectionDesynced = false;
    const config = { ...readConfig(configPath), enabled: true };
    memory.config = config;
    let projected = event.messages;
    try {
      if (!pi.getActiveTools || pi.getActiveTools().includes('context_recall')) {
        const result = await memory.project(event.messages, ctx);
        projected = result.messages; projectionStats = result.stats;
        if (isDirectModel && projectionStats?.gcTriggered) pendingAcpGc = true;
      } else {
        memory.last = { skipped: 'recall_inactive' };
      }
    } catch { memory.metrics.failures++; }
    try {
      const { messages, stats, imageMetrics: pairs } = await optimizer.optimizeMessages(projected, config, {
        alreadyOptimized: (message: any) => message.role === 'toolResult' && message.toolName === 'context_recall' && !!message.details?.contextId,
      });
      imageStats = stats;
      imageMetrics = pairs;
      reusedRecallImageHashes = collectReusedRecallImageHashes(messages);
      for (const [imgHash, pair] of pairs.entries()) {
        if (knownImageMetrics.has(imgHash) && reusedRecallImageHashes.has(imgHash) && pair.originalBytes === pair.optimizedBytes) {
          continue;
        }
        knownImageMetrics.set(imgHash, pair);
      }
      while (knownImageMetrics.size > 256) {
        const oldest = knownImageMetrics.keys().next().value;
        if (oldest === undefined) break;
        knownImageMetrics.delete(oldest);
      }
      context = sourcesFromContext(messages);
      if (isDirectModel) {
        lastDirectMeta = {
          reusedImageHashes: reusedRecallImageHashes,
          context, imageStats: stats, imageMetrics: pairs, projectionStats,
          provider: ctx.model.provider, model: ctx.model.id, id: ctx.model.id,
          api: ctx.model.api, baseUrl: ctx.model.baseUrl,
          estimated_context_tokens: ctx.getContextUsage?.()?.tokens ?? null,
          ui: ctx.hasUI ? ctx.ui : undefined,
        };
        const { results: toolResults, hasTrailingUser } = extractAcpMcpToolResults(messages);
        if (toolResults.length > 0) {
          pendingAcpContinuation = {
            ...lastDirectMeta,
            payload: { toolResults },
            hasTrailingUser,
          };
        }
      }
      return { messages };
    } catch {
      context = undefined;
      imageMetrics = undefined;
      reusedRecallImageHashes = undefined;
      pendingAcpContinuation = undefined;
      return { messages: projected };
    }
  });
  pi.on('agent_settled', async (_event, ctx) => {
    if (!enabled) return;
    if (pendingAcpUpstreamFallback || pendingAcpDirect) {
      commitPendingAcpFallback();
    }
    try { await optimizer.sweep(memory.config); } catch { /* 清理失败不影响对话。 */ }
    try { await memory.maintain(); } catch { memory.metrics.failures++; }
    reporter.changed();
    await reporter.flush();
    const usage = ctx.getContextUsage();
    if (memory.options.llmCompactFallback && !memory.compactSinceProjection && (usage?.percent ?? 0) >= memory.options.thresholds.emergency * 100 &&
      Date.now() - memory.lastFallbackAt >= memory.options.fallbackCooldownSeconds * 1000 &&
      (memory.last.projectedEstimatedTokens ?? 0) / (ctx.model?.contextWindow ?? Infinity) >= memory.options.thresholds.emergency && ctx.isIdle()) {
      memory.lastFallbackAt = Date.now();
      memory.fallbackPending = true;
      ctx.compact();
    }
  });
  pi.on('session_before_compact', (event) => {
    if (!enabled) return;
    memory.metrics.compactAttempts++;
    memory.fallbackInProgress = memory.fallbackPending;
    if (event.reason !== 'manual' || memory.fallbackPending) memory.metrics.emergencyCompactCount++;
    memory.fallbackPending = false;
    // 第一版保留原生 compact，不取消也不替换其结果。
  });
  pi.on('session_compact', (event) => {
    resetTransientState();
    if (enabled) {
      memory.compactSinceProjection = true;
      memory.onCompact();
      if (event.reason !== 'manual' || memory.fallbackInProgress) memory.metrics.compactFallbacks++;
      memory.fallbackInProgress = false;
    }
  });
  pi.on('session_compact_failed', () => {
    memory.fallbackInProgress = false;
    if (enabled) memory.metrics.compactFailures = (memory.metrics.compactFailures ?? 0) + 1;
  });
  pi.on('before_provider_request', (event, ctx) => {
    if (!enabled) return;
    if (pendingAcpUpstreamFallback || pendingAcpDirect) {
      commitPendingAcpFallback();
    }
    candidate = undefined;
    pendingAcpDirect = undefined;
    pendingAcpUpstreamFallback = undefined;
    pendingAcpContinuation = undefined;
    waiting.length = 0;
    try {
      const model = ctx.model;
      if (!model || !isProviderPayload(model.api, event.payload)) return;
      const body = JSON.stringify(event.payload);
      const wireBytes = Buffer.byteLength(body, 'utf8');
      const request = {
        bytes: wireBytes,
        context, imageStats, imageMetrics, reusedImageHashes: reusedRecallImageHashes, projectionStats,
        provider: model.provider, model: model.id, id: model.id,
        api: model.api, baseUrl: model.baseUrl,
        estimated_context_tokens: ctx.getContextUsage()?.tokens ?? null,
        ui: ctx.hasUI ? ctx.ui : undefined,
      };
      if (isDirectPayloadApi(model.api)) {
        const nextSessionId = typeof (event.payload as any)?.sessionId === 'string'
          ? (event.payload as any).sessionId as string
          : undefined;
        const prevSessionId = lastAcpSessionId;
        const prevDesynced = acpProjectionDesynced;
        if (pendingAcpGc) {
          acpProjectionDesynced = Boolean(lastAcpSessionId && nextSessionId === lastAcpSessionId);
          pendingAcpGc = false;
        } else if (acpProjectionDesynced && nextSessionId && nextSessionId !== lastAcpSessionId) {
          acpProjectionDesynced = false;
        }
        if (nextSessionId) lastAcpSessionId = nextSessionId;
        lastDirectMeta = request;
        // 先暂存直接载荷，待 after_provider_response 确认是否由 acp-upstream 全量快照接管或立即按 acp-stdio 落账。
        pendingAcpDirect = {
          request,
          endpoint: model.baseUrl || 'acp://antigravity-cli',
          body,
          wireBytes,
          transport: 'acp-stdio',
          initialStatus: null,
          isAux: false,
          prevSessionId,
          prevDesynced,
        };
      } else {
        candidate = request;
      }
    } catch { candidate = undefined; pendingAcpDirect = undefined; pendingAcpUpstreamFallback = undefined; }
    finally { context = undefined; imageStats = undefined; imageMetrics = undefined; reusedRecallImageHashes = undefined; projectionStats = undefined; }
  });
  pi.on('after_provider_response', (event) => {
    if (!enabled) return;
    try {
      const acpTransport = readResponseHeader(event.headers, 'x-acp-transport');
      const isAux = readResponseHeader(event.headers, 'x-acp-auxiliary') === '1';
      const applyProjectionHeader = () => {
        if (isAux) return;
        const sessionId = readResponseHeader(event.headers, 'x-acp-session-id');
        if (sessionId) lastAcpSessionId = sessionId;
        const projectionSynced = readResponseHeader(event.headers, 'x-acp-projection-synced');
        if (projectionSynced === '1') {
          acpProjectionDesynced = false;
          pendingAcpGc = false;
        } else if (projectionSynced === '0') {
          acpProjectionDesynced = true;
          pendingAcpGc = false;
        }
      };

      if (acpTransport === 'acp-upstream') {
        const isDetached = readResponseHeader(event.headers, 'x-acp-upstream-detached') === '1';
        if (!isDetached) applyProjectionHeader();
        const rawSnapshot = readResponseHeader(event.headers, 'x-acp-upstream-snapshot');
        const genCountRaw = readResponseHeader(event.headers, 'x-acp-upstream-gen-count');
        const parsedGenCount = genCountRaw && /^\d+$/.test(genCountRaw.trim())
          ? Math.min(10, Math.max(1, Number.parseInt(genCountRaw.trim(), 10)))
          : 1;
        let snapshot: any;
        if (rawSnapshot) {
          try { snapshot = JSON.parse(rawSnapshot); } catch { snapshot = undefined; }
        }
        const pendingMeta = isDetached
          ? lastDirectMeta
          : (pendingAcpUpstreamFallback?.request ?? pendingAcpDirect?.request ?? lastDirectMeta);
        if (snapshot && typeof snapshot === 'object') {
          if (!isDetached) {
            pendingAcpUpstreamFallback = undefined;
            pendingAcpDirect = undefined;
            pendingAcpContinuation = undefined;
          }
          const status = typeof event.status === 'number' ? event.status : 200;
          for (let g = 0; g < parsedGenCount; g++) {
            const isFinalGen = g === parsedGenCount - 1;
            recordUpstreamSnapshot({
              snapshot,
              meta: pendingMeta,
              status: isFinalGen ? status : 200,
              enqueueWaiting: !isDetached && isFinalGen && !isAux,
            });
          }
        } else if (!isDetached) {
          commitPendingAcpFallback(typeof event.status === 'number' ? event.status : 200);
        }
        return;
      }

      if (acpTransport === 'acp-upstream-reused') {
        applyProjectionHeader();
        pendingAcpUpstreamFallback = undefined;
        pendingAcpDirect = undefined;
        pendingAcpContinuation = undefined;
        return;
      }

      if (acpTransport === 'acp-upstream-unavailable') {
        applyProjectionHeader();
        commitPendingAcpFallback(typeof event.status === 'number' ? event.status : 200);
        return;
      }

      if (acpTransport === 'acp-mcp-result') {
        applyProjectionHeader();
        const continuation = pendingAcpContinuation;
        pendingAcpContinuation = undefined;
        const isCutIn = readResponseHeader(event.headers, 'x-acp-mcp-cutin') === '1';
        const isUpstreamPending = readResponseHeader(event.headers, 'x-acp-upstream-pending') === '1';
        if (isCutIn && isUpstreamPending) {
          // 紧随其后的工具边界切入 session/prompt 会统一上报完整上游快照，跳过本次纯本地切入占位。
          return;
        }
        if (continuation) {
          const settledHeader = readResponseHeader(event.headers, 'x-acp-settled-mcp-ids');
          const settledIds = settledHeader
            ? new Set(settledHeader.split(',').map((item) => item.trim()).filter(Boolean))
            : undefined;
          const deferredLimitHeader = readResponseHeader(event.headers, 'x-acp-mcp-images-deferred');
          const deferredImageLimit = deferredLimitHeader && /^\d+$/.test(deferredLimitHeader.trim())
            ? Number.parseInt(deferredLimitHeader.trim(), 10)
            : null;
          const rawToolResults = settledIds?.size
            ? continuation.payload.toolResults.filter((item: any) => settledIds.has(item.toolCallId))
            : continuation.payload.toolResults;
          // 若桥接层将超过阈值的大图片延迟至紧随其后的多模态 session/prompt 投递，则 MCP 回传记录排除这些图片，避免重复统计。
          const toolResults = deferredImageLimit !== null
            ? rawToolResults.map((item: any) => ({
                ...item,
                content: (item.content ?? []).filter((block: any) =>
                  block?.type !== 'image' || typeof block.data !== 'string' || Buffer.byteLength(block.data, 'base64') <= deferredImageLimit),
              }))
            : rawToolResults;
          if (toolResults.length > 0) {
            const body = JSON.stringify({ toolResults });
            const wireBytes = Buffer.byteLength(body, 'utf8');
            const status = typeof event.status === 'number' ? event.status : 200;
            if (isUpstreamPending) {
              pendingAcpUpstreamFallback = {
                request: { ...continuation, bytes: wireBytes },
                endpoint: `${continuation.baseUrl || 'acp://antigravity-cli'}/mcp-result`,
                body,
                wireBytes,
                transport: 'acp-mcp-result',
                initialStatus: status,
                isAux: false,
              };
            } else {
              recordRequest({
                request: { ...continuation, bytes: wireBytes },
                endpoint: `${continuation.baseUrl || 'acp://antigravity-cli'}/mcp-result`,
                headers: new Headers(),
                body,
                wireBytes,
                transport: 'acp-mcp-result',
                initialStatus: status,
                enqueueWaiting: true,
              });
            }
          }
        }
        return;
      }

      if (!pendingAcpDirect) return;
      const direct = pendingAcpDirect;
      pendingAcpDirect = undefined;
      if (isAux) {
        lastAcpSessionId = direct.prevSessionId;
        acpProjectionDesynced = direct.prevDesynced;
      } else {
        applyProjectionHeader();
      }
      const status = typeof event.status === 'number' ? event.status : 200;
      const isUpstreamPending = readResponseHeader(event.headers, 'x-acp-upstream-pending') === '1';
      if (isUpstreamPending) {
        pendingAcpUpstreamFallback = {
          ...direct,
          initialStatus: status,
          isAux,
        };
      } else {
        recordRequest({
          request: direct.request,
          endpoint: direct.endpoint,
          headers: new Headers(),
          body: direct.body,
          wireBytes: direct.wireBytes,
          transport: direct.transport,
          initialStatus: status,
          enqueueWaiting: !isAux,
        });
      }
    } catch { /* 只读观测。 */ }
  });
  pi.on('message_end', async (event) => {
    if (!enabled) return;
    if (event.message.role === 'toolResult') {
      try { await memory.capture(event.message); } catch { memory.metrics.failures++; }
    }
    try {
      if (event.message.role !== 'assistant') return;
      if (pendingAcpGc) {
        acpProjectionDesynced = true;
        pendingAcpGc = false;
      }
      memory.observeAssistantMessage(event.message, { skipCalibration: acpProjectionDesynced });
      candidate = undefined;
      if (pendingAcpUpstreamFallback || pendingAcpDirect) {
        if (event.message.stopReason === 'aborted') {
          pendingAcpUpstreamFallback = undefined;
          pendingAcpDirect = undefined;
        } else {
          commitPendingAcpFallback();
        }
      }
      const continuation = pendingAcpContinuation;
      pendingAcpContinuation = undefined;
      const usage = event.message.usage;
      const contextTokens = usage ? usage.input + usage.cacheRead + usage.cacheWrite : null;
      const record = waiting.shift();
      if (record) {
        record.context_tokens = contextTokens;
        if ((record.transport === 'acp-mcp-result' || record.transport === 'acp-upstream') && event.message.stopReason === 'error') {
          const statusMatch = /\b([45]\d\d)\b/.exec(event.message.errorMessage ?? '');
          record.response_status = statusMatch ? Number(statusMatch[1]) : null;
        }
        save(record);
      } else if (continuation && !continuation.hasTrailingUser && event.message.stopReason !== 'aborted' && event.message.stopReason !== 'error') {
        const body = JSON.stringify(continuation.payload);
        const wireBytes = Buffer.byteLength(body, 'utf8');
        recordRequest({
          request: { ...continuation, bytes: wireBytes },
          endpoint: `${continuation.baseUrl || 'acp://antigravity-cli'}/mcp-result`,
          headers: new Headers(),
          body,
          wireBytes,
          transport: 'acp-mcp-result',
          initialStatus: 200,
          initialContextTokens: contextTokens,
          enqueueWaiting: false,
        });
      }
    } catch { /* 只读观测。 */ }
  });
  pi.on('session_shutdown', async (_event, ctx) => {
    enabled = false;
    memory.config.enabled = false;
    resetTransientState();
    knownImageMetrics.clear();
    try { await reporter.close(); } catch { /* 报告故障不能阻止退出。 */ }
    try { await memory.close(); } catch { /* 归档故障不能阻止退出。 */ }
    stopObservation?.();
    stopObservation = undefined;
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
