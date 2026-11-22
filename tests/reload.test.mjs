import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { piRoot } from './pi-root.mjs';

// 同一进程加载真实扩展，修改隔离副本中的实现后再次调用 Pi 加载器。
test('Pi reload 刷新真实 ContextMemory 和它依赖的 ContextArchive，源码未变时重复 reload 正常', async () => {
  const root = piRoot();
  const { loadExtensionsCached, clearExtensionCache } = await import(pathToFileURL(join(root, 'dist/core/extensions/loader.js')).href);
  const repository = resolve(import.meta.dirname, '..');
  const source = join(repository, 'src');
  // 临时目录位于仓库内，保证副本可以解析仓库依赖。
  const directory = await mkdtemp(join(repository, '.reload-test-'));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const pathKeys = ['PI_TRAFFIC_OPT_CONFIG_PATH', 'PI_TRAFFIC_OPT_ARCHIVE_DIR', 'PI_TRAFFIC_OPT_CACHE_DIR', 'PI_TRAFFIC_OPT_REPORT_DIR'];
  const previousPaths = Object.fromEntries(pathKeys.map(key => [key, process.env[key]]));
  for (const key of pathKeys) delete process.env[key];
  process.env.PI_TRAFFIC_OPT_CACHE_DIR = join(directory, 'cache');
  // 默认数据目录指向临时目录，避免读写真实 Pi 配置。
  process.env.PI_CODING_AGENT_DIR = join(directory, 'agent');
  const files = ['index.ts', 'module-loader.mjs', 'optimizer.mjs', 'configuration.mjs', 'context-memory.mjs', 'archive.mjs', 'profile.mjs', 'transport.mjs', 'reporting.mjs'];
  const notifications = [];
  const ctx = { hasUI: false, ui: { notify: text => notifications.push(text) } };
  const loaded = [];
  const load = async () => {
    clearExtensionCache();
    const result = await loadExtensionsCached([join(directory, 'index.ts')], directory);
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    loaded.push(result.extensions[0]);
    return result.extensions[0];
  };
  const stats = async extension => {
    await extension.commands.get('traffic-opt').handler('context', ctx);
    return JSON.parse(notifications.at(-1));
  };
  const shutdown = async extension => {
    for (const handler of extension.handlers.get('session_shutdown') ?? []) await handler({ type: 'session_shutdown', reason: 'reload' }, ctx);
  };
  try {
    for (const file of files) await writeFile(join(directory, file), await readFile(join(source, file)));
    const first = await load();
    assert.equal((await stats(first)).archive.objects, 0);
    await shutdown(first);
    const memoryFile = join(directory, 'context-memory.mjs');
    const memory = await readFile(memoryFile, 'utf8');
    assert.ok(memory.includes('  async recall(params) {'));
    await writeFile(memoryFile, memory.replace('  async recall(params) {', '  async recall(params) {\n    if (params.workingState) return { content: [{ type: "text", text: "reloaded_context" }], details: undefined };'));
    const archiveFile = join(directory, 'archive.mjs');
    const archive = await readFile(archiveFile, 'utf8');
    assert.ok(archive.includes('  stats() {'));
    await writeFile(archiveFile, archive.replace('  stats() {', '  stats() {\n    if (!this.db) return { objects: 733, blobs: 0, allocatedBytes: 0 };'));
    const second = await load();
    assert.equal((await stats(second)).archive.objects, 733);
    const tool = second.tools.get('context_recall').definition;
    assert.equal((await tool.execute('reload-probe', { workingState: true })).content[0].text, 'reloaded_context');
    await shutdown(second);
    const third = await load();
    assert.equal((await stats(third)).archive.objects, 733);
    assert.equal((await third.tools.get('context_recall').definition.execute('reload-again', { workingState: true })).content[0].text, 'reloaded_context');
  } finally {
    for (const extension of loaded) await shutdown(extension);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    for (const [key, value] of Object.entries(previousPaths)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
