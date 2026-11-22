const { normalizeConfig: normalizeImages } = await import(new URL('./optimizer.mjs' + new URL(import.meta.url).search, import.meta.url).href);

export const contextDefaults = Object.freeze({
  enabled: true, archiveToolResults: true, projection: true, recall: true, historySearch: true,
  // 保留原生 compact；此开关只控制扩展主动请求的极端 fallback。
  llmCompactFallback: true, fallbackCooldownSeconds: 300,
  minimumToolResultBytes: 4096, oversizedToolResultBytes: 32768,
  keepRecentTurns: 4, keepRecentTokens: 12000,
  hotLeaseTurns: 4, hotLeaseSeconds: 120, reuseLeaseBonusTurns: 2, maxLeaseTurns: 20,
  thresholds: { low: 0.6, medium: 0.75, high: 0.9, emergency: 0.95, target: 0.6, aggressiveTarget: 0.4 },
  gc: {
    lowPressureMinReclaimTokens: 65536,
    lowPressureMinReclaimShare: 0.45,
    lowMediumMinBatchTokens: 49152,
    lowMediumMinBatchShare: 0.25,
    minBatchTokens: 32768,
    minBatchShare: 0.12,
    highPressureMinBatchTokens: 16384,
    highPressureMinBatchShare: 0.04,
    emergencyMinBatchTokens: 4096,
    cooldownTurns: 8,
    minCacheableTokens: 8192,
  },
  archive: { maxSizeMB: 2048, retentionDays: 30, maxObjectMB: 32, maxFileHashMB: 64, maxMetadataArgumentBytes: 8192, maxSnapshotProofBytes: 1048576, maxSnapshotProofLines: 10000,
    maxIndexChars: 262144, maintenanceSeconds: 300 },
  recallOptions: { pageLines: 80, maxPageLines: 400, maxBytes: 16384, maxFullBytes: 65536,
    maxMatches: 20, maxAround: 60, maxImages: 4, maxImageMB: 16, searchLimit: 10, maxSearchLimit: 30 },
  stateLimit: 12,
});
export const reportDefaults = Object.freeze({ summaryIntervalSeconds: 30, retentionDays: 14,
  maxSizeMB: 256, maxRunMB: 32, recentRecords: 200 });
const object = (v) => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const number = (v, d, lo, hi, integer = true) => Number.isFinite(v) && v >= lo && v <= hi &&
  (!integer || Number.isSafeInteger(v)) ? v : d;
const boolean = (v, d) => typeof v === 'boolean' ? v : d;

// 生成规范化模型键（provider/modelId），保留模型 ID 中自带的斜杠。
export function modelKey(model) {
  if (typeof model === 'string') {
    const trimmed = model.trim();
    return trimmed || undefined;
  }
  if (!model || typeof model !== 'object') return undefined;
  const id = typeof model.id === 'string' ? model.id.trim() : '';
  if (!id) return undefined;
  const provider = typeof model.provider === 'string' ? model.provider.trim() : '';
  return provider ? `${provider}/${id}` : id;
}

// 仅判断模型级开关（默认全部模型启用）。
export function isModelAllowed(config, model) {
  const map = object(config?.models);
  const fullKey = modelKey(model);
  if (fullKey && typeof map[fullKey] === 'boolean') return map[fullKey];
  if (model && typeof model === 'object' && typeof model.id === 'string') {
    const bareId = model.id.trim();
    if (bareId && typeof map[bareId] === 'boolean') return map[bareId];
  }
  return true;
}

// 结合全局开关与模型级开关，判断当前模型是否启用优化功能。
export function isModelEnabled(config, model) {
  if (config?.enabled === false) return false;
  return isModelAllowed(config, model);
}

