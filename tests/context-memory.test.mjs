import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { ImageOptimizer } from '../src/optimizer.mjs';
import { normalizeConfiguration } from '../src/configuration.mjs';
import { ContextMemory } from '../src/context-memory.mjs';

const system = { role: 'system', content: '测试指令', timestamp: 1 };
const assistant = (id, name = 'bash', arguments_ = {}) => ({ role: 'assistant', timestamp: 2,
  content: [{ type: 'toolCall', id, name, arguments: arguments_ }] });
const result = (id, text, name = 'bash') => ({ role: 'toolResult', toolCallId: id, toolName: name,
  content: [{ type: 'text', text }], isError: false, timestamp: 3 });
const tail = (n = 5) => Array.from({ length: n }, (_, i) => ({ role: 'assistant', content: [{ type: 'text', text: '继续工作' }], timestamp: 10 + i }));
async function environment(fn, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-context-test-'));
  let now = Date.now();
  const config = normalizeConfiguration({ skipBelowKB: 0, contextOptimization: {
    keepRecentTurns: 1, keepRecentTokens: 0, minimumToolResultBytes: 128, oversizedToolResultBytes: 1024,
    hotLeaseTurns: 3, hotLeaseSeconds: 2, ...overrides } });
  const optimizer = new ImageOptimizer({ cacheDir: join(directory, 'cache') });
  const memory = new ContextMemory({ directory: join(directory, 'archive'), config, optimizer, clock: () => now });
  const ctx = { cwd: directory, model: { contextWindow: 200000 }, sessionManager: { getSessionId: () => 'session-test', getBranch: () => [] } };
  try { await memory.start(ctx); await fn({ directory, memory, config, optimizer, ctx, advance: (ms, turns = 0) => { now += ms; memory.turn += turns; } }); }
  finally { await memory.close(); await rm(directory, { recursive: true, force: true }); }
}

test('大文件 snapshot → 稳定投影 → 精确局部 recall；关闭恢复完整上下文', async () => environment(async ({ directory, memory, ctx }) => {
  const path = join(directory, 'source.ts');
  const text = Array.from({ length: 2000 }, (_, i) => `export const value${i} = "记录-${i}";`).join('\n');
  await writeFile(path, text);
  const args = { path, offset: 100, limit: 1900 };
  await memory.observeCall({ toolName: 'read', toolCallId: 'read-1', input: args }, ctx);
  const snapshot = text.split('\n').slice(99, 99 + args.limit).join('\n');
  const m = result('read-1', snapshot, 'read');
  await memory.observeResult({ ...m, input: args }, ctx);
  const history = [system, assistant('read-1', 'read', args), m, ...tail()];
  const before = JSON.stringify(history);
  const first = await memory.project(history, ctx);
  assert.equal(JSON.stringify(history), before);
  assert.equal(first.messages[0], system);
  assert.equal(first.messages[1], history[1]);
  assert.equal(first.messages[2].toolCallId, 'read-1');
  const placeholder = first.messages[2].content[0].text;
  assert.ok(Buffer.byteLength(placeholder) < 1600);
  assert.equal((await memory.project(history, ctx)).messages[2].content[0].text, placeholder);
  const id = placeholder.match(/ctx:\/\/tool\/[a-f0-9]+/)[0];
  const recall = await memory.recall({ id, query: 'value1100', around: 2 });
  const data = JSON.parse(recall.content[0].text);
  assert.equal(data.snapshot.state, 'current');
  assert.ok(data.text.includes('value1100'));
  assert.ok(recall.details.returnedBytes < 2000);
  assert.equal(memory.metrics.exactRecallsWithoutToolExecution, 1);
  assert.equal(memory.archive.usage(id).recallCount, 1);
  assert.equal(memory.calls.size, 1);
  memory.config.enabled = false;
  assert.equal((await memory.project(history, ctx)).messages, history);
  await assert.rejects(memory.recall({ id }), /关闭/);
}));

