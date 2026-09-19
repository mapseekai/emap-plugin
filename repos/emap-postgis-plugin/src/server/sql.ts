import { parse, deparse } from 'pgsql-parser';
import { PostgisError } from '../errors.js';
/** Validate with the PostgreSQL parser, not a SELECT-prefix regular expression. */
export async function selectSql(input: unknown): Promise<string> {
  if (typeof input !== 'string' || !input.trim() || Buffer.byteLength(input) > 50000)
    throw new PostgisError('INVALID_SQL', 'SQL is required and must be at most 50000 UTF-8 bytes');
  let ast: Awaited<ReturnType<typeof parse>>;
  try { ast = await parse(input); }
  catch { throw new PostgisError('INVALID_SQL', 'Invalid PostgreSQL syntax'); }
  if (ast.stmts?.length !== 1 || !("SelectStmt" in (ast.stmts?.[0]?.stmt ?? {})))
    throw new PostgisError('SELECT_ONLY', 'Exactly one SELECT or read-only WITH SELECT is allowed');
  const stack: unknown[] = [ast];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    for (const [key, value] of Object.entries(node)) {
      if ((key.endsWith('Stmt') && key !== 'SelectStmt') || key === 'intoClause' || key === 'lockingClause')
        throw new PostgisError('SELECT_ONLY', 'Writes, SELECT INTO and locking clauses are not allowed');
      if (key === 'FuncCall') {
        const parts = (value as { funcname?: { String?: { sval?: string } }[] }).funcname ?? [];
        const name = parts.at(-1)?.String?.sval?.toLowerCase() ?? '';
        if (['set_config', 'setval', 'nextval'].includes(name) || name.startsWith('pg_') || name.startsWith('dblink'))
          throw new PostgisError('UNSAFE_FUNCTION', 'Session, sequence and administrative functions are not allowed');
      }
      stack.push(value);
    }
  }
  return (await deparse(ast)).trim().replace(/;$/, '');
}
export const identifier = (value: string): string => '"' + value.replaceAll('"', '""') + '"';
