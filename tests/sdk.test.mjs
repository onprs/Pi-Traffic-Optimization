import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import register from '../src/index.ts';
import { runSession, fixtures, installedPi } from './sdk-runner.mjs';

test('Pi 1.x SDK 长会话：真实工具、精确 recall、stale、image page-in 与 canonical pairing', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-sdk-context-'));
  const workspace = join(directory, 'workspace');
  try {
    await fixtures(workspace);
    const steps = [
      { tool: 'read', args: { path: 'source.ts', offset: 1, limit: 750 } },
      { tool: 'bash', args: { command: 'node build-fixture.mjs' } },
      { tool: 'read', args: { path: 'image.png' } },
      { tool: 'bash', args: { command: 'node --version' } },
      { tool: 'context_recall', args: (p, find) => {
        const id = find(p, 'call_1'); assert.ok(id, '旧 read 应投影成 handle');
        return { id, query: 'entry300', around: 3 };
      } },
      { tool: 'edit', args: { path: 'source.ts', edits: [{ oldText: 'TOKEN_OLD', newText: 'TOKEN_NEW' }] } },
      { tool: 'context_recall', args: (p, find) => ({ id: find(p, 'call_1'), head: 2 }) },
      { tool: 'context_recall', args: (p, find) => ({ id: find(p, 'call_2'), query: 'undefined reference', around: 4 }) },
      { tool: 'context_recall', args: (p, find) => ({ id: find(p, 'call_3', 'image') }) },
      ...Array.from({ length: 6 }, () => ({ tool: 'bash', args: { command: 'node --version' } })),
      { finish: true },
    ];
    const r = await runSession({ workspace, output: join(directory, 'run'), steps, verifyDisabled: true, configOverrides: { keepRecentTokens: 0 } });
    assert.equal(r.executions.filter(e => e.name === 'read').length, 2);
    assert.equal(r.executions.filter(e => e.name === 'context_recall').length, 4);
    assert.ok(r.requests.some(req => JSON.stringify(req.payload).includes('ctx://tool/')));
    const pages = r.canonical.filter(m => m.toolName === 'context_recall');
    assert.equal(pages[0].details.snapshot.state, 'current');
    assert.equal(pages[1].details.snapshot.state, 'stale');
    assert.match(pages[1].content[0].text, /TOKEN_OLD/);
    assert.match(pages[2].content[0].text, /undefined reference/);
    assert.ok(pages[2].details.returnedBytes < 4000);
    assert.equal(pages[3].content[1].type, 'image');
    assert.ok(r.requests.some(req => req.payload.input.some(item => item.type === 'function_call_output' && item.call_id === 'call_9' && JSON.stringify(item.output).includes('input_image'))));
    const original = r.canonical.find(m => m.toolName === 'read' && m.content[0]?.text?.includes('TOKEN_OLD'));
    assert.ok(original.content[0].text.length > 30000);
    assert.ok(r.persisted.includes('TOKEN_OLD'));
    assert.ok(r.persisted.includes('TOKEN_NEW'));
    for (const m of r.canonical.filter(m => m.role === 'toolResult')) {
      const call = r.canonical.flatMap(x => x.content ?? []).find(b => b.type === 'toolCall' && b.id === m.toolCallId);
      assert.ok(call, `canonical 中缺少调用 ${m.toolCallId}`);
    }
    assert.equal(r.summary.context_optimization.thrashingCount, 0);
    assert.equal(r.summary.context_optimization.failures, 0);
    assert.equal(r.disabledCheck.recallActive, false);
    assert.equal(r.disabledCheck.projectedHandlesInToolResults, false);
    assert.ok(r.disabledCheck.imageBase64Bytes > 1000000);
    assert.equal(r.reenabledCheck.recallActive, true);
    assert.equal(r.reenabledCheck.projectedHandlesInToolResults, true);
    assert.ok(r.archiveFilesAfterShutdown.every(n => !/-wal$|-shm$/.test(n)));
    assert.equal(r.summary.request_count, r.requests.length - 1);
    assert.equal(r.summary.total_upload_bytes, r.requests.filter((_, i) => i !== r.disabledCheck.requestIndex).reduce((n, x) => n + x.bytes, 0));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Pi SDK (google-generative-ai)：多轮 35KB 工具输出保持请求前缀严格只追加，不频繁触发 GC 破坏缓存', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-sdk-gemini-prefix-'));
  const workspace = join(directory, 'workspace');
  const keys = ['PI_TRAFFIC_OPT_CONFIG_PATH', 'PI_TRAFFIC_OPT_ARCHIVE_DIR', 'PI_TRAFFIC_OPT_CACHE_DIR', 'PI_TRAFFIC_OPT_REPORT_DIR'];
  const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  let session;
  let server;
  try {
    await mkdir(workspace, { recursive: true });
    // ~36 KiB UTF-8 文件，超过旧版 oversizedToolResultBytes (32 KiB)
    const big36k = Array.from({ length: 900 }, (_, i) => `export const item_${i} = "payload-value-${i}-abcdef0123456789";`).join('\n');
    await writeFile(join(workspace, 'chunk.ts'), big36k);
    const { sdk } = await installedPi();
    const configPath = join(directory, 'config.json');
    const reportDir = join(directory, 'report');
    Object.assign(process.env, {
      PI_TRAFFIC_OPT_CONFIG_PATH: configPath,
      PI_TRAFFIC_OPT_ARCHIVE_DIR: join(directory, 'archive'),
      PI_TRAFFIC_OPT_CACHE_DIR: join(directory, 'cache'),
      PI_TRAFFIC_OPT_REPORT_DIR: reportDir,
    });
    // 使用生产默认核心参数（1M 窗口，keepRecentTurns=4，keepRecentTokens=12000，oversizedToolResultBytes=32768）
    await writeFile(configPath, JSON.stringify({
      enabled: true, logging: 'off',
      contextOptimization: { keepRecentTurns: 4, keepRecentTokens: 12000, minimumToolResultBytes: 4096, oversizedToolResultBytes: 32768 },
    }));

    const requests = [];
    let turn = 0;
    server = createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(payload);
      turn++;
      const parts = turn <= 12
        ? [{ functionCall: { id: `gcall_${turn}`, name: 'read', args: { path: join(workspace, 'chunk.ts') } } }]
        : [{ text: '全部读取完成。' }];
      const promptTokens = Math.ceil(JSON.stringify(payload.contents).length / 3);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(`data: ${JSON.stringify({
        candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: promptTokens, cachedContentTokenCount: Math.max(0, promptTokens - 15000), candidatesTokenCount: 20, totalTokenCount: promptTokens + 20 },
      })}\n\n`);
      res.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const agentDir = join(directory, 'agent');
    await mkdir(agentDir, { recursive: true });
    const runtime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null,
      modelsStorePath: join(agentDir, 'models-store.json'), refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerProvider('gemini-prefix-test', {
      api: 'google-generative-ai', baseUrl, apiKey: 'local-test-only',
      models: [{ api: 'google-generative-ai', id: 'gemini-4-hydrogen', name: 'Gemini Prefix Test',
        reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1048576, maxTokens: 4096 }],
    });
    const settings = sdk.SettingsManager.inMemory({ defaultTools: ['read', 'context_recall'],
      compaction: { enabled: false }, retry: { enabled: false }, images: { autoResize: false }, cacheWarming: 'off' });
    const loader = new sdk.DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: '系统规则 '.repeat(4000), extensionFactories: [register] });
    await loader.reload();
    const manager = sdk.SessionManager.create(workspace, join(directory, 'sessions'));
    ({ session } = await sdk.createAgentSession({ cwd: workspace, agentDir, resourceLoader: loader, modelRuntime: runtime,
      model: runtime.getModel('gemini-prefix-test', 'gemini-4-hydrogen'), thinkingLevel: 'off',
      sessionManager: manager, settingsManager: settings }));
    await session.bindExtensions({});
    await session.prompt('连续读取文件以验证前缀缓存稳定性。');

    assert.equal(requests.length, 13);
    // 验证连续 13 次请求对 Gemini contents 的前缀保护：积攒期间严格只追加，达到批量门槛后最多触发 1 次批量清扫而非每轮破坏缓存
    let prefixBreaks = 0;
    for (let i = 1; i < requests.length; i++) {
      const prev = requests[i - 1].contents;
      const currPrefix = requests[i].contents.slice(0, prev.length);
      if (JSON.stringify(currPrefix) !== JSON.stringify(prev)) prefixBreaks++;
    }
    assert.ok(prefixBreaks <= 1, `13 轮连续 36KB 输出最多触发 1 次批量清扫，实际破坏 ${prefixBreaks} 次`);
    await session.prompt('/traffic-opt 统计');
    const summary = JSON.parse(await readFile(join(reportDir, 'summary.json'), 'utf8'));
    assert.ok(summary.context_optimization.gcSweeps <= 1);
    assert.ok(summary.context_optimization.gcSkips >= 5);
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    server?.closeAllConnections?.();
    if (server) await new Promise(r => server.close(r));
    for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(directory, { recursive: true, force: true });
  }
});