test('edit 后旧 snapshot stale，旧证据可取回，支持 current/diff 和关系查询', async () => environment(async ({ directory, memory, ctx }) => {
  const path = join(directory, 'source.ts');
  const old = 'const state = "old";\n' + '历史数据\n'.repeat(300);
  await writeFile(path, old);
  await memory.observeCall({ toolName: 'read', toolCallId: 'read-old', input: { path } }, ctx);
  await memory.observeResult({ ...result('read-old', old, 'read'), input: { path } }, ctx);
  const o = memory.results.get('read-old').object;
  await writeFile(path, old.replace('"old"', '"new"'));
  await memory.observeCall({ toolName: 'edit', toolCallId: 'edit-1', input: { path, edits: [] } }, ctx);
  await memory.observeResult({ ...result('edit-1', '修改成功', 'edit'), input: { path } }, ctx);
  assert.equal(memory.archive.get(o.id).stale, true);
  const live = old.replace('"old"', '"new"');
  await memory.observeCall({ toolName: 'read', toolCallId: 'read-new', input: { path } }, ctx);
  await memory.observeResult({ ...result('read-new', live, 'read'), input: { path } }, ctx);
  const fresh = memory.results.get('read-new').object;
  const recall = await memory.recall({ id: o.id, head: 2 });
  assert.notEqual(memory.archive.get(fresh.id).stale, true);
  assert.equal(JSON.parse((await memory.recall({ id: fresh.id, metadataOnly: true })).content[0].text).snapshot.state, 'current');
  const data = JSON.parse(recall.content[0].text);
  assert.equal(data.snapshot.state, 'stale');
  assert.ok(data.text.includes('"old"'));
  assert.ok(JSON.parse((await memory.recall({ id: o.id, view: 'current', head: 2 })).content[0].text).text.includes('"new"'));
  assert.ok(JSON.parse((await memory.recall({ id: o.id, view: 'diff', head: 4 })).content[0].text).text.includes('+const state'));
  const related = JSON.parse((await memory.recall({ id: o.id, related: true })).content[0].text).related;
  assert.ok(related.some(e => e.relation === 'same_file'));
}));

test('长 build 日志的 exact/query 分页、FTS5/BM25、lease 和回收不抖动', async () => environment(async ({ memory, ctx, advance }) => {
  const log = Array.from({ length: 3000 }, (_, i) => i === 1800 ? 'undefined reference to missing_symbol' : `[build ${i}] compilation continues`).join('\n');
  await memory.observeCall({ toolName: 'bash', toolCallId: 'build', input: { command: 'cmake --build build' } }, ctx);
  await memory.observeResult({ ...result('build', log), structuredContent: { exit_code: 1 }, isError: true }, ctx);
  const history = [system, assistant('build'), result('build', log), ...tail()];
  const p = await memory.project(history, ctx);
  const id = p.messages[2].content[0].text.match(/ctx:\/\/tool\/[a-f0-9]+/)[0];
  const r = await memory.recall({ id, query: 'undefined reference', around: 3 });
  assert.ok(r.details.returnedBytes < 2500);
  assert.ok(JSON.parse(r.content[0].text).text.includes('missing_symbol'));
  const search = JSON.parse((await memory.recall({ query: 'missing_symbol' })).content[0].text);
  assert.equal(search.hits[0].id, id);
  const page = { role: 'toolResult', toolName: 'context_recall', toolCallId: 'recall-1', content: r.content, details: r.details };
  const recalledHistory = [...history, assistant('recall-1', 'context_recall', { id }), page, ...tail(8)];
  memory.turn++;
  assert.deepEqual((await memory.project(recalledHistory, ctx)).messages.find(m => m.toolCallId === 'recall-1').content, r.content);
  advance(3000, 1);
  assert.deepEqual((await memory.project(recalledHistory, ctx)).messages.find(m => m.toolCallId === 'recall-1').content, r.content);
  advance(0, 2);
  const evicted = (await memory.project(recalledHistory, ctx)).messages.find(m => m.toolCallId === 'recall-1');
  assert.match(evicted.content[0].text, /历史 recall 页/);
  assert.equal(memory.archive.usage(id).pageEvictions, 1);
  const oldPlaceholder = evicted.content[0].text;
  const oldPageId = oldPlaceholder.match(/ctx:\/\/tool\/[a-f0-9]+/)[0];
  const r2 = await memory.recall({ id, query: 'missing_symbol', around: 1 });
  const secondPage = { role: 'toolResult', toolName: 'context_recall', toolCallId: 'recall-2', content: r2.content, details: r2.details };
  const secondHistory = [...recalledHistory, assistant('recall-2', 'context_recall', { id }), secondPage, ...tail(3)];
  const next = await memory.project(secondHistory, ctx);
  assert.equal(next.messages.find(m => m.toolCallId === 'recall-1').content[0].text, oldPlaceholder);
  assert.deepEqual(next.messages.find(m => m.toolCallId === 'recall-2').content, r2.content);
  const historicalPage = await memory.recall({ id: oldPageId });
  assert.ok(JSON.parse(historicalPage.content[0].text).text.includes('undefined reference'));
  assert.equal(memory.metrics.thrashingCount, 0);
  assert.equal((await memory.project(recalledHistory, ctx)).messages[2].content[0].text, p.messages[2].content[0].text);
  assert.equal(memory.calls.size, 1);
}));

