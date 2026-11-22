import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request } from 'node:http';
import { connect, createServer as createHttp2Server } from 'node:http2';
import { once } from 'node:events';
import { brotliCompressSync, deflateSync, gzipSync, zstdCompressSync } from 'node:zlib';
import { observeRequests } from '../src/transport.mjs';

const body = JSON.stringify({ model: 'test', messages: [{ role: 'user', content: '中文\n"正文"' }] });
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; };
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });

function observer(candidate) {
  const records = [];
  let active = true;
  const stop = observeRequests({
    getCandidate: () => active ? candidate : undefined,
    onRequest: request => { const record = { ...request, status: null }; records.push(record); return record; },
    onResponse: (record, status) => { record.status = status; },
  });
  return { records, stop, disable: () => { active = false; } };
}

test('fetch 支持字符串、URL、Request、二进制及 Blob，最终正文与服务端一致', async () => {
  const received = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(received.length === 1 ? 429 : 200); res.end('{}');
  });
  const baseUrl = await listen(server);
  const before = globalThis.fetch;
  const observation = observer({ api: 'openai-completions', id: 'test', baseUrl });
  try {
    const endpoint = `${baseUrl}/chat/completions?api-key=secret`;
    await fetch(endpoint, { method: 'POST', body });
    await fetch(new URL(endpoint), { method: 'POST', body: Buffer.from(body) });
    await fetch(new Request(endpoint, { method: 'POST', body }));
    await fetch(endpoint, { method: 'POST', body: new TextEncoder().encode(body).buffer });
    await fetch(endpoint, { method: 'POST', body: new Blob([body]) });
    await fetch(`${baseUrl}/other`, { method: 'POST', body });
    await fetch(endpoint);
    assert.deepEqual(observation.records.map(record => record.body), received.slice(0, 5));
    assert.deepEqual(observation.records.map(record => record.status), [429, 200, 200, 200, 200]);
    assert.ok(observation.records.every(record => record.transport === 'http-fetch'));
    assert.ok(observation.records.every(record => record.endpoint === `${baseUrl}/chat/completions`));
    observation.disable();
    await fetch(endpoint, { method: 'POST', body });
    assert.equal(observation.records.length, 5);
  } finally { observation.stop(); await close(server); }
  assert.equal(globalThis.fetch, before);
});

test('压缩请求分别记录线上大小和解压正文，未知编码或损坏正文仍照常发送', async () => {
  const received = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push(Buffer.concat(chunks)); res.end('{}');
  });
  const baseUrl = await listen(server);
  const observation = observer({ api: 'openai-completions', baseUrl });
  const encodings = [
    ['gzip', gzipSync(body)], ['deflate', deflateSync(body)], ['br', brotliCompressSync(body)], ['zstd', zstdCompressSync(body)],
    ['gzip, br', brotliCompressSync(gzipSync(body))],
  ];
  try {
    for (const [encoding, compressed] of encodings) {
      await fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers: { 'content-encoding': encoding }, body: compressed });
      const record = observation.records.at(-1);
      assert.equal(record.body, body);
      assert.equal(record.wireBytes, compressed.length);
      assert.deepEqual(received.at(-1), compressed);
    }
    for (const encoding of ['gzip', 'unknown', 'constructor']) await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST', headers: { 'content-encoding': encoding }, body: '损坏的压缩数据',
    });
    assert.equal(observation.records.length, encodings.length);
    assert.equal(received.length, encodings.length + 3);
  } finally { observation.stop(); await close(server); }
});

test('fetch 原参数、响应、同步异常和异步拒绝保持原行为，观测失败不重发请求', async () => {
  const before = globalThis.fetch;
  const failure = new Error('连接失败');
  const response = new Response('{}');
  let calls = 0;
  const input = new URL('https://example.test/chat/completions');
  const init = { method: 'POST', body };
  globalThis.fetch = function (actualInput, actualInit) {
    assert.equal(actualInput, input); assert.equal(actualInit, init);
    calls++;
    if (calls === 2) throw failure;
    if (calls === 3) return Promise.reject(failure);
    return Promise.resolve(response);
  };
  const original = globalThis.fetch;
  const stop = observeRequests({
    getCandidate: () => ({ api: 'openai-completions', baseUrl: 'https://example.test' }),
    onRequest: () => { throw new Error('报告失败'); }, onResponse: () => {},
  });
  try {
    assert.equal(await fetch(input, init), response);
    assert.throws(() => fetch(input, init), error => error === failure);
    await assert.rejects(fetch(input, init), error => error === failure);
    assert.equal(calls, 3);
    stop(); assert.equal(globalThis.fetch, original);
  } finally { stop(); globalThis.fetch = before; }
});

