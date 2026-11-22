import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyzePayload, inferCandidateModels, isDirectPayloadApi, isProviderPayload,
  isVirtualModelApi, matchesProviderEndpoint, resolveEndpointCandidate, sourcesFromContext,
} from '../src/profile.mjs';

const data = Buffer.from('协议图片').toString('base64');
const imageUrl = `data:image/png;base64,${data}`;
const schema = { name: 'read', parameters: { type: 'object' } };
const args = { path: '证据.png' };
const context = sourcesFromContext([
  { role: 'user', content: [{ type: 'image', data, mimeType: 'image/png' }] },
  { role: 'assistant', content: [{ type: 'toolCall', id: 'call1', name: 'read' }] },
  { role: 'toolResult', toolName: 'read', content: [{ type: 'image', data, mimeType: 'image/png' }] },
]);
const fixtures = {
  'openai-responses': {
    instructions: '系统', input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: '用户' }, { type: 'input_image', image_url: imageUrl }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '助手' }] },
      { type: 'function_call', call_id: 'call1', name: 'read', arguments: JSON.stringify(args) },
      { type: 'function_call_output', call_id: 'call1', output: [{ type: 'input_text', text: '结果' }, { type: 'input_image', image_url: imageUrl }] },
    ], tools: [schema],
  },
  'openai-completions': {
    messages: [
      { role: 'system', content: '系统' },
      { role: 'user', content: [{ type: 'text', text: '用户' }, { type: 'image_url', image_url: { url: imageUrl } }] },
      { role: 'assistant', content: '助手', tool_calls: [{ id: 'call1', type: 'function', function: { name: 'read', arguments: JSON.stringify(args) } }] },
      { role: 'tool', tool_call_id: 'call1', content: [{ type: 'text', text: '结果' }, { type: 'image_url', image_url: imageUrl }] },
    ], tools: [schema],
  },
  'anthropic-messages': {
    system: [{ type: 'text', text: '系统', cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: '用户' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] },
      { role: 'assistant', content: [{ type: 'text', text: '助手' }, { type: 'tool_use', id: 'call1', name: 'read', input: args }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call1', content: [{ type: 'text', text: '结果' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] }] },
    ], tools: [schema],
  },
  'google-generative-ai': {
    systemInstruction: { parts: [{ text: '系统' }] },
    contents: [
      { role: 'user', parts: [{ text: '用户' }, { inlineData: { mimeType: 'image/png', data } }] },
      { role: 'model', parts: [{ text: '助手' }, { functionCall: { name: 'read', args }, thoughtSignature: 'c2ln' }] },
      { role: 'user', parts: [{ functionResponse: { name: 'read', response: { output: '结果' }, parts: [{ inlineData: { mimeType: 'image/png', data } }] } }] },
    ], tools: [{ functionDeclarations: [schema] }],
  },
  'bedrock-converse-stream': {
    system: [{ text: '系统' }],
    messages: [
      { role: 'user', content: [{ text: '用户' }, { image: { format: 'png', source: { bytes: data } } }] },
      { role: 'assistant', content: [{ text: '助手' }, { toolUse: { toolUseId: 'call1', name: 'read', input: args } }] },
      { role: 'user', content: [{ toolResult: { toolUseId: 'call1', content: [{ text: '结果' }, { image: { format: 'png', source: { bytes: data } } }] } }] },
    ], toolConfig: { tools: [schema] },
  },
  'pi-messages': {
    context: { messages: [
      { role: 'system', content: '系统', sections: { rules: '附加规则' }, toolsAdded: [schema] },
      { role: 'user', content: [{ type: 'text', text: '用户' }, { type: 'image', mimeType: 'image/png', data }] },
      { role: 'assistant', content: [{ type: 'text', text: '助手' }, { type: 'toolCall', id: 'call1', name: 'read', arguments: args }] },
      { role: 'toolResult', toolCallId: 'call1', toolName: 'read', content: [{ type: 'text', text: '结果' }, { type: 'image', mimeType: 'image/png', data }] },
    ] },
  },
};
fixtures['azure-openai-responses'] = fixtures['openai-responses'];
fixtures['openai-codex-responses'] = fixtures['openai-responses'];
fixtures['mistral-conversations'] = fixtures['openai-completions'];
fixtures['google-vertex'] = fixtures['google-generative-ai'];

