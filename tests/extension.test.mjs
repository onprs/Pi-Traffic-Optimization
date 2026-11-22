import assert from 'node:assert/strict';
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
    // 下一新用户轮次走 before_provider_request（acp-stdio 重建同步）后，恢复正常动态校准
    await app.emit('context_with_system', { messages: [...gcMessages, { role: 'user', content: '下一轮' }] });
    app.emit('before_provider_request', { payload: { sessionId: 'agy-2', prompt: [{ type: 'text', text: '下一轮' }] } });
    app.emit('after_provider_response', { status: 200, headers: { 'x-acp-session-id': 'agy-2' } });
    await app.emit('message_end', { message: { role: 'assistant', provider: 'antigravity', model: 'gemini-4-neon', stopReason: 'stop', usage: { input: 10000, cacheRead: 35000, cacheWrite: 0 } } });
    await app.emit('context_with_system', { messages: [...gcMessages, { role: 'user', content: '确认校准' }] });
    await app.command.handler('上下文', app.ctx);
    assert.ok(JSON.parse(app.notices.at(-1)[0]).lastProjection.calibrationFactor > 1.2, '同步重建后应恢复正常动态校准');

    // model_select 清理瞬态请求状态，避免误记上一轮残余 continuation
    await app.emit('context_with_system', { messages: step2Messages });
    await app.emit('model_select');
    await app.emit('message_end', { message: { role: 'assistant', provider: 'antigravity', model: 'gemini-4-neon', stopReason: 'stop', usage: { input: 10, cacheRead: 0, cacheWrite: 0 } } });
    await app.emit('agent_settled');
    const summaryAfter = JSON.parse(await readFile(join(report, 'summary.json'), 'utf8'));
    assert.equal(summaryAfter.request_count, 6, 'model_select 后不应误记残留的 acp-mcp-result');
    await app.emit('session_shutdown');
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
});
