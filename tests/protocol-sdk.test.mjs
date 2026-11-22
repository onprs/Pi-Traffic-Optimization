import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createServer as createHttp2Server } from 'node:http2';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { zstdDecompressSync } from 'node:zlib';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { installedPi, fixtures } from './sdk-runner.mjs';
import register from '../src/index.ts';

const apis = ['openai-responses', 'azure-openai-responses', 'openai-codex-responses', 'openai-completions',
  'mistral-conversations', 'anthropic-messages', 'google-generative-ai', 'google-vertex', 'pi-messages', 'bedrock-converse-stream'];
const usage = { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function sendReply(res, api) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
  const event = (type, rest) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...rest })}\n\n`);
  if (api.includes('responses')) {
    const item = { type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '完成。', annotations: [] }] };
    const response = { id: 'resp_test', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } };
    event('response.created', { response: { ...response, status: 'in_progress', output: [] } });
    event('response.output_item.added', { output_index: 0, item: { ...item, content: [] } });
    event('response.output_text.delta', { output_index: 0, content_index: 0, item_id: item.id, delta: '完成。' });
    event('response.output_item.done', { output_index: 0, item });
    event('response.completed', { response });
  } else if (api === 'anthropic-messages') {
    event('message_start', { message: { id: 'msg_test', type: 'message', role: 'assistant', content: [], model: 'test-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
    event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '完成。' } });
    event('content_block_stop', { index: 0 });
    event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } });
    event('message_stop', {});
  } else if (api.startsWith('google-')) {
    send({ candidates: [{ content: { role: 'model', parts: [{ text: '完成。' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1, totalTokenCount: 11 } });
  } else if (api === 'pi-messages') {
    send({ type: 'start' }); send({ type: 'text_start', contentIndex: 0 });
    send({ type: 'text_delta', contentIndex: 0, delta: '完成。' });
    send({ type: 'text_end', contentIndex: 0, content: '完成。' });
    send({ type: 'done', reason: 'stop', usage });
  } else {
    send({ id: 'chat_test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '完成。' }, finish_reason: null }] });
    send({ id: 'chat_test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } });
    res.write('data: [DONE]\n\n');
  }
  res.end();
}

async function runProtocol({ sdk, root, api, directory, workspace, fixture }) {
  await mkdir(directory, { recursive: true });
  const keys = ['PI_TRAFFIC_OPT_CONFIG_PATH', 'PI_TRAFFIC_OPT_ARCHIVE_DIR', 'PI_TRAFFIC_OPT_CACHE_DIR', 'PI_TRAFFIC_OPT_REPORT_DIR'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    PI_TRAFFIC_OPT_CONFIG_PATH: join(directory, 'config.json'), PI_TRAFFIC_OPT_ARCHIVE_DIR: join(directory, 'archive'),
    PI_TRAFFIC_OPT_CACHE_DIR: join(directory, 'cache'), PI_TRAFFIC_OPT_REPORT_DIR: join(directory, 'report'),
  });
  await writeFile(process.env.PI_TRAFFIC_OPT_CONFIG_PATH, JSON.stringify({ enabled: true, logging: 'off', skipBelowKB: 0,
    contextOptimization: { keepRecentTurns: 1, keepRecentTokens: 0 } }));
  const requests = [];
  const connections = new Set();
  let callbackError;
  const native = api === 'bedrock-converse-stream';
  const server = native ? createHttp2Server() : createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const json = req.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(body) : body;
      requests.push({ body, json, payload: JSON.parse(json), path: req.url });
      sendReply(res, api);
    } catch (error) { callbackError = error; res.writeHead(500); res.end('{}'); }
  });
  if (native) {
    const requireFromPi = createRequire(join(root, 'package.json'));
    const { EventStreamCodec } = requireFromPi('@smithy/core/event-streams');
    const codec = new EventStreamCodec(value => Buffer.from(value).toString('utf8'), value => Buffer.from(value));
    server.on('session', connection => { connections.add(connection); connection.once('close', () => connections.delete(connection)); });
    server.on('stream', async (stream, headers) => {
      try {
        const chunks = []; for await (const chunk of stream) chunks.push(chunk);
        const body = Buffer.concat(chunks); requests.push({ body, json: body, payload: JSON.parse(body), path: headers[':path'] });
        stream.respond({ ':status': 200, 'content-type': 'application/vnd.amazon.eventstream' });
        const send = (type, body) => stream.write(codec.encode({ headers: {
          ':message-type': { type: 'string', value: 'event' }, ':event-type': { type: 'string', value: type },
          ':content-type': { type: 'string', value: 'application/json' },
        }, body: Buffer.from(JSON.stringify(body)) }));
        send('messageStart', { role: 'assistant' });
        send('contentBlockDelta', { contentBlockIndex: 0, delta: { text: '完成。' } });
        send('contentBlockStop', { contentBlockIndex: 0 });
        send('messageStop', { stopReason: 'end_turn' });
        send('metadata', { usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 }, metrics: { latencyMs: 1 } });
        stream.end();
      } catch (error) { callbackError = error; stream.close(); }
    });
  }
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const errors = [];
  let session;
  let manager;
  try {
    const agentDir = join(directory, 'agent'); await mkdir(agentDir, { recursive: true });
    const runtime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null,
      modelsStorePath: join(agentDir, 'models-store.json'), refreshOnCreate: false, allowModelNetwork: false });
    const account = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'local-test' } })).toString('base64url');
    runtime.registerProvider('protocol-test', { api, baseUrl, apiKey: api === 'openai-codex-responses' ? `test.${account}.test` : 'local-test-only',
      models: [{ api, id: 'test-model', name: '协议测试模型', reasoning: false, input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 1024 }] });
    const model = runtime.getModel('protocol-test', 'test-model');
    const settings = sdk.SettingsManager.inMemory({ defaultTools: ['read', 'context_recall'], transport: 'sse',
      compaction: { enabled: false }, retry: { enabled: false }, images: { autoResize: false }, cacheWarming: 'off' });
    const loader = new sdk.DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: '核对协议请求。', extensionFactories: [register] });
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    manager = sdk.SessionManager.create(workspace, join(directory, 'sessions'));
    const timestamp = Date.now();
    manager.appendMessage({ role: 'user', content: '读取文件。', timestamp });
    manager.appendMessage({ role: 'assistant', api, provider: model.provider, model: model.id,
      content: [{ type: 'toolCall', id: 'call_read', name: 'read', arguments: { path: join(workspace, 'source.ts') } }],
      usage, stopReason: 'toolUse', timestamp });
    manager.appendMessage({ role: 'toolResult', toolCallId: 'call_read', toolName: 'read',
      content: [{ type: 'text', text: fixture.text }], isError: false, timestamp });
    for (let i = 0; i < 3; i++) {
      manager.appendMessage({ role: 'user', content: `继续核对 ${i}。`, timestamp });
      manager.appendMessage({ role: 'assistant', api, provider: model.provider, model: model.id,
        content: [{ type: 'text', text: '继续。' }], usage, stopReason: 'stop', timestamp });
    }
    manager.appendMessage({ role: 'assistant', api, provider: model.provider, model: model.id,
      content: [{ type: 'toolCall', id: 'call_image', name: 'read', arguments: { path: join(workspace, 'image.png') } }],
      usage, stopReason: 'toolUse', timestamp });
    manager.appendMessage({ role: 'toolResult', toolCallId: 'call_image', toolName: 'read',
      content: [{ type: 'text', text: '图片内容。' }, { type: 'image', data: fixture.png.toString('base64'), mimeType: 'image/png' }],
      isError: false, timestamp });
    ({ session } = await sdk.createAgentSession({ cwd: workspace, agentDir, resourceLoader: loader, modelRuntime: runtime,
      model, thinkingLevel: 'off', sessionManager: manager, settingsManager: settings }));
    await session.bindExtensions({});
    session.subscribe(event => {
      if (event.type === 'message_end' && event.message.role === 'assistant' && event.message.stopReason === 'error') errors.push(event.message.errorMessage);
    });
    await session.prompt('核对图片并完成。', { images: [{ type: 'image', data: fixture.png.toString('base64'), mimeType: 'image/png' }] });
    if (callbackError) throw callbackError;
    assert.deepEqual(errors, [], `${api} provider 响应应被正常解析`);
    assert.equal(requests.length, 1, `${api} 应只发送一次请求`);
    await session.prompt('/traffic-opt 统计');
    const summary = JSON.parse(await readFile(join(directory, 'report/summary.json'), 'utf8'));
    assert.equal(summary.request_count, 1, `${api} 应记录实际请求`);
    assert.equal(summary.total_upload_bytes, requests[0].body.length);
    const record = summary.requests[0];
    assert.equal(record.api, api);
    assert.equal(record.transport, native ? 'node-http2' : 'http-fetch');
    assert.equal(record.response_status, 200);
    assert.equal(record.context_tokens, 10);
    assert.ok(record.tool_bytes_projected > 0, `${api} 旧工具结果应投影`);
    assert.equal(record.image_count, 2, `${api} 应识别用户图片和工具图片`);
    assert.ok(record.image_decoded_bytes < fixture.png.length * 2, `${api} 图片应压缩`);
    assert.deepEqual(new Set(summary.image_details.map(image => image.source_type)), new Set(['user image', 'toolResult/read image']));
    if (api === 'openai-codex-responses') {
      assert.equal(record.content_encoding, 'zstd');
      assert.ok(record.total_payload_bytes < record.json_payload_bytes);
    }
    for (const key of ['system_bytes', 'user_text_bytes', 'tool_call_bytes', 'tool_result_bytes', 'tool_schema_bytes']) {
      assert.ok(record[key] > 0, `${api} 缺少 ${key}`);
    }
    assert.equal(record.json_payload_bytes, requests[0].json.length);
    assert.equal(record.json_payload_bytes, ['system_bytes', 'user_text_bytes', 'assistant_text_bytes', 'tool_call_bytes',
      'tool_result_bytes', 'image_payload_bytes', 'tool_schema_bytes', 'other_bytes'].reduce((sum, key) => sum + record[key], 0));
    assert.ok(requests[0].json.includes(Buffer.from('ctx://tool/')), `${api} 应发送归档 handle`);
    assert.ok(manager.getBranch().some(entry => entry.message?.role === 'toolResult' && entry.message.content[0]?.text === fixture.text));
    assert.equal(record.endpoint.includes('?'), false);
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    for (const connection of connections) connection.destroy();
    server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test('Pi SDK：全部内置协议的优化、序列化、最终传输与报告相符', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-protocol-sdk-'));
  try {
    const pi = await installedPi();
    const workspace = join(directory, 'workspace'); const fixture = await fixtures(workspace);
    for (const api of apis) await t.test(api, { timeout: 10000 }, () => runProtocol({ ...pi, api, workspace, fixture, directory: join(directory, api) }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Pi SDK：antigravity-acp 自定义 streamSimple provider 的投影契约、图片压缩与直接载荷报告相符', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-antigravity-sdk-'));
  const keys = ['PI_TRAFFIC_OPT_CONFIG_PATH', 'PI_TRAFFIC_OPT_ARCHIVE_DIR', 'PI_TRAFFIC_OPT_CACHE_DIR', 'PI_TRAFFIC_OPT_REPORT_DIR'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  let session;
  try {
    const { sdk, root } = await installedPi();
    const piAi = await import(import.meta.resolve('@earendil-works/pi-ai', pathToFileURL(join(root, 'package.json')).href));
    const workspace = join(directory, 'workspace'); const fixture = await fixtures(workspace);
    Object.assign(process.env, {
      PI_TRAFFIC_OPT_CONFIG_PATH: join(directory, 'config.json'),
      PI_TRAFFIC_OPT_ARCHIVE_DIR: join(directory, 'archive'),
      PI_TRAFFIC_OPT_CACHE_DIR: join(directory, 'cache'),
      PI_TRAFFIC_OPT_REPORT_DIR: join(directory, 'report'),
    });
    await writeFile(process.env.PI_TRAFFIC_OPT_CONFIG_PATH, JSON.stringify({
      enabled: true, logging: 'off', skipBelowKB: 0,
      contextOptimization: { keepRecentTurns: 1, keepRecentTokens: 0 },
    }));

    const observedPayloads = [];
    const agentDir = join(directory, 'agent'); await mkdir(agentDir, { recursive: true });
    const runtime = await sdk.ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'), modelsPath: null,
      modelsStorePath: join(agentDir, 'models-store.json'), refreshOnCreate: false, allowModelNetwork: false,
    });
    const api = 'antigravity-acp';
    runtime.registerProvider('antigravity', {
      api, baseUrl: 'acp://antigravity-cli', apiKey: 'agy-managed',
      models: [{
        api, id: 'gemini-4-neon', name: 'Gemini 4 Neon', reasoning: true, input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 8192,
      }],
      // 模拟 pi-antigravity-bridge 的 streamSimple：把可见消息转成 ACP session/prompt 并触发 onPayload/onResponse。
      streamSimple: (model, context, options) => {
        const stream = piAi.createAssistantMessageEventStream();
        queueMicrotask(async () => {
          try {
            const prompt = [{ type: 'text', text: '<workspace_context>\n<cwd>/workspace</cwd>\n</workspace_context>' }];
            for (const msg of context.messages) {
              if (msg.role === 'toolResult') {
                const text = (msg.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
                prompt.push({ type: 'text', text: `<tool_result id="${msg.toolCallId}" tool="${msg.toolName}" status="ok">\n${text}\n</tool_result>` });
                for (const b of msg.content ?? []) if (b.type === 'image') prompt.push({ type: 'image', data: b.data, mimeType: b.mimeType });
              } else if (msg.role === 'user') {
                if (typeof msg.content === 'string') prompt.push({ type: 'text', text: msg.content });
                else for (const b of msg.content ?? []) {
                  if (b.type === 'text') prompt.push({ type: 'text', text: b.text });
                  else if (b.type === 'image') prompt.push({ type: 'image', data: b.data, mimeType: b.mimeType });
                }
              } else if (msg.role === 'assistant') {
                const text = (msg.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
                if (text) prompt.push({ type: 'text', text: `<assistant model="${msg.model}">\n${text}\n</assistant>` });
              }
            }
            const outbound = { sessionId: 'agy-sdk-1', prompt };
            const finalPayload = (await options?.onPayload?.(outbound, model)) ?? outbound;
            observedPayloads.push(finalPayload);
            await options?.onResponse?.({ status: 200, headers: { 'x-acp-session-id': 'agy-sdk-1' } }, model);
            const message = {
              role: 'assistant', api, provider: model.provider, model: model.id,
              content: [{ type: 'text', text: '完成。' }],
              usage: { ...usage, input: 10, cacheRead: 20, totalTokens: 31 },
              stopReason: 'stop', timestamp: Date.now(),
            };
            stream.push({ type: 'start', partial: message });
            stream.push({ type: 'done', reason: 'stop', message });
            stream.end(message);
          } catch (error) {
            stream.push({ type: 'error', reason: 'error', error: { role: 'assistant', api, provider: model.provider, model: model.id, content: [], usage, stopReason: 'error', errorMessage: String(error), timestamp: Date.now() } });
            stream.end();
          }
        });
        return stream;
      },
    });

    const model = runtime.getModel('antigravity', 'gemini-4-neon');
    const settings = sdk.SettingsManager.inMemory({
      defaultTools: ['read', 'context_recall'], transport: 'sse',
      compaction: { enabled: false }, retry: { enabled: false }, images: { autoResize: false }, cacheWarming: 'off',
    });
    const loader = new sdk.DefaultResourceLoader({
      cwd: workspace, agentDir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: '核对 ACP 协议请求。', extensionFactories: [register],
    });
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    const manager = sdk.SessionManager.create(workspace, join(directory, 'sessions'));
    const timestamp = Date.now();
    manager.appendMessage({ role: 'user', content: '读取文件。', timestamp });
    manager.appendMessage({
      role: 'assistant', api, provider: model.provider, model: model.id,
      content: [{ type: 'toolCall', id: 'agy_mcp_read_1', name: 'read', arguments: { path: join(workspace, 'source.ts') } }],
      usage, stopReason: 'toolUse', timestamp,
    });
    manager.appendMessage({
      role: 'toolResult', toolCallId: 'agy_mcp_read_1', toolName: 'read',
      content: [{ type: 'text', text: fixture.text }], isError: false, timestamp,
    });
    for (let i = 0; i < 3; i++) {
      manager.appendMessage({ role: 'user', content: `继续核对 ${i}。`, timestamp });
      manager.appendMessage({
        role: 'assistant', api, provider: model.provider, model: model.id,
        content: [{ type: 'text', text: '继续。' }], usage, stopReason: 'stop', timestamp,
      });
    }
    manager.appendMessage({
      role: 'assistant', api, provider: model.provider, model: model.id,
      content: [{ type: 'toolCall', id: 'agy_mcp_read_img', name: 'read', arguments: { path: join(workspace, 'image.png') } }],
      usage, stopReason: 'toolUse', timestamp,
    });
    manager.appendMessage({
      role: 'toolResult', toolCallId: 'agy_mcp_read_img', toolName: 'read',
      content: [{ type: 'text', text: '图片内容。' }, { type: 'image', data: fixture.png.toString('base64'), mimeType: 'image/png' }],
      isError: false, timestamp,
    });

    ({ session } = await sdk.createAgentSession({
      cwd: workspace, agentDir, resourceLoader: loader, modelRuntime: runtime,
      model, thinkingLevel: 'off', sessionManager: manager, settingsManager: settings,
    }));
    await session.bindExtensions({});
    const errors = [];
    session.subscribe(event => {
      if (event.type === 'message_end' && event.message.role === 'assistant' && event.message.stopReason === 'error') errors.push(event.message.errorMessage);
    });
    await session.prompt('核对 ACP 图片并完成。', { images: [{ type: 'image', data: fixture.png.toString('base64'), mimeType: 'image/png' }] });
    assert.deepEqual(errors, []);
    assert.equal(observedPayloads.length, 1);

    // 验证投影占位符严格满足 pi-antigravity-bridge 的正则契约
    const toolResultBlock = observedPayloads[0].prompt.find(b => b.type === 'text' && b.text.includes('id="agy_mcp_read_1"'));
    assert.ok(toolResultBlock);
    assert.match(toolResultBlock.text, /\n\[已归档 ctx:\/\/tool\/[a-f0-9]{16,64}\]/);

    await session.prompt('/traffic-opt 统计');
    const summary = JSON.parse(await readFile(join(directory, 'report/summary.json'), 'utf8'));
    assert.equal(summary.request_count, 1);
    const serialized = Buffer.from(JSON.stringify(observedPayloads[0]), 'utf8');
    assert.equal(summary.total_upload_bytes, serialized.length);
    const record = summary.requests[0];
    assert.equal(record.api, api);
    assert.equal(record.transport, 'acp-stdio');
    assert.equal(record.endpoint, 'acp://antigravity-cli');
    assert.equal(record.response_status, 200);
    assert.equal(record.context_tokens, 30);
    assert.ok(record.tool_bytes_projected > 0);
    assert.equal(record.image_count, 2);
    assert.ok(record.image_decoded_bytes < fixture.png.length * 2);
    assert.deepEqual(new Set(summary.image_details.map(image => image.source_type)), new Set(['user image', 'toolResult/read image']));
    assert.equal(record.json_payload_bytes, serialized.length);
    assert.equal(record.json_payload_bytes, ['system_bytes', 'user_text_bytes', 'assistant_text_bytes', 'tool_call_bytes',
      'tool_result_bytes', 'image_payload_bytes', 'tool_schema_bytes', 'other_bytes'].reduce((sum, key) => sum + record[key], 0));
    assert.ok(manager.getBranch().some(entry => entry.message?.role === 'toolResult' && entry.message.content[0]?.text === fixture.text));
  } finally {
    if (session) { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' }); session.dispose(); }
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
