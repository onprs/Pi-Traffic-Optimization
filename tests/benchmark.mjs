import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runSession, fixtures } from './sdk-runner.mjs';

const output = resolve(process.argv[2] ?? join(import.meta.dirname, '../reports/benchmarks', new Date().toISOString().replaceAll(':', '-')));
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'pi-context-benchmark-'));
const workspace = join(directory, 'workspace');
const percentile = (values, p) => { const sorted = [...values].sort((a,b)=>a-b); return sorted[Math.max(0, Math.ceil(sorted.length*p)-1)] ?? 0; };
const data = (r) => ({ piVersion: r.version, requestCount: r.requests.length,
  finalBodyBytes: r.requests.at(-1).bytes, totalBodyBytes: r.requests.reduce((n,x)=>n+x.bytes,0),
  totalImageBase64Bytes: r.summary.images_bytes, finalImageBlocks: r.requests.at(-1).payload.input.reduce((n,x)=>n+(JSON.stringify(x).match(/input_image/g)?.length??0),0),
  durationMs: r.durationMs, cpuMs: r.cpuMs, archiveDiskBytes: r.diskBytes,
  archiveDiskBytesAfterShutdown: r.diskBytesAfterShutdown, compactEvents: r.compactions, metrics: r.summary.context_optimization,
  projectionMedianMs: percentile(r.projectionTimesMs,.5), projectionP95Ms: percentile(r.projectionTimesMs,.95),
  contextToProviderMedianMs: percentile(r.contextToProviderMs,.5), contextToProviderP95Ms: percentile(r.contextToProviderMs,.95),
  requests: r.requests.map((q,i)=>({ request:i+1, bytes:q.bytes, kind:q.kind, syntheticInputTokens:q.tokens })),
  toolExecutions: r.executions.reduce((map,e)=>({...map,[e.name]:(map[e.name]??0)+1}),{}) });
