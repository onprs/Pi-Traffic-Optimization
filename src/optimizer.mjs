import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, readdir, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';

export const defaults = Object.freeze({
  enabled: true, skipBelowKB: 300, maxLongEdge: 1920, targetKB: 375,
  maxQuality: 88, defaultQuality: 82, minQuality: 60, preserveAlpha: true,
  cache: { enabled: true, maxSizeMB: 1024, maxAgeDays: 7 }, logging: 'summary',
});
const algorithm = `webp-inside-orient-v3-sharp-${sharp.versions.sharp}`;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const validBase64 = (value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
const cacheFile = /^[a-f0-9]{64}\.(webp|skip)$/;
const temporaryFile = /^[a-f0-9]{64}\.[a-f0-9-]{36}\.tmp$/;
const validMime = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/tiff', 'image/avif']);
const limit = (n, fallback, low, high) => Number.isFinite(n) && n >= low && n <= high ? n : fallback;

export function normalizeConfig(raw = {}) {
  const cache = raw.cache && typeof raw.cache === 'object' ? raw.cache : {};
  const maxQuality = limit(raw.maxQuality, defaults.maxQuality, 1, 100);
  const defaultQuality = limit(raw.defaultQuality, defaults.defaultQuality, 1, maxQuality);
  const minQuality = limit(raw.minQuality, defaults.minQuality, 1, defaultQuality);
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : defaults.enabled,
    skipBelowKB: limit(raw.skipBelowKB, defaults.skipBelowKB, 0, 102400),
    maxLongEdge: limit(raw.maxLongEdge, defaults.maxLongEdge, 256, 16384),
    targetKB: limit(raw.targetKB, defaults.targetKB, 10, 102400),
    maxQuality, defaultQuality, minQuality,
    preserveAlpha: typeof raw.preserveAlpha === 'boolean' ? raw.preserveAlpha : defaults.preserveAlpha,
    cache: {
      enabled: typeof cache.enabled === 'boolean' ? cache.enabled : defaults.cache.enabled,
      maxSizeMB: limit(cache.maxSizeMB, defaults.cache.maxSizeMB, 1, 10240),
      maxAgeDays: limit(cache.maxAgeDays, defaults.cache.maxAgeDays, 1, 365),
    },
    logging: ['summary', 'off'].includes(raw.logging) ? raw.logging : defaults.logging,
  };
}

export const fingerprint = (config) => sha256(JSON.stringify({
  algorithm, maxLongEdge: config.maxLongEdge, targetKB: config.targetKB,
  maxQuality: config.maxQuality, defaultQuality: config.defaultQuality,
  minQuality: config.minQuality, preserveAlpha: config.preserveAlpha,
}));

const emptyStats = () => ({ requests: 0, images: 0, unique: 0, hits: 0, misses: 0,
  skipped: 0, errors: 0, archiveReuses: 0, originalBytes: 0, optimizedBytes: 0, processingMs: 0, encodeMs: 0, hitMs: 0 });
const metrics = (source) => ({ ...source });

export class ImageOptimizer {
  constructor({ cacheDir = join(tmpdir(), 'pi-image-optimizer'), memoryLimitBytes = 64 * 1024 * 1024 } = {}) {
    this.cacheDir = cacheDir;
    this.memoryLimitBytes = memoryLimitBytes;
    this.memory = new Map();
    this.memoryBytes = 0;
    this.seen = new Set();
    this.totals = emptyStats();
    this.last = emptyStats();
    this.lastSweep = 0;
    this.diskBytes = null;
  }

  remember(key, value) {
    const size = value.bytes;
    if (size > this.memoryLimitBytes) return;
    const old = this.memory.get(key);
    if (old) this.memoryBytes -= old.bytes;
    this.memory.delete(key);
    this.memory.set(key, value);
    this.memoryBytes += size;
    while (this.memoryBytes > this.memoryLimitBytes || this.memory.size > 4096) {
      const first = this.memory.keys().next().value;
      this.memoryBytes -= this.memory.get(first).bytes;
      this.memory.delete(first);
    }
  }

