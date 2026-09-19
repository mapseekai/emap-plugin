import { PostgisError, assertActive, integer } from './errors.js';
import type { PostgisOptions, RequestOptions, WkbStreamRequest, WkbQueryResult } from './types.js';

/** NDJSON is a bounded transport envelope. A verified end frame is mandatory. */
export async function* readWkbStream(options: PostgisOptions, input: WkbStreamRequest, call: RequestOptions = {}): AsyncGenerator<WkbQueryResult> {
  if (input.maxRows !== undefined) integer(input.maxRows,1,1,Number.MAX_SAFE_INTEGER-1,'maxRows');
  if (input.batchSize !== undefined) integer(input.batchSize,256,1,2000,'batchSize');
  const maxFrame = integer(options.maxResponseBytes,12_582_912,1024,104_857_600,'maxResponseBytes');
  const totalBudget = integer(options.maxStreamBytes,536870912,1024,1073741824,'maxStreamBytes');
  let totalBytes=0;
  const task = new AbortController();
  const cancel = () => task.abort(call.signal?.reason);
  call.signal?.addEventListener('abort',cancel,{once:true}); if (call.signal?.aborted) cancel();
  const timeout = options.timeoutMs ?? 60000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timed = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertActive(task.signal);
    timer = setTimeout(()=>task.abort(new PostgisError('TIMEOUT','数据读取超时，请缩小查询范围。',408)),timeout);
    let onAbort = () => {};
    const aborted = new Promise<never>((_,reject)=>{onAbort=()=>reject(task.signal.reason);task.signal.addEventListener('abort',onAbort,{once:true});if(task.signal.aborted)onAbort();});
    try { return await Promise.race([operation(),aborted]); }
    finally { clearTimeout(timer);task.signal.removeEventListener('abort',onAbort); }
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const token = typeof options.token === 'function' ? await options.token() : options.token;
    assertActive(task.signal);
    const response = await timed(()=>(options.fetch ?? globalThis.fetch.bind(globalThis))(
      options.endpoint.replace(/\/$/,'')+'/wkb/stream',{
        method:'POST', headers:{'Content-Type':'application/json',Accept:'application/x-ndjson',...(token?{Authorization:`Bearer ${token}`}:{})},
        body:JSON.stringify(input),signal:task.signal,credentials:'same-origin',redirect:'error',cache:'no-store',
      }));
    reader = response.body?.getReader();
    if (!reader) throw new PostgisError('INVALID_RESPONSE','Empty stream response');
    if (!response.ok) {
      if (response.status===404 || response.status===405) throw new PostgisError('STREAM_UNSUPPORTED','请更新本机连接器或服务端网关后使用全部数据读取。');
      const chunks: Uint8Array[]=[];let size=0;
      for (;;) { const part=await timed(()=>reader!.read());if(part.done)break;size+=part.value.length;if(size>65536)throw new PostgisError('INVALID_RESPONSE','Error response too large');chunks.push(part.value); }
      const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
      let payload: {error?:{code?:string;message?:string}}={};try{payload=JSON.parse(new TextDecoder().decode(bytes));}catch{}
      throw new PostgisError(payload.error?.code??'HTTP_ERROR',payload.error?.message??'Stream request failed',response.status);
    }
    if (!response.headers.get('content-type')?.includes('application/x-ndjson')) throw new PostgisError('STREAM_UNSUPPORTED','网关未提供兼容的流式数据接口，请更新。');
    const decoder=new TextDecoder();let buffer='';let metadata: Pick<WkbQueryResult,'srid'|'geometryColumn'|'format'|'encoding'>|undefined;
    let total=0;let completed=false;
    for (;;) {
      const part=await timed(()=>reader!.read()); assertActive(task.signal);
      totalBytes+=part.value?.byteLength??0;
      if(totalBytes>totalBudget)throw new PostgisError('RESULT_TOO_LARGE','全量数据超过本机读取预算，请选择前 N 条或缩小查询范围。',413);
      buffer+=part.done?decoder.decode():decoder.decode(part.value,{stream:true});
      let newline: number;
      while ((newline=buffer.indexOf('\n'))>=0) {
        const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
        if (!line.trim()) continue;
        if (completed || new TextEncoder().encode(line).byteLength>maxFrame) throw new PostgisError('INVALID_RESPONSE','Invalid or oversized stream frame');
        let frame: any;try{frame=JSON.parse(line);}catch{throw new PostgisError('INVALID_RESPONSE','Invalid JSON stream frame');}
        if (frame.type==='error') throw new PostgisError(frame.error?.code??'STREAM_FAILED',frame.error?.message??'Stream failed');
        if (frame.type==='meta') {
          if (metadata || !Number.isInteger(frame.srid) || frame.srid<1 || frame.srid>998999 || typeof frame.geometryColumn!=='string' || !['wkb','ewkb'].includes(frame.format) || frame.encoding!=='hex') throw new PostgisError('INVALID_RESPONSE','Invalid stream metadata');
          metadata={srid:frame.srid,geometryColumn:frame.geometryColumn,format:frame.format,encoding:'hex'};
        } else if (frame.type==='batch') {
          if (!metadata || !Array.isArray(frame.rows) || !frame.rows.length || frame.rows.length>2000 || frame.rowCount!==frame.rows.length || frame.offset!==total) throw new PostgisError('INVALID_RESPONSE','Invalid stream sequence or row count');
          const offset=total;total+=frame.rowCount;
          if(!Number.isSafeInteger(total) || (input.maxRows!==undefined && total>input.maxRows))throw new PostgisError('INVALID_RESPONSE','Stream exceeded requested row count');
          yield {...metadata,rows:frame.rows,rowCount:frame.rowCount,offset,limit:frame.rowCount,hasMore:true};
        } else if (frame.type==='end') {
          if(!metadata || frame.rowCount!==total || typeof frame.hasMore!=='boolean' || !Number.isSafeInteger(frame.limit) || frame.limit<total || (input.maxRows===undefined && frame.hasMore)) throw new PostgisError('INVALID_RESPONSE','Invalid stream completion');
          completed=true;
          yield {...metadata,rows:[],rowCount:0,offset:total,limit:frame.limit,hasMore:frame.hasMore};
        } else throw new PostgisError('INVALID_RESPONSE','Unknown stream frame');
      }
      if (buffer.length>maxFrame) throw new PostgisError('INVALID_RESPONSE','Stream frame exceeds byte budget');
      if (part.done) break;
    }
    if (!completed || buffer.trim()) throw new PostgisError('INCOMPLETE_STREAM','数据读取中断，未导入不完整的表，请重试。');
  } finally {
    clearTimeout(timer);task.abort();call.signal?.removeEventListener('abort',cancel);
    await reader?.cancel().catch(()=>{});reader?.releaseLock();
  }
}
