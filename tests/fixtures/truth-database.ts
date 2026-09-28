import type { PGlite } from '@electric-sql/pglite';
import type { NeonQueryFunction } from '@neondatabase/serverless';

export function sqlAdapter(db: PGlite) {
  return (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((result, part, index) => result + (index ? `$${index}` : '') + part, '');
    return (await db.query(query, values)).rows;
  }) as unknown as NeonQueryFunction<false, false>;
}
