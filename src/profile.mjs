import { createHash } from 'node:crypto';

const bytes = (value) => Buffer.byteLength(value, 'utf8');
const encodedStringBytes = (value) => bytes(JSON.stringify(value)) - 2;
const dataUrl = /^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/s;
const families = new Map([
  ['openai-responses', 'responses'], ['azure-openai-responses', 'responses'], ['openai-codex-responses', 'responses'],
  ['openai-completions', 'chat'], ['mistral-conversations', 'chat'], ['anthropic-messages', 'anthropic'],
  ['google-generative-ai', 'google'], ['google-vertex', 'google'], ['bedrock-converse-stream', 'bedrock'],
  ['pi-messages', 'pi'], ['antigravity-acp', 'acp'],
]);

// 使用非 HTTP 传输并通过 before_provider_request 直接交付出站载荷的协议。
export const isDirectPayloadApi = (api) => families.get(api) === 'acp';
export const VIRTUAL_MODEL_API = 'pi-virtual';
export const isVirtualModelApi = (api) => api === VIRTUAL_MODEL_API;

export function isProviderPayload(api, payload) {
  if (!payload || typeof payload !== 'object') return false;
  switch (families.get(api)) {
    case 'responses': return typeof payload.input === 'string' || Array.isArray(payload.input);
    case 'google': return Array.isArray(payload.contents);
    case 'pi': return Array.isArray(payload.context?.messages);
    case 'acp': return (typeof payload.sessionId === 'string' && Array.isArray(payload.prompt)) || Array.isArray(payload.toolResults);
    case 'chat': case 'anthropic': case 'bedrock': return Array.isArray(payload.messages);
    default: return false;
  }
}

const protocolSchemeFamily = (protocol) => (protocol === 'https:' || protocol === 'wss:') ? 'tls'
  : (protocol === 'http:' || protocol === 'ws:') ? 'plain' : protocol;

// 只匹配当前模型所属的推理入口；查询参数、凭据和其他无关请求不进入报告。
export function matchesProviderEndpoint(model, input, options = {}) {
  if (!model || !families.has(model.api) || isDirectPayloadApi(model.api)) return false;
  let url;
  try { url = new URL(input); } catch { return false; }
  const allowWebSocket = Boolean(options?.allowWebSocket);
  const allowedProtocols = allowWebSocket ? ['http:', 'https:', 'ws:', 'wss:'] : ['http:', 'https:'];
  if (!allowedProtocols.includes(url.protocol)) return false;
  let base;
  try { base = new URL(model.baseUrl); } catch { /* Vertex 的默认地址可能包含 {location}。 */ }
  const path = url.pathname.replace(/\/+$/, '');
  const root = base?.pathname.replace(/\/+$/, '') ?? '';
  const sameOrigin = allowWebSocket
    ? Boolean(base && base.host === url.host && protocolSchemeFamily(base.protocol) === protocolSchemeFamily(url.protocol))
    : base?.origin === url.origin;
  const googleDefault = model.api === 'google-vertex' && (!base || base.hostname.includes('{location}')) &&
    /^(?:[a-z0-9-]+-)?aiplatform\.googleapis\.com$/.test(url.hostname);
  const bedrockDefault = model.api === 'bedrock-converse-stream' && base &&
    /^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/.test(base.hostname) &&
    /^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?$/.test(url.hostname);
  if (!sameOrigin && !googleDefault && !bedrockDefault) return false;
  switch (model.api) {
    case 'openai-responses': return path === `${root}/responses`;
    case 'azure-openai-responses': {
      const azureHost = /\.(?:openai\.azure|cognitiveservices\.azure|ai\.azure)\.com$/.test(base.hostname);
      const normalized = azureHost && ['', '/openai', '/openai/v1/responses'].includes(root) ? '/openai/v1' : root;
      return path === `${normalized}/responses`;
    }
    case 'openai-codex-responses': {
      const endpoint = /\/codex\/responses$/.test(root) ? root : /\/codex$/.test(root) ? `${root}/responses` : `${root}/codex/responses`;
      return path === endpoint;
    }
    case 'openai-completions': return path === `${root}/chat/completions`;
    case 'mistral-conversations': return path === `${root}/v1/chat/completions`;
    case 'anthropic-messages': return path === `${root}/v1/messages` || (root.endsWith('/v1') && path === `${root}/messages`);
    case 'pi-messages': return path === `${root}/messages`;
    case 'google-generative-ai': case 'google-vertex':
      return (googleDefault || path.startsWith(`${root}/`)) && /\/models\/[^/]+:(?:streamGenerateContent|generateContent)$/.test(path);
    case 'bedrock-converse-stream':
      return path === `${root}/model/${encodeURIComponent(model.id)}/converse-stream`;
    default: return false;
  }
}

