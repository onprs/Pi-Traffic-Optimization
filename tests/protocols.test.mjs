import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzePayload, isProviderPayload, matchesProviderEndpoint, sourcesFromContext } from '../src/profile.mjs';

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