try {
  await fixtures(workspace);
  const steps = [
    { tool: 'read', args: { path: 'source.ts', limit: 750 } },
    { tool: 'bash', args: { command: 'node build-fixture.mjs' } },
    { tool: 'read', args: { path: 'image.png' } },
    ...Array.from({ length: 18 }, (_, i) => i % 3 === 0
      ? { tool: 'bash', args: { command: 'node build-fixture.mjs' } }
      : { tool: 'read', args: { path: 'source.ts', offset: 1 + i * 10, limit: 750 } }),
    { finish: true },
  ];
  const pairedConfig = { keepRecentTurns: 4, keepRecentTokens: 12000, oversizedToolResultBytes: 32768 };
  const base = await runSession({ workspace, output: join(output,'baseline'), projection: false, steps,
    configOverrides: pairedConfig });
  const opt = await runSession({ workspace, output: join(output,'projection'), steps,
    configOverrides: pairedConfig });
  assert.equal(base.requests.length,opt.requests.length);
  assert.equal(base.compactions.length,0); assert.equal(opt.compactions.length,0);
  // 比较 serializer 后相同工具 loadout/调用序列，排除 session 专用 prompt-cache key 的随机值。
  for (let i=0;i<base.requests.length;i++) {
    assert.deepEqual(base.requests[i].payload.tools,opt.requests[i].payload.tools);
    assert.deepEqual(base.requests[i].payload.input.filter(x=>x.type==='function_call'),opt.requests[i].payload.input.filter(x=>x.type==='function_call'));
  }
  const nativeSteps = Array.from({ length: 14 }, (_,i)=>({ tool:'read', args:{path:'source.ts',offset:1+i*10,limit:750} })).concat({finish:true});
  const nativeBase=await runSession({workspace,output:join(output,'native-baseline'),projection:false,compactWindow:80000,steps:nativeSteps,configOverrides:{keepRecentTokens:0}});
  const nativeOpt=await runSession({workspace,output:join(output,'native-projection'),compactWindow:80000,steps:nativeSteps,configOverrides:{keepRecentTokens:0}});
  const recallSteps=[...steps.slice(0,4),
    {tool:'context_recall',args:(p,find)=>({id:find(p,'call_1'),query:'entry300',around:3})},
    {tool:'context_recall',args:(p,find)=>({id:find(p,'call_2'),query:'undefined reference',around:4})},
    {tool:'context_recall',args:(p,find)=>({id:find(p,'call_3','image')})},
    ...Array.from({length:8},()=>({tool:'bash',args:{command:'node --version'}})), {finish:true}];
  const recall=await runSession({workspace,output:join(output,'recall'),steps:recallSteps,configOverrides:{keepRecentTokens:0}});
  const pages=recall.canonical.filter(m=>m.toolName==='context_recall');
  assert.equal(pages.length,3,JSON.stringify(pages.map(p=>({isError:p.isError,text:p.content?.[0]?.text?.slice(0,500)}))));
  assert.ok(pages.every(p=>!p.isError),JSON.stringify({pages:pages.map(p=>p.content?.[0]?.text), executions:recall.executions, last:recall.requests.at(-1)?.payload.input.filter(x=>x.type==='function_call_output').map(x=>({call:x.call_id,output:x.output?.slice?.(0,500)}))}));
  const raw=base.canonical.find(m=>m.toolName==='read').content[0].text;
  const placeholder=opt.requests.at(-1).payload.input.find(x=>x.type==='function_call_output'&&x.call_id==='call_1').output;
  const baseline=data(base),optimized=data(opt);
  const sourceHashes = Object.fromEntries(await Promise.all(['index.ts','module-loader.mjs','optimizer.mjs','profile.mjs','transport.mjs','archive.mjs','context-memory.mjs','configuration.mjs','config.json','reporting.mjs','tests/sdk-runner.mjs','tests/benchmark.mjs'].map(async path => [path,createHash('sha256').update(await readFile(resolve(import.meta.dirname,'..',path))).digest('hex')])));
  const result={timestamp:new Date().toISOString(),sourceHashes,environment:{node:process.version,platform:process.platform,pi:base.version},
    measurement:'真实 Pi SDK + built-in tools + 本地 HTTP/SSE；请求字节 measured，provider usage 为字符/4 的 synthetic 值。未调用远程 LLM。',
    configuration:{...pairedConfig,hotLeaseTurns:4,hotLeaseSeconds:120},
    paired:{baseline,optimized,finalMeasuredReductionBytes:baseline.finalBodyBytes-optimized.finalBodyBytes,
      finalMeasuredReductionRatio:1-optimized.finalBodyBytes/baseline.finalBodyBytes,
      totalMeasuredReductionBytes:baseline.totalBodyBytes-optimized.totalBodyBytes,
      historicalImageBase64ReductionBytes:baseline.totalImageBase64Bytes-optimized.totalImageBase64Bytes,
      toolOriginalBytes:Buffer.byteLength(raw),toolPlaceholderBytes:Buffer.byteLength(placeholder)},
    nativeCompact:{baseline:data(nativeBase),optimized:data(nativeOpt),scope:'实际 Pi compact 事件；触发 token 为本地模拟 provider 的估算 usage，不证明生产模型行为。'},
    recall:{...data(recall),pages:pages.map(p=>({id:p.details.contextId,returnedBytes:p.details.returnedBytes,
      snapshot:p.details.snapshot,lease:p.details.lease,imageBlocks:p.content.filter(b=>b.type==='image').length})),
      verifiedNoOriginalReexecution:['read','bash'].every(name=>recall.executions.filter(e=>e.name===name).length===recallSteps.filter(s=>s.tool===name).length),
      encodingMisses:recall.summary.context_optimization.imageCacheMisses,
      thrashing:recall.summary.context_optimization.thrashingCount},
    limits:['耗时包含本进程 SDK/provider serializer 与本地服务端，CPU 不包含子进程 CPU。',
      'projectionTimesMs 覆盖 request-local 扩展处理；archiveMs 另计工具结果进入归档时的处理；file hash 在工具观察路径。',
      '两个等价工作负载会话的随机 session key 和临时 stdout 路径有少量不同；请求体总差为两次真实上传的 measured 差，不能当任意 provider 的通用节省率。',
      'HTTP 对照使用默认工作集：4 turns / 12000 tokens / 32768 bytes。native compact 和 recall 对照使用最近 1 turn / 0 token 额外保护，以覆盖压力和回取边界。',
      '没有证明自主模型会在每种任务下选择 recall；工具未自动拦截重执行。']};
  assert.equal(result.recall.verifiedNoOriginalReexecution,true);
  assert.equal(result.recall.encodingMisses,1);
  assert.equal(result.recall.thrashing,0);
  await writeFile(join(output,'benchmark.json'),JSON.stringify(result,null,2)+'\n');
  await writeFile(join(output,'requests.csv'),'mode,request,kind,bytes,synthetic_input_tokens\n'+
    [ ['baseline',baseline],['projection',optimized] ].flatMap(([name,r])=>r.requests.map(q=>[name,q.request,q.kind,q.bytes,q.syntheticInputTokens].join(','))).join('\n')+'\n');
  const fmt=n=>n.toFixed(3);
  const md=['# Context Virtual Memory 维护 benchmark','',result.measurement,'',
    `Pi ${base.version}；Node ${process.version}；${process.platform}。工作集参数：最近 4 turns、12000 tokens 保护、超大阈值 32768 bytes；lease 4 turns / 120 s。`,'',
    '| 指标 | 原工作集 | Projection |','|---|---:|---:|',
    `| 最终 HTTP body bytes | ${baseline.finalBodyBytes} | ${optimized.finalBodyBytes} |`,
    `| ${baseline.requestCount} 次累计 HTTP bytes | ${baseline.totalBodyBytes} | ${optimized.totalBodyBytes} |`,
    `| 累计 Image Base64 bytes | ${baseline.totalImageBase64Bytes} | ${optimized.totalImageBase64Bytes} |`,
    `| Projection 中位 ms | ${fmt(baseline.projectionMedianMs)} | ${fmt(optimized.projectionMedianMs)} |`,
    `| Projection P95 ms | ${fmt(baseline.projectionP95Ms)} | ${fmt(optimized.projectionP95Ms)} |`,
    `| 本进程 CPU ms | ${fmt(baseline.cpuMs)} | ${fmt(optimized.cpuMs)} |`,
    `| Archive disk bytes | ${baseline.archiveDiskBytes} | ${optimized.archiveDiskBytes} |`,'',
    `典型 read ${result.paired.toolOriginalBytes} bytes → placeholder ${result.paired.toolPlaceholderBytes} bytes。最终实际 HTTP body 下降 ${(result.paired.finalMeasuredReductionRatio*100).toFixed(2)}%。`,'',
    `Recall：${pages.length} 次；返回字节 ${pages.map(p=>p.details.returnedBytes).join(' / ')}；累计 recall ${fmt(recall.summary.context_optimization.recallMs)} ms；归档累计 ${fmt(recall.summary.context_optimization.archiveMs)} ms；编码 misses ${recall.summary.context_optimization.imageCacheMisses}；thrashing ${recall.summary.context_optimization.thrashingCount}。`,'',
    `原生 compact：baseline ${nativeBase.compactions.length} 次（首次在普通请求 ${nativeBase.compactions[0]?.afterNormalRequest??'未触发'} 后）；projection ${nativeOpt.compactions.length} 次。此数据使用 synthetic provider usage。`,'',
    '## 边界','',...result.limits.map(x=>'- '+x),'',
    '详细数据、每次 HTTP 大小、磁盘占用和 lease 在 benchmark.json；原增量流量报告在各运行目录 traffic/；canonical session 在 sessions/。',''];
  await writeFile(join(output,'report.md'),md.join('\n'));
  console.log(JSON.stringify({output,paired:result.paired.finalMeasuredReductionRatio,final:[baseline.finalBodyBytes,optimized.finalBodyBytes],native:[nativeBase.compactions.length,nativeOpt.compactions.length],recall:pages.map(p=>p.details.returnedBytes)},null,2));
} finally { await rm(directory,{recursive:true,force:true}); }