// 在虚拟模型路由场景下，根据出站载荷结构与已注册物理模型集合推断候选目标模型。
export function inferCandidateModels(payload, knownModels = []) {
  if (!payload || typeof payload !== 'object') return [];
  const models = Array.isArray(knownModels)
    ? knownModels.filter((item) => item && typeof item === 'object' && typeof item.api === 'string' && !isVirtualModelApi(item.api))
    : [];
  const requested = typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : '';
  if (isProviderPayload('antigravity-acp', payload)) {
    const direct = models.filter((item) => isDirectPayloadApi(item.api));
    if (requested) {
      const exact = direct.filter((item) => item.id === requested || `${item.provider}/${item.id}` === requested);
      if (exact.length > 0) return exact;
    }
    if (direct.length > 0) return direct;
    return [{
      provider: 'antigravity',
      id: requested || 'unknown',
      api: 'antigravity-acp',
      baseUrl: 'acp://antigravity-cli',
    }];
  }
  const matched = models.filter((item) => families.has(item.api) && !isDirectPayloadApi(item.api) && isProviderPayload(item.api, payload));
  if (matched.length === 0) return [];
  if (requested) {
    const exact = matched.filter((item) => item.id === requested || `${item.provider}/${item.id}` === requested);
    if (exact.length > 0) return exact;
    const suffix = matched.filter((item) => item.id.endsWith(`/${requested}`) || requested.endsWith(`/${item.id}`));
    if (suffix.length > 0) return suffix;
  }
  return matched;
}

// 根据实际出站 URL 匹配单个模型或从虚拟模型候选中反查精确物理模型。
export function resolveEndpointCandidate(candidate, input, options = {}) {
  if (!candidate) return undefined;
  const native = Boolean(options?.native);
  if (!Array.isArray(candidate.candidates)) {
    if (native && candidate.api !== 'bedrock-converse-stream') return undefined;
    return matchesProviderEndpoint(candidate, input, options) ? candidate : undefined;
  }
  const hits = candidate.candidates.filter((item) =>
    (!native || item.api === 'bedrock-converse-stream') && matchesProviderEndpoint(item, input, options));
  if (hits.length === 0) return undefined;
  let selected = hits[0];
  if (hits.length > 1) {
    let urlModel = '';
    try {
      const pathname = new URL(input).pathname;
      const googleMatch = /\/models\/([^/]+):(?:streamGenerateContent|generateContent)$/.exec(pathname);
      if (googleMatch) urlModel = decodeURIComponent(googleMatch[1]);
    } catch { /* 忽略无法解析的 URL。 */ }
    const requested = urlModel || (typeof candidate.payloadModel === 'string' ? candidate.payloadModel : '');
    if (requested) {
      selected = hits.find((item) => item.id === requested || `${item.provider}/${item.id}` === requested)
        ?? hits.find((item) => item.id.endsWith(`/${requested}`) || requested.endsWith(`/${item.id}`))
        ?? hits[0];
    }
  }
  return {
    ...candidate,
    provider: selected.provider,
    model: selected.id,
    id: selected.id,
    api: selected.api,
    baseUrl: selected.baseUrl,
    inferredModel: true,
  };
}