test('图片归档与 recall 返回真实 image block，复用压缩缓存且旧图片不再上传', async () => environment(async ({ memory, optimizer, ctx, directory }) => {
  const raw = Buffer.alloc(600 * 600 * 3);
  let seed = 123456789;
  for (let i = 0; i < raw.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; raw[i] = seed & 255; }
  const original = await sharp(raw, { raw: { width: 600, height: 600, channels: 3 } }).png().toBuffer();
  const image = { type: 'image', mimeType: 'image/png', data: original.toString('base64') };
  const history = [system, { role: 'user', content: [image], timestamp: 10 }, ...tail(), { role: 'user', content: '继续', timestamp: 100 }, ...tail()];
  const first = await memory.project(history, ctx);
  assert.equal(first.messages[1].content[0].type, 'text');
  const o = memory.images.get(image.data);
  assert.ok(o.optimizedBytes < o.originalBytes);
  const encoded = optimizer.totals.misses;
  const recalled = await memory.recall({ id: o.id });
  assert.equal(recalled.content[1].type, 'image');
  assert.equal(recalled.content[1].mimeType, 'image/webp');
  const message = { role: 'toolResult', toolName: 'context_recall', content: recalled.content, details: recalled.details };
  await optimizer.optimizeMessages([message], memory.config, { alreadyOptimized: m => m.toolName === 'context_recall' });
  assert.equal(optimizer.totals.misses, encoded);
  await optimizer.clearCache();
  const again = await memory.recall({ id: o.id });
  assert.equal(again.content[1].data, recalled.content[1].data);
  assert.equal(optimizer.totals.misses, encoded);
  assert.equal(first.stats.imageBlocksProjected, 1);
  assert.equal(first.stats.imageBytesAvoided, o.optimizedBytes);
  assert.ok((await stat(o.archivePath)).size > 0);
}));

