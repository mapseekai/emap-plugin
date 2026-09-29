import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { PostgisGateway } from '@mapseekai/emap-postgis-plugin/server';
import { testDatabase } from '../../../repos/emap-postgis-plugin/test/integration/database.mjs';
import { startRuntime } from './runtime-helper.mjs';
const reqFromPlugin = createRequire(import.meta.resolve('@mapseekai/emap-postgis-plugin/server'));
const { Pool } = reqFromPlugin('pg'); // Test fixture only, never part of the installation payload.
const db = await testDatabase(); let runtime, reference, admin;
const checks = []; const origin = 'https://emap.example';
const secret = () => randomBytes(32).toString('base64url');
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
try {
  runtime = await startRuntime();
  reference = new PostgisGateway({ connections: { main: { config: db.config } }, onError: error => console.error("Fixture query:", error.message) });
  admin = new Pool(db.adminConfig);
  await runtime.rpc('initialize',{profiles:[{id:'main',label:'Fixture',...db.config,tls:'local'}],grants:[]});
  const call = async (path,body,token,site=origin,extra={}) => {
    const r=await fetch(runtime.base+path,{method:body===undefined?'GET':'POST',headers:{Origin:site,...(body===undefined?{}:{'Content-Type':'application/json'}),...(token?{Authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body),...extra});
    return {status:r.status,body:await r.json()};
  };
  async function session(remember=false) {
    const requestId=secret(),verifier=secret();
    await runtime.rpc('open',{url:`emap-connect://start?request_id=${requestId}`});
    assert.equal((await call('/connector/pair',{requestId,challenge:createHash('sha256').update(verifier).digest('base64url')})).status,200);
    const status=await call('/connector/pair/status',{requestId,verifier});
    if(status.body.state==='pending') {
      await runtime.rpc('approve',{requestId,connectionId:'main',remember});
      return (await call('/connector/pair/status',{requestId,verifier})).body.token;
    }
    return status.body.token;
  }
  const token=await session();
  const cases=[
    {sql:'SELECT id,name,precise,geom FROM shapes ORDER BY id',idColumn:'id'},
    ...['ST_AsEWKB(geom)','ST_AsBinary(geom)',"encode(ST_AsEWKB(geom),'hex')",'geom::geography'].map(expr=>({sql:`SELECT id,${expr} AS shape FROM shapes WHERE id=$1`,parameters:[1],geometryColumn:'shape',sourceSrid:4326})),
    {sql:'SELECT geom FROM shapes WHERE id=1',format:'wkb',targetSrid:3857,sourceSrid:4490},
    {sql:'WITH q AS (SELECT * FROM shapes WHERE id>$1) SELECT * FROM q ORDER BY id',parameters:[0],limit:1,offset:1},
    ...["ST_GeomFromText('GEOMETRYCOLLECTION(POINT(1 2),LINESTRING(0 0,1 1))',4326)","ST_GeomFromText('POINT ZM(1 2 3 4)',4326)",'NULL::geometry',"ST_GeomFromText('POINT EMPTY',4326)"].map(geom=>({sql:`SELECT ${geom} AS geom`})),
    {sql:'SELECT geom FROM shapes WHERE false'},
    {sql:'SELECT geom AS "geometry with space",name AS "quoted""name" FROM shapes WHERE id=1',geometryColumn:'geometry with space'},
  ];
  for(const fixture of cases) {
    const input={connectionId:'main',...fixture};
    const expected=await reference.queryWkb(input);const actual=await call('/postgis/wkb',input,token);
    assert.equal(actual.status,200,JSON.stringify(actual.body));assert.deepEqual(actual.body,expected,fixture.sql);
  }
  checks.push(`${cases.length} WKB/EWKB cases exactly match the existing public Node gateway (including SRID, collections, NULL/EMPTY, precision and pagination)`);
  const curve=await call('/postgis/wkb',{connectionId:'main',sql:"SELECT 'curve' AS name,ST_GeomFromText('CIRCULARSTRING(0 0,1 1,2 0)',4326) AS geom"},token);
  assert.equal(curve.status,200,JSON.stringify(curve.body));assert.equal(curve.body.rows[0].properties.name,'curve');
  checks.push('Native WKB attribute projection avoids intermediate GeoJSON and accepts curved geometry');
  for(const fixture of [
    {sql:'SELECT $1::text AS value',parameters:["中文'; DROP TABLE shapes; --"]},
    {sql:'SELECT $1::int AS n,$2::boolean AS b,$3::jsonb AS data',parameters:[7,true,{text:'中文',nested:[1,2]}]},
    {sql:'SELECT $1::int[] AS ids,$2::text[] AS labels',parameters:[[1,2,3],['a,b','NULL','quote"','slash\\',null]]},
    {sql:'SELECT $1::numeric AS value,$2::text AS empty',parameters:['9007199254740993.123456',null]},
    {sql:'SELECT id,name FROM shapes WHERE id=ANY($1::bigint[]) ORDER BY id',parameters:[[1,3]]},
  ]) {
    const input={connectionId:'main',...fixture};
    const expected=JSON.parse(JSON.stringify(await reference.query(input)));const actual=await call('/postgis/query',input,token);
    assert.equal(actual.status,200,JSON.stringify(actual.body));assert.deepEqual(actual.body,expected,fixture.sql);
  }
  checks.push('5 bound-parameter query cases match: Unicode/injection text, numeric precision, boolean, JSON, SQL arrays and NULL');
  for(const sql of ['DELETE FROM shapes','SELECT 1; SELECT 2','WITH q AS (DELETE FROM shapes RETURNING *) SELECT * FROM q','SELECT * INTO copied FROM shapes','SELECT * FROM shapes FOR UPDATE',"SELECT set_config('transaction_read_only','off',true)","SELECT pg_sleep(1)","SELECT nextval('x')"]) {
    const r=await call('/postgis/query',{connectionId:'main',sql},token);assert.equal(r.status,400,sql);
  }
  checks.push('8 unsafe SQL cases rejected by the native PostgreSQL AST policy');
  for(const bad of ['SELECT geom,geom FROM shapes','SELECT geom AS a,geom AS b FROM shapes',"SELECT ST_GeomFromText('POINT(1 2)') AS geom"]){assert.equal((await call('/postgis/wkb',{connectionId:'main',sql:bad},token)).status,400);}
  checks.push('Duplicate columns, ambiguous geometry and unknown SRID remain errors');
  for(const site of ['null','http://evil.example','https://emap.example/'])assert.equal((await call('/connector/health',undefined,undefined,site)).status,403);
  assert.equal((await fetch(runtime.base+'/connector/health')).status,403);
  const hostStatus=await new Promise((resolve,reject)=>{
    const r=httpRequest(runtime.base+'/connector/health',{headers:{Host:'evil.example',Origin:origin}},response=>{response.resume();resolve(response.statusCode);});r.on('error',reject);r.end();
  });assert.equal(hostStatus,403);
  const preflight=await fetch(runtime.base+'/postgis/wkb',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,content-type','Access-Control-Request-Private-Network':'true'}});
  assert.equal(preflight.status,204);assert.equal(preflight.headers.get('Access-Control-Allow-Private-Network'),'true');
  assert.equal((await call('/postgis/connections',undefined,token,'https://evil.example')).status,401);
  assert.equal((await call('/postgis/query',{connectionId:'other',sql:'SELECT 1'},token)).status,403);
  assert.equal((await call('/postgis/query',{connectionId:'main',sql:'SELECT 1',password:'not-accepted'},token)).status,400);
  assert.equal((await call('/connector/approve',{requestId:'x'},token)).status,404);
  checks.push('Real native HTTP enforces Host/Origin, preflight, token scope and rejects management/credential routes');
  // Test cancellation with a deliberately slow function inside our disposable DB only.
  await admin.query("CREATE FUNCTION public.emap_fixture_pause() RETURNS int LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(5); RETURN 1; END $$");
  const slowInput={connectionId:'main',sql:'SELECT emap_fixture_pause() AS n'};
  const pending=call('/postgis/query',slowInput,token);await pause(200);await runtime.rpc('revoke',{origin,connectionId:'main'});
  assert.equal((await pending).status,403);
  async function noNativeQueries() {
    for(let i=0;i<20;i++){const r=await admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND application_name='postgis-connector' AND state='active'");if(r.rows[0].n===0)return;await pause(100);}throw new Error('Native database work outlived cancellation');
  }
  await noNativeQueries();checks.push('Revocation aborts the active database connection, not merely hiding its result');
  const next=await session();const controller=new AbortController();
  const cancelled=call('/postgis/query',slowInput,next,origin,{signal:controller.signal}).then(()=>false,()=>true);
  await pause(200);controller.abort();assert.equal(await cancelled,true);await noNativeQueries();
  checks.push('Browser disconnect cancels native database work');
  await runtime.rpc('upsert',{id:'unsafe',label:'Fixture admin',...db.adminConfig,tls:'local'});
  assert.equal((await runtime.rpc('test',{connectionId:'unsafe'})).ok,true);
  await assert.rejects(runtime.rpc('validate',{id:'bad',label:'Bad',...db.config,host:'remote.example',tls:'local'}),e=>e.code==='TLS_REQUIRED');
  checks.push('Administrative accounts connect; remote plaintext connections remain forbidden');
  const snapshot=JSON.stringify(await runtime.rpc('snapshot'));assert(!snapshot.includes(db.config.password));assert(!snapshot.includes(next));
  checks.push('Native management snapshot excludes database passwords and browser bearer tokens');
  await mkdir('test-results',{recursive:true});await writeFile('test-results/native-parity.json',JSON.stringify({count:checks.length,checks},null,2));
  console.log(JSON.stringify({count:checks.length,checks},null,2));
} finally {await reference?.dispose();await admin?.end();await runtime?.close();await db.dispose();}
