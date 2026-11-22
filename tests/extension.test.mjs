import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import register from '../src/index.ts';

const endpoint = 'https://example.test/v1/responses';
const asMiB = (bytes) => `${(bytes / 1048576).toFixed(3)} MiB`;

async function harness(options = {}) {
  const handlers = new Map();
  const commands = new Map();
  const statuses = [];
  const notices = [];
  let activeTools = options.activeTools;
  const ctx = {
    hasUI: true, mode: 'rpc',
    model: options.model ?? { baseUrl: 'https://example.test/v1', provider: 'test', id: 'test', api: 'openai-responses' },
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
    ...(activeTools !== undefined ? { getActiveTools: () => activeTools } : {}),
  });
  return {
    ctx, statuses, notices, command: commands.get('traffic-opt'),
    setActiveTools: (next) => { activeTools = next; },
    emit: (event, value = {}) => handlers.get(event)?.(value, ctx),
  };
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

test('未指定路径时配置写入 Pi 配置目录，包目录保持只读', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-traffic-agent-'));
  const keys = ['PI_CODING_AGENT_DIR', 'PI_TRAFFIC_OPT_CONFIG_PATH', 'PI_TRAFFIC_OPT_CACHE_DIR', 'PI_TRAFFIC_OPT_REPORT_DIR', 'PI_TRAFFIC_OPT_ARCHIVE_DIR'];
  const previousEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const priorFetch = globalThis.fetch;
  for (const key of keys) delete process.env[key];
  process.env.PI_CODING_AGENT_DIR = join(dir, 'agent');
  process.env.PI_TRAFFIC_OPT_CACHE_DIR = join(dir, 'cache');
  try {
    const app = await harness();
    await app.command.handler('关', app.ctx);
    const config = JSON.parse(await readFile(join(dir, 'agent', 'traffic-optimization', 'config.json'), 'utf8'));
    assert.equal(config.enabled, false);
    assert.equal(existsSync(new URL('../src/config.json', import.meta.url)), false);
    await app.emit('session_shutdown');
  } finally {
    globalThis.fetch = priorFetch;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('antigravity-acp 适配：直接载荷观测、宿主 MCP 工具结果回传、增量图片压缩率与 agy-tools 模式保护', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-traffic-acp-'));
  const keys = ['PI_TRAFFIC_OPT_CONFIG_PATH', 'PI_TRAFFIC_OPT_CACHE_DIR', 'PI_TRAFFIC_OPT_REPORT_DIR', 'PI_TRAFFIC_OPT_ARCHIVE_DIR'];
  const previousEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const config = join(dir, 'config.json');
  const report = join(dir, 'report');
  process.env.PI_TRAFFIC_OPT_CONFIG_PATH = config;
  process.env.PI_TRAFFIC_OPT_CACHE_DIR = join(dir, 'cache');
  process.env.PI_TRAFFIC_OPT_REPORT_DIR = report;
  process.env.PI_TRAFFIC_OPT_ARCHIVE_DIR = join(dir, 'archive');
  await writeFile(config, JSON.stringify({ enabled: true, skipBelowKB: 0, cache: { enabled: false }, logging: 'off' }));
  const makeNoisePng = async (seedInit, size) => {
    const raw = Buffer.alloc(size * size * 3);
    let seed = seedInit;
    for (let i = 0; i < raw.length; i++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      raw[i] = seed & 255;
    }
    return sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  };
  try {
    const app = await harness({
      model: { baseUrl: 'acp://antigravity-cli', provider: 'antigravity', id: 'gemini-4-neon', api: 'antigravity-acp', contextWindow: 1000000 },
      activeTools: ['read', 'bash', 'context_recall'],
    });
    await app.emit('session_start');
    const pngA = await makeNoisePng(17, 260);
    const pngB = await makeNoisePng(99, 320);

    // 轮次 1：用户发送图片 A，走 before_provider_request (acp-stdio) + after_provider_response + toolUse
    const step1Messages = [{ role: 'user', content: [{ type: 'text', text: '分析图A' }, { type: 'image', data: pngA.toString('base64'), mimeType: 'image/png' }] }];
    const step1Out = await app.emit('context_with_system', { messages: step1Messages });
    const imgAOpt = step1Out.messages[0].content[1];
    assert.equal(imgAOpt.mimeType, 'image/webp');
    const optABytes = Buffer.from(imgAOpt.data, 'base64').length;
    const step1Payload = { sessionId: 'agy-1', prompt: [{ type: 'text', text: '分析图A' }, { type: 'image', data: imgAOpt.data, mimeType: imgAOpt.mimeType }] };
    app.emit('before_provider_request', { payload: step1Payload });
    app.emit('after_provider_response', { status: 200, headers: { 'x-acp-session-id': 'agy-1' } });
    await app.emit('message_end', { message: { role: 'assistant', provider: 'antigravity', model: 'gemini-4-neon', stopReason: 'toolUse', usage: { input: 100, cacheRead: 20, cacheWrite: 0 } } });
    const expectedRate1 = `${((pngA.length - optABytes) / pngA.length * 100).toFixed(1)}%`;
    assert.ok(app.statuses.at(-1).endsWith(`图片压缩率 ${expectedRate1}`), `首轮压缩率应精确: ${app.statuses.at(-1)}`);

    // 轮次 2（活跃热会话内 MCP 回传）：历史仍含图片 A，新增 agy_mcp_ read 工具返回图片 B，无 before_provider_request
    const step2Messages = [
      ...step1Messages,
      { role: 'assistant', content: [{ type: 'toolCall', id: 'agy_mcp_001', name: 'read', arguments: { path: 'b.png' } }] },
      { role: 'toolResult', toolCallId: 'agy_mcp_001', toolName: 'read', isError: false,
        content: [{ type: 'text', text: '已读取图片B' }, { type: 'image', data: pngB.toString('base64'), mimeType: 'image/png' }] },
    ];
    const step2Out = await app.emit('context_with_system', { messages: step2Messages });
    const imgBOpt = step2Out.messages[2].content[1];
    assert.equal(imgBOpt.mimeType, 'image/webp');
    const optBBytes = Buffer.from(imgBOpt.data, 'base64').length;
    await app.emit('message_end', { message: { role: 'assistant', provider: 'antigravity', model: 'gemini-4-neon', stopReason: 'stop', usage: { input: 140, cacheRead: 100, cacheWrite: 0 } } });
    // 累计压缩率应精确为 (A+B) 而非 (A+A+B)
    const expectedRate2 = `${((pngA.length + pngB.length - optABytes - optBBytes) / (pngA.length + pngB.length) * 100).toFixed(1)}%`;
    assert.ok(app.statuses.at(-1).endsWith(`图片压缩率 ${expectedRate2}`), `增量回传压缩率不应重复计入旧图A: ${app.statuses.at(-1)}`);

    // 轮次 3：增量纯文本追问（历史仍含 A 与 B，但 prompt 只发送纯文本），图片压缩率保持不变
    await app.emit('context_with_system', { messages: [...step2Messages, { role: 'user', content: '继续总结' }] });
    app.emit('before_provider_request', { payload: { sessionId: 'agy-1', prompt: [{ type: 'text', text: '继续总结' }] } });
    app.emit('after_provider_response', { status: 200, headers: { 'x-acp-session-id': 'agy-1' } });
    await app.emit('message_end', { message: { role: 'assistant', provider: 'antigravity', model: 'gemini-4-neon', stopReason: 'stop', usage: { input: 20, cacheRead: 260, cacheWrite: 0 } } });
    assert.ok(app.statuses.at(-1).endsWith(`图片压缩率 ${expectedRate2}`));

    // 轮次 4：agy-tools 模式（context_recall 未激活，镜像工具 agy_read 不触发 acp-mcp-result）
    app.setActiveTools(['agy_read', 'agy_edit', 'agy_bash']);
    const agyToolsMessages = [
      { role: 'user', content: '查看结果' },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'native_call_1', name: 'agy_read', arguments: { path: 'a.ts' } }] },
      { role: 'toolResult', toolCallId: 'native_call_1', toolName: 'agy_read', isError: false, content: [{ type: 'text', text: 'x'.repeat(8000) }] },
    ];
    const agyOut = await app.emit('context_with_system', { messages: agyToolsMessages });
    assert.equal(agyOut.messages[2].content[0].text.length, 8000, 'context_recall 未激活时不应投影');
    await app.emit('message_end', { message: { role: 'assistant', provider: 'antigravity', model: 'gemini-4-neon', stopReason: 'stop', usage: { input: 50, cacheRead: 200, cacheWrite: 0 } } });
    await app.command.handler('上下文', app.ctx);
    assert.equal(JSON.parse(app.notices.at(-1)[0]).lastProjection.skipped, 'recall_inactive');

    await app.emit('agent_settled');
    const summary = JSON.parse(await readFile(join(report, 'summary.json'), 'utf8'));
    assert.equal(summary.request_count, 3, '应记录 2 次 acp-stdio + 1 次 acp-mcp-result，不含 agy_read 镜像步');
    assert.deepEqual(summary.requests.map(r => r.transport), ['acp-stdio', 'acp-mcp-result', 'acp-stdio']);
    assert.deepEqual(summary.requests.map(r => r.response_status), [200, 200, 200]);
    assert.deepEqual(summary.requests.map(r => r.context_tokens), [120, 240, 280]);
    assert.equal(summary.requests[0].endpoint, 'acp://antigravity-cli');
    assert.equal(summary.requests[1].endpoint, 'acp://antigravity-cli/mcp-result');

    // 轮次 5：有状态热轮次中途触发 GC 时不应用未瘦身的后端 usage 污染 calibrationFactor，待下一轮 acp-stdio 重建后恢复校准
    app.setActiveTools(['read', 'bash', 'context_recall']);
    await app.command.handler('gc', app.ctx);
    const bigText = '中'.repeat(24000);
    const gcMessages = [
      { role: 'user', content: '分析大文件' },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'agy_mcp_old', name: 'read', arguments: { path: 'old.txt' } }] },
      { role: 'toolResult', toolCallId: 'agy_mcp_old', toolName: 'read', isError: false, content: [{ type: 'text', text: bigText }] },
      ...Array.from({ length: 5 }, (_, idx) => ([
        { role: 'user', content: `追问${idx}` },
        { role: 'assistant', content: [{ type: 'text', text: '答复' }] },
      ])).flat(),
      { role: 'assistant', content: [{ type: 'toolCall', id: 'agy_mcp_hot', name: 'read', arguments: { path: 'hot.txt' } }] },
      { role: 'toolResult', toolCallId: 'agy_mcp_hot', toolName: 'read', isError: false, content: [{ type: 'text', text: bigText }] },
    ];
    await app.emit('context_with_system', { messages: gcMessages });
    // 热轮次无 before_provider_request，后端仍上报未瘦身的 60000 tokens
    await app.emit('message_end', { message: { role: 'assistant', provider: 'antigravity', model: 'gemini-4-neon', stopReason: 'toolUse', usage: { input: 10000, cacheRead: 50000, cacheWrite: 0 } } });
    await app.command.handler('上下文', app.ctx);
    assert.equal(JSON.parse(app.notices.at(-1)[0]).lastProjection.calibrationFactor, 1, '热轮次中途 GC 不应被未瘦身后端 usage 拉高校准系数');
    // 紧接着同一热轮次的下一步也应保持不污染
    await app.emit('context_with_system', { messages: gcMessages });
    await app.emit('message_end', { message: { role: 'assistant', provider: 'antigravity', model: 'gemini-4-neon', stopReason: 'stop', usage: { input: 10000, cacheRead: 50000, cacheWrite: 0 } } });
    await app.command.handler('上下文', app.ctx);
    assert.equal(JSON.parse(app.notices.at(-1)[0]).lastProjection.calibrationFactor, 1);
    // 紧接着复用同一旧 sessionId（且显式返回 x-acp-projection-synced=0）时，继续跳过失真校准
    await app.emit('context_with_system', { messages: [...gcMessages, { role: 'user', content: '复用旧会话' }] });
    app.emit('before_provider_request', { payload: { sessionId: 'agy-1', prompt: [{ type: 'text', text: '复用旧会话' }] } });
    app.emit('after_provider_response', { status: 200, headers: { 'x-acp-session-id': 'agy-1', 'x-acp-projection-synced': '0' } });
    await app.emit('message_end', { message: { role: 'assistant', provider: 'antigravity', model: 'gemini-4-neon', stopReason: 'stop', usage: { input: 10000, cacheRead: 50000, cacheWrite: 0 } } });
    await app.command.handler('上下文', app.ctx);
    assert.equal(JSON.parse(app.notices.at(-1)[0]).lastProjection.calibrationFactor, 1, '复用未瘦身旧会话时不得清零脱节保护');

    // 下一新用户轮次切换新 sessionId 并返回 x-acp-projection-synced=1 后，恢复正常动态校准
    await app.emit('context_with_system', { messages: [...gcMessages, { role: 'user', content: '下一轮' }] });
    app.emit('before_provider_request', { payload: { sessionId: 'agy-2', prompt: [{ type: 'text', text: '下一轮' }] } });
    app.emit('after_provider_response', { status: 200, headers: { 'x-acp-session-id': 'agy-2', 'x-acp-projection-synced': '1' } });
    await app.emit('message_end', { message: { role: 'assistant', provider: 'antigravity', model: 'gemini-4-neon', stopReason: 'stop', usage: { input: 10000, cacheRead: 35000, cacheWrite: 0 } } });
    await app.emit('context_with_system', { messages: [...gcMessages, { role: 'user', content: '确认校准' }] });
    await app.command.handler('上下文', app.ctx);
    assert.ok(JSON.parse(app.notices.at(-1)[0]).lastProjection.calibrationFactor > 1.2, '同步重建后应恢复正常动态校准');

    // 工具边界 steer 切入：经 after_provider_response(x-acp-transport=acp-mcp-result) 记账工具回传，随后再记账 steer session/prompt
    const steerMessages = [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'agy_mcp_steer_1', name: 'read', arguments: { path: 'a.ts' } }] },
      { role: 'toolResult', toolCallId: 'agy_mcp_steer_1', toolName: 'read', isError: false, content: [{ type: 'text', text: 'steer 前工具输出' }] },
      { role: 'user', content: '转向新指令' },
    ];
    await app.emit('context_with_system', { messages: steerMessages });
    app.emit('after_provider_response', {
      status: 200,
      headers: { 'x-acp-session-id': 'agy-2', 'x-acp-transport': 'acp-mcp-result', 'x-acp-settled-mcp-ids': 'agy_mcp_steer_1' },
    });
    app.emit('before_provider_request', { payload: { sessionId: 'agy-2', prompt: [{ type: 'text', text: '转向新指令' }] } });
    app.emit('after_provider_response', { status: 200, headers: { 'x-acp-session-id': 'agy-2', 'x-acp-projection-synced': '1' } });
    await app.emit('message_end', { message: { role: 'assistant', provider: 'antigravity', model: 'gemini-4-neon', stopReason: 'stop', usage: { input: 500, cacheRead: 0, cacheWrite: 0 } } });

    // MCP 回传后上游返回 429 error：仍保留已发出的 acp-mcp-result 记录并标注状态 429
    const errMcpMessages = [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'agy_mcp_err_1', name: 'read', arguments: { path: 'b.ts' } }] },
      { role: 'toolResult', toolCallId: 'agy_mcp_err_1', toolName: 'read', isError: false, content: [{ type: 'text', text: '触发限流的工具输出' }] },
    ];
    await app.emit('context_with_system', { messages: errMcpMessages });
    app.emit('after_provider_response', {
      status: 200,
      headers: { 'x-acp-session-id': 'agy-2', 'x-acp-transport': 'acp-mcp-result', 'x-acp-settled-mcp-ids': 'agy_mcp_err_1' },
    });
    await app.emit('message_end', {
      message: { role: 'assistant', provider: 'antigravity', model: 'gemini-4-neon', stopReason: 'error', errorMessage: 'Antigravity quota exhausted (429): limit', usage: { input: 0, cacheRead: 0, cacheWrite: 0 } },
    });

    // 辅助请求（x-acp-auxiliary=1）记入流量报告但不压入主会话 waiting 队列
    app.emit('before_provider_request', { payload: { sessionId: 'agy-aux-1', prompt: [{ type: 'text', text: '<task_instructions>\ncompact\n</task_instructions>' }] } });
    app.emit('after_provider_response', { status: 200, headers: { 'x-acp-session-id': 'agy-aux-1', 'x-acp-auxiliary': '1' } });

    // model_select 清理瞬态请求状态，避免误记上一轮残余 continuation
    await app.emit('context_with_system', { messages: step2Messages });
    await app.emit('model_select');
    await app.emit('message_end', { message: { role: 'assistant', provider: 'antigravity', model: 'gemini-4-neon', stopReason: 'stop', usage: { input: 10, cacheRead: 0, cacheWrite: 0 } } });
    await app.emit('agent_settled');
    const summaryAfter = JSON.parse(await readFile(join(report, 'summary.json'), 'utf8'));
    assert.equal(summaryAfter.request_count, 11, '应精确记录旧会话复用、重建、steer 切入双记账、429 错误 MCP 与辅助请求且不误记残留');
    assert.ok(summaryAfter.requests.some((r) => r.transport === 'acp-mcp-result' && r.response_status === 429));
    assert.ok(summaryAfter.requests.some((r) => r.transport === 'acp-stdio' && r.system_bytes > 0));
    await app.emit('session_shutdown');
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('antigravity-acp 延迟大图投递（x-acp-mcp-images-deferred）防重计且精确计算压缩率', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-traffic-acp-deferred-'));
  const report = join(dir, 'reports');
  const previousEnv = {
    PI_TRAFFIC_OPT_CONFIG_PATH: process.env.PI_TRAFFIC_OPT_CONFIG_PATH,
    PI_TRAFFIC_OPT_REPORT_DIR: process.env.PI_TRAFFIC_OPT_REPORT_DIR,
    PI_TRAFFIC_OPT_ARCHIVE_DIR: process.env.PI_TRAFFIC_OPT_ARCHIVE_DIR,
    PI_TRAFFIC_OPT_CACHE_DIR: process.env.PI_TRAFFIC_OPT_CACHE_DIR,
  };
  process.env.PI_TRAFFIC_OPT_CONFIG_PATH = join(dir, 'config.json');
  process.env.PI_TRAFFIC_OPT_REPORT_DIR = report;
  process.env.PI_TRAFFIC_OPT_ARCHIVE_DIR = join(dir, 'archive');
  process.env.PI_TRAFFIC_OPT_CACHE_DIR = join(dir, 'cache');
  try {
    // 生成 1 张高熵大图（压缩后仍 > 9,600B）与 1 张极小纯色图（<= 9,600B）
    const width = 256;
    const height = 256;
    const noise = Buffer.alloc(width * height * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 73 + ((i >> 3) ^ (i * 17))) & 0xff;
    const bigPng = await sharp(noise, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
    const smallPng = await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 20, g: 180, b: 60 } } }).png().toBuffer();

    const app = await harness({
      model: { baseUrl: 'acp://antigravity-cli', provider: 'antigravity', id: 'gemini-4-neon', api: 'antigravity-acp', contextWindow: 1000000 },
      activeTools: ['read', 'context_recall'],
    });
    await app.emit('session_start');

    const messages = [
      { role: 'user', content: '读取大小两张图片' },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'agy_mcp_img_mix', name: 'read', arguments: { path: 'mix.png' } }] },
      {
        role: 'toolResult',
        toolCallId: 'agy_mcp_img_mix',
        toolName: 'read',
        isError: false,
        content: [
          { type: 'text', text: 'Read image files' },
          { type: 'image', data: smallPng.toString('base64'), mimeType: 'image/png' },
          { type: 'image', data: bigPng.toString('base64'), mimeType: 'image/png' },
        ],
      },
    ];
    const transformed = await app.emit('context_with_system', { messages });
    const toolContent = transformed.messages[2].content;
    const optSmall = toolContent[1];
    const optBig = toolContent[2];
    const smallOptBytes = Buffer.byteLength(optSmall.data, 'base64');
    const bigOptBytes = Buffer.byteLength(optBig.data, 'base64');
    assert.ok(smallOptBytes <= 9600, `小图应 <= 9600B，实际=${smallOptBytes}`);
    assert.ok(bigOptBytes > 9600, `大图压缩后仍应 > 9600B 以触发延迟投递，实际=${bigOptBytes}`);

    // 1. 宿主 MCP 结算：携带 x-acp-mcp-images-deferred: "9600"，acp-mcp-result 应仅计入小图、排除大图
    app.emit('after_provider_response', {
      status: 200,
      headers: {
        'x-acp-session-id': 'agy-deferred-1',
        'x-acp-transport': 'acp-mcp-result',
        'x-acp-settled-mcp-ids': 'agy_mcp_img_mix',
        'x-acp-projection-synced': '1',
        'x-acp-mcp-images-deferred': '9600',
      },
    });

    // 2. 紧随其后的同会话多模态 session/prompt 投递大图
    app.emit('before_provider_request', {
      payload: {
        sessionId: 'agy-deferred-1',
        prompt: [
          { type: 'text', text: '<tool_result id="agy_mcp_img_mix" tool="read" status="ok">\n[Attached 1 image(s) from tool "read" delivered via multimodal prompt]\n</tool_result>' },
          { type: 'image', data: optBig.data, mimeType: optBig.mimeType },
          { type: 'text', text: 'Please inspect the attached tool result image(s) above and continue.' },
        ],
      },
    });
    app.emit('after_provider_response', {
      status: 200,
      headers: { 'x-acp-session-id': 'agy-deferred-1', 'x-acp-projection-synced': '1' },
    });
    await app.emit('message_end', {
      message: { role: 'assistant', provider: 'antigravity', model: 'gemini-4-neon', stopReason: 'stop', usage: { input: 2000, cacheRead: 1000, cacheWrite: 0 } },
    });
    await app.emit('agent_settled');

    const summary = JSON.parse(await readFile(join(report, 'summary.json'), 'utf8'));
    assert.equal(summary.request_count, 2);
    assert.deepEqual(summary.requests.map((r) => r.transport), ['acp-mcp-result', 'acp-stdio']);
    assert.equal(summary.requests[0].image_count, 1, 'acp-mcp-result 应仅计入未延迟的小图');
    assert.equal(summary.requests[0].image_decoded_bytes, smallOptBytes);
    assert.equal(summary.requests[1].image_count, 1, 'acp-stdio 应计入延迟投递的大图');
    assert.equal(summary.requests[1].image_decoded_bytes, bigOptBytes);
    assert.equal(summary.image_occurrences, 2, '总图片出现次数不得重复计入延迟大图');
    assert.equal(summary.image_decoded_bytes, smallOptBytes + bigOptBytes);
    assert.deepEqual(
      summary.image_details.map((d) => ({ source: d.source_type, tool: d.tool_name, bytes: d.decoded_bytes })),
      [
        { source: 'toolResult/read image', tool: 'read', bytes: smallOptBytes },
        { source: 'toolResult/read image', tool: 'read', bytes: bigOptBytes },
      ],
    );
    const expectedSavedPct = (((bigPng.length + smallPng.length) - (bigOptBytes + smallOptBytes)) / (bigPng.length + smallPng.length) * 100).toFixed(1);
    assert.ok(app.statuses.at(-1)?.includes(`图片压缩率 ${expectedSavedPct}%`), `状态栏压缩率应为 ${expectedSavedPct}%，实际: ${app.statuses.at(-1)}`);
    await app.emit('session_shutdown');
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('antigravity-acp 上游全量快照（acp-upstream）替换本地增量、防切片重计、支持切入抢跑与无快照回退', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-traffic-acp-upstream-'));
  const report = join(dir, 'reports');
  const previousEnv = {
    PI_TRAFFIC_OPT_CONFIG_PATH: process.env.PI_TRAFFIC_OPT_CONFIG_PATH,
    PI_TRAFFIC_OPT_REPORT_DIR: process.env.PI_TRAFFIC_OPT_REPORT_DIR,
    PI_TRAFFIC_OPT_ARCHIVE_DIR: process.env.PI_TRAFFIC_OPT_ARCHIVE_DIR,
    PI_TRAFFIC_OPT_CACHE_DIR: process.env.PI_TRAFFIC_OPT_CACHE_DIR,
  };
  process.env.PI_TRAFFIC_OPT_CONFIG_PATH = join(dir, 'config.json');
  process.env.PI_TRAFFIC_OPT_REPORT_DIR = report;
  process.env.PI_TRAFFIC_OPT_ARCHIVE_DIR = join(dir, 'archive');
  process.env.PI_TRAFFIC_OPT_CACHE_DIR = join(dir, 'cache');
  await writeFile(process.env.PI_TRAFFIC_OPT_CONFIG_PATH, JSON.stringify({ enabled: true, skipBelowKB: 0, cache: { enabled: false }, logging: 'off' }));
  try {
    const raw = Buffer.alloc(240 * 240 * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 53 + ((i >> 2) ^ (i * 19))) & 0xff;
    const pngImg = await sharp(raw, { raw: { width: 240, height: 240, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();

    const app = await harness({
      model: { baseUrl: 'acp://antigravity-cli', provider: 'antigravity', id: 'gemini-4-neon', api: 'antigravity-acp', contextWindow: 1000000 },
      activeTools: ['read', 'bash', 'context_recall'],
    });
    await app.emit('session_start');

    // 轮次 1：发送大图（本地增量仅 ~60KB，真实上游全量快照 200KB）；x-acp-upstream-pending=1 暂不记本地增量，由 acp-upstream 一次性落账
    const msg1 = [{ role: 'user', content: [{ type: 'text', text: '分析这张图' }, { type: 'image', data: pngImg.toString('base64'), mimeType: 'image/png' }] }];
    const out1 = await app.emit('context_with_system', { messages: msg1 });
    const optImg = out1.messages[0].content[1];
    const optBytes = Buffer.byteLength(optImg.data, 'base64');
    const optB64Bytes = optImg.data.length;
    const optHash = createHash('sha256').update(optImg.data, 'base64').digest('hex');

    const statusCountBefore = app.statuses.length;
    app.emit('before_provider_request', { payload: { sessionId: 'agy-up-1', prompt: [{ type: 'text', text: '分析这张图' }, { type: 'image', data: optImg.data, mimeType: optImg.mimeType }] } });
    app.emit('after_provider_response', { status: 200, headers: { 'x-acp-session-id': 'agy-up-1', 'x-acp-projection-synced': '1', 'x-acp-upstream-pending': '1' } });
    assert.equal(app.statuses.length, statusCountBefore, '收到 x-acp-upstream-pending=1 后在 acp-upstream 到达前不应先落本地增量假账');

    const snap1 = {
      genIdx: 0,
      total_payload_bytes: 200000 + optB64Bytes,
      json_payload_bytes: 200000 + optB64Bytes,
      system_bytes: 30000,
      user_text_bytes: 1000,
      assistant_text_bytes: 0,
      tool_call_bytes: 0,
      tool_result_bytes: 150000,
      image_payload_bytes: optB64Bytes,
      image_decoded_bytes: optBytes,
      tool_schema_bytes: 15000,
      opaque_reasoning_bytes: 0,
      other_bytes: 4000,
      text_content_utf8_bytes: 181000,
      image_count: 1,
      images: [{ image_hash: optHash, mime_type: 'image/webp', decoded_bytes: optBytes, base64_bytes: optB64Bytes, image_payload_bytes: optB64Bytes, source_type: 'user image', tool_name: '' }],
      results: [],
    };
    app.emit('after_provider_response', {
      status: 200,
      headers: {
        'x-acp-session-id': 'agy-up-1',
        'x-acp-transport': 'acp-upstream',
        'x-acp-projection-synced': '1',
        'x-acp-upstream-gen-count': '1',
        'x-acp-upstream-snapshot': JSON.stringify(snap1),
      },
    });
    await app.emit('message_end', { message: { role: 'assistant', provider: 'antigravity', model: 'gemini-4-neon', stopReason: 'toolUse', usage: { input: 5000, cacheRead: 40000, cacheWrite: 0 } } });
    assert.ok(app.statuses.at(-1)?.includes(`当前 ${asMiB(snap1.total_payload_bytes)}`), `状态栏当前应显示上游全量: ${app.statuses.at(-1)}`);

    // 轮次 2：同一次生成的第 2 个顺序工具（x-acp-transport=acp-upstream-reused），不得重复累加外网流量
    const msg2 = [
      { role: 'user', content: '历史图片已被归档，仅纯文本追问' },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'agy_mcp_seq_1', name: 'bash', arguments: { command: 'echo ok' } }] },
      { role: 'toolResult', toolCallId: 'agy_mcp_seq_1', toolName: 'bash', isError: false, content: [{ type: 'text', text: 'ok' }] },
    ];
    await app.emit('context_with_system', { messages: msg2 });
    app.emit('after_provider_response', { status: 200, headers: { 'x-acp-session-id': 'agy-up-1', 'x-acp-transport': 'acp-mcp-result', 'x-acp-settled-mcp-ids': 'agy_mcp_seq_1', 'x-acp-upstream-pending': '1' } });
    app.emit('after_provider_response', { status: 200, headers: { 'x-acp-session-id': 'agy-up-1', 'x-acp-transport': 'acp-upstream-reused', 'x-acp-projection-synced': '1' } });
    await app.emit('message_end', { message: { role: 'assistant', provider: 'antigravity', model: 'gemini-4-neon', stopReason: 'toolUse', usage: { input: 100, cacheRead: 900, cacheWrite: 0 } } });

    // 轮次 3：工具边界切入（先收到 x-acp-mcp-cutin=1 + x-acp-upstream-pending=1 跳过本地占位，再收到抢跑取消的 detached 499，再收到真实全量 1.05MiB 且仍含已缓存优化图）
    await app.emit('context_with_system', { messages: [...msg2, { role: 'user', content: '切入继续' }] });
    app.emit('after_provider_response', { status: 200, headers: { 'x-acp-session-id': 'agy-up-1', 'x-acp-transport': 'acp-mcp-result', 'x-acp-settled-mcp-ids': 'agy_mcp_seq_1', 'x-acp-mcp-cutin': '1', 'x-acp-upstream-pending': '1' } });
    const detachedSnap = {
      genIdx: 1,
      total_payload_bytes: 12000,
      json_payload_bytes: 12000,
      system_bytes: 2000, user_text_bytes: 500, assistant_text_bytes: 500, tool_call_bytes: 500,
      tool_result_bytes: 500, image_payload_bytes: 0, image_decoded_bytes: 0, tool_schema_bytes: 7000,
      opaque_reasoning_bytes: 0, other_bytes: 1000, text_content_utf8_bytes: 4000, image_count: 0, images: [], results: [],
    };
    app.emit('after_provider_response', {
      status: 499,
      headers: {
        'x-acp-session-id': 'agy-up-1',
        'x-acp-transport': 'acp-upstream',
        'x-acp-upstream-detached': '1',
        'x-acp-upstream-gen-count': '1',
        'x-acp-upstream-snapshot': JSON.stringify(detachedSnap),
      },
    });
    app.emit('before_provider_request', { payload: { sessionId: 'agy-up-1', prompt: [{ type: 'text', text: '切入继续' }] } });
    app.emit('after_provider_response', { status: 200, headers: { 'x-acp-session-id': 'agy-up-1', 'x-acp-projection-synced': '1', 'x-acp-upstream-pending': '1' } });
    const snap3 = {
      ...snap1,
      genIdx: 2,
      total_payload_bytes: 1100000 + optB64Bytes,
      json_payload_bytes: 1100000 + optB64Bytes,
      tool_result_bytes: 1050000,
    };
    app.emit('after_provider_response', {
      status: 200,
      headers: {
        'x-acp-session-id': 'agy-up-1',
        'x-acp-transport': 'acp-upstream',
        'x-acp-projection-synced': '1',
        'x-acp-upstream-gen-count': '1',
        'x-acp-upstream-snapshot': JSON.stringify(snap3),
      },
    });
    await app.emit('message_end', { message: { role: 'assistant', provider: 'antigravity', model: 'gemini-4-neon', stopReason: 'stop', usage: { input: 6000, cacheRead: 280000, cacheWrite: 0 } } });

    // 即使轮次 3 的 context_with_system 不再包含原图，knownImageMetrics 仍准确维持原图压缩率
    const expectedPct = (((pngImg.length - optBytes) / pngImg.length) * 100).toFixed(1);
    assert.ok(app.statuses.at(-1)?.includes(`当前 ${asMiB(snap3.total_payload_bytes)}`), `状态栏当前应为 ~1.05MiB: ${app.statuses.at(-1)}`);
    assert.ok(app.statuses.at(-1)?.includes(`图片压缩率 ${expectedPct}%`), `跨轮重传已归档优化图仍应维持准确压缩率 ${expectedPct}%，实际: ${app.statuses.at(-1)}`);

    // 轮次 4：acp-upstream-unavailable 应平滑回退至本地 acp-stdio 记账
    await app.emit('context_with_system', { messages: [{ role: 'user', content: '无快照回退' }] });
    app.emit('before_provider_request', { payload: { sessionId: 'agy-up-2', prompt: [{ type: 'text', text: '无快照回退' }] } });
    app.emit('after_provider_response', { status: 200, headers: { 'x-acp-session-id': 'agy-up-2', 'x-acp-upstream-pending': '1' } });
    app.emit('after_provider_response', { status: 200, headers: { 'x-acp-session-id': 'agy-up-2', 'x-acp-transport': 'acp-upstream-unavailable' } });
    await app.emit('message_end', { message: { role: 'assistant', provider: 'antigravity', model: 'gemini-4-neon', stopReason: 'stop', usage: { input: 100, cacheRead: 0, cacheWrite: 0 } } });
    await app.emit('agent_settled');

    const summary = JSON.parse(await readFile(join(report, 'summary.json'), 'utf8'));
    assert.equal(summary.request_count, 4, '应精准记录 1 次首轮 + 1 次 detached 499 + 1 次切入全量 + 1 次回退 acp-stdio（不含 reused 与 cutin 占位）');
    assert.deepEqual(summary.requests.map((r) => r.transport), ['acp-upstream', 'acp-upstream', 'acp-upstream', 'acp-stdio']);
    assert.deepEqual(summary.requests.map((r) => r.response_status), [200, 499, 200, 200]);
    assert.deepEqual(summary.requests.map((r) => r.context_tokens), [45000, null, 286000, 100]);
    assert.equal(summary.unique_images, 1);
    assert.equal(summary.image_occurrences, 2);
    assert.equal(summary.repeated_occurrences, 1);
    await app.emit('session_shutdown');
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