test('旧工具图片按 turn 归档，少量文本的 recent token 保护不使图片长期重复上传', async () => environment(async ({ memory, ctx, directory }) => {
  const raw = Buffer.alloc(400 * 400 * 3);
  let seed = 192837;
  for (let i = 0; i < raw.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; raw[i] = seed & 255; }
  const bytes = await sharp(raw, { raw: { width: 400, height: 400, channels: 3 } }).png().toBuffer();
  const path = join(directory, 'screenshot.png'); await writeFile(path, bytes);
  await memory.observeCall({ toolName: 'read', toolCallId: 'image-old', input: { path } }, ctx);
  const m = { ...result('image-old', 'Read image file [image/png]', 'read'), content: [{ type: 'text', text: 'Read image file [image/png]' }, { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }] };
  await memory.observeResult({ ...m, input: { path } }, ctx);
  const history = [system, assistant('image-old', 'read', { path }), m, ...tail(20)];
  const projected = await memory.project(history, ctx);
  assert.equal(projected.messages[2].content[0].text, m.content[0].text);
  assert.match(projected.messages[2].content[1].text, /ctx:\/\/image\//);
  assert.equal(m.content[1].type, 'image');
  assert.equal(projected.stats.imageBlocksProjected, 1);
  assert.equal((await memory.project(history, ctx)).messages[2].content[1].text, projected.messages[2].content[1].text);
  const id = projected.messages[2].content[1].text.match(/ctx:\/\/image\/[a-f0-9]{64}/)[0];
  await assert.rejects(memory.recall({ id, view: 'current' }), /当前图片/);
}, { keepRecentTurns: 4, keepRecentTokens: 12000 }));

test('图片 recall 页到期归档复用原图片对象，再次 pin 保持旧 prefix 和编码次数', async () => environment(async ({ memory, optimizer, ctx, advance }) => {
  const original = await sharp({ create: { width: 400, height: 300, channels: 3, background: 'red' } }).png().toBuffer();
  const image = { type: 'image', mimeType: 'image/png', data: original.toString('base64') };
  const object = await memory.captureImage(image);
  const recalled = await memory.recall({ id: object.id });
  const page = { role: 'toolResult', toolName: 'context_recall', toolCallId: 'image-page', content: recalled.content, details: recalled.details, timestamp: Date.now() };
  const history = [system, assistant('image-page', 'context_recall', { id: object.id }), page, ...tail()];
  const misses = optimizer.totals.misses;
  advance(3000, 4);
  const cold = await memory.project(history, ctx);
  assert.match(cold.messages[2].content[0].text, /历史 recall 页/);
  assert.equal(optimizer.totals.misses, misses);
  await memory.recall({ id: object.id });
  assert.equal((await memory.project(history, ctx)).messages[2].content[0].text, cold.messages[2].content[0].text);
  assert.equal(optimizer.totals.misses, misses);
}));

test('归档失败保留原结果；损坏或缺失 blob 不投影；恢复后旧 handle 可复用', async () => environment(async ({ memory, ctx }) => {
  const text = '可靠历史输出\n'.repeat(2000);
  const history = [system, assistant('fault'), result('fault', text), ...tail()];
  const originalPut = memory.archive.put.bind(memory.archive);
  memory.archive.put = async () => { throw new Error('模拟写入失败'); };
  assert.equal((await memory.project(history, ctx)).messages[2], history[2]);
  memory.archive.put = originalPut;
  const first = await memory.project(history, ctx);
  const o = memory.results.get('fault').object;
  const good = await readFile(o.archivePath);
  const broken = Buffer.alloc(good.length, 65);
  await writeFile(o.archivePath, broken);
  assert.equal((await memory.project(history, ctx)).messages[2], history[2]);
  await assert.rejects(memory.recall({ id: o.id }), /校验失败/);
  await writeFile(o.archivePath, good);
  assert.equal((await memory.project(history, ctx)).messages[2].content[0].text, first.messages[2].content[0].text);
  await rm(o.archivePath);
  assert.equal((await memory.project(history, ctx)).messages[2], history[2]);
}));

test('大 write 参数放独立 blob；单行精确匹配和 UTF-8/控制字符分页不丢字节', async () => environment(async ({ directory, memory, ctx }) => {
  const path = join(directory, 'large.txt');
  const input = { path, content: '中'.repeat(350000) + 'NEEDLE(a)' + '尾'.repeat(1000) };
  await writeFile(path, input.content);
  await memory.observeCall({ toolName: 'write', toolCallId: 'write-large', input }, ctx);
  await memory.observeResult({ ...result('write-large', '写入成功', 'write'), input }, ctx);
  const object = memory.results.get('write-large').object;
  assert.ok(object.argumentBlob);
  assert.ok(Buffer.byteLength(memory.archive.db.prepare('SELECT metadata FROM objects WHERE id=?').get(object.id).metadata) < 8192);
  assert.deepEqual(JSON.parse((await memory.archive.readBlob(object.argumentBlob)).toString('utf8')), input);
  const page = await memory.recall({ id: object.id, part: 'arguments', query: 'NEEDLE(a)' });
  assert.ok(JSON.parse(page.content[0].text).text.includes('NEEDLE(a)'));
  assert.ok(page.details.returnedBytes <= memory.options.recallOptions.maxBytes);
  const source = ('汉🙂' + String.fromCharCode(7)).repeat(10000);
  let offset = 1, byteOffset = 0, restored = '';
  for (let i = 0; i < 200; i++) {
    const chunk = memory.selectText(source, { offset, byteOffset });
    restored += chunk.text;
    assert.ok(Buffer.byteLength(JSON.stringify(chunk)) <= memory.options.recallOptions.maxBytes);
    if (!chunk.truncated) break;
    offset = chunk.nextOffset; byteOffset = chunk.nextByteOffset;
  }
  assert.equal(restored, source);
  memory.working.latestCommands = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i), { command: 'x'.repeat(1024) }]));
  memory.working.latestTests = { ...memory.working.latestCommands };
  const state = await memory.recall({ workingState: true });
  assert.ok(state.details.returnedBytes <= memory.options.recallOptions.maxBytes);
  assert.ok(JSON.parse(state.content[0].text).workingStatePage);
}));