for (const [api, payload] of Object.entries(fixtures)) test(`${api}：内容分类、图片来源及字节守恒`, () => {
  const before = JSON.stringify(payload);
  const metrics = analyzePayload(api, payload, context);
  assert.equal(isProviderPayload(api, payload), true);
  assert.equal(JSON.stringify(payload), before);
  assert.equal(metrics.total_payload_bytes, Buffer.byteLength(before));
  for (const key of ['system_bytes', 'user_text_bytes', 'assistant_text_bytes', 'tool_call_bytes', 'tool_result_bytes', 'tool_schema_bytes']) {
    assert.ok(metrics[key] > 0, `${api} 缺少 ${key}`);
  }
  assert.deepEqual(metrics.images.map(image => image.source_type), ['user image', 'toolResult/read image']);
  assert.equal(metrics.images[1].tool_name, 'read');
  assert.equal(metrics.image_payload_bytes, data.length * 2);
  assert.equal(metrics.results[0].tool_name, 'read');
  assert.equal(metrics.results[0].image_bytes, data.length);
  assert.equal(metrics.total_payload_bytes, ['system_bytes', 'user_text_bytes', 'assistant_text_bytes', 'tool_call_bytes',
    'tool_result_bytes', 'image_payload_bytes', 'tool_schema_bytes', 'other_bytes'].reduce((sum, key) => sum + metrics[key], 0));
  assert.equal(JSON.stringify(metrics).includes(data), false);
});

test('各协议按真实路径匹配当前模型，忽略查询参数并排除无关入口', () => {
  const cases = [
    ['openai-responses', '/v1', '/v1/responses'],
    ['azure-openai-responses', '/openai/v1', '/openai/v1/responses?api-version=v1'],
    ['openai-codex-responses', '/backend-api', '/backend-api/codex/responses'],
    ['openai-codex-responses', '/backend-api/codex', '/backend-api/codex/responses'],
    ['openai-codex-responses', '/backend-api/codex/responses', '/backend-api/codex/responses'],
    ['openai-completions', '/v1', '/v1/chat/completions'],
    ['mistral-conversations', '', '/v1/chat/completions'],
    ['anthropic-messages', '', '/v1/messages?beta=true'],
    ['google-generative-ai', '/v1beta', '/v1beta/models/test:streamGenerateContent?alt=sse&key=secret'],
    ['google-vertex', '/v1', '/v1/projects/project/locations/region/publishers/google/models/test:streamGenerateContent?alt=sse'],
    ['bedrock-converse-stream', '/proxy', '/proxy/model/test/converse-stream'],
    ['pi-messages', '/v1', '/v1/messages?debug=1'],
  ];
  for (const [api, root, path] of cases) {
    const model = { api, id: 'test', baseUrl: `https://example.test${root}` };
    assert.equal(matchesProviderEndpoint(model, `https://example.test${path}`), true, `${api} ${path}`);
    assert.equal(matchesProviderEndpoint(model, `https://other.test${path}`), false);
    assert.equal(matchesProviderEndpoint(model, 'https://example.test/unrelated'), false);
  }
  for (const root of ['', '/openai', '/openai/v1/responses']) assert.equal(matchesProviderEndpoint(
    { api: 'azure-openai-responses', baseUrl: `https://resource.openai.azure.com${root}` },
    'https://resource.openai.azure.com/openai/v1/responses?api-version=v1'), true);
  assert.equal(matchesProviderEndpoint({ api: 'google-vertex', baseUrl: 'https://{location}-aiplatform.googleapis.com' },
    'https://us-central1-aiplatform.googleapis.com/v1/projects/test/locations/us-central1/publishers/google/models/test:streamGenerateContent'), true);
  assert.equal(matchesProviderEndpoint({ api: 'bedrock-converse-stream', id: 'arn:aws:bedrock:model/test', baseUrl: 'https://example.test' },
    'https://example.test/model/arn%3Aaws%3Abedrock%3Amodel%2Ftest/converse-stream'), true);
});