export function normalizeConfiguration(raw = {}) {
  raw = object(raw);
  const rawModels = object(raw.models);
  const models = {};
  for (const [key, value] of Object.entries(rawModels)) {
    const normalizedKey = key.trim();
    if (normalizedKey && typeof value === 'boolean') models[normalizedKey] = value;
  }
  const input = object(raw.contextOptimization);
  const d = contextDefaults;
  const c = {};
  for (const k of ['enabled', 'archiveToolResults', 'projection', 'recall', 'historySearch', 'llmCompactFallback']) c[k] = boolean(input[k], d[k]);
  const ranges = { minimumToolResultBytes: [128, 1048576], oversizedToolResultBytes: [1024, 16777216],
    keepRecentTurns: [0, 100], keepRecentTokens: [0, 1000000], hotLeaseTurns: [1, 100],
    hotLeaseSeconds: [0, 86400], fallbackCooldownSeconds: [1, 86400], reuseLeaseBonusTurns: [0, 20], maxLeaseTurns: [1, 200], stateLimit: [1, 50] };
  for (const [k, [lo, hi]] of Object.entries(ranges)) c[k] = number(input[k], d[k], lo, hi);
  c.maxLeaseTurns = Math.max(c.hotLeaseTurns, c.maxLeaseTurns);
  c.oversizedToolResultBytes = Math.max(c.minimumToolResultBytes, c.oversizedToolResultBytes);
  const t = object(input.thresholds);
  c.thresholds = Object.fromEntries(Object.entries(d.thresholds).map(([k, v]) => [k, number(t[k], v, 0.01, 1, false)]));
  if (!(c.thresholds.aggressiveTarget <= c.thresholds.target && c.thresholds.target <= c.thresholds.low && c.thresholds.low < c.thresholds.medium &&
    c.thresholds.medium < c.thresholds.high && c.thresholds.high < c.thresholds.emergency)) c.thresholds = { ...d.thresholds };
  c.gc = {};
  const g = object(input.gc);
  for (const [k, lo, hi, integer] of [
    ['lowPressureMinReclaimTokens', 1024, 1048576, true],
    ['lowPressureMinReclaimShare', 0.01, 0.99, false],
    ['lowMediumMinBatchTokens', 1024, 1048576, true],
    ['lowMediumMinBatchShare', 0.01, 0.99, false],
    ['minBatchTokens', 1024, 1048576, true],
    ['minBatchShare', 0.01, 0.99, false],
    ['highPressureMinBatchTokens', 512, 1048576, true],
    ['highPressureMinBatchShare', 0.01, 0.99, false],
    ['emergencyMinBatchTokens', 256, 1048576, true],
    ['cooldownTurns', 0, 100, true],
    ['minCacheableTokens', 0, 262144, true],
  ]) {
    c.gc[k] = number(g[k], d.gc[k], lo, hi, integer);
  }
  c.archive = {};
  const a = object(input.archive);
  for (const [k, lo, hi] of [['maxSizeMB', 1, 102400], ['retentionDays', 1, 3650], ['maxObjectMB', 1, 512],
    ['maxFileHashMB', 1, 1024], ['maxMetadataArgumentBytes', 1024, 65536], ['maxSnapshotProofBytes', 65536, 33554432], ['maxSnapshotProofLines', 2000, 100000], ['maxIndexChars', 1024, 1048576], ['maintenanceSeconds', 10, 86400]]) {
    c.archive[k] = number(a[k], d.archive[k], lo, hi);
  }
  c.recallOptions = {};
  const r = object(input.recallOptions);
  for (const [k, lo, hi] of [['pageLines', 1, 2000], ['maxPageLines', 1, 5000], ['maxBytes', 2048, 262144],
    ['maxFullBytes', 1024, 1048576], ['maxMatches', 1, 100], ['maxAround', 0, 200], ['maxImages', 1, 20], ['maxImageMB', 1, 64],
    ['searchLimit', 1, 100], ['maxSearchLimit', 1, 100]]) c.recallOptions[k] = number(r[k], d.recallOptions[k], lo, hi);
  c.recallOptions.pageLines = Math.min(c.recallOptions.pageLines, c.recallOptions.maxPageLines);
  c.recallOptions.searchLimit = Math.min(c.recallOptions.searchLimit, c.recallOptions.maxSearchLimit);
  c.recallOptions.maxFullBytes = Math.max(c.recallOptions.maxBytes, c.recallOptions.maxFullBytes);
  const report = object(raw.reporting);
  const reporting = {};
  for (const [k, lo, hi] of [['summaryIntervalSeconds', 1, 3600], ['retentionDays', 1, 365],
    ['maxSizeMB', 1, 10240], ['maxRunMB', 1, 1024], ['recentRecords', 10, 1000]]) reporting[k] = number(report[k], reportDefaults[k], lo, hi);
  return { ...normalizeImages(raw), models, contextOptimization: c, reporting };
}