test('FTS 转义、配置边界、长行安全分页和 recent 原始结果保护', async () => environment(async ({ memory, ctx }) => {
  const text = 'x'.repeat(100000);
  const m = result('recent', text);
  const history = [system, assistant('recent'), m];
  const p = await memory.project(history, ctx);
  assert.equal(p.messages[2], m);
  const id = memory.results.get('recent').object.id;
  const r = await memory.recall({ id, full: true });
  const data = JSON.parse(r.content[0].text);
  assert.ok(r.details.returnedBytes < 68000);
  assert.equal(data.longLine, true);
  const next = JSON.parse((await memory.recall({ id, offset: data.nextOffset, byteOffset: data.nextByteOffset })).content[0].text);
  assert.ok(next.text.length > 0);
  assert.doesNotThrow(() => memory.archive.search('" OR * (invalid)'));
  const c = normalizeConfiguration({ contextOptimization: { keepRecentTurns: -1, thresholds: { low: .99, medium: .3 } } });
  assert.equal(c.contextOptimization.keepRecentTurns, 4);
  assert.equal(c.contextOptimization.thresholds.low, .6);
}));

test('缓存感知 GC：大窗口低压力碎片与已归档历史不引发频繁每轮 GC', async () => environment(async ({ memory, ctx }) => {
  const geminiCtx = { ...ctx, model: { provider: 'custom.gemini', id: 'gemini-4-hydrogen', contextWindow: 1048576 } };
  const heavySystem = { role: 'system', content: '', sections: { base: '系统提示 '.repeat(12000) }, toolsAdded: [{ name: 'bash', description: 'run' }], timestamp: 1 };
  const history = [heavySystem];
  const chunk36k = '日志记录 line-data-0123456789abcdef\n'.repeat(1000); // ~36 KiB
  const large900k = '历史超大归档记录 abcdef0123456789\n'.repeat(28000); // ~980 KiB (模拟曾归档的历史总量)

  // 先模拟 4 个已经归档投影过的历史大对象，验证其不再虚高拉爆 pressure。
  for (let i = 0; i < 4; i++) {
    const id = `old-${i}`;
    await memory.observeResult({ ...result(id, large900k), input: { command: 'old' } }, geminiCtx);
    const obj = memory.results.get(id).object;
    memory.archive.saveProjection(memory.sessionId, `tool:${id}`, obj.id, memory.toolPlaceholder(obj));
    history.push(assistant(id), result(id, large900k));
  }
  // 新增 10 轮中等输出（每轮 ~36 KiB，超过旧版 oversizedToolResultBytes），验证不会每轮触发 GC。
  for (let t = 0; t < 10; t++) {
    memory.setTurn();
    const id = `drip-${t}`;
    await memory.observeResult({ ...result(id, chunk36k), input: { command: 'cat' } }, geminiCtx);
    history.push(assistant(id), result(id, chunk36k));
    const res = await memory.project(history, geminiCtx);
    assert.ok(res.stats.pressure < 0.5, `已归档历史不应导致虚高压力: ${res.stats.pressure}`);
    assert.equal(res.stats.gcTriggered, false, `第 ${t} 轮小增量不应破坏前缀缓存`);
  }
  assert.equal(memory.metrics.gcSweeps, 0);
  assert.ok(memory.metrics.gcSkips > 0);
  // 达到 400 KiB 累积后或强制 GC，应一次性批量清扫全部冷却候选并进入冷却期。
  memory.forceGC = true;
  const forced = await memory.project(history, geminiCtx);
  assert.equal(forced.stats.gcTriggered, true);
  assert.equal(forced.stats.gcReason, 'forced');
  assert.equal(memory.metrics.gcSweeps, 1);
  // 紧接着再跑 2 轮，处于 cooldown 且增量小，必须继续保持前缀稳定。
  for (let t = 10; t < 12; t++) {
    memory.setTurn();
    const id = `post-${t}`;
    await memory.observeResult({ ...result(id, chunk36k), input: { command: 'cat' } }, geminiCtx);
    history.push(assistant(id), result(id, chunk36k));
    const res = await memory.project(history, geminiCtx);
    assert.equal(res.stats.gcTriggered, false);
  }
}, { keepRecentTurns: 4, keepRecentTokens: 12000, minimumToolResultBytes: 4096, oversizedToolResultBytes: 32768 }));