test('未知协议和远程图片地址保持未分类，Responses 支持字符串 input', () => {
  const unknown = analyzePayload('custom-api', fixtures['openai-completions']);
  assert.equal(unknown.total_payload_bytes, unknown.other_bytes);
  assert.equal(unknown.image_count, 0);
  assert.equal(isProviderPayload('custom-api', fixtures['openai-completions']), false);
  const remote = analyzePayload('openai-completions', { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://images.test/photo.png' } }] }] });
  assert.equal(remote.image_count, 0);
  assert.equal(analyzePayload('openai-responses', { input: '中文' }).user_text_bytes, 6);
});

test('antigravity-acp：session/prompt 与宿主 MCP 工具回传载荷分类、字节守恒且不误匹配 HTTP 端点', () => {
  assert.equal(isDirectPayloadApi('antigravity-acp'), true);
  assert.equal(isDirectPayloadApi('openai-responses'), false);
  assert.equal(matchesProviderEndpoint({ api: 'antigravity-acp', id: 'gemini-4-neon', baseUrl: 'acp://antigravity-cli' }, 'http://127.0.0.1:12345/mcp'), false);
  assert.equal(matchesProviderEndpoint({ api: 'antigravity-acp', id: 'gemini-4-neon', baseUrl: 'https://example.test' }, 'https://example.test/v1/responses'), false);

  const agyContext = sourcesFromContext([
    { role: 'user', content: [{ type: 'image', data, mimeType: 'image/png' }] },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'agy_mcp_1', name: 'agy_read' }] },
    { role: 'toolResult', toolCallId: 'agy_mcp_1', toolName: 'agy_read', content: [{ type: 'image', data, mimeType: 'image/png' }] },
    { role: 'user', content: [{ type: 'image', data, mimeType: 'image/png' }] },
  ]);
  assert.deepEqual(agyContext.sources.map(item => item.source), ['user image', 'toolResult/read image', 'user image']);

  const acpPromptPayload = {
    sessionId: 'agy-session-1',
    prompt: [
      { type: 'text', text: '<workspace_context>\n<cwd>/repo</cwd>\n</workspace_context>' },
      { type: 'text', text: '用户提问' },
      { type: 'image', data, mimeType: 'image/png' },
      { type: 'text', text: '<assistant model="gemini-4-neon">\n收到。\n<tool_call id="agy_mcp_1" name="agy_read">{"path":"a.ts"}</tool_call>\n</assistant>' },
      { type: 'text', text: '<tool_result id="agy_mcp_1" tool="agy_read" status="ok">\n结果\n</tool_result>' },
      { type: 'image', data, mimeType: 'image/png' },
      { type: 'image', data, mimeType: 'image/png' },
      { type: 'resource', resource: { uri: 'file:///note.txt', mimeType: 'text/plain', text: '附注' } },
      { type: 'resource_link', uri: 'file:///ref.md', name: 'ref' },
    ],
  };
  const beforePrompt = JSON.stringify(acpPromptPayload);
  assert.equal(isProviderPayload('antigravity-acp', acpPromptPayload), true);
  const promptMetrics = analyzePayload('antigravity-acp', acpPromptPayload, agyContext);
  assert.equal(JSON.stringify(acpPromptPayload), beforePrompt);
  assert.equal(promptMetrics.total_payload_bytes, Buffer.byteLength(beforePrompt));
  for (const key of ['system_bytes', 'user_text_bytes', 'assistant_text_bytes', 'tool_call_bytes', 'tool_result_bytes', 'image_payload_bytes']) {
    assert.ok(promptMetrics[key] > 0, `antigravity-acp 缺少 ${key}`);
  }
  assert.deepEqual(promptMetrics.images.map(image => image.source_type), ['user image', 'toolResult/read image', 'user image']);
  assert.equal(promptMetrics.images[1].tool_name, 'agy_read');
  assert.equal(promptMetrics.images[2].tool_name, '');
  assert.equal(promptMetrics.results.length, 1);
  assert.equal(promptMetrics.results[0].tool_name, 'agy_read');
  assert.equal(promptMetrics.results[0].image_bytes, data.length);
  assert.equal(promptMetrics.total_payload_bytes, ['system_bytes', 'user_text_bytes', 'assistant_text_bytes', 'tool_call_bytes',
    'tool_result_bytes', 'image_payload_bytes', 'tool_schema_bytes', 'other_bytes'].reduce((sum, key) => sum + promptMetrics[key], 0));

  const mcpPayload = {
    toolResults: [
      {
        toolCallId: 'agy_mcp_1',
        toolName: 'read',
        isError: false,
        content: [{ type: 'text', text: '文件内容' }, { type: 'image', data, mimeType: 'image/png' }],
      },
    ],
  };
  const beforeMcp = JSON.stringify(mcpPayload);
  assert.equal(isProviderPayload('antigravity-acp', mcpPayload), true);
  const mcpMetrics = analyzePayload('antigravity-acp', mcpPayload, context);
  assert.equal(mcpMetrics.total_payload_bytes, Buffer.byteLength(beforeMcp));
  assert.ok(mcpMetrics.tool_result_bytes > 0);
  assert.equal(mcpMetrics.image_payload_bytes, data.length);
  assert.equal(mcpMetrics.results[0].tool_name, 'read');
  assert.equal(mcpMetrics.results[0].image_bytes, data.length);
  assert.equal(mcpMetrics.total_payload_bytes, ['system_bytes', 'user_text_bytes', 'assistant_text_bytes', 'tool_call_bytes',
    'tool_result_bytes', 'image_payload_bytes', 'tool_schema_bytes', 'other_bytes'].reduce((sum, key) => sum + mcpMetrics[key], 0));

  // 带末尾换行的 <workspace_context>、SQLite preloadedTurns 复合分片与同 base64 增量图片来源归属
  const wsTrailingNewlinePayload = {
    sessionId: 'agy-session-preload',
    preloadedTurns: [
      {
        userText: '<workspace_context>\n<cwd>/repo</cwd>\n</workspace_context>\n\n<conversation-checkpoint part="1/1">\n<user>历史问题</user>\n<assistant model="gemini-4-neon">\n<tool_call id="c1" name="read">{"path":"a.ts"}</tool_call>\n</assistant>\n<tool_result id="c1" tool="read" status="ok">\n历史输出\n</tool_result>\n</conversation-checkpoint>',
        assistantAckText: 'Understood. Historical context segment 1/1 received.',
      },
    ],
    prompt: [
      { type: 'text', text: '<workspace_context>\n<cwd>/repo</cwd>\n</workspace_context>\n' },
      { type: 'image', data, mimeType: 'image/png' },
    ],
  };
  const preloadRaw = JSON.stringify(wsTrailingNewlinePayload);
  const preloadContext = sourcesFromContext([
    { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'image', data, mimeType: 'image/png' }] },
    { role: 'user', content: [{ type: 'image', data, mimeType: 'image/png' }] },
  ]);
  const preloadMetrics = analyzePayload('antigravity-acp', wsTrailingNewlinePayload, preloadContext);
  assert.equal(preloadMetrics.total_payload_bytes, Buffer.byteLength(preloadRaw));
  assert.ok(preloadMetrics.system_bytes > 0, '带末尾换行的 <workspace_context> 必须归入 system_bytes');
  assert.ok(preloadMetrics.tool_call_bytes > 0 && preloadMetrics.tool_result_bytes > 0 && preloadMetrics.assistant_text_bytes > 0);
  assert.equal(preloadMetrics.images.length, 1);
  assert.equal(preloadMetrics.images[0].source_type, 'user image', '增量 prompt 中用户图片不应被早期同 base64 工具图片顶替');
  assert.equal(preloadMetrics.total_payload_bytes, ['system_bytes', 'user_text_bytes', 'assistant_text_bytes', 'tool_call_bytes',
    'tool_result_bytes', 'image_payload_bytes', 'tool_schema_bytes', 'other_bytes'].reduce((sum, key) => sum + preloadMetrics[key], 0));

  // toolResults 载荷即使历史中先出现同 base64 的 user image，仍应归属 toolResult/read image
  const reversedContext = sourcesFromContext([
    { role: 'user', content: [{ type: 'image', data, mimeType: 'image/png' }] },
    { role: 'toolResult', toolCallId: 'agy_mcp_2', toolName: 'read', content: [{ type: 'image', data, mimeType: 'image/png' }] },
  ]);
  const mcpImageMetrics = analyzePayload('antigravity-acp', {
    toolResults: [{ toolCallId: 'agy_mcp_2', toolName: 'read', isError: false, content: [{ type: 'image', data, mimeType: 'image/png' }] }],
  }, reversedContext);
  assert.equal(mcpImageMetrics.images[0].source_type, 'toolResult/read image');

  // 延迟多模态切入的 <tool_result> + 多张同 base64 图片：即便历史首条为同 base64 user image，仍准确归属 toolResult/read image，随后才切回 user image
  const repeatedSameImgContext = sourcesFromContext([
    { role: 'user', content: [{ type: 'image', data, mimeType: 'image/png' }] },
    { role: 'toolResult', toolCallId: 'agy_mcp_3', toolName: 'read', content: [{ type: 'image', data, mimeType: 'image/png' }, { type: 'image', data, mimeType: 'image/png' }] },
    { role: 'user', content: [{ type: 'image', data, mimeType: 'image/png' }] },
  ]);
  const deferredMultiImgMetrics = analyzePayload('antigravity-acp', {
    sessionId: 'agy-session-deferred',
    prompt: [
      { type: 'text', text: '<tool_result id="agy_mcp_3" tool="read" status="ok">\n[Attached 2 image(s) from tool "read" delivered via multimodal prompt]\n</tool_result>' },
      { type: 'image', data, mimeType: 'image/png' },
      { type: 'image', data, mimeType: 'image/png' },
      { type: 'image', data, mimeType: 'image/png' },
      { type: 'text', text: 'Please inspect the attached tool result image(s) above and continue.' },
    ],
  }, repeatedSameImgContext);
  assert.deepEqual(
    deferredMultiImgMetrics.images.map((image) => image.source_type),
    ['toolResult/read image', 'toolResult/read image', 'user image'],
  );
  assert.deepEqual(
    deferredMultiImgMetrics.images.map((image) => image.tool_name),
    ['read', 'read', ''],
  );
  assert.equal(deferredMultiImgMetrics.results.length, 1);
  assert.equal(deferredMultiImgMetrics.results[0].image_bytes, data.length * 2);
});

