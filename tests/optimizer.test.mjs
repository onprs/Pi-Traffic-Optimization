import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, rm, readFile, writeFile, mkdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { ImageOptimizer, normalizeConfig, fingerprint } from '../src/optimizer.mjs';

const config = normalizeConfig({ skipBelowKB: 0, targetKB: 400 });
const image = (buffer, mimeType = 'image/png') => ({ type: 'image', mimeType, data: buffer.toString('base64') });
async function noisy(width = 700, height = 700, channels = 3) {
  const raw = Buffer.alloc(width * height * channels);
  let seed = 123456789;
  for (let i = 0; i < raw.length; i++) {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    raw[i] = seed & 255;
  }
  return sharp(raw, { raw: { width, height, channels } }).png().toBuffer();
}
async function withCache(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-opt-test-'));
  try { await fn(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('保留消息、顺序、原图，重复图只压缩一次并支持磁盘命中', async () => withCache(async (directory) => {
  const original = image(await noisy());
  const untouched = structuredClone(original);
  const messages = [
    { role: 'system', content: '指令' },
    { role: 'user', content: [{ type: 'text', text: '提问' }, original] },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'read', arguments: {} }] },
    { role: 'toolResult', toolName: 'read', content: [{ type: 'text', text: '结果' }, structuredClone(original)] },
  ];
  const engine = new ImageOptimizer({ cacheDir: directory });
  const first = await engine.optimizeMessages(messages, config);
  assert.equal(first.stats.images, 2);
  assert.equal(first.stats.misses, 1);
  assert.equal(first.stats.hits, 1);
  assert.equal(first.messages.length, 4);
  assert.equal(first.messages[0], messages[0]);
  assert.equal(first.messages[2], messages[2]);
  assert.equal(first.messages[1].content[0], messages[1].content[0]);
  assert.equal(first.messages[3].content[0], messages[3].content[0]);
  assert.deepEqual(original, untouched);
  assert.equal(first.messages[1].content[1].mimeType, 'image/webp');
  assert.deepEqual(first.messages[1].content[1], first.messages[3].content[1]);
  assert.ok(first.stats.optimizedBytes < first.stats.originalBytes * .95);
  const later = await engine.optimizeMessages(messages, config);
  assert.equal(later.stats.misses, 0);
  assert.equal(later.stats.hits, 2);
  const restarted = new ImageOptimizer({ cacheDir: directory });
  assert.equal((await restarted.optimizeMessages(messages, config)).stats.hits, 2);
  assert.equal((await restarted.optimizeMessages(messages, { ...config, targetKB: 300 })).stats.misses, 1);
  assert.notEqual(fingerprint(config), fingerprint({ ...config, targetKB: 300 }));
  assert.equal((await restarted.optimizeMessages(messages, { ...config, enabled: false })).messages, messages);
  await engine.clearCache();
  assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.webp')), []);
}));

test('小图、动画、无效 base64、错误缓存均原样通过', async () => withCache(async (directory) => {
  const small = image(await sharp({ create: { width: 10, height: 10, channels: 3, background: '#ffffff' } }).png().toBuffer());
  const invalid = { type: 'image', mimeType: 'image/png', data: 'not+valid!==' };
  const gif = image(Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64'), 'image/gif');
  const engine = new ImageOptimizer({ cacheDir: directory });
  const result = await engine.optimizeMessages([{ role: 'user', content: [small, invalid, gif] }], normalizeConfig());
  assert.equal(result.stats.skipped, 3);
  assert.equal(result.messages[0].content[0], small);
  assert.equal(result.messages[0].content[1], invalid);
  assert.equal(result.messages[0].content[2], gif);
  const big = image(await noisy());
  await engine.optimizeMessages([{ role: 'user', content: [big] }], config);
  const [key] = (await readdir(directory)).filter(name => name.endsWith('.webp'));
  await writeFile(join(directory, key), 'bad cache');
  const restarted = new ImageOptimizer({ cacheDir: directory });
  const failed = await restarted.optimizeMessages([{ role: 'user', content: [big] }], config);
  assert.equal(failed.stats.errors, 1);
  assert.equal(failed.messages[0].content[0], big);
}));

test('磁盘写入失败回退，透明通道保留，最长边不放大', async () => withCache(async (directory) => {
  const root = join(directory, 'unwritable');
  await writeFile(root, 'occupied');
  const big = image(await noisy());
  const failed = await new ImageOptimizer({ cacheDir: root }).optimizeMessages([{ role: 'user', content: [big] }], config);
  assert.equal(failed.stats.errors, 1);
  assert.equal(failed.messages[0].content[0], big);
  const input = await sharp({ create: { width: 200, height: 100, channels: 4, background: '#ffffff00' } })
    .composite([{ input: Buffer.from('<svg width="200" height="100"><rect width="100" height="100" fill="red"/></svg>') }]).png().toBuffer();
  const smaller = await new ImageOptimizer({ cacheDir: directory }).optimizeMessages([{ role: 'user', content: [image(input)] }], config);
  const output = smaller.messages[0].content[0];
  if (output.mimeType === 'image/webp') {
    const meta = await sharp(Buffer.from(output.data, 'base64')).metadata();
    assert.equal(meta.hasAlpha, true);
    assert.equal(meta.width, 200);
    assert.equal(meta.height, 100);
  }
}));

test('缓存过期和容量清理不删除其他文件', async () => withCache(async (directory) => {
  const engine = new ImageOptimizer({ cacheDir: directory });
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'other.txt'), 'untouched');
  const old = join(directory, `${'a'.repeat(64)}.webp`);
  const recent = join(directory, `${'b'.repeat(64)}.webp`);
  await writeFile(old, Buffer.alloc(1048577));
  await writeFile(recent, Buffer.alloc(1048577));
  await utimes(old, new Date(0), new Date(0));
  await engine.sweep(normalizeConfig({ cache: { maxSizeMB: 1, maxAgeDays: 7 } }));
  assert.deepEqual(await readdir(directory), ['other.txt']);
  assert.equal(await readFile(join(directory, 'other.txt'), 'utf8'), 'untouched');
  const cacheConfig = normalizeConfig({ cache: { maxSizeMB: 1, maxAgeDays: 7 } });
  await engine.store('c'.repeat(64), Buffer.alloc(700000), cacheConfig);
  await engine.store('d'.repeat(64), Buffer.alloc(700000), cacheConfig);
  assert.ok(engine.diskBytes <= 1048576);
  assert.equal((await readdir(directory)).filter(name => name.endsWith('.webp')).length, 1);
}));

