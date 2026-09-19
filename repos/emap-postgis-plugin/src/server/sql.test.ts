import { describe, it, expect } from 'vitest';
import { selectSql, identifier } from './sql.js';
describe('PostgreSQL SELECT policy', () => {
  it.each([
    'SELECT 1 AS id',
    '/* comment */ SELECT $1::text AS name;',
    "SELECT 'delete; drop table roads' AS label",
    'WITH x AS (SELECT 1 id) SELECT * FROM x',
    'SELECT a.id FROM roads a JOIN names b ON a.id=b.id WHERE b.name=$1',
    'SELECT ST_Intersects(geom, ST_MakeEnvelope(1,2,3,4,4326)) FROM roads',
    'SELECT 1 UNION ALL SELECT 2',
  ])('accepts %s', async (sql) => expect(await selectSql(sql)).not.toMatch(/;$/));
  it.each([
    'SELECT 1; SELECT 2', 'DELETE FROM roads', 'DROP TABLE roads',
    'COPY roads TO STDOUT', 'EXPLAIN SELECT 1', 'SELECT * INTO copy FROM roads',
    'SELECT * FROM roads FOR UPDATE',
    'WITH changed AS (DELETE FROM roads RETURNING *) SELECT * FROM changed',
    "SELECT set_config('transaction_read_only','off',true)",
    "SELECT pg_catalog.set_config('search_path','evil',false)",
    "SELECT nextval('seq')", "SELECT dblink('x','SELECT 1')", '',
  ])('rejects %s', async (sql) => { await expect(selectSql(sql)).rejects.toThrow(); });
  it('quotes identifiers without trusting SQL fragments', () => {
    expect(identifier('a"b')).toBe('"a""b"');
  });
});
