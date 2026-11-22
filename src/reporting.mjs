import { mkdir, appendFile, writeFile, rename, readdir, stat, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
const { csv, mib } = await import(new URL('./profile.mjs' + new URL(import.meta.url).search, import.meta.url).href);

export const requestColumns = ['timestamp', 'request_id', 'event', 'provider', 'model', 'api', 'endpoint', 'transport',
  'context_tokens', 'estimated_context_tokens', 'candidate_payload_bytes', 'total_payload_bytes', 'json_payload_bytes',
  'system_bytes', 'user_text_bytes', 'assistant_text_bytes', 'text_bytes', 'tool_call_bytes', 'tool_result_bytes',
  'image_payload_bytes', 'image_decoded_bytes', 'tool_schema_bytes', 'other_bytes', 'opaque_reasoning_bytes',
  'image_count', 'content_encoding', 'content_length', 'response_status', 'download_bytes', 'profile_ms',
  'tool_bytes_projected', 'image_blocks_projected', 'image_bytes_avoided', 'projection_ms'];
const imageColumns = ['request_id', 'image_hash', 'mime_type', 'decoded_bytes', 'base64_bytes',
  'image_payload_bytes', 'source_type', 'repeated', 'tool_name'];
const sumKeys = ['total_payload_bytes', 'json_payload_bytes', 'candidate_payload_bytes', 'image_payload_bytes', 'image_decoded_bytes',
  'system_bytes', 'user_text_bytes', 'assistant_text_bytes', 'tool_call_bytes', 'tool_result_bytes',
  'tool_schema_bytes', 'other_bytes', 'opaque_reasoning_bytes', 'text_content_utf8_bytes',
  'tool_bytes_projected', 'image_blocks_projected', 'image_bytes_avoided'];
const percent = (n, total) => total ? (100 * n / total).toFixed(1) + '%' : '0.0%';

// 主路径只更新有界内存和追加队列；摘要定时写入，故障由队列吞掉。
export class TrafficReporter {
  constructor(directory, config, getContextStats = () => undefined) {
    this.directory = directory; this.config = config; this.getContextStats = getContextStats;
    this.records = []; this.count = 0; this.sums = Object.fromEntries(sumKeys.map(k => [k, 0]));
    this.toolTotals = new Map(); this.imageHashes = new Set(); this.imageOccurrences = 0;
    this.repeatedBytes = 0; this.repeatedOccurrences = 0; this.maximum = 0;
    this.histogram = new Map(); this.largest = []; this.queue = Promise.resolve(); this.pendingBytes = 0;
    this.writtenBytes = 0; this.droppedEvents = 0; this.failures = 0; this.dirty = false;
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.flush(); }, this.config.summaryIntervalSeconds * 1000);
    this.timer.unref?.();
  }
  enqueue(files) {
    const size = files.reduce((n, [, content]) => n + Buffer.byteLength(content), 0);
    if (this.pendingBytes + size > 4 * 1048576 || this.writtenBytes + this.pendingBytes + size > this.config.maxRunMB * 1048576) {
      this.droppedEvents++; return;
    }
    this.pendingBytes += size;
    this.queue = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      for (const [name, content] of files) await appendFile(join(this.directory, name), content, { mode: 0o600 });
      this.writtenBytes += size;
    }).catch(() => { this.failures++; }).finally(() => { this.pendingBytes -= size; });
  }
  add(record) {
    if (!this.count) this.enqueue([['requests.csv', csv(requestColumns) + '\n'], ['images.csv', csv(imageColumns) + '\n']]);
    this.count++; record.request_id = this.count;
    this.records.push(record);
    if (this.records.length > this.config.recentRecords) this.records.shift();
    for (const key of sumKeys) this.sums[key] += record[key] ?? (key === 'json_payload_bytes' ? record.total_payload_bytes : 0);
    this.maximum = Math.max(this.maximum, record.total_payload_bytes);
    const bucket = Math.floor(Math.log2(Math.max(1, record.total_payload_bytes)) * 16);
    this.histogram.set(bucket, (this.histogram.get(bucket) ?? 0) + 1);
    for (const image of record.images ?? []) {
      this.imageHashes.add(image.image_hash); this.imageOccurrences++;
      if (image.repeated) { this.repeatedBytes += image.image_payload_bytes; this.repeatedOccurrences++; }
    }
    for (const result of record.results ?? []) {
      const prior = this.toolTotals.get(result.tool_name) ?? { text_bytes: 0, image_bytes: 0, occurrences: 0 };
      prior.text_bytes += result.text_bytes; prior.image_bytes += result.image_bytes; prior.occurrences++;
      this.toolTotals.set(result.tool_name, prior);
      this.largest.push({ request_id: record.request_id, ...result });
    }
    this.largest.sort((a, b) => b.text_bytes + b.image_bytes - a.text_bytes - a.image_bytes);
    this.largest.length = Math.min(10, this.largest.length);
    this.dirty = true;
    this.enqueue([['events.jsonl', JSON.stringify({ event: 'request', ...record }) + '\n'],
      ['requests.csv', csv(requestColumns.map(k => k === 'event' ? 'request' : record[k])) + '\n'],
      ['images.csv', (record.images ?? []).map(image => csv(imageColumns.map(k => k === 'request_id' ? record.request_id : image[k])) + '\n').join('')]]);
  }
  changed(record) {
    this.dirty = true;
    if (record) this.enqueue([['events.jsonl', JSON.stringify({ event: 'update', request_id: record.request_id,
      context_tokens: record.context_tokens, response_status: record.response_status }) + '\n'],
      ['requests.csv', csv(requestColumns.map(k => k === 'event' ? 'update' : record[k])) + '\n']]);
  }
  percentile(p) {
    let n = 0;
    for (const [bucket, count] of [...this.histogram].sort(([a], [b]) => a - b)) {
      n += count;
      if (n >= Math.ceil(this.count * p)) return Math.round(2 ** ((bucket + 0.5) / 16));
    }
    return 0;
  }
  summary() {
    const s = this.sums; const total = s.total_payload_bytes;
    return { request_count: this.count, total_upload_bytes: total, average_bytes: this.count ? total / this.count : 0,
      p50_bytes: this.percentile(.5), p95_bytes: this.percentile(.95), percentile_measurement: 'estimated_log_histogram',
      maximum_bytes: this.maximum, candidate_payload_bytes: s.candidate_payload_bytes,
      json_payload_bytes: s.json_payload_bytes,
      images_bytes: s.image_payload_bytes, image_share: s.json_payload_bytes ? s.image_payload_bytes / s.json_payload_bytes : 0,
      image_decoded_bytes: s.image_decoded_bytes, image_occurrences: this.imageOccurrences, unique_images: this.imageHashes.size,
      repeated_image_bytes: this.repeatedBytes, repeated_occurrences: this.repeatedOccurrences,
      system_bytes: s.system_bytes, user_text_bytes: s.user_text_bytes, assistant_text_bytes: s.assistant_text_bytes,
      tool_call_bytes: s.tool_call_bytes, tool_result_text_bytes: s.tool_result_bytes, tool_schema_bytes: s.tool_schema_bytes,
      other_bytes: s.other_bytes, opaque_reasoning_bytes: s.opaque_reasoning_bytes,
      raw_text_utf8_bytes: s.text_content_utf8_bytes, response_download_bytes: null,
      requests: this.records.map(({ images, results, ...r }) => r),
      recent_records_limit: this.config.recentRecords,
      image_details: this.records.flatMap(r => (r.images ?? []).map(image => ({ request_id: r.request_id, ...image }))),
      tool_results_by_tool: Object.fromEntries(this.toolTotals), largest_tool_results: this.largest,
      context_optimization: this.getContextStats(),
      measurements: { http_payload: 'measured_final_transport_body_bytes', json_payload: 'measured_decoded_json_utf8', tool_bytes_projected: 'measured_context_text_utf8_delta',
        image_bytes_avoided: 'counterfactual_optimized_decoded_bytes', tokens: 'estimated_characters_divided_by_3',
        http_bytes_saved: null, compact_avoided: 'estimated_pressure_only' },
      reporting: { event_bytes: this.writtenBytes, dropped_events: this.droppedEvents, failures: this.failures } };
  }
  async atomic(name, content) {
    const temp = join(this.directory, name + '.tmp');
    await writeFile(temp, content, { mode: 0o600 }); await rename(temp, join(this.directory, name));
  }
  async flush() {
    if (this.flushing) return this.flushing;
    if (!this.count || !this.dirty) return;
    this.dirty = false;
    this.flushing = (async () => {
      await this.queue;
      const s = this.summary();
      await this.atomic('summary.json', JSON.stringify(s, null, 2) + '\n');
      const lines = ['# Pi 流量与 Context Projection 观测', '',
        '最终请求体大小为 measured，HTTP 覆盖 fetch、Node HTTP/1 与 HTTP/2（含重试及内容压缩），ACP 优先统计 antigravity-acp 从本地会话快照还原的上游全量请求（acp-upstream），不可用时回退统计 session/prompt 与宿主 MCP 工具结果回传。响应/TCP/TLS 字节未采集。',
        '内容分类及图片占比按解压后的 JSON UTF-8 字节计算；json_payload_bytes 与压缩后的 total_payload_bytes 分别记录。WebSocket 未计量。',
        'events.jsonl 是增量事实记录；requests.csv 的 request/update 行按 request_id 合并，update 不算新请求。摘要明细仅保留最近配置数量。',
        'tool 投影量是 context 文本 UTF-8 差；图片避免量是优化图片二进制的 counterfactual。未优化 HTTP 请求体不存在时，HTTP 节省值为 null。tokens 和 compact 压力指标为 estimated。', '',
        `请求 ${s.request_count}；累计 ${mib(s.total_upload_bytes)} MiB；均值 ${mib(s.average_bytes)} MiB；最大 ${mib(s.maximum_bytes)} MiB。`, '',
        '| 类别 | MiB | 占比 |', '|---|---:|---:|',
        ...[['System', s.system_bytes], ['User', s.user_text_bytes], ['Assistant', s.assistant_text_bytes],
          ['Tool arguments', s.tool_call_bytes], ['Tool results', s.tool_result_text_bytes], ['Image Base64', s.images_bytes],
          ['Tool schemas', s.tool_schema_bytes], ['Other / JSON', s.other_bytes]].map(([k, v]) => `| ${k} | ${mib(v)} | ${percent(v, s.json_payload_bytes)} |`), '',
        `图片唯一 ${s.unique_images}，出现 ${s.image_occurrences}，重复 ${s.repeated_occurrences}。`, '',
        '## Context 指标', '', '```json', JSON.stringify(s.context_optimization, null, 2), '```', '',
        '## 最近请求', '', '| 请求 | HTTP bytes | 输入 tokens | 工具投影 bytes | 图片投影数 |', '|---|---:|---:|---:|---:|',
        ...s.requests.map(r => `| ${r.request_id} | ${r.total_payload_bytes} | ${r.context_tokens ?? '未知'} | ${r.tool_bytes_projected ?? 0} | ${r.image_blocks_projected ?? 0} |`), ''];
      await this.atomic('report.md', lines.join('\n'));
    })().catch(() => { this.failures++; this.dirty = true; }).finally(() => { this.flushing = undefined; });
    return this.flushing;
  }
  async retain() {
    const parent = dirname(this.directory);
    let dirs;
    try { dirs = await readdir(parent, { withFileTypes: true }); } catch { return; }
    const runs = [];
    for (const dir of dirs) if (dir.isDirectory() && /^\d{4}-\d\d-\d\dT.*-\d+$/.test(dir.name)) {
      const path = join(parent, dir.name);
      if (path === this.directory) continue;
      let size = 0;
      for (const name of await readdir(path)) { const file = await stat(join(path, name)); if (file.isFile()) size += file.size; }
      const info = await stat(path); runs.push({ path, size, time: info.mtimeMs });
    }
    let size = runs.reduce((n, r) => n + r.size, this.writtenBytes);
    for (const r of runs.sort((a, b) => a.time - b.time)) {
      if (Date.now() - r.time > this.config.retentionDays * 86400000 || size > this.config.maxSizeMB * 1048576) {
        await rm(r.path, { recursive: true, force: true }); size -= r.size;
      }
    }
  }
  async close() {
    clearInterval(this.timer); this.timer = undefined;
    await this.flush(); await this.queue;
    try { await this.retain(); } catch { this.failures++; }
  }
}
