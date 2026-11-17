import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import register from '../index.ts';

export async function installedPi() {
  const root = process.env.PI_TRAFFIC_OPT_PI_ROOT ?? (process.env.APPDATA
    ? join(process.env.APPDATA, 'npm/node_modules/@earendil-works/pi-coding-agent')
    : join(dirname(dirname(process.execPath)), 'lib/node_modules/@earendil-works/pi-coding-agent'));
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (!pkg.version.startsWith('1.')) throw new Error('维护测试需要已安装 Pi 1.x；设置 PI_TRAFFIC_OPT_PI_ROOT');
  return { sdk: await import(pathToFileURL(join(root, 'dist/index.js')).href), version: pkg.version, root };
}
export async function fixtures(directory) {
  await mkdir(directory, { recursive: true });
  const text = 'const state = "TOKEN_OLD";\n' + Array.from({ length: 1750 }, (_, i) => `export const entry${i} = "snapshot-data-${i}-abcdefghijklmnopqrstuvwxyz";`).join('\n');
  await writeFile(join(directory, 'source.ts'), text);
  await writeFile(join(directory, 'build-fixture.mjs'), `const log=Array.from({length:3500},(_,i)=>i===2600?'undefined reference to archived_symbol':('[build '+i+'] compiling implementation and checking dependencies')); process.stdout.write(log.join('\\n')); process.exitCode=1;`);
  const raw = Buffer.alloc(700 * 700 * 3); let seed = 998877;
  for (let i = 0; i < raw.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; raw[i] = seed & 255; }
  const png = await sharp(raw, { raw: { width: 700, height: 700, channels: 3 } }).png().toBuffer();
  await writeFile(join(directory, 'image.png'), png);
  return { text, png };
}
const extractText = (value) => typeof value === 'string' ? value : JSON.stringify(value);
const findHandle = (payload, call, kind = 'tool') => {
  const item = payload.input.find(x => x.type === 'function_call_output' && x.call_id === call);
  const value = item ? extractText(item.output) : '';
  const match = value.match(new RegExp(`ctx://${kind}/[a-f0-9]{64}`));
  if (!match) throw new Error(`请求中尚无 ${call} 的 ${kind} handle`);
  return match[0];
};
const countTokens = (payload) => {
  let characters = 0;
  for (const item of payload.input ?? []) {
    const value = item.output ?? item.content ?? item.arguments;
    if (typeof value === 'string') characters += value.length;
    else for (const b of value ?? []) if (b.text) characters += b.text.length;
  }
  return Math.ceil(characters / 4);
};
function sendSSE(response, item, usage, serial) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (type, rest) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`);
  const info = { id: `resp_${serial}`, object: 'response', status: 'completed', model: 'context-test-model',
    output: [item], usage: { input_tokens: usage, output_tokens: 5, total_tokens: usage + 5,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  send('response.created', { response: { ...info, status: 'in_progress', output: [] } });
  const empty = item.type === 'function_call' ? { ...item, arguments: '' } : { ...item, content: [] };
  send('response.output_item.added', { output_index: 0, item: empty });
  if (item.type === 'function_call') send('response.function_call_arguments.done', { output_index: 0, item_id: item.id, arguments: item.arguments });
  else send('response.output_text.delta', { output_index: 0, content_index: 0, item_id: item.id, delta: item.content[0].text });
  send('response.output_item.done', { output_index: 0, item });
  send('response.completed', { response: info }); response.end();
}
const reply = (text, serial) => ({ type: 'message', id: `msg_${serial}`, role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }] });
export async function diskSize(directory) {
  let bytes = 0;
  try { for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name); bytes += item.isDirectory() ? await diskSize(path) : (await stat(path)).size;
  } } catch (e) { if (e.code !== 'ENOENT') throw e; }
  return bytes;
}

// 使用真实 SDK、built-in tools、provider serializer 与本地 HTTP/SSE。
// 服务端只按确定性脚本生成响应；usage 是字符估算，不能当生产模型 token 计量。
export async function runSession({ workspace, output, projection = true, compactWindow = 1000000,
  steps, configOverrides = {}, promptImages = [], verifyDisabled = false }) {
  const { sdk, version } = await installedPi();
  await mkdir(output, { recursive: true });
  const report = join(output, 'traffic'); const archive = join(output, 'archive');
  const configPath = join(output, 'config.json');
  const config = { enabled: true, logging: 'off', contextOptimization: { projection,
    keepRecentTurns: 1, keepRecentTokens: 2000, oversizedToolResultBytes: 32768, hotLeaseTurns: 4,
    hotLeaseSeconds: 120, ...configOverrides } };
  await writeFile(configPath, JSON.stringify(config));
  const keys = ['PI_TRAFFIC_OPT_CONFIG_PATH', 'PI_TRAFFIC_OPT_ARCHIVE_DIR', 'PI_TRAFFIC_OPT_CACHE_DIR', 'PI_TRAFFIC_OPT_REPORT_DIR'];
  const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { PI_TRAFFIC_OPT_CONFIG_PATH: configPath, PI_TRAFFIC_OPT_ARCHIVE_DIR: archive,
    PI_TRAFFIC_OPT_CACHE_DIR: join(output, 'cache'), PI_TRAFFIC_OPT_REPORT_DIR: report });
  const requests = [], executions = [], latencies = [], errors = [], projections = [], compactions = [];
  let normal = 0, serial = 0, callbackError;
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks); const payload = JSON.parse(raw);
      const isCompact = !(payload.tools?.length);
      requests.push({ bytes: raw.length, payload, kind: isCompact ? 'compact' : 'normal', tokens: countTokens(payload) });
      serial++;
      if (isCompact) { sendSSE(res, reply('已完成文件读取和命令检查。所有历史证据均保留在原会话；继续下一项工作。', serial), countTokens(payload), serial); return; }
      const step = steps[normal++];
      if (!step || step.finish) { sendSSE(res, reply('验证完成。', serial), countTokens(payload), serial); return; }
      const args = typeof step.args === 'function' ? step.args(payload, findHandle) : step.args;
      const item = { type: 'function_call', id: `fc_${normal}`, call_id: `call_${normal}`, name: step.tool,
        arguments: JSON.stringify(args), status: 'completed' };
      sendSSE(res, item, countTokens(payload), serial);
    } catch (e) { callbackError = e; res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  let session;
  let contextBegan;
  let start; let cpu;
  try {
    const agentDir = join(output, 'agent'); await mkdir(agentDir, { recursive: true });
    const runtime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null,
      modelsStorePath: join(agentDir, 'models-store.json'), refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerProvider('context-test', { api: 'openai-responses', baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'local-test-only', models: [{ id: 'context-test-model', name: 'Context 测试模型', api: 'openai-responses',
        reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: compactWindow, maxTokens: 1024 }] });
    const settings = sdk.SettingsManager.inMemory({ defaultTools: ['read', 'bash', 'edit', 'write', 'context_recall'],
      compaction: { enabled: true, reserveTokens: 5000, keepRecentTokens: 4000 }, retry: { enabled: false },
      transport: 'sse', images: { autoResize: false }, cacheWarming: 'off' });
    const loader = new sdk.DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: '按测试步骤完成任务，历史归档可精确 recall。', extensionFactories: [pi => {
        pi.on('context_with_system', () => { contextBegan = performance.now(); });
      }, register, pi => {
        pi.on('context_with_system', () => { projections.push(performance.now() - contextBegan); });
        pi.on('before_provider_request', () => { if (contextBegan) latencies.push(performance.now() - contextBegan); });
        pi.on('tool_execution_start', e => executions.push({ name: e.toolName, id: e.toolCallId, args: e.args }));
        pi.on('session_before_compact', e => compactions.push({ reason: e.reason, afterNormalRequest: normal }));
      }] });
    await loader.reload();
    if (loader.getExtensions().errors.length) throw new Error(JSON.stringify(loader.getExtensions().errors));
    const manager = sdk.SessionManager.create(workspace, join(output, 'sessions'));
    ({ session } = await sdk.createAgentSession({ cwd: workspace, agentDir, resourceLoader: loader,
      modelRuntime: runtime, model: runtime.getModel('context-test', 'context-test-model'), thinkingLevel: 'off',
      sessionManager: manager, settingsManager: settings }));
    await session.bindExtensions({});
    session.subscribe(e => { if (e.type === 'message_end' && e.message.role === 'assistant' && e.message.stopReason === 'error') errors.push(e.message.errorMessage); });
    start = performance.now(); cpu = process.cpuUsage();
    await session.prompt('开始维护验证。', { images: promptImages });
    if (callbackError) throw callbackError;
    if (errors.length) throw new Error(errors.join('\n'));
    let disabledCheck, reenabledCheck;
    if (verifyDisabled) {
      await session.prompt('/traffic-opt 关');
      const recallActive = session.getActiveToolNames().includes('context_recall');
      await session.prompt('继续确认完整上下文。');
      const payload = requests.at(-1).payload;
      disabledCheck = { requestIndex: requests.length - 1, recallActive, bodyBytes: requests.at(-1).bytes,
        projectedHandlesInToolResults: payload.input.some(x => x.type === 'function_call_output' && /\[已归档/.test(JSON.stringify(x.output))),
        imageBase64Bytes: payload.input.reduce((n, x) => n + (JSON.stringify(x).match(/data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/g) ?? [])
          .reduce((v, s) => v + s.slice(s.indexOf(',') + 1).length, 0), 0) };
      await session.prompt('/traffic-opt 开');
      await session.prompt('恢复上下文优化。');
      reenabledCheck = { recallActive: session.getActiveToolNames().includes('context_recall'),
        projectedHandlesInToolResults: requests.at(-1).payload.input.some(x => x.type === 'function_call_output' && /\[已归档/.test(JSON.stringify(x.output))) };
    }
    await session.prompt('/traffic-opt 统计');
    const summary = JSON.parse(await readFile(join(report, 'summary.json'), 'utf8'));
    const canonical = manager.getBranch().filter(e => e.type === 'message').map(e => e.message);
    const file = manager.getSessionFile();
    const persisted = file ? await readFile(file, 'utf8') : '';
    const usage = process.cpuUsage(cpu);
    const result = { version, requests, executions, summary, canonical, persisted,
      durationMs: performance.now() - start, cpuMs: (usage.user + usage.system) / 1000,
      diskBytes: await diskSize(archive), compactions, errors, reportDirectory: report,
      sessionFile: file, disabledCheck, reenabledCheck, contextToProviderMs: latencies, projectionTimesMs: projections };
    await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    session.dispose(); session = undefined;
    result.diskBytesAfterShutdown = await diskSize(archive);
    result.archiveFilesAfterShutdown = await readdir(archive);
    return result;
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    server.closeAllConnections(); await new Promise(r => server.close(r));
    for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
