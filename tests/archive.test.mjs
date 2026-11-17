import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContextArchive, hash } from '../src/archive.mjs';
import { ContextMemory } from '../src/context-memory.mjs';
import { normalizeConfiguration } from '../src/configuration.mjs';
import { ImageOptimizer } from '../src/optimizer.mjs';
import { TrafficReporter } from '../src/reporting.mjs';
const config = normalizeConfiguration({ contextOptimization: { keepRecentTurns: 0, keepRecentTokens: 0,
  oversizedToolResultBytes: 1024, hotLeaseTurns: 3, hotLeaseSeconds: 1 } });
const meta = (name, bytes) => ({ id: `ctx://tool/${hash(name)}`, kind: 'tool', sessionId: 'test',
  toolName: 'bash', toolCallId: name, createdAt: Date.now(), contentHash: hash(bytes), related: [] });

test('并发归档、内容和 FTS 去重、容量回退、exact/hash lookup 与重开数据库', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-archive-persistence-'));
  const a = new ContextArchive(directory, { ...config.contextOptimization.archive, maxSizeMB: 1 });
  try {
    const blob = Buffer.alloc(600000, 65); const one = meta('one', blob), two = meta('two', blob);
    await Promise.all([a.put(one, [blob], 'common evidence symbol'), a.put(two, [blob], 'common evidence symbol')]);
    assert.equal(a.stats().blobs, 1); assert.equal(a.stats().blobBytes, blob.length);
    assert.equal(a.db.prepare('SELECT COUNT(*) AS n FROM history').get().n, 1);
    assert.equal(a.search('symbol').length, 2);
    assert.equal(a.findByHash(hash(blob)).length, 2);
    const big = Buffer.alloc(600000, 66);
    await assert.rejects(a.put(meta('full',big), [big]), /容量不足/);
    assert.equal(a.stats().objects, 2);
    await a.close(); await a.init();
    assert.equal(a.get(one.id).id, one.id);
    assert.deepEqual(await a.readBlob(a.get(one.id).blobs[0]), blob);
    const gc = await a.collect({ activeSession: 'test', now: Date.now() + 40 * 86400000 });
    assert.equal(gc.removed, 0);
  } finally { await a.close(); await rm(directory,{recursive:true,force:true}); }
});

test('部分 blob 写入失败会回滚；GC 与写入串行且保留 metadata 仍引用的文件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-archive-atomic-'));
  const a = new ContextArchive(directory, { ...config.contextOptimization.archive, maxSizeMB: 1 });
  try {
    const bytes = Buffer.alloc(20000, 71);
    const first = await a.put(meta('original', bytes), [bytes]);
    await assert.rejects(a.put(meta('partial', bytes), [Buffer.alloc(100000, 72), Buffer.alloc(1048576, 73)]), /容量不足/);
    assert.equal(a.stats().objects, 1);
    assert.equal((await readdir(join(directory, 'blobs'))).length, 1);
    assert.deepEqual(await a.readBlob(first.blobs[0]), bytes);
    const now = Date.now() + 40 * 86400000;
    a.attach('live');
    const [, fresh] = await Promise.all([a.collect({ activeSession: 'live', now }), a.put({ ...meta('fresh', bytes), sessionId: 'live', createdAt: now }, [bytes])]);
    assert.equal(await a.available(fresh), true);
    a.db.prepare('DELETE FROM object_blobs WHERE id=?').run(fresh.id);
    await a.collect({ activeSession: 'live', now });
    assert.deepEqual(await a.readBlob(fresh.blobs[0]), bytes);
    await a.close();
    assert.ok((await readdir(directory)).every(name => !/-wal$|-shm$/.test(name)));
  } finally { await a.close(); await rm(directory, { recursive: true, force: true }); }
});

test('旧版 owner 表迁移 pid，较新 schema 拒绝写入并释放连接', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-archive-migration-'));
  const a = new ContextArchive(directory, config.contextOptimization.archive);
  try {
    await a.init();
    a.db.exec('ALTER TABLE session_owners DROP COLUMN pid; PRAGMA user_version=0;');
    await a.close(); await a.init(); a.attach('migrated');
    assert.ok(a.db.prepare('PRAGMA table_info(session_owners)').all().some(c => c.name === 'pid'));
    assert.equal(a.db.prepare('PRAGMA user_version').get().user_version, 1);
    a.db.exec('PRAGMA user_version=2;'); await a.close();
    await assert.rejects(a.init(), /版本较新/);
    assert.equal(a.db, undefined);
  } finally { await a.close(); await rm(directory, { recursive: true, force: true }); }
});

