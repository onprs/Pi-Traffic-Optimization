import { channel } from 'node:diagnostics_channel';
import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from 'node:zlib';
const { resolveEndpointCandidate } = await import(new URL('./profile.mjs' + new URL(import.meta.url).search, import.meta.url).href);

const asBuffer = (chunk, encoding) => typeof chunk === 'string' ? Buffer.from(chunk, encoding) :
  ArrayBuffer.isView(chunk) ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength) :
  chunk instanceof ArrayBuffer ? Buffer.from(chunk) : undefined;
const decode = (chunk) => new TextDecoder('utf-8', { fatal: true }).decode(chunk);
const decompressors = new Map([['gzip', gunzipSync], ['deflate', inflateSync], ['br', brotliDecompressSync], ['zstd', zstdDecompressSync]]);

export function observeRequests({ getCandidate, onRequest, onResponse }) {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const originalWsSend = typeof originalWebSocket === 'function' && typeof originalWebSocket.prototype?.send === 'function'
    ? originalWebSocket.prototype.send
    : undefined;
  const wsUrls = new WeakMap();
  const subscriptions = [];
  let active = true;
  let observedWebSocket;
  let observedWsSend;
  const target = (url, method, options = {}) => {
    const candidate = active && getCandidate();
    if (!candidate) return;
    if (!options.allowWebSocket && method?.toUpperCase() !== 'POST') return;
    return resolveEndpointCandidate(candidate, url, options);
  };
  const observe = (candidate, url, headers, body, transport) => {
    if (!active || !getCandidate()) return;
    try {
      const wire = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
      let decoded = wire;
      const encodings = (headers.get('content-encoding') ?? '').toLowerCase().split(',').map(value => value.trim()).filter(value => value && value !== 'identity');
      for (const encoding of encodings.reverse()) {
        const decompress = decompressors.get(encoding);
        if (!decompress) return;
        decoded = decompress(decoded, { maxOutputLength: 256 * 1024 * 1024 });
      }
      const parsed = new URL(url);
      return onRequest({ candidate, endpoint: parsed.origin + parsed.pathname, headers,
        body: decode(decoded), wireBytes: wire.byteLength, transport });
    } catch { /* 观测失败保留原请求。 */ }
  };
  const response = (record, status) => {
    if (active && record) try { onResponse(record, status); } catch { /* 报告故障不影响响应。 */ }
  };
  const observedFetch = function (input, init) {
    const invoke = (record) => {
      const result = originalFetch.apply(this, arguments);
      if (record) void Promise.resolve(result).then(value => response(record, value.status), () => {});
      return result;
    };
    let record;
    let pendingBody;
    let readBody;
    try {
      const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      const candidate = target(url, init?.method ?? input?.method ?? 'GET');
      if (candidate) {
        const headers = new Headers(init?.headers ?? input?.headers);
        readBody = (body) => observe(candidate, url, headers, body, 'http-fetch');
        const body = init?.body;
        if (typeof body === 'string') record = readBody(body);
        else {
          const buffer = asBuffer(body);
          if (buffer) record = readBody(buffer);
          // Request 副本用于读取正文，原对象继续交给 provider 的 fetch。
          else if (body instanceof Blob) pendingBody = body.arrayBuffer();
          else if (body == null && input instanceof Request) pendingBody = input.clone().arrayBuffer();
        }
      }
    } catch { /* 保持 fetch 的原参数、异常与返回值。 */ }
    if (pendingBody) return pendingBody.then(body => invoke(readBody(Buffer.from(body))), () => invoke());
    return invoke(record);
  };
  globalThis.fetch = observedFetch;

  const sendWithObservation = (socket, originalSend, args, data) => {
    let matched;
    let url;
    let snapshot;
    let isBlob = false;
    if (active) {
      try {
        url = wsUrls.get(socket) ?? (typeof socket?.url === 'string' ? socket.url : '');
        if (url) {
          matched = target(url, undefined, { allowWebSocket: true });
          if (matched) {
            if (typeof data === 'string') snapshot = data;
            else {
              const buffer = asBuffer(data);
              if (buffer) snapshot = Buffer.from(buffer);
              else if (data instanceof Blob) isBlob = true;
            }
          }
        }
      } catch { /* 保持 WebSocket.send 的原参数与行为。 */ }
    }
    const result = originalSend.apply(socket, args);
    if (matched) {
      try {
        if (snapshot !== undefined) observe(matched, url, new Headers(), snapshot, 'websocket');
        else if (isBlob) void data.arrayBuffer().then(body => observe(matched, url, new Headers(), Buffer.from(body), 'websocket'), () => {});
      } catch { /* 观测失败不影响已发送帧。 */ }
    }
    return result;
  };

  if (typeof originalWebSocket === 'function') {
    if (originalWsSend) {
      observedWsSend = function (data) {
        return sendWithObservation(this, originalWsSend, arguments, data);
      };
      try { originalWebSocket.prototype.send = observedWsSend; } catch { observedWsSend = undefined; }
    }
    try {
      observedWebSocket = new Proxy(originalWebSocket, {
        construct(ctor, args, newTarget) {
          const instance = Reflect.construct(ctor, args, newTarget === observedWebSocket ? ctor : newTarget);
          try {
            if (args[0] != null) wsUrls.set(instance, String(args[0]));
            if ((Object.prototype.hasOwnProperty.call(instance, 'send') || !observedWsSend) && typeof instance.send === 'function') {
              const ownSend = instance.send;
              instance.send = function (data) {
                return sendWithObservation(this, ownSend, arguments, data);
              };
            }
          } catch { /* 保持 WebSocket 构造原行为。 */ }
          return instance;
        },
      });
      globalThis.WebSocket = observedWebSocket;
    } catch { observedWebSocket = undefined; }
  }

  const subscribe = (name, handler) => {
    const source = channel(name);
    const listener = (event) => { if (active) try { handler(event); } catch { /* diagnostics 回调不得抛错。 */ } };
    source.subscribe(listener);
    subscriptions.push(() => source.unsubscribe(listener));
  };
  const streams = new WeakMap();
  subscribe('http2.client.stream.created', ({ stream, headers }) => {
    const url = `${headers[':scheme']}://${headers[':authority']}${headers[':path']}`;
    const candidate = target(url, headers[':method'], { native: true });
    if (!candidate) return;
    const regularHeaders = Object.entries(headers).filter(([key]) => !key.startsWith(':'));
    const state = { candidate, url, headers: new Headers(regularHeaders), chunks: [], record: undefined, status: undefined };
    streams.set(stream, state);
    stream.once('response', headers => {
      state.status = headers[':status']; response(state.record, state.status);
    });
    stream.once('close', () => streams.delete(stream));
  });
  subscribe('http2.client.stream.bodyChunkSent', ({ stream, writev, data, encoding }) => {
    const state = streams.get(stream);
    if (!state) return;
    const chunks = writev ? data.allBuffers ? data : data.map(item => asBuffer(item.chunk, item.encoding)) : [asBuffer(data, encoding)];
    for (const chunk of chunks) state.chunks.push(Buffer.from(chunk));
  });
  subscribe('http2.client.stream.bodySent', ({ stream }) => {
    const state = streams.get(stream);
    if (!state) return;
    const body = Buffer.concat(state.chunks); state.chunks.length = 0;
    state.record = observe(state.candidate, state.url, state.headers, body, 'node-http2');
    if (state.status !== undefined) response(state.record, state.status);
  });

  // Bedrock 的代理或 HTTP/1 配置使用 ClientRequest；只包装已匹配的实例。
  subscribe('http.client.request.created', ({ request }) => {
    const url = new URL(request.path, `${request.protocol}//${request.getHeader('host')}`).href;
    const candidate = target(url, request.method, { native: true });
    if (!candidate) return;
    const chunks = [];
    let valid = true;
    const capture = (chunk, encoding) => {
      try { if (chunk != null) chunks.push(Buffer.from(asBuffer(chunk, typeof encoding === 'string' ? encoding : undefined))); }
      catch { valid = false; chunks.length = 0; }
    };
    const originalWrite = request.write;
    const originalEnd = request.end;
    request.write = function (chunk, encoding, callback) {
      capture(chunk, encoding);
      return originalWrite.apply(this, arguments);
    };
    request.end = function (chunk, encoding, callback) {
      if (typeof chunk !== 'function') capture(chunk, encoding);
      return originalEnd.apply(this, arguments);
    };
    let record;
    request.once('finish', () => {
      request.write = originalWrite; request.end = originalEnd;
      if (valid) try {
        const headers = new Headers(Object.entries(request.getHeaders()).map(([key, value]) => [key, String(value)]));
        record = observe(candidate, url, headers, Buffer.concat(chunks), 'node-http');
      } catch { /* 请求已经发送，观测失败不影响传输。 */ }
      chunks.length = 0;
    });
    request.once('response', value => response(record, value.statusCode));
  });
  return () => {
    active = false;
    for (const unsubscribe of subscriptions) unsubscribe();
    if (globalThis.fetch === observedFetch) globalThis.fetch = originalFetch;
    if (observedWsSend && originalWebSocket?.prototype?.send === observedWsSend) {
      originalWebSocket.prototype.send = originalWsSend;
    }
    if (observedWebSocket && globalThis.WebSocket === observedWebSocket) {
      globalThis.WebSocket = originalWebSocket;
    }
  };
}