test('WebSocket 端点、自定义 Anthropic /v1 端点及虚拟模型候选反查', () => {
  const codex = { api: 'openai-codex-responses', id: 'gpt-5.4', baseUrl: 'https://chatgpt.com/backend-api' };
  assert.equal(matchesProviderEndpoint(codex, 'wss://chatgpt.com/backend-api/codex/responses'), false, 'HTTP 模式下不应匹配 wss');
  assert.equal(matchesProviderEndpoint(codex, 'wss://chatgpt.com/backend-api/codex/responses?beta=1', { allowWebSocket: true }), true);
  assert.equal(matchesProviderEndpoint(codex, 'ws://chatgpt.com/backend-api/codex/responses', { allowWebSocket: true }), false, 'https 与 ws 协议族不匹配');
  assert.equal(matchesProviderEndpoint(codex, 'wss://other.test/backend-api/codex/responses', { allowWebSocket: true }), false);
  assert.equal(matchesProviderEndpoint({ api: 'openai-codex-responses', id: 'gpt-5.4', baseUrl: 'http://127.0.0.1:8080/backend-api' }, 'ws://127.0.0.1:8080/backend-api/codex/responses', { allowWebSocket: true }), true);
  assert.equal(matchesProviderEndpoint({ api: 'openai-responses', id: 'gpt-5', baseUrl: 'https://api.example.test/v1' }, 'wss://api.example.test/v1/responses', { allowWebSocket: true }), true);

  // 自定义 Anthropic baseUrl 已带 /v1 时同时兼容 /v1/v1/messages 与 /v1/messages
  const anthropicV1 = { api: 'anthropic-messages', id: 'claude-sonnet', baseUrl: 'https://proxy.example.test/v1' };
  assert.equal(matchesProviderEndpoint(anthropicV1, 'https://proxy.example.test/v1/v1/messages'), true);
  assert.equal(matchesProviderEndpoint(anthropicV1, 'https://proxy.example.test/v1/messages'), true);
  assert.equal(matchesProviderEndpoint(anthropicV1, 'https://proxy.example.test/v1/other'), false);

  // 虚拟模型候选推断与按实际出站 URL 精确反查物理模型
  assert.equal(isVirtualModelApi('pi-virtual'), true);
  assert.equal(isVirtualModelApi('openai-responses'), false);
  const physicalCatalog = [
    { provider: 'router', id: 'fusion', api: 'pi-virtual', baseUrl: '' },
    { provider: 'custom.chat', id: 'deepseek-v4', api: 'openai-completions', baseUrl: 'https://gateway.test/v1' },
    { provider: 'custom.resp', id: 'gpt-6', api: 'openai-responses', baseUrl: 'https://gateway.test/v1' },
    { provider: 'custom.gemini', id: 'gemini-2.5-flash', api: 'google-generative-ai', baseUrl: 'https://gateway.test/v1' },
    { provider: 'custom.gemini', id: 'gemini-2.5-pro', api: 'google-generative-ai', baseUrl: 'https://gateway.test/v1' },
    { provider: 'openai-codex', id: 'gpt-5.4', api: 'openai-codex-responses', baseUrl: 'https://chatgpt.com/backend-api' },
    { provider: 'antigravity', id: 'gemini-4-neon', api: 'antigravity-acp', baseUrl: 'acp://antigravity-cli' },
  ];
  const chatInferred = inferCandidateModels({ model: 'deepseek-v4', messages: [{ role: 'user', content: 'hi' }] }, physicalCatalog);
  assert.deepEqual(chatInferred.map((m) => `${m.provider}/${m.id}`), ['custom.chat/deepseek-v4']);

  // Google 载荷不含 model 字段，凭实际 URL 中的 /models/<id>:streamGenerateContent 精确区分
  const googleInferred = inferCandidateModels({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, physicalCatalog);
  assert.equal(googleInferred.length, 2);
  const resolvedGoogle = resolveEndpointCandidate(
    { candidates: googleInferred, bytes: 100 },
    'https://gateway.test/v1/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
  );
  assert.equal(resolvedGoogle.provider, 'custom.gemini');
  assert.equal(resolvedGoogle.model, 'gemini-2.5-pro');
  assert.equal(resolvedGoogle.api, 'google-generative-ai');

  // WebSocket 虚拟模型候选反查
  const codexInferred = inferCandidateModels({ model: 'gpt-5.4', input: [{ role: 'user', content: 'hi' }] }, physicalCatalog);
  const resolvedWs = resolveEndpointCandidate(
    { candidates: codexInferred, payloadModel: 'gpt-5.4' },
    'wss://chatgpt.com/backend-api/codex/responses',
    { allowWebSocket: true },
  );
  assert.equal(resolvedWs.provider, 'openai-codex');
  assert.equal(resolvedWs.model, 'gpt-5.4');
  assert.equal(resolvedWs.api, 'openai-codex-responses');

  // ACP 直接载荷推断
  const acpInferred = inferCandidateModels({ sessionId: 's1', prompt: [{ type: 'text', text: 'hi' }] }, physicalCatalog);
  assert.deepEqual(acpInferred.map((m) => `${m.provider}/${m.id}`), ['antigravity/gemini-4-neon']);
  assert.deepEqual(inferCandidateModels({ unknown: true }, physicalCatalog), []);
});