test('二十个语义位置仅对三张不同原图执行图像处理', async () => withCache(async (directory) => {
  const originals = await Promise.all([noisy(650, 650), noisy(650, 651), noisy(651, 650)]);
  const messages = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'toolResult' : 'user',
    content: [image(originals[i % 3])] }));
  const result = await new ImageOptimizer({ cacheDir: directory }).optimizeMessages(messages, config);
  assert.equal(result.stats.images, 20);
  assert.equal(result.stats.misses, 3);
  assert.equal(result.stats.hits, 17);
  assert.equal(result.messages.length, 20);
  assert.deepEqual(result.messages.map(m => m.role), messages.map(m => m.role));
}));

test('无法缩小时缓存跳过标记，不持久化原图', async () => withCache(async (directory) => {
  const original = image(await sharp(await noisy(700, 700)).avif({ quality: 15 }).toBuffer(), 'image/avif');
  const engine = new ImageOptimizer({ cacheDir: directory });
  const first = await engine.optimizeMessages([{ role: 'user', content: [original] }], config);
  assert.equal(first.stats.skipped, 1);
  assert.equal(first.stats.misses, 1);
  assert.equal(first.messages[0].content[0], original);
  const filenames = await readdir(directory);
  assert.equal(filenames.length, 1);
  assert.ok(filenames[0].endsWith('.skip'));
  assert.equal((await readFile(join(directory, filenames[0]))).length, 0);
  const second = await new ImageOptimizer({ cacheDir: directory }).optimizeMessages([{ role: 'user', content: [original] }], config);
  assert.equal(second.stats.hits, 1);
  assert.equal(second.messages[0].content[0], original);
}));

test('内存与磁盘缓存均按配置年龄过期', async () => withCache(async (directory) => {
  const original = image(await noisy());
  const engine = new ImageOptimizer({ cacheDir: directory });
  const messages = [{ role: 'user', content: [original] }];
  const first = await engine.optimizeMessages(messages, config);
  assert.equal(first.stats.misses, 1);
  const cached = engine.memory.values().next().value;
  cached.createdAt = 0;
  const name = (await readdir(directory)).find(item => item.endsWith('.webp'));
  await utimes(join(directory, name), new Date(0), new Date(0));
  const again = await engine.optimizeMessages(messages, config);
  assert.equal(again.stats.misses, 1);
  assert.equal(again.stats.hits, 0);
  assert.equal(again.messages[0].content[0].mimeType, 'image/webp');
}));

test('EXIF 方向校正并在缩放时保持方向和比例', async () => withCache(async (directory) => {
  const png = await noisy(480, 240);
  const jpeg = await sharp(png).jpeg({ quality: 95 }).withMetadata({ orientation: 6 }).toBuffer();
  assert.equal((await sharp(jpeg).metadata()).orientation, 6);
  const original = image(jpeg, 'image/jpeg');
  const adjusted = await new ImageOptimizer({ cacheDir: directory }).optimizeMessages([{ role: 'user', content: [original] }],
    normalizeConfig({ skipBelowKB: 0, maxLongEdge: 256 }));
  const result = adjusted.messages[0].content[0];
  assert.equal(result.mimeType, 'image/webp');
  const meta = await sharp(Buffer.from(result.data, 'base64')).metadata();
  assert.equal(meta.orientation, undefined);
  assert.equal(meta.width, 128);
  assert.equal(meta.height, 256);
}));
