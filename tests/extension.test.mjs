import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import register from '../index.ts';

const endpoint = 'https://example.test/v1/responses';
const asMiB = (bytes) => `${(bytes / 1048576).toFixed(3)} MiB`;

async function harness() {
  const handlers = new Map();
  const commands = new Map();
  const statuses = [];
  const notices = [];
  const ctx = {
    hasUI: true, mode: 'rpc',
    model: { baseUrl: 'https://example.test/v1', provider: 'test', id: 'test', api: 'openai-responses' },
    getContextUsage: () => ({ tokens: 1 }),
    ui: {
      setStatus: (key, value) => { assert.equal(key, '00-traffic-optimization'); statuses.push(value); },
      notify: (...args) => notices.push(args),
    },
  };
  await register({
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, command) => commands.set(name, command),
    registerTool: () => {},
  });
  return { ctx, statuses, notices, command: commands.get('traffic-opt'), emit: (event, value = {}) => handlers.get(event)?.(value, ctx) };
}

function payloadFor(messages) {
  const image = messages[0].content[1];
  return { input: [{ role: 'user', content: [
    { type: 'input_text', text: '测试' },
    { type: 'input_image', image_url: `data:${image.mimeType};base64,${image.data}` },
  ] }], tools: [] };
}

test('无请求的 Pi 会话不生成空报告', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-traffic-empty-'));
  const originalConfig = process.env.PI_TRAFFIC_OPT_CONFIG_PATH;
  const originalReport = process.env.PI_TRAFFIC_OPT_REPORT_DIR;
  const originalArchive = process.env.PI_TRAFFIC_OPT_ARCHIVE_DIR;
  const originalCache = process.env.PI_TRAFFIC_OPT_CACHE_DIR;
  const originalFetch = globalThis.fetch;
  process.env.PI_TRAFFIC_OPT_CONFIG_PATH = join(dir, 'config.json');
  process.env.PI_TRAFFIC_OPT_REPORT_DIR = join(dir, 'reports');
  process.env.PI_TRAFFIC_OPT_ARCHIVE_DIR = join(dir, 'archive');
  process.env.PI_TRAFFIC_OPT_CACHE_DIR = join(dir, 'cache');
  try {
    const app = await harness();
    await app.emit('session_start');
    await app.emit('session_shutdown');
    assert.equal(globalThis.fetch, originalFetch);
    assert.equal(existsSync(join(dir, 'reports')), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalConfig === undefined) delete process.env.PI_TRAFFIC_OPT_CONFIG_PATH;
    else process.env.PI_TRAFFIC_OPT_CONFIG_PATH = originalConfig;
    if (originalReport === undefined) delete process.env.PI_TRAFFIC_OPT_REPORT_DIR;
    else process.env.PI_TRAFFIC_OPT_REPORT_DIR = originalReport;
    if (originalArchive === undefined) delete process.env.PI_TRAFFIC_OPT_ARCHIVE_DIR;
    else process.env.PI_TRAFFIC_OPT_ARCHIVE_DIR = originalArchive;
    if (originalCache === undefined) delete process.env.PI_TRAFFIC_OPT_CACHE_DIR;
    else process.env.PI_TRAFFIC_OPT_CACHE_DIR = originalCache;
    await rm(dir, { recursive: true, force: true });
  }
});

