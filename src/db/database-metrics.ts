export type DatabaseAccessMetrics = {
  reads: number;
  writes: number;
  rowsReadObserved?: number;
};
export function measuredDatabase(
  db: D1Database,
  metrics: DatabaseAccessMetrics,
): D1Database {
  const statements = new WeakMap<
    object,
    { sql: string; original: D1PreparedStatement }
  >();
  const readStatement = (sql: string) =>
    /^(SELECT|WITH)\b/i.test(sql.trim()) &&
    !/\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|PRAGMA|ATTACH|DETACH|VACUUM)\b/i.test(
      sql,
    );
  function statement(
    original: D1PreparedStatement,
    sql: string,
  ): D1PreparedStatement {
    const proxy = new Proxy(original, {
      get(target, key) {
        if (key === "bind")
          return (...values: unknown[]) =>
            statement(target.bind(...values), sql);
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          if (readStatement(sql)) metrics.reads++;
          else metrics.writes++;
          const result = await value.apply(target, args);
          if (result?.meta && typeof result.meta.rows_read === "number")
            metrics.rowsReadObserved =
              (metrics.rowsReadObserved ?? 0) + result.meta.rows_read;
          return result;
        };
      },
    });
    statements.set(proxy, { sql, original });
    return proxy;
  }
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          return statement(target.prepare(sql), sql);
        };
      if (key === "batch")
        return async (values: D1PreparedStatement[]) => {
          const original = values.map((value) => {
            const item = statements.get(value);
            if (item && readStatement(item.sql)) metrics.reads++;
            else metrics.writes++;
            return item?.original ?? value;
          });
          return target.batch(original);
        };
      if (key === "exec")
        return async (sql: string) => {
          metrics.writes++;
          return target.exec(sql);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
