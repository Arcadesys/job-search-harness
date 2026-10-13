/** Tagged, parameterized queries only. Neither clients nor agent tools receive
 * this interface; the broker exposes validated domain operations instead. */
export type SqlRow = { [column: string]: any };
export type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<SqlRow[]>;

export function parameterizedSql(db: {
  query: (query: string, values: unknown[]) => Promise<{ rows: SqlRow[] }>;
}): Sql {
  return async (strings, ...values) => {
    const query = strings.reduce(
      (text, part, index) => text + (index ? `$${index}` : '') + part,
      '',
    );
    return (await db.query(query, values)).rows;
  };
}
