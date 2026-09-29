import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {testDatabase} from '../../../repos/emap-postgis-plugin/test/integration/database.mjs';
import {createPostgisClient} from '@mapseekai/emap-postgis-plugin';
import {PostgisGateway,createPostgisServer} from '@mapseekai/emap-postgis-plugin/server';
import {startRuntime} from './runtime-helper.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
const {Pool}=createRequire(import.meta.resolve('@mapseekai/emap-postgis-plugin/server'))('pg');
const db=await testDatabase();const admin=new Pool(db.adminConfig);let runtime,server,gateway;
const site='https://loom-options.example';const checks=[];
try{
  await admin.query(`CREATE TABLE stream_fixture AS SELECT i::bigint id,9007199254740993::bigint precise,'道路'::text label,ST_SetSRID(ST_Point(i/1000.0,20),4326) geom FROM generate_series(1,15001) i;
    GRANT SELECT ON stream_fixture TO emap_reader;
    CREATE FUNCTION fixture_slow_geom(i integer) RETURNS geometry LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.002); RETURN ST_SetSRID(ST_Point(1,2),4326); END $$;`);
  runtime=await startRuntime();
  await runtime.rpc('initialize',{profiles:[{id:'admin',label:'Admin fixture',...db.adminConfig,tls:'local'}],grants:[]});
  assert.equal((await runtime.rpc('test',{connectionId:'admin'})).ok,true);
  const post=async(path,body,token)=>{
    const r=await fetch(runtime.base+path,{method:'POST',headers:{Origin:site,'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
    return {status:r.status,body:await r.json()};
  };
  const pair=async(duration,approve=true)=>{
    const requestId=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url');
    await runtime.rpc('open',{url:`emap-connect://start?request_id=${requestId}`});
    const response=await post('/connector/pair',{requestId,challenge:createHash('sha256').update(verifier).digest('base64url'),sessionDurationMs:duration});
    assert.equal(response.status,200);
    const pending=(await runtime.rpc('snapshot')).pending;
    if(approve&&pending.length)await runtime.rpc('approve',{requestId,connectionId:'admin',remember:true});
    return {requestId,verifier,response:await post('/connector/pair/status',{requestId,verifier})};
  };
  const p=await pair(14400000);const session=p.response.body;
  assert(session.expiresAt>Date.now()+14390000&&session.expiresAt<=Date.now()+14400000);
  checks.push('Administrative account connects; requested 4-hour session has an actual 4-hour server expiry');
  const boundFetch=(url,init)=>fetch(url,{...init,headers:{...init.headers,Origin:site}});
  const client=createPostgisClient({endpoint:runtime.base+'/postgis',token:session.token,fetch:boundFetch,conversion:{worker:false},timeoutMs:60000});
  try{
    const ro=await client.query({connectionId:'admin',sql:"SELECT current_setting('transaction_read_only') AS mode"});assert.equal(ro.rows[0].mode,'on');
    await assert.rejects(client.query({connectionId:'admin',sql:'DELETE FROM stream_fixture'}),e=>e.code==='SELECT_ONLY');
    checks.push('Admin queries still run in READ ONLY transactions and write SQL remains rejected');
    let mutation;let progressCalls=0;
    const result=await client.queryDatasetStream({connectionId:'admin',sql:'SELECT * FROM stream_fixture ORDER BY id'}, {onProgress:()=>{progressCalls++;mutation??=admin.query('INSERT INTO stream_fixture SELECT 99999,1,\'new\',ST_SetSRID(ST_Point(1,2),4326); DELETE FROM stream_fixture WHERE id=15001');}});
    await mutation;
    assert.equal(result.rowCount,15001);assert.equal(result.hasMore,false);assert(progressCalls>2);
    const records=result.dataset.layers[0].data.getRecords();const ids=new Set(records.map(r=>String(r.id)));
    assert.equal(ids.size,15001);assert(ids.has('15001'));assert(!ids.has('99999'));assert.equal(records[0].precise,'9007199254740993');
    checks.push('All 15,001 features stream into one Dataset; bigint precision retained; concurrent edits do not change the cursor snapshot');
    const partial=await client.queryDatasetStream({connectionId:'admin',sql:'SELECT * FROM stream_fixture ORDER BY id',maxRows:12000});
    assert.equal(partial.rowCount,12000);assert.equal(partial.hasMore,true);
    checks.push('Explicit 12,000-row limits work above 10,000 and retain truncation metadata');
    const pending=await pair(86400000,false);assert.equal(pending.response.body.state,'pending');
    assert.equal((await runtime.rpc('snapshot')).pending[0].sessionDurationMs,86400000);
    await runtime.rpc('deny',{requestId:pending.requestId});
    checks.push('Extending remembered 4-hour consent to 24 hours requires new local approval');
    const abort=new AbortController();
    await assert.rejects(client.queryDatasetStream({connectionId:'admin',sql:'SELECT i,fixture_slow_geom(i) geom FROM generate_series(1,50000) i'}, {signal:abort.signal,onProgress:()=>abort.abort()}));
    for(let i=0;i<30;i++){const r=await admin.query("SELECT count(*)::int n FROM pg_stat_activity WHERE application_name='postgis-connector' AND state='active'");if(!r.rows[0].n)break;if(i===29)throw new Error('Cancelled stream query remained active');await new Promise(r=>setTimeout(r,100));}
    let revoke;
    await assert.rejects(client.queryDatasetStream({connectionId:'admin',sql:'SELECT i,fixture_slow_geom(i) geom FROM generate_series(1,50000) i'}, {onProgress:()=>{revoke??=runtime.rpc('revoke',{origin:site,connectionId:'admin'});}}));
    await revoke;
    checks.push('Browser cancellation and native revocation interrupt streams and never yield a partial success Dataset');
  }finally{client.dispose();}
  gateway=new PostgisGateway({connections:{admin:{config:db.adminConfig}}});
  const token=randomBytes(32).toString('hex');server=createPostgisServer({gateway,token});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const external=createPostgisClient({endpoint:`http://127.0.0.1:${server.address().port}/postgis`,token,conversion:{worker:false}});
  try{assert.equal((await external.testConnection('admin')).ok,true);const r=await external.queryDatasetStream({connectionId:'admin',sql:'SELECT * FROM stream_fixture ORDER BY id'});assert.equal(r.rowCount,15001);assert.equal(r.hasMore,false);}finally{external.dispose();}
  checks.push('The Node gateway uses the same streaming contract and accepts administrative accounts');
  const report={checks,count:checks.length,scope:'Isolated disposable Docker only; no saved credentials, grants or business tables changed'};
  await mkdir('test-results/options',{recursive:true});await writeFile('test-results/options/integration.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{
  server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));await gateway?.dispose();await runtime?.close();await admin.end();await db.dispose();
}
