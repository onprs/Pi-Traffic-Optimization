import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { analyzeResponsesPayload, sourcesFromContext } from '../src/profile.mjs';

const picture = Buffer.from('pi profiler synthetic image bytes');
const base64 = picture.toString('base64');
const payload = () => ({
  model: 'local-test', stream: true, store: false,
  input: [
    { role: 'developer', content: '系统\n说明' },
    { role: 'user', content: [{ type: 'input_text', text: 'a "b"\n' }, { type: 'input_image', image_url: `data:image/png;base64,${base64}` }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] },
    { type: 'function_call', name: 'read', call_id: 'call1', arguments: '{"path":"fixture.png"}' },
    { type: 'function_call_output', call_id: 'call1', output: [{ type: 'input_text', text: 'image read' }, { type: 'input_image', image_url: `data:image/png;base64,${base64}` }] },
  ],
  tools: [{ type: 'function', name: 'read', description: 'fixture', parameters: { type: 'object' } }],
});
const context = () => sourcesFromContext([
  { role: 'user', content: [{ type: 'image', mimeType: 'image/png', data: base64 }] },
  { role: 'assistant', content: [{ type: 'toolCall', id: 'call1|fc1', name: 'read' }] },
  { role: 'toolResult', toolCallId: 'call1|fc1', toolName: 'read', content: [{ type: 'image', mimeType: 'image/png', data: base64 }] },
]);

test('最终 JSON 字节和所有分类精确守恒，且不修改 payload', () => {
  const input = payload();
  const before = JSON.stringify(input);
  const metrics = analyzeResponsesPayload(input, context());
  assert.equal(JSON.stringify(input), before);
  assert.equal(metrics.total_payload_bytes, Buffer.byteLength(before, 'utf8'));
  assert.equal(metrics.image_count, 2);
  assert.equal(metrics.image_payload_bytes, base64.length * 2);
  assert.equal(metrics.image_decoded_bytes, picture.length * 2);
  assert.equal(metrics.images[0].image_hash, createHash('sha256').update(picture).digest('hex'));
  assert.deepEqual(metrics.images.map((image) => image.source_type), ['user image', 'toolResult/read image']);
  assert.equal(metrics.tool_result_bytes, 'image read'.length);
  assert.equal(metrics.tool_schema_bytes, Buffer.byteLength(JSON.stringify(input.tools)));
  assert.equal(metrics.user_text_bytes, Buffer.byteLength(JSON.stringify('a "b"\n')) - 2);
  assert.equal(metrics.total_payload_bytes, ['system_bytes', 'user_text_bytes', 'assistant_text_bytes',
    'tool_call_bytes', 'tool_result_bytes', 'image_payload_bytes', 'tool_schema_bytes', 'other_bytes']
    .reduce((sum, key) => sum + metrics[key], 0));
  assert.ok(metrics.other_bytes > 0);
  assert.equal(JSON.stringify(metrics).includes(base64), false);
});

test('跨次请求保留同一图片 hash 并记录重复累计，图片不重复解码', () => {
  const seen = new Set();
  const cache = new Map();
  const first = analyzeResponsesPayload(payload(), context(), seen, cache);
  const later = analyzeResponsesPayload(payload(), context(), seen, cache);
  assert.deepEqual(first.images.map((image) => image.repeated), [false, false]);
  assert.deepEqual(later.images.map((image) => image.repeated), [true, true]);
  assert.equal(cache.size, 1);
  assert.equal(later.images.reduce((n, image) => n + image.image_payload_bytes, 0), base64.length * 2);
});

test('HTTP 边界额外的 provider 元数据计入精确 JSON 残差', () => {
  const actual = { ...payload(), extra_meta: 1 };
  const raw = JSON.stringify(actual);
  const metrics = analyzeResponsesPayload(actual, context(), new Set(), new Map(), raw);
  assert.equal(metrics.total_payload_bytes, Buffer.byteLength(raw, 'utf8'));
  assert.equal(metrics.total_payload_bytes, metrics.system_bytes + metrics.user_text_bytes +
    metrics.assistant_text_bytes + metrics.tool_call_bytes + metrics.tool_result_bytes +
    metrics.image_payload_bytes + metrics.tool_schema_bytes + metrics.other_bytes);
});

test('未知 payload 格式不会产生臆测的图片/文本分类', () => {
  const metrics = analyzeResponsesPayload({ input: [{ role: 'something', content: 'secret' }] });
  assert.equal(metrics.total_payload_bytes, metrics.other_bytes);
  assert.equal(metrics.image_count, 0);
});
