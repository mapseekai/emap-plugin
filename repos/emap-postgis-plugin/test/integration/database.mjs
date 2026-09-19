import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
const exec = promisify(execFile);
/** Owns an isolated disposable Docker database; never reads application credentials. */
export async function testDatabase() {
  const name = `emap-postgis-test-${randomUUID()}`;
  const password = randomUUID(); const readerPassword = randomUUID();
  const image = process.env.POSTGIS_TEST_IMAGE ?? 'imresamu/postgis:17-3.6-alpine3.22';
  let admin; let started = false;
  const dispose = async () => {
    await admin?.end();
    if (started) await exec('docker', ['rm', '-f', name]);
  };
  try {
    await exec('docker', ['run', '--rm', '-d', '--name', name, '-p', '127.0.0.1::5432',
      '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=emap_test', image]); started = true;
    const { stdout } = await exec('docker', ['port', name, '5432/tcp']);
    const port = Number(stdout.trim().split(':').at(-1));
    const base = { host: '127.0.0.1', port, database: 'emap_test' };
    admin = new Pool({ ...base, user: 'postgres', password, max: 1, connectionTimeoutMillis: 1000 });
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try { await admin.query('SELECT 1'); ready = true; break; }
      catch { await new Promise((done) => setTimeout(done, 250)); }
    }
    if (!ready) throw new Error('Isolated PostGIS test container did not become ready');
    await admin.query(`CREATE EXTENSION IF NOT EXISTS postgis;
      CREATE TABLE shapes (id bigint PRIMARY KEY, name text, precise bigint, geom geometry);
      INSERT INTO shapes VALUES
        (1,'point',9007199254740993,ST_SetSRID(ST_Point(10.5,20.5),4326)),
        (2,'line',9007199254740993,ST_GeomFromText('LINESTRING(10 20,11 21)',4326)),
        (3,'area',9007199254740993,ST_GeomFromText('POLYGON((10 20,11 20,11 21,10 21,10 20))',4326));
      CREATE ROLE emap_reader LOGIN PASSWORD '${readerPassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      GRANT CONNECT ON DATABASE emap_test TO emap_reader;
      GRANT USAGE ON SCHEMA public TO emap_reader;
      GRANT SELECT ON shapes TO emap_reader;
      ALTER ROLE emap_reader SET default_transaction_read_only=on;`);
    return { config: { ...base, user: 'emap_reader', password: readerPassword },
      adminConfig: { ...base, user: 'postgres', password }, dispose };
  } catch (error) { await dispose(); throw error; }
}
