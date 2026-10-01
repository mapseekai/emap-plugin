import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { selectSql, identifier } from './sql.js';
const policy = JSON.parse(readFileSync(new URL('../../test/fixtures/sql-policy.json', import.meta.url), 'utf8')) as {
  cases: { name: string; sql: string; error?: string }[];
};
describe('PostgreSQL SELECT policy', () => {
  it.each(policy.cases)('$name', async ({ sql, error }) => {
    if (error) await expect(selectSql(sql)).rejects.toMatchObject({ code: error });
    else expect(await selectSql(sql)).not.toMatch(/;$/);
  });
  it('limits UTF-8 bytes, not character count', async () => {
    await expect(selectSql(`SELECT '${'中'.repeat(17000)}'`)).rejects.toMatchObject({ code: 'INVALID_SQL' });
  });
  it('quotes identifiers without trusting SQL fragments', () => {
    expect(identifier('a"b')).toBe('"a""b"');
  });
});