  async lookup(key, config) {
    if (!config.cache.enabled) return null;
    const memoryValue = this.memory.get(key);
    if (memoryValue) {
      if (Date.now() - memoryValue.createdAt <= config.cache.maxAgeDays * 86400000) {
        this.memory.delete(key);
        this.memory.set(key, memoryValue);
        return memoryValue;
      }
      this.memoryBytes -= memoryValue.bytes;
      this.memory.delete(key);
    }
    let path = join(this.cacheDir, `${key}.webp`);
    let details;
    try { details = await stat(path); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      path = join(this.cacheDir, `${key}.skip`);
      try { details = await stat(path); } catch (other) {
        if (other.code === 'ENOENT') return null;
        throw other;
      }
    }
    if (Date.now() - details.mtimeMs > config.cache.maxAgeDays * 86400000) {
      await rm(path);
      if (this.diskBytes !== null) this.diskBytes -= details.size;
      return null;
    }
    if (path.endsWith('.skip')) {
      const value = { skip: true, bytes: 0, createdAt: details.mtimeMs };
      this.remember(key, value);
      return value;
    }
    const buffer = await readFile(path);
    if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') throw new Error('Cached image is invalid');
    const value = { data: buffer.toString('base64'), bytes: buffer.length, mimeType: 'image/webp', optimizedHash: sha256(buffer), createdAt: details.mtimeMs };
    this.remember(key, value);
    return value;
  }

  async store(key, buffer, config) {
    const value = { data: buffer.toString('base64'), bytes: buffer.length, mimeType: 'image/webp', optimizedHash: sha256(buffer), createdAt: Date.now() };
    if (config.cache.enabled) {
      await mkdir(this.cacheDir, { recursive: true });
      const temporary = join(this.cacheDir, `${key}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, buffer, { flag: 'wx' });
        await rename(temporary, join(this.cacheDir, `${key}.webp`));
      } finally { await rm(temporary, { force: true }); }
      if (this.diskBytes === null || this.diskBytes + buffer.length > config.cache.maxSizeMB * 1048576) {
        await this.sweep(config, true);
      } else {
        this.diskBytes += buffer.length;
      }
      this.remember(key, value);
    }
    return value;
  }

  async storeSkip(key, config) {
    if (!config.cache.enabled) return;
    await mkdir(this.cacheDir, { recursive: true });
    const temporary = join(this.cacheDir, `${key}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, '', { flag: 'wx' });
      await rename(temporary, join(this.cacheDir, `${key}.skip`));
    } finally { await rm(temporary, { force: true }); }
    this.remember(key, { skip: true, bytes: 0, createdAt: Date.now() });
  }