test('Bedrock HTTP/1 分块正文和响应状态从实际请求采集，关闭后停止观测', async () => {
  let received;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received = Buffer.concat(chunks).toString('utf8'); res.writeHead(201); res.end('{}');
  });
  const baseUrl = await listen(server);
  const observation = observer({ api: 'bedrock-converse-stream', id: 'test', baseUrl });
  const send = async () => {
    const req = request(`${baseUrl}/model/test/converse-stream`, { method: 'POST', headers: { 'content-type': 'application/json' } });
    const completed = new Promise((resolve, reject) => {
      req.on('error', reject); req.on('response', res => { res.resume(); res.on('end', resolve); });
    });
    const buffer = Buffer.from(body); const split = buffer.indexOf(Buffer.from('中文')) + 1;
    req.write(buffer.subarray(0, split)); req.end(buffer.subarray(split));
    await completed;
  };
  try {
    await send();
    assert.equal(received, body);
    assert.equal(observation.records.length, 1);
    assert.equal(observation.records[0].body, body);
    assert.equal(observation.records[0].transport, 'node-http');
    assert.equal(observation.records[0].status, 201);
    observation.stop(); await send();
    assert.equal(observation.records.length, 1);
  } finally { observation.stop(); await close(server); }
});

test('Bedrock HTTP/2 通过 diagnostics 采集合并及分块写入，UTF-8 字节无损', async () => {
  const received = [];
  const server = createHttp2Server();
  server.on('stream', async stream => {
    const chunks = []; for await (const chunk of stream) chunks.push(chunk);
    received.push(Buffer.concat(chunks).toString('utf8')); stream.respond({ ':status': 202 }); stream.end('{}');
  });
  const baseUrl = await listen(server);
  const client = connect(baseUrl);
  const observation = observer({ api: 'bedrock-converse-stream', id: 'test', baseUrl });
  try {
    for (const vector of [true, false]) {
      const stream = client.request({ ':method': 'POST', ':path': '/model/test/converse-stream', 'content-type': 'application/json' });
      stream.resume();
      const completed = once(stream, 'end');
      const buffer = Buffer.from(body); const split = buffer.indexOf(Buffer.from('中文')) + 1;
      if (vector) stream.cork();
      stream.write(buffer.subarray(0, split));
      if (!vector) await new Promise(resolve => setImmediate(resolve));
      stream.end(buffer.subarray(split));
      if (vector) stream.uncork();
      await completed;
    }
    assert.deepEqual(received, [body, body]);
    assert.deepEqual(observation.records.map(record => record.body), received);
    assert.ok(observation.records.every(record => record.transport === 'node-http2' && record.status === 202));
  } finally { observation.stop(); client.destroy(); await close(server); }
});