test('session 重载恢复稳定 placeholder、snapshot hash、working state 和 lease', async () => {
  const directory = await mkdtemp(join(tmpdir(),'pi-archive-reload-'));
  const archiveDir=join(directory,'archive'); const optimizer=new ImageOptimizer({cacheDir:join(directory,'cache')});
  const m=new ContextMemory({directory:archiveDir,config,optimizer});
  const history=[{role:'system',content:'测试',timestamp:1},
    {role:'assistant',content:[{type:'toolCall',id:'call-1',name:'read',arguments:{path:'source.ts'}}],timestamp:2},
    {role:'toolResult',toolName:'read',toolCallId:'call-1',content:[{type:'text',text:'historical snapshot\n'.repeat(200)}],timestamp:3,isError:false},
    {role:'assistant',content:[{type:'text',text:'后续'}],timestamp:4}];
  const ctx={cwd:directory,model:{contextWindow:100000},sessionManager:{getSessionId:()=> 'reload',getBranch:()=>history.map(message=>({message}))}};
  let reloaded;
  try {
    await m.start(ctx);
    const p=await m.project(history,ctx);const o=m.results.get('call-1').object;
    const r=await m.recall({id:o.id,head:2});
    await m.close();
    reloaded=new ContextMemory({directory:archiveDir,config,optimizer});await reloaded.start(ctx);
    const later=await reloaded.project(history,ctx);
    assert.equal(later.messages[2].content[0].text,p.messages[2].content[0].text);
    assert.equal(reloaded.archive.get(o.id).snapshotStatus,'historical_unverified');
    assert.equal(reloaded.protected(o.id),true);
    assert.ok(reloaded.working.recentReads[join(directory,'source.ts')]);
    assert.equal((await reloaded.recall({id:o.id,head:2})).content[0].text,r.content[0].text);
  } finally {await m.close();await reloaded?.close();await rm(directory,{recursive:true,force:true});}
});

test('nested recall 保护父工具的尾部结果；dependency 能找到稳定父 handle', async () => {
  const directory=await mkdtemp(join(tmpdir(),'pi-archive-nested-'));
  const m=new ContextMemory({directory:join(directory,'archive'),config,optimizer:new ImageOptimizer({cacheDir:join(directory,'cache')})});
  const ctx={cwd:directory};
  try {
    await m.archive.init();
    await m.observeCall({toolName:'read',toolCallId:'parent/1',parentToolCallId:'parent',input:{path:'source.ts'}},ctx);
    await m.observeResult({toolName:'read',toolCallId:'parent/1',parentToolCallId:'parent',input:{path:'source.ts'},content:[{type:'text',text:'nested evidence\n'.repeat(1000)}],isError:false},ctx);
    const nested=m.results.get('parent/1').object;
    const recall=await m.recall({id:nested.id,limit:200});
    await m.observeResult({toolName:'context_recall',toolCallId:'recall-parent/1',parentToolCallId:'recall-parent',details:recall.details},ctx);
    const parent={role:'toolResult',toolName:'codemode',toolCallId:'recall-parent',content:recall.content,isError:false,timestamp:1};
    await m.observeResult(parent,ctx);
    const messages=[{role:'system',content:'测试'},parent,...Array.from({length:10},()=>({role:'assistant',content:[{type:'text',text:'继续'}]}))];
    assert.equal((await m.project(messages,ctx)).messages[1],parent);
    await m.observeResult({role:'toolResult',toolName:'codemode',toolCallId:'parent',content:[{type:'text',text:'父结果\n'.repeat(2000)}],isError:false,timestamp:1},ctx);
    const parentId=m.results.get('parent').object.id;
    assert.ok(m.archive.relationships(nested.id).some(e=>e.target===parentId&&e.relation==='nested_in'));
  } finally {await m.close();await rm(directory,{recursive:true,force:true});}
});

test('报告增量追加、有界明细、实际字节聚合以及报告故障隔离', async () => {
  const directory=await mkdtemp(join(tmpdir(),'pi-report-incremental-'));
  const reporter=new TrafficReporter(join(directory,'report'),{...normalizeConfiguration().reporting,recentRecords:10});
  try {
    for(let i=0;i<200;i++) reporter.add({timestamp:'test',total_payload_bytes:100+i,image_payload_bytes:0,images:[],results:[]});
    assert.equal(reporter.records.length,10);
    await reporter.flush();
    const summary=JSON.parse(await readFile(join(directory,'report/summary.json'),'utf8'));
    assert.equal(summary.request_count,200);
    assert.equal(summary.total_upload_bytes,200*100+199*200/2);
    assert.equal((await readFile(join(directory,'report/events.jsonl'),'utf8')).trim().split('\n').length,200);
    const invalid=join(directory,'occupied');await writeFile(invalid,'not a directory');
    const failed=new TrafficReporter(invalid,normalizeConfiguration().reporting);
    assert.doesNotThrow(()=>failed.add({total_payload_bytes:100,image_payload_bytes:0,images:[],results:[]}));
    await failed.close();assert.ok(failed.failures>0);
  } finally {await reporter.close();await rm(directory,{recursive:true,force:true});}
});