test('缓存感知 GC：UTF-8 中文与 system.sections 估算、usage 动态校准、compact 复位与到期 recall 不单点炸缓存', async () => environment(async ({ directory, memory, config, optimizer, ctx, advance }) => {
  const sys = { role: 'system', content: '', sections: { rules: '中文规则'.repeat(5000) }, timestamp: 1 };
  assert.ok(memory.estimate(sys) > 15000);

  const geminiCtx = { ...ctx, model: { provider: 'custom.gemini', id: 'gemini-4-hydrogen', contextWindow: 1048576 } };
  const big = '中'.repeat(24000); // 72 KiB UTF-8 => ~24k tokens
  const history = [sys, assistant('c1'), result('c1', big), ...tail(6)];
  const p1 = await memory.project(history, geminiCtx);
  assert.equal(p1.stats.gcTriggered, false);
  // 模拟 provider 返回真实输入 tokens 高于静态估算，触发校准。
  memory.observeAssistantMessage({
    role: 'assistant', provider: 'custom.gemini', model: 'gemini-4-hydrogen', stopReason: 'stop',
    usage: { input: 60000, cacheRead: 0, cacheWrite: 0, output: 100 },
  });
  assert.ok(memory.calibrationFactor > 1 && memory.calibrationFactor <= 1.8);
  const p2 = await memory.project(history, geminiCtx);
  assert.ok(p2.stats.activeEstimatedTokens > p1.stats.activeEstimatedTokens);

  // compact 后应复位校准因子。
  memory.onCompact();
  assert.equal(memory.calibrationFactor, 1);

  // 大型上下文中单个到期的小型 recall 页不应单独修改前缀破坏缓存。
  const obj = memory.results.get('c1').object;
  const recallRes = await memory.recall({ id: obj.id, head: 2 });
  const recallMsg = { role: 'toolResult', toolName: 'context_recall', toolCallId: 'rec-1', content: recallRes.content, details: recallRes.details };
  const recallHistory = [...history, assistant('rec-1', 'context_recall', { id: obj.id }), recallMsg, ...tail(6)];
  advance(5000, 5);
  const pRecall = await memory.project(recallHistory, geminiCtx);
  assert.equal(pRecall.stats.gcTriggered, false);
  assert.equal(pRecall.messages.find(m => m.toolCallId === 'rec-1').content, recallRes.content);

  // 重启重建后应保留 lastGcTurn 与 calibrationFactor。
  memory.lastGcTurn = memory.turn;
  memory.calibrationFactor = 1.25;
  memory.calibrationModel = 'custom.gemini:gemini-4-hydrogen';
  memory.saveSessionState();
  await memory.close();
  const reopened = new ContextMemory({ directory: join(directory, 'archive'), config, optimizer, clock: () => Date.now() });
  await reopened.start({ ...geminiCtx, sessionManager: { getSessionId: () => 'session-test', getBranch: () => Array.from({ length: memory.turn }, () => ({ message: { role: 'assistant', content: [] } })) } });
  assert.equal(reopened.lastGcTurn, memory.turn);
  assert.equal(reopened.calibrationFactor, 1.25);
  await reopened.close();
}, { keepRecentTurns: 4, keepRecentTokens: 12000, minimumToolResultBytes: 4096, oversizedToolResultBytes: 32768 }));