test('统一开关、补全、图片优化和实际请求统计在同一扩展中工作', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-traffic-opt-'));
  const previousEnv = Object.fromEntries(['PI_TRAFFIC_OPT_CONFIG_PATH', 'PI_TRAFFIC_OPT_CACHE_DIR', 'PI_TRAFFIC_OPT_REPORT_DIR', 'PI_TRAFFIC_OPT_ARCHIVE_DIR']
    .map((key) => [key, process.env[key]]));
  const priorFetch = globalThis.fetch;
  const config = join(dir, 'config.json');
  const report = join(dir, 'report');
  process.env.PI_TRAFFIC_OPT_CONFIG_PATH = config;
  process.env.PI_TRAFFIC_OPT_CACHE_DIR = join(dir, 'cache');
  process.env.PI_TRAFFIC_OPT_REPORT_DIR = report;
  process.env.PI_TRAFFIC_OPT_ARCHIVE_DIR = join(dir, 'archive');
  await writeFile(config, JSON.stringify({ enabled: true, skipBelowKB: 0, cache: { enabled: false }, logging: 'off' }));
  let networkCalls = 0;
  const originalFetch = async () => { networkCalls++; return new Response('{}', { status: 200 }); };
  globalThis.fetch = originalFetch;
  try {
    const app = await harness();
    assert.ok(app.command);
    assert.deepEqual(app.command.getArgumentCompletions('清'), [{ value: '清理缓存', label: '清理缓存' }]);
    assert.deepEqual(app.command.getArgumentCompletions('关'), [{ value: '关', label: '关' }]);
    await app.emit('session_start');
    assert.notEqual(globalThis.fetch, originalFetch);
    assert.match(app.statuses.at(-1), /^累计上传 0.000 MiB \| 当前 0.000 MiB \| 图片压缩率 0.0%$/);

    const raw = Buffer.alloc(500 * 500 * 3);
    let seed = 123;
    for (let i = 0; i < raw.length; i++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      raw[i] = seed & 255;
    }
    const original = (await sharp(raw, { raw: { width: 500, height: 500, channels: 3 } }).png().toBuffer()).toString('base64');
    const messages = [{ role: 'user', content: [{ type: 'text', text: '测试' }, { type: 'image', mimeType: 'image/png', data: original }] }];
    const transformed = await app.emit('context_with_system', { messages });
    assert.equal(messages[0].content[1].data, original);
    assert.equal(transformed.messages[0].content[1].mimeType, 'image/webp');
    const optimizedBytes = Buffer.from(transformed.messages[0].content[1].data, 'base64').length;
    const originalBytes = Buffer.from(original, 'base64').length;
    assert.ok(optimizedBytes < originalBytes);
    const payload = payloadFor(transformed.messages);
    app.emit('before_provider_request', { payload });
    await globalThis.fetch('https://example.test/v1/other', { method: 'POST', body: '{}' });
    const body = JSON.stringify(payload);
    await globalThis.fetch(endpoint, { method: 'POST', body });
    await globalThis.fetch(endpoint, { method: 'POST', body });
    await app.emit('after_provider_response', { status: 200 });
    await app.emit('message_end', { message: { role: 'assistant', usage: { input: 1, cacheRead: 0, cacheWrite: 0 } } });
    await app.emit('agent_settled');
    const summary = JSON.parse(await readFile(join(report, 'summary.json'), 'utf8'));
    const bytes = Buffer.byteLength(body);
    assert.equal(summary.request_count, 2);
    assert.equal(summary.total_upload_bytes, bytes * 2);
    assert.equal(summary.images_bytes, transformed.messages[0].content[1].data.length * 2);
    assert.equal(summary.requests[0].response_status, 200);
    assert.equal(summary.requests[0].context_tokens, null);
    assert.equal(summary.requests[1].response_status, 200);
    assert.equal(summary.requests[1].context_tokens, 1);
    assert.match(app.statuses.at(-1), new RegExp(`累计上传 ${asMiB(bytes * 2)} \\| 当前 ${asMiB(bytes)}`));
    assert.match(app.statuses.at(-1), new RegExp(`图片压缩率 ${((originalBytes - optimizedBytes) / originalBytes * 100).toFixed(1)}%`));
    const imageRate = app.statuses.at(-1).match(/图片压缩率 ([\d.]+%)/)[1];
    await app.emit('context_with_system', { messages });
    const textOnly = { input: [{ role: 'user', content: '纯文本' }], tools: [] };
    app.emit('before_provider_request', { payload: textOnly });
    await globalThis.fetch(endpoint, { method: 'POST', body: JSON.stringify(textOnly) });
    assert.ok(app.statuses.at(-1).endsWith(`图片压缩率 ${imageRate}`));

    const displayedMetrics = app.statuses.at(-1);
    await app.command.handler('关', app.ctx);
    assert.equal(JSON.parse(await readFile(config, 'utf8')).enabled, false);
    assert.equal(JSON.parse(await readFile(config, 'utf8')).skipBelowKB, 0);
    assert.equal(app.statuses.at(-1), displayedMetrics);
    assert.equal(await app.emit('context_with_system', { messages }), undefined);
    await globalThis.fetch(endpoint, { method: 'POST', body });
    await app.emit('agent_settled');
    assert.equal((await readFile(join(report, 'summary.json'), 'utf8')).includes('"request_count": 3'), true);
    await app.command.handler('开', app.ctx);
    const again = await app.emit('context_with_system', { messages });
    assert.equal(again.messages[0].content[1].mimeType, 'image/webp');
    const next = payloadFor(again.messages);
    app.emit('before_provider_request', { payload: next });
    await globalThis.fetch(endpoint, { method: 'POST', body: JSON.stringify(next) });
    await app.emit('agent_settled');
    assert.equal(JSON.parse(await readFile(join(report, 'summary.json'), 'utf8')).request_count, 4);
    await app.command.handler('统计', app.ctx);
    assert.match(app.notices.at(-1)[0], /累计上传/);
    await app.command.handler('清理缓存', app.ctx);
    assert.equal(app.notices.at(-1)[0], '图片缓存已清理');
    await app.command.handler('关', app.ctx);
    await app.emit('session_shutdown');
    assert.equal(globalThis.fetch, originalFetch);
    assert.equal(app.statuses.at(-1), undefined);
    assert.equal(networkCalls, 6);

    const restarted = await harness();
    await restarted.emit('session_start');
    assert.equal(globalThis.fetch, originalFetch);
    assert.match(restarted.statuses.at(-1), /^累计上传 0.000 MiB \| 当前 0.000 MiB \| 图片压缩率 0.0%$/);
    await restarted.emit('session_shutdown');
  } finally {
    globalThis.fetch = priorFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