test('WebSocket 观测覆盖原型 send、复用连接、重载前已建连接、异常透传与还原', async () => {
  const beforeWS = globalThis.WebSocket;
  const sent = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url) {
      this.url = String(url);
      this.failNext = false;
    }
    send(data) {
      if (this.failNext) {
        this.failNext = false;
        throw new Error('socket closed');
      }
      sent.push({ url: this.url, data });
    }
  }
  globalThis.WebSocket = FakeWebSocket;
  const preExisting = new FakeWebSocket('wss://chatgpt.com/backend-api/codex/responses?token=secret');
  const originalProtoSend = FakeWebSocket.prototype.send;
  const wsBody1 = JSON.stringify({ type: 'response.create', model: 'gpt-5.4', input: [{ role: 'user', content: [{ type: 'input_text', text: '首轮' }] }] });
  const wsBody2 = JSON.stringify({ type: 'response.create', model: 'gpt-5.4', previous_response_id: 'resp_1', input: [{ role: 'user', content: [{ type: 'input_text', text: '续传' }] }] });
  let shouldThrowOnRequest = false;
  const records = [];
  let active = true;
  const stop = observeRequests({
    getCandidate: () => active ? { api: 'openai-codex-responses', id: 'gpt-5.4', baseUrl: 'https://chatgpt.com/backend-api' } : undefined,
    onRequest: (request) => {
      if (shouldThrowOnRequest) throw new Error('报告写入失败');
      records.push(request);
      return request;
    },
    onResponse: () => {},
  });
  try {
    assert.equal(globalThis.WebSocket.OPEN, 1);
    const socket = new globalThis.WebSocket('wss://chatgpt.com/backend-api/codex/responses?api-key=secret');
    assert.equal(socket instanceof FakeWebSocket, true);
    socket.send(wsBody1);
    socket.send(new TextEncoder().encode(wsBody2));
    // 复用重载前已存在的连接
    preExisting.send(new Blob([wsBody2]));
    await new Promise(resolve => setImmediate(resolve));
    // 无关地址不应被捕获
    const other = new globalThis.WebSocket('wss://other.test/ws');
    other.send(wsBody1);
    // send 抛同步异常时透传原异常且不误记账
    socket.failNext = true;
    assert.throws(() => socket.send(wsBody1), /socket closed/);
    // onRequest 内部抛错不影响 send 正常完成
    shouldThrowOnRequest = true;
    socket.send(wsBody1);
    shouldThrowOnRequest = false;

    assert.equal(sent.length, 5);
    assert.equal(records.length, 3);
    assert.deepEqual(records.map(r => r.body), [wsBody1, wsBody2, wsBody2]);
    assert.deepEqual(records.map(r => r.wireBytes), [Buffer.byteLength(wsBody1), Buffer.byteLength(wsBody2), Buffer.byteLength(wsBody2)]);
    assert.ok(records.every(r => r.transport === 'websocket'));
    assert.ok(records.every(r => r.endpoint === 'wss://chatgpt.com/backend-api/codex/responses'));

    // 停用后不再记录
    active = false;
    socket.send(wsBody1);
    assert.equal(records.length, 3);
  } finally {
    stop();
    assert.equal(globalThis.WebSocket, FakeWebSocket);
    assert.equal(FakeWebSocket.prototype.send, originalProtoSend);
    globalThis.WebSocket = beforeWS;
  }
});

test('WebSocket 实例自有 send 不重复记账，且支持虚拟模型多候选在 fetch 与 WebSocket 上精确反查', async () => {
  const beforeWS = globalThis.WebSocket;
  const server = createServer(async (req, res) => {
    for await (const _ of req) {}
    res.writeHead(200); res.end('{}');
  });
  const baseUrl = await listen(server);
  class OwnSendWS {
    constructor(url) {
      this.url = String(url);
      this.sent = [];
      this.send = (data) => { this.sent.push(data); };
    }
  }
  globalThis.WebSocket = OwnSendWS;
  const multiCandidate = {
    payloadModel: 'gpt-5.4',
    candidates: [
      { provider: 'custom.chat', id: 'deepseek-v4', api: 'openai-completions', baseUrl },
      { provider: 'custom.gemini', id: 'gemini-2.5-flash', api: 'google-generative-ai', baseUrl },
      { provider: 'custom.gemini', id: 'gemini-2.5-pro', api: 'google-generative-ai', baseUrl },
      { provider: 'openai-codex', id: 'gpt-5.4', api: 'openai-codex-responses', baseUrl },
    ],
  };
  const observation = observer(multiCandidate);
  try {
    await fetch(`${baseUrl}/chat/completions`, { method: 'POST', body });
    const googleBody = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }] });
    await fetch(`${baseUrl}/models/gemini-2.5-pro:streamGenerateContent?alt=sse`, { method: 'POST', body: googleBody });
    const wsUrl = baseUrl.replace(/^http:/, 'ws:') + '/codex/responses';
    const ws = new globalThis.WebSocket(wsUrl);
    const codexBody = JSON.stringify({ type: 'response.create', model: 'gpt-5.4', input: [{ role: 'user', content: 'hi' }] });
    ws.send(codexBody);

    assert.equal(ws.sent.length, 1);
    assert.equal(observation.records.length, 3);
    assert.equal(observation.records[0].candidate.provider, 'custom.chat');
    assert.equal(observation.records[0].candidate.model, 'deepseek-v4');
    assert.equal(observation.records[1].candidate.provider, 'custom.gemini');
    assert.equal(observation.records[1].candidate.model, 'gemini-2.5-pro');
    assert.equal(observation.records[2].candidate.provider, 'openai-codex');
    assert.equal(observation.records[2].candidate.model, 'gpt-5.4');
    assert.equal(observation.records[2].transport, 'websocket');
  } finally {
    observation.stop();
    globalThis.WebSocket = beforeWS;
    await close(server);
  }
});
