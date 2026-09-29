import { describe, it, expect } from 'vitest';
import { createPostgisClient } from './client.js';
import { readWkbStream } from './stream.js';
const meta={type:'meta',geometryColumn:'geom',srid:4326,format:'ewkb',encoding:'hex'};
const geom='0101000020e6100000000000000000f03f0000000000000040';
const row={geometry:geom,properties:{name:'道路 中文'}};
const batch={type:'batch',rows:[row],rowCount:1,offset:0};
const end={type:'end',rowCount:1,hasMore:false,limit:1};
function transport(frames: unknown[], split=29) {
  const bytes=new TextEncoder().encode(frames.map(f=>JSON.stringify(f)+'\n').join(''));
  return (async()=>new Response(new ReadableStream({
    start(controller){for(let i=0;i<bytes.length;i+=split)controller.enqueue(bytes.slice(i,i+split));controller.close();},
  }),{headers:{'content-type':'application/x-ndjson'}})) as typeof fetch;
}
const options={endpoint:'http://127.0.0.1:18787/postgis',conversion:{worker:false}};
const input={connectionId:'db',sql:'SELECT geom FROM roads'};
async function collect(frames:unknown[]){const out=[];for await(const item of readWkbStream({...options,fetch:transport(frames)},input))out.push(item);return out;}
describe('bounded WKB stream',()=>{
  it('decodes fragmented UTF-8 and checks the complete row sequence',async()=>{
    const pages=await collect([meta,batch,end]);expect(pages[0].rows[0].properties.name).toBe('道路 中文');expect(pages.at(-1)?.hasMore).toBe(false);
  });
  it.each([
    [meta,batch], [batch,end], [meta,batch,{...end,rowCount:2}],
    [meta,{...batch,offset:1},end], [meta,batch,{...end,hasMore:true}],
    [meta,batch,{type:'error',error:{code:'REVOKED',message:'Revoked'}}],
    [meta,batch,end,batch],
  ])('rejects incomplete or invalid sequence %j',async(...frames)=>{await expect(collect(frames)).rejects.toThrow();});
  it('builds one dataset incrementally past the former 10,000 and 100,000 limits',async()=>{
    const frames:unknown[]=[meta];const total=100005;
    for(let offset=0;offset<total;offset+=1000){const rows=Array.from({length:Math.min(1000,total-offset)},(_,i)=>({geometry:geom,properties:{id:offset+i}}));frames.push({type:'batch',rows,rowCount:rows.length,offset});}
    frames.push({...end,rowCount:total,limit:total});
    const client=createPostgisClient({...options,fetch:transport(frames,65536)});
    let progress=0;try{const result=await client.queryDatasetStream(input,{onProgress:p=>{progress=p.rowsRead;}});
      expect(result.rowCount).toBe(total);expect(result.dataset.layers).toHaveLength(1);expect(result.dataset.layers[0].shapes).toHaveLength(total);expect(progress).toBe(total);expect(result.hasMore).toBe(false);
    }finally{client.dispose();}
  },15000);
  it('retains explicit truncation metadata for a bounded stream',async()=>{
    const client=createPostgisClient({...options,fetch:transport([meta,batch,{...end,hasMore:true}])});
    try{const r=await client.queryDatasetStream({...input,maxRows:1});expect(r.hasMore).toBe(true);expect(r.rowCount).toBe(1);}finally{client.dispose();}
  });
  it('accepts an empty table with a verified completion',async()=>{
    const client=createPostgisClient({...options,fetch:transport([meta,{...end,rowCount:0,limit:0}])});
    try{expect((await client.queryDatasetStream(input)).rowCount).toBe(0);}finally{client.dispose();}
  });
  it('does not publish partial data after a late server failure',async()=>{
    const client=createPostgisClient({...options,fetch:transport([meta,batch,{type:'error',error:{code:'REVOKED',message:'revoked'}}])});
    try{await expect(client.queryDatasetStream(input)).rejects.toMatchObject({code:'REVOKED'});}finally{client.dispose();}
  });

  it('fails explicitly on a source-byte budget instead of silently truncating rows',async()=>{
    const rows=Array.from({length:30},()=>row);
    const client=createPostgisClient({...options,maxStreamBytes:1024,fetch:transport([meta,{...batch,rows,rowCount:30},{...end,rowCount:30,limit:30}])});
    try{await expect(client.queryDatasetStream(input)).rejects.toMatchObject({code:'RESULT_TOO_LARGE'});}finally{client.dispose();}
  });
  it('disposal aborts an in-flight streamed read',async()=>{
    const client=createPostgisClient({...options,fetch:(async()=>new Promise(()=>{})) as typeof fetch});
    const pending=client.queryDatasetStream(input);const rejected=expect(pending).rejects.toThrow();client.dispose();await rejected;
  });
  it.each(['timeout', 'abort', 'dispose'] as const)('cancels token acquisition on %s and releases conversion capacity', async mode => {
    let release!: (value: string) => void;
    const token = new Promise<string>(resolve => { release = resolve; });
    let tokenCalls = 0, fetchCalls = 0;
    const response = transport([meta, batch, end]);
    const client = createPostgisClient({ ...options, conversion: { worker: false, maxConcurrent: 1 },
      timeoutMs: mode === 'timeout' ? 20 : 1000,
      token: () => ++tokenCalls === 1 ? token : 'ready',
      fetch: (...args) => { fetchCalls++; return response(...args); },
    });
    const abort = new AbortController();
    const pending = client.queryDatasetStream(input, { signal: abort.signal });
    const rejected = expect(pending).rejects.toMatchObject(mode === 'timeout' ? { code: 'TIMEOUT' } : { name: 'AbortError' });
    if (mode === 'abort') abort.abort();
    if (mode === 'dispose') client.dispose();
    try {
      await rejected;
      expect(fetchCalls).toBe(0);
      if (mode !== 'dispose') expect((await client.queryDatasetStream(input)).rowCount).toBe(1);
      release('late'); await Promise.resolve();
      expect(fetchCalls).toBe(mode === 'dispose' ? 0 : 1);
    } finally { client.dispose(); release('cleanup'); }
  }, 2000);
});
