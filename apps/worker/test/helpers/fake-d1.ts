type QueryMatcher = string | RegExp | ((normalizedSql: string) => boolean);

export type FakeD1QueryHandler = {
  match: QueryMatcher;
  all?: (args: unknown[], normalizedSql: string) => unknown[] | Promise<unknown[]>;
  first?: (args: unknown[], normalizedSql: string) => unknown | null | Promise<unknown | null>;
};

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toLowerCase();
}

function matchesQuery(normalizedSql: string, matcher: QueryMatcher): boolean {
  if (typeof matcher === 'string') {
    return normalizedSql.includes(matcher.toLowerCase());
  }
  if (matcher instanceof RegExp) {
    return matcher.test(normalizedSql);
  }
  return matcher(normalizedSql);
}

class FakePreparedStatement {
  private args: unknown[] = [];
  private readonly normalizedSql: string;

  constructor(
    private readonly sql: string,
    private readonly handlers: FakeD1QueryHandler[],
  ) {
    this.normalizedSql = normalizeSql(sql);
  }

  bind(...args: unknown[]): this {
    this.args = args;
    return this;
  }

  async all<T = unknown>(): Promise<{ results: T[] }> {
    const handler = this.handlers.find((item) => item.all && matchesQuery(this.normalizedSql, item.match));
    if (!handler || !handler.all) {
      throw new Error(`No fake D1 all() handler matched SQL: ${this.sql}`);
    }
    const rows = await handler.all(this.args, this.normalizedSql);
    return { results: (rows ?? []) as T[] };
  }

  async first<T = unknown>(): Promise<T | null> {
    const handler = this.handlers.find(
      (item) => item.first && matchesQuery(this.normalizedSql, item.match),
    );
    if (!handler || !handler.first) {
      throw new Error(`No fake D1 first() handler matched SQL: ${this.sql}`);
    }
    const row = await handler.first(this.args, this.normalizedSql);
    return (row ?? null) as T | null;
  }
}

export function createFakeD1Database(handlers: FakeD1QueryHandler[]): D1Database {
  return {
    prepare(sql: string) {
      return new FakePreparedStatement(sql, handlers) as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
}