test('pi-antigravity-bridge 镜像工具：agy_edit 多文件失效旧 read、agy_read current 召回、agy_bash 关系与多工具分摊切片校准防护', async () => environment(async ({ directory, memory, ctx }) => {
  const fileA = join(directory, 'a.ts');
  const fileB = join(directory, 'b.ts');
  await writeFile(fileA, 'const a = 1;\n');
  await writeFile(fileB, 'const b = 1;\n');

  // 1. 先用原生 read 读取 fileA 和 fileB，形成 verified snapshot
  await memory.observeCall({ toolCallId: 'r-a', toolName: 'read', input: { path: fileA } }, ctx);
  await memory.observeResult({ toolCallId: 'r-a', toolName: 'read', input: { path: fileA }, content: [{ type: 'text', text: 'const a = 1;\n' }] }, ctx);
  await memory.observeCall({ toolCallId: 'r-b', toolName: 'read', input: { path: fileB } }, ctx);
  await memory.observeResult({ toolCallId: 'r-b', toolName: 'read', input: { path: fileB }, content: [{ type: 'text', text: 'const b = 1;\n' }] }, ctx);
  const objA = memory.results.get('r-a').object;
  const objB = memory.results.get('r-b').object;
  assert.equal(objA.snapshotStatus, 'verified_before_after');
  assert.equal(objB.snapshotStatus, 'verified_before_after');

  // 2. 使用 agy_edit 修改两文件（通过 details.diffs 报告多路径），应使两文件缓存失效并标记 stale
  await writeFile(fileA, 'const a = 2;\n');
  await writeFile(fileB, 'const b = 2;\n');
  await memory.observeCall({ toolCallId: 'ae-1', toolName: 'agy_edit', input: { title: 'Edit files', path: fileA } }, ctx);
  await memory.observeResult({
    toolCallId: 'ae-1', toolName: 'agy_edit', input: { title: 'Edit files', path: fileA }, isError: false,
    content: [{ type: 'text', text: 'Updated a.ts and b.ts' }],
    details: { path: fileA, diffs: [{ path: fileA, oldText: '1', newText: '2' }, { path: fileB, oldText: '1', newText: '2' }] },
  }, ctx);
  const agyEditObj = memory.results.get('ae-1').object;
  assert.ok(agyEditObj.related.some(e => e.relation === 'same_file' && e.id === objA.id));
  assert.ok(agyEditObj.related.some(e => e.relation === 'same_file' && e.id === objB.id));
  assert.ok(memory.working.modifiedFiles[fileA]);
  assert.ok(memory.working.modifiedFiles[fileB]);
  assert.equal(memory.archive.get(objA.id).stale, true);
  assert.equal(memory.archive.get(objB.id).stale, true);
  const recalledA = JSON.parse((await memory.recall({ id: objA.id })).content[0].text);
  assert.equal(recalledA.snapshot.state, 'stale');

  // 3. agy_read 归档标记为 source_unverified，支持 details.line 回退、纳入 recentReads 并支持 view=current
  await writeFile(fileA, 'line1\nconst a = 2;\n');
  await memory.observeCall({ toolCallId: 'ar-1', toolName: 'agy_read', input: { path: fileA } }, ctx);
  await memory.observeResult({
    toolCallId: 'ar-1', toolName: 'agy_read', input: { path: fileA },
    details: { path: fileA, line: 2 },
    content: [{ type: 'text', text: 'const a = 2;\n' }],
  }, ctx);
  const agyReadObj = memory.results.get('ar-1').object;
  assert.equal(agyReadObj.snapshotStatus, 'source_unverified');
  assert.equal(agyReadObj.range.offset, 2);
  assert.equal(memory.working.recentReads[fileA].id, agyReadObj.id);
  // 同文件执行带 hash 校验的 read 不应误标未修改时的 agy_read 为 stale
  await memory.observeCall({ toolCallId: 'r-a2', toolName: 'read', input: { path: fileA } }, ctx);
  await memory.observeResult({ toolCallId: 'r-a2', toolName: 'read', input: { path: fileA }, content: [{ type: 'text', text: 'line1\nconst a = 2;\n' }] }, ctx);
  await memory.recall({ id: memory.results.get('r-a2').object.id, metadataOnly: true });
  assert.notEqual(memory.archive.get(agyReadObj.id).stale, true);
  const liveA = JSON.parse((await memory.recall({ id: agyReadObj.id, view: 'current' })).content[0].text);
  assert.equal(liveA.snapshot.state, 'unverified');
  assert.match(liveA.text, /^1: const a = 2;/);
  // 后续 edit 修改 fileA 后，agy_read 也应被 markStale 标记为 stale
  await writeFile(fileA, 'line1\nconst a = 3;\n');
  await memory.observeResult({ toolCallId: 'ae-2', toolName: 'agy_edit', input: { path: fileA }, isError: false, content: [{ type: 'text', text: 'Updated a.ts' }] }, ctx);
  assert.equal(memory.archive.get(agyReadObj.id).stale, true);
  const staleAgyRead = JSON.parse((await memory.recall({ id: agyReadObj.id })).content[0].text);
  assert.equal(staleAgyRead.snapshot.state, 'stale');

  // 3b. agy_read 传入 file:// URI、StartLine/EndLine 及带连续行号前缀的快照，diff 不产生整段假差异
  const fileC = join(directory, 'c.ts');
  await writeFile(fileC, 'line1\nkeep-2\nchange-3\nkeep-4\nline5\n');
  const fileCUri = pathToFileURL(fileC).href;
  await memory.observeCall({ toolCallId: 'ar-uri', toolName: 'agy_read', input: { path: fileCUri, StartLine: 2, EndLine: 4 } }, ctx);
  await memory.observeResult({
    toolCallId: 'ar-uri', toolName: 'agy_read', input: { path: fileCUri, StartLine: 2, EndLine: 4 },
    details: { path: fileCUri, line: 2, limit: 3 },
    content: [{ type: 'text', text: '2: keep-2\n3: change-3\n4: keep-4' }],
  }, ctx);
  const uriReadObj = memory.results.get('ar-uri').object;
  assert.equal(uriReadObj.path, fileC);
  assert.deepEqual(uriReadObj.range, { offset: 2, limit: 3 });
  await writeFile(fileC, 'line1\nkeep-2\nchange-3-new\nkeep-4\nline5\n');
  await memory.observeResult({
    toolCallId: 'ae-uri', toolName: 'agy_edit', input: { path: fileCUri }, isError: false,
    content: [{ type: 'text', text: 'Updated c.ts' }],
  }, ctx);
  assert.equal(memory.archive.get(uriReadObj.id).stale, true);
  const diffC = JSON.parse((await memory.recall({ id: uriReadObj.id, view: 'diff' })).content[0].text);
  assert.equal(diffC.snapshot.state, 'stale');
  assert.ok(diffC.text.includes(' keep-2') && diffC.text.includes('-change-3') && diffC.text.includes('+change-3-new') && diffC.text.includes(' keep-4'));
  assert.equal(diffC.text.includes('line5'), false);

  // 4. agy_bash 执行测试，建立 runs_after_edit 关系并记录至 latestTests
  await memory.observeCall({ toolCallId: 'ab-1', toolName: 'agy_bash', input: { command: 'npm test' } }, ctx);
  await memory.observeResult({ toolCallId: 'ab-1', toolName: 'agy_bash', input: { command: 'npm test' }, content: [{ type: 'text', text: 'x'.repeat(5000) }] }, ctx);
  const agyBashObj = memory.results.get('ab-1').object;
  assert.ok(agyBashObj.related.some(e => e.relation === 'runs_after_edit'));
  assert.ok(memory.working.latestTests[agyBashObj.id]);

  // 5. 多工具并发分摊切片与 skipCalibration（热轮次中途 GC 脱节）均不应污染 calibrationFactor
  const agyCtx = { ...ctx, model: { provider: 'antigravity', id: 'gemini-4-neon', contextWindow: 1048576 } };
  const big = '中'.repeat(24000);
  const history = [assistant('c1'), result('c1', big), ...tail(6)];
  await memory.project(history, agyCtx);
  memory.observeAssistantMessage({
    role: 'assistant', provider: 'antigravity', model: 'gemini-4-neon', stopReason: 'toolUse',
    usage: { input: 10000, cacheRead: 35000, cacheWrite: 0, output: 100 },
  });
  const calibrated = memory.calibrationFactor;
  assert.ok(calibrated > 1.2, `全窗口样本应提升校准系数: ${calibrated}`);
  await memory.project(history, agyCtx);
  // 模拟多工具并发后续切片（仅 300 tokens）
  memory.observeAssistantMessage({
    role: 'assistant', provider: 'antigravity', model: 'gemini-4-neon', stopReason: 'toolUse',
    usage: { input: 60, cacheRead: 240, cacheWrite: 0, output: 20 },
  });
  assert.equal(memory.calibrationFactor, calibrated, '多工具分摊切片不应污染校准系数');
  await memory.project(history, agyCtx);
  memory.observeAssistantMessage({
    role: 'assistant', provider: 'antigravity', model: 'gemini-4-neon', stopReason: 'toolUse',
    usage: { input: 10000, cacheRead: 90000, cacheWrite: 0, output: 100 },
  }, { skipCalibration: true });
  assert.equal(memory.calibrationFactor, calibrated, 'skipCalibration 时不应污染校准系数');
}, { keepRecentTurns: 4, keepRecentTokens: 12000, minimumToolResultBytes: 4096, oversizedToolResultBytes: 32768 }));