  async sweep(config, force = false) {
    if (!config.cache.enabled || (!force && Date.now() - this.lastSweep < 3600000 &&
      this.diskBytes !== null && this.diskBytes <= config.cache.maxSizeMB * 1048576)) return;
    let entries;
    try { entries = await readdir(this.cacheDir); } catch (error) {
      if (error.code === 'ENOENT') { this.diskBytes = 0; this.lastSweep = Date.now(); return; }
      throw error;
    }
    const files = [];
    for (const name of entries) {
      if (!cacheFile.test(name) && !temporaryFile.test(name)) continue;
      const path = join(this.cacheDir, name);
      let info;
      try { info = await stat(path); } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (!info.isFile()) continue;
      if (temporaryFile.test(name)) {
        if (Date.now() - info.mtimeMs > 86400000) await rm(path);
      } else if (Date.now() - info.mtimeMs > config.cache.maxAgeDays * 86400000) await rm(path);
      else files.push({ path, size: info.size, modified: info.mtimeMs });
    }
    let size = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files.sort((a, b) => a.modified - b.modified)) {
      if (size <= config.cache.maxSizeMB * 1048576) break;
      await rm(file.path);
      size -= file.size;
    }
    this.diskBytes = size;
    this.lastSweep = Date.now();
  }

  async clearCache() {
    this.memory.clear();
    this.memoryBytes = 0;
    this.diskBytes = null;
    this.lastSweep = 0;
    let entries;
    try { entries = await readdir(this.cacheDir); } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const name of entries) if (cacheFile.test(name) || temporaryFile.test(name)) await rm(join(this.cacheDir, name));
  }

  async optimizeImage(image, config, stats, imageMetrics) {
    stats.images++;
    const began = performance.now();
    try {
      if (!image || image.type !== 'image' || typeof image.data !== 'string' ||
        !validMime.has(image.mimeType) || !validBase64(image.data)) {
        stats.skipped++;
        return image;
      }
      const original = Buffer.from(image.data, 'base64');
      stats.originalBytes += original.length;
      const hash = sha256(original);
      if (original.length < config.skipBelowKB * 1024) {
        stats.skipped++;
        stats.optimizedBytes += original.length;
        imageMetrics?.set(hash, { originalBytes: original.length, optimizedBytes: original.length });
        return image;
      }
      if (!this.seen.has(hash)) { this.seen.add(hash); stats.unique++; }
      const key = sha256(`${hash}:${fingerprint(config)}`);
      const hit = await this.lookup(key, config);
      if (hit) {
        stats.hits++;
        stats.hitMs += performance.now() - began;
        stats.optimizedBytes += hit.skip ? original.length : hit.bytes;
        if (hit.skip) {
          stats.skipped++;
          imageMetrics?.set(hash, { originalBytes: original.length, optimizedBytes: original.length });
          return image;
        }
        const hitHash = hit.optimizedHash ?? sha256(Buffer.from(hit.data, 'base64'));
        imageMetrics?.set(hitHash, { originalBytes: original.length, optimizedBytes: hit.bytes });
        return { ...image, data: hit.data, mimeType: hit.mimeType };
      }
      stats.misses++;
      const meta = await sharp(original, { animated: false, limitInputPixels: 268402689 }).metadata();
      if (!meta.width || !meta.height || !meta.format || meta.pages > 1 || meta.format === 'gif' || meta.format === 'svg') {
        await this.storeSkip(key, config);
        stats.skipped++;
        stats.optimizedBytes += original.length;
        imageMetrics?.set(hash, { originalBytes: original.length, optimizedBytes: original.length });
        return image;
      }
      const edge = Math.max(meta.width, meta.height);
      const target = config.targetKB * 1024;
      let best;
      const encodeStart = performance.now();
      const encode = async (quality) => {
        const pipeline = sharp(original).rotate();
        if (meta.hasAlpha && !config.preserveAlpha) pipeline.flatten({ background: '#ffffff' });
        if (edge > config.maxLongEdge) pipeline.resize(config.maxLongEdge, config.maxLongEdge, { fit: 'inside', withoutEnlargement: true });
        const candidate = await pipeline.webp({ quality, effort: 1, smartSubsample: true,
          alphaQuality: meta.hasAlpha && config.preserveAlpha ? 90 : undefined }).toBuffer();
        if (!best || candidate.length < best.length) best = candidate;
        return candidate.length;
      };
      const initial = await encode(config.defaultQuality);
      if (initial > target) {
        const steps = initial > target * 1.2 ? [config.minQuality] :
          [Math.max(config.minQuality, config.defaultQuality - 6),
            Math.max(config.minQuality, config.defaultQuality - 14), config.minQuality];
        for (const quality of new Set(steps)) {
          if (quality === config.defaultQuality) continue;
          if (await encode(quality) <= target) break;
        }
      }
      stats.encodeMs += performance.now() - encodeStart;
      if (!best || best.length >= original.length * 0.95) {
        await this.storeSkip(key, config);
        stats.skipped++;
        stats.optimizedBytes += original.length;
        imageMetrics?.set(hash, { originalBytes: original.length, optimizedBytes: original.length });
        return image;
      }
      const result = await this.store(key, best, config);
      stats.optimizedBytes += result.bytes;
      imageMetrics?.set(result.optimizedHash, { originalBytes: original.length, optimizedBytes: result.bytes });
      return { ...image, data: result.data, mimeType: result.mimeType };
    } catch {
      stats.errors++;
      if (typeof image?.data === 'string' && validBase64(image.data) && validMime.has(image.mimeType)) {
        const fallback = Buffer.from(image.data, 'base64');
        stats.optimizedBytes += fallback.length;
        imageMetrics?.set(sha256(fallback), { originalBytes: fallback.length, optimizedBytes: fallback.length });
      }
      return image;
    } finally { stats.processingMs += performance.now() - began; }
  }

  async optimizeMessages(messages, config, { alreadyOptimized = () => false } = {}) {
    const stats = emptyStats();
    const imageMetrics = new Map();
    if (!config.enabled) return { messages, stats, imageMetrics };
    stats.requests = 1;
    const transformed = [];
    for (const message of messages) {
      if (!Array.isArray(message.content) || !message.content.some((item) => item?.type === 'image')) {
        transformed.push(message);
        continue;
      }
      const content = [];
      for (const item of message.content) {
        if (item?.type !== 'image') { content.push(item); continue; }
        if (alreadyOptimized(message)) {
          const buffer = Buffer.from(item.data, 'base64');
          const size = buffer.length;
          stats.images++; stats.originalBytes += size; stats.optimizedBytes += size; stats.archiveReuses++;
          const hash = sha256(buffer);
          if (!imageMetrics.has(hash)) imageMetrics.set(hash, { originalBytes: size, optimizedBytes: size });
          content.push(item);
        } else content.push(await this.optimizeImage(item, config, stats, imageMetrics));
      }
      transformed.push({ ...message, content });
    }
    for (const key of Object.keys(stats)) this.totals[key] += stats[key];
    this.last = metrics(stats);
    return { messages: transformed, stats, imageMetrics };
  }
}