export function sourcesFromContext(messages) {
  const sources = [];
  const calls = new Map();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const block of message.content ?? []) {
        if (block.type === 'toolCall') {
          calls.set(block.id, block.name);
          calls.set(block.id.split('|')[0], block.name);
        }
      }
    }
  }
  for (const message of messages) {
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (block.type !== 'image' || typeof block.data !== 'string') continue;
      const source = message.role === 'toolResult'
        ? (message.toolName === 'read' || message.toolName === 'agy_read') ? 'toolResult/read image' : 'toolResult/other'
        : message.role === 'user' ? 'user image' : 'unknown';
      sources.push({ data: block.data, source, mime: block.mimeType });
    }
  }
  return { sources, calls };
}

export function analyzePayload(api, payload, context = {}, seen = new Set(), hashCache = new Map(), rawJson) {
  const serialized = rawJson ?? JSON.stringify(payload);
  if (typeof serialized !== 'string') throw new Error('请求体无法序列化为 JSON');
  const total = bytes(serialized);
  const parts = {
    system_bytes: 0, user_text_bytes: 0, assistant_text_bytes: 0,
    tool_call_bytes: 0, tool_result_bytes: 0, image_payload_bytes: 0,
    tool_schema_bytes: 0, other_bytes: 0,
  };
  const images = [];
  const results = [];
  const calls = new Map(context.calls ?? []);
  let rawTextBytes = 0;
  let opaqueReasoningBytes = 0;
  let decodedTotal = 0;
  const sourceImages = new Map();
  for (const source of context.sources ?? []) {
    const list = sourceImages.get(source.data) ?? [];
    list.push(source); sourceImages.set(source.data, list);
  }
  const addText = (key, value) => {
    if (typeof value !== 'string') return;
    parts[key] += encodedStringBytes(value);
    rawTextBytes += bytes(value);
  };
  const addJson = (key, value) => {
    if (value !== undefined) parts[key] += bytes(JSON.stringify(value));
  };
  const addOpaque = (value) => {
    if (typeof value === 'string') opaqueReasoningBytes += encodedStringBytes(value);
  };
  const isReadToolName = (name) => name === 'read' || name === 'agy_read';
  const takeImageSource = (b64, preferredSource) => {
    const list = sourceImages.get(b64);
    if (preferredSource) {
      if (list?.length) {
        const index = list.findIndex((item) => item.source === preferredSource);
        if (index >= 0) return list.splice(index, 1)[0];
      }
      return { source: preferredSource };
    }
    return list?.shift();
  };
  const addBase64 = (b64, mime, toolName, preferredSource) => {
    if (typeof b64 !== 'string' || typeof mime !== 'string' || !mime.startsWith('image/') || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return;
    let sha256 = hashCache.get(b64);
    if (!sha256) {
      sha256 = createHash('sha256').update(b64, 'base64').digest('hex');
      if (b64.length <= 8 * 1024 * 1024) {
        hashCache.set(b64, sha256);
        let retained = 0;
        for (const key of hashCache.keys()) retained += key.length;
        while (retained > 24 * 1024 * 1024 || hashCache.size > 12) {
          const oldest = hashCache.keys().next().value;
          retained -= oldest.length;
          hashCache.delete(oldest);
        }
      }
    }
    const decoded = Buffer.byteLength(b64, 'base64');
    const source = takeImageSource(b64, preferredSource);
    images.push({ image_hash: sha256, mime_type: mime, decoded_bytes: decoded,
      base64_bytes: b64.length, image_payload_bytes: b64.length,
      source_type: source?.source ?? 'unknown', repeated: seen.has(sha256), tool_name: toolName ?? '' });
    decodedTotal += decoded;
    parts.image_payload_bytes += b64.length;
  };
  const addImageUrl = (value, toolName) => {
    const match = typeof value === 'string' && dataUrl.exec(value);
    if (match) addBase64(match[2], match[1], toolName);
  };
  const call = (id, name, args) => {
    if (id) calls.set(id, name);
    if (typeof args === 'string') addText('tool_call_bytes', args);
    else addJson('tool_call_bytes', args);
  };
  const result = (name, visit) => {
    const oldText = parts.tool_result_bytes;
    const oldImage = parts.image_payload_bytes;
    visit(name);
    results.push({ tool_name: name, text_bytes: parts.tool_result_bytes - oldText,
      image_bytes: parts.image_payload_bytes - oldImage });
  };
  const textKeys = new Map([['system', 'system_bytes'], ['developer', 'system_bytes'], ['user', 'user_text_bytes'],
    ['assistant', 'assistant_text_bytes'], ['model', 'assistant_text_bytes'], ['tool', 'tool_result_bytes'], ['toolResult', 'tool_result_bytes']]);
  const textKey = (role) => textKeys.get(role);
  const visitContent = (content, key, toolName) => {
    if (!key) return;
    if (typeof content === 'string') { addText(key, content); return; }
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (!item) continue;
      switch (item.type) {
        case 'input_text': case 'output_text': case 'text': addText(key, item.text); break;
        case 'input_image': addImageUrl(item.image_url, toolName); break;
        case 'image_url': addImageUrl(typeof item.image_url === 'string' ? item.image_url : item.image_url?.url, toolName); break;
        case 'image':
          if (item.source?.type === 'base64') addBase64(item.source.data, item.source.media_type, toolName);
          else if (families.get(api) === 'pi') addBase64(item.data, item.mimeType, toolName);
          break;
        case 'tool_use': call(item.id, item.name, item.input); break;
        case 'toolCall': call(item.id, item.name, item.arguments); break;
        case 'tool_result': {
          const name = calls.get(item.tool_use_id) ?? 'unknown';
          result(name, () => visitContent(item.content, 'tool_result_bytes', name));
          break;
        }
        case 'thinking': addText(key, item.thinking); addOpaque(item.signature ?? item.thinkingSignature); break;
        case 'redacted_thinking': addOpaque(item.data); break;
      }
    }
  };
  const visitGoogleParts = (content, key, toolName) => {
    for (const item of content ?? []) {
      addText(key, item.text);
      addOpaque(item.thoughtSignature);
      if (item.inlineData) addBase64(item.inlineData.data, item.inlineData.mimeType, toolName);
      if (item.functionCall) call(item.functionCall.id, item.functionCall.name, item.functionCall.args);
      if (item.functionResponse) {
        const response = item.functionResponse;
        const name = response.name ?? calls.get(response.id) ?? 'unknown';
        result(name, () => {
          addJson('tool_result_bytes', response.response);
          visitGoogleParts(response.parts, 'tool_result_bytes', name);
        });
      }
    }
  };
  const visitBedrock = (content, key, toolName) => {
    for (const item of content ?? []) {
      addText(key, item.text);
      if (item.json !== undefined) addJson(key, item.json);
      if (item.image) {
        const format = item.image.format;
        addBase64(item.image.source?.bytes, `image/${format === 'jpg' ? 'jpeg' : format}`, toolName);
      }
      if (item.toolUse) call(item.toolUse.toolUseId, item.toolUse.name, item.toolUse.input);
      if (item.toolResult) {
        const name = calls.get(item.toolResult.toolUseId) ?? 'unknown';
        result(name, () => visitBedrock(item.toolResult.content, 'tool_result_bytes', name));
      }
      if (item.reasoningContent) {
        addText(key, item.reasoningContent.reasoningText?.text);
        addOpaque(item.reasoningContent.reasoningText?.signature);
        addOpaque(item.reasoningContent.redactedContent);
      }
    }
  };
  switch (families.get(api)) {
    case 'responses':
      addText('system_bytes', payload.instructions);
      if (typeof payload.input === 'string') addText('user_text_bytes', payload.input);
      else for (const item of payload.input ?? []) {
        if (textKey(item.role)) visitContent(item.content, textKey(item.role));
        else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
          call(item.call_id, item.name, item.arguments);
          addText('tool_call_bytes', item.input);
        } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
          const name = calls.get(item.call_id) ?? 'unknown';
          result(name, () => visitContent(item.output, 'tool_result_bytes', name));
        } else if (item.type === 'reasoning') addOpaque(item.encrypted_content);
      }
      addJson('tool_schema_bytes', payload.tools);
      break;
    case 'chat':
      for (const message of payload.messages ?? []) {
        if (message.role === 'tool') {
          const name = calls.get(message.tool_call_id) ?? message.name ?? 'unknown';
          result(name, () => visitContent(message.content, 'tool_result_bytes', name));
        } else {
          visitContent(message.content, textKey(message.role));
          if (message.role === 'assistant') {
            addText('assistant_text_bytes', message.reasoning_content);
            for (const item of message.tool_calls ?? []) call(item.id, item.function?.name, item.function?.arguments);
          }
        }
      }
      addJson('tool_schema_bytes', payload.tools);
      break;
    case 'anthropic':
      visitContent(payload.system, 'system_bytes');
      for (const message of payload.messages ?? []) visitContent(message.content, textKey(message.role));
      addJson('tool_schema_bytes', payload.tools);
      break;
    case 'google':
      visitGoogleParts(payload.systemInstruction?.parts, 'system_bytes');
      for (const message of payload.contents ?? []) {
        const key = textKey(message.role);
        if (key) visitGoogleParts(message.parts, key);
      }
      addJson('tool_schema_bytes', payload.tools);
      break;
    case 'bedrock':
      visitBedrock(payload.system, 'system_bytes');
      for (const message of payload.messages ?? []) {
        const key = textKey(message.role);
        if (key) visitBedrock(message.content, key);
      }
      addJson('tool_schema_bytes', payload.toolConfig?.tools);
      break;
    case 'pi':
      for (const message of payload.context?.messages ?? []) {
        if (message.role === 'toolResult') {
          result(message.toolName, () => visitContent(message.content, 'tool_result_bytes', message.toolName));
        } else {
          visitContent(message.content, textKey(message.role));
          if (message.role === 'system') {
            for (const section of Object.values(message.sections ?? {})) addText('system_bytes', section);
            addJson('tool_schema_bytes', message.toolsAdded);
          }
        }
      }
      break;
    case 'acp': {
      const analyzeAssistantBlock = (block) => {
        let cursor = 0;
        for (const match of block.matchAll(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/g)) {
          if (match.index > cursor) addText('assistant_text_bytes', block.slice(cursor, match.index));
          addText('tool_call_bytes', match[0]);
          cursor = match.index + match[0].length;
        }
        if (cursor < block.length) addText('assistant_text_bytes', block.slice(cursor));
      };
      const analyzeAcpText = (text) => {
        if (/^\s*<(?:workspace_context|task_instructions)>[\s\S]*<\/(?:workspace_context|task_instructions)>\s*$/.test(text)) {
          addText('system_bytes', text);
          return undefined;
        }
        const wholeToolMatch = /^\s*<tool_result\b([^>]*)>[\s\S]*<\/tool_result>\s*$/.exec(text);
        if (wholeToolMatch) {
          const nameMatch = /\btool="([^"]+)"/.exec(wholeToolMatch[1]);
          const toolName = nameMatch?.[1] ?? 'unknown';
          result(toolName, () => addText('tool_result_bytes', text));
          return results.at(-1);
        }
        if (/^\s*<assistant\b[^>]*>[\s\S]*<\/assistant>\s*$/.test(text)) {
          analyzeAssistantBlock(text);
          return undefined;
        }
        const tagPattern = /<(workspace_context|task_instructions)>[\s\S]*?<\/\1>|<tool_result\b([^>]*)>[\s\S]*?<\/tool_result>|<assistant\b[^>]*>[\s\S]*?<\/assistant>/g;
        let cursor = 0;
        let trailingResult;
        for (const match of text.matchAll(tagPattern)) {
          if (match.index > cursor) addText('user_text_bytes', text.slice(cursor, match.index));
          const chunk = match[0];
          if (match[1]) {
            addText('system_bytes', chunk);
            trailingResult = undefined;
          } else if (match[2] !== undefined) {
            const nameMatch = /\btool="([^"]+)"/.exec(match[2]);
            const toolName = nameMatch?.[1] ?? 'unknown';
            result(toolName, () => addText('tool_result_bytes', chunk));
            trailingResult = results.at(-1);
          } else {
            analyzeAssistantBlock(chunk);
            trailingResult = undefined;
          }
          cursor = match.index + chunk.length;
        }
        if (cursor < text.length) {
          const tail = text.slice(cursor);
          addText('user_text_bytes', tail);
          if (tail.trim().length > 0) trailingResult = undefined;
        }
        return trailingResult;
      };
      if (Array.isArray(payload.preloadedTurns)) {
        for (const turn of payload.preloadedTurns) {
          if (!turn || typeof turn !== 'object') continue;
          if (typeof turn.userText === 'string') analyzeAcpText(turn.userText);
          if (typeof turn.assistantAckText === 'string') addText('assistant_text_bytes', turn.assistantAckText);
        }
      }
      if (Array.isArray(payload.prompt)) {
        let activeResult;
        for (const item of payload.prompt) {
          if (!item) continue;
          if (item.type === 'text' && typeof item.text === 'string') {
            activeResult = analyzeAcpText(item.text);
          } else if (item.type === 'image') {
            const queue = sourceImages.get(item.data);
            let preferredSource = 'user image';
            if (activeResult) {
              const expectedToolSource = isReadToolName(activeResult.tool_name) ? 'toolResult/read image' : 'toolResult/other';
              const hasPendingExpectedToolSource = Boolean(queue?.some((entry) => entry.source === expectedToolSource));
              if (!hasPendingExpectedToolSource && queue?.some((entry) => entry.source === 'user image')) {
                activeResult = undefined;
                preferredSource = 'user image';
              } else {
                preferredSource = expectedToolSource;
              }
            }
            const beforeImage = parts.image_payload_bytes;
            addBase64(item.data, item.mimeType, activeResult?.tool_name, preferredSource);
            if (activeResult) activeResult.image_bytes += parts.image_payload_bytes - beforeImage;
          } else if (item.type === 'resource') {
            activeResult = undefined;
            if (typeof item.resource?.text === 'string') addText('user_text_bytes', item.resource.text);
            if (typeof item.resource?.blob === 'string' && typeof item.resource?.mimeType === 'string' && item.resource.mimeType.startsWith('image/')) {
              addBase64(item.resource.blob, item.resource.mimeType, undefined, 'user image');
            }
          } else {
            activeResult = undefined;
          }
        }
      } else if (Array.isArray(payload.toolResults)) {
        for (const item of payload.toolResults) {
          if (!item) continue;
          const toolName = item.toolName || calls.get(item.toolCallId) || 'unknown';
          const preferredSource = isReadToolName(toolName) ? 'toolResult/read image' : 'toolResult/other';
          result(toolName, () => {
            for (const block of item.content ?? []) {
              if (!block) continue;
              if (block.type === 'text') addText('tool_result_bytes', block.text);
              else if (block.type === 'image') addBase64(block.data, block.mimeType, toolName, preferredSource);
            }
          });
        }
      }
      break;
    }
  }
  const categorized = Object.values(parts).reduce((a, b) => a + b, 0);
  parts.other_bytes = total - categorized;
  if (parts.other_bytes < 0) throw new Error('分类字节总量超过请求体大小');
  for (const image of images) seen.add(image.image_hash);
  return { total_payload_bytes: total, ...parts, image_count: images.length,
    image_decoded_bytes: decodedTotal, text_content_utf8_bytes: rawTextBytes,
    opaque_reasoning_bytes: opaqueReasoningBytes, images, results };
}

export const analyzeResponsesPayload = (...args) => analyzePayload('openai-responses', ...args);
export const mib = (n) => (n / 1048576).toFixed(3);
export const csv = (cells) => cells.map((cell) => {
  const str = String(cell ?? '');
  return /[",\r\n]/.test(str) ? `"${str.replaceAll('"', '""')}"` : str;
}).join(',');
