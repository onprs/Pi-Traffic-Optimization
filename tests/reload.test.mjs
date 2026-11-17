import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// 同一进程加载真实扩展，修改隔离副本中的实现后再次调用 Pi 加载器。
test('Pi reload 刷新真实 ContextMemory 和它依赖的 ContextArchive，源码未变时重复 reload 正常', async () => {
  const root = process.env.PI_TRAFFIC_OPT_PI_ROOT ?? (process.env.APPDATA
    ? join(process.env.APPDATA, 'npm/node_modules/@earendil-works/pi-coding-agent')
    : join(dirname(dirname(process.execPath)), 'lib/node_modules/@earendil-works/pi-coding-agent'));
  const { loadExtensionsCached, clearExtensionCache } = await import(pathToFileURL(join(root, 'dist/core/extensions/loader.js')).href);
  const source = resolve(import.meta.dirname, '..');
  const directory = await mkdtemp(join(source, '.reload-test-'));
  const files = ['index.ts', 'module-loader.mjs', 'optimizer.mjs', 'configuration.mjs', 'context-memory.mjs', 'archive.mjs', 'profile.mjs', 'transport.mjs', 'reporting.mjs', 'config.json'];
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
    await extension.commands.get('traffic-opt').handler('上下文', ctx);
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
    await rm(directory, { recursive: true, force: true });
  }
});
