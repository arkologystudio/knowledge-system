/**
 * Regression: the RLS dispatcher wraps remote reads in a transaction, while
 * search methods open their own transaction to scope statement_timeout. A
 * postgres.js TransactionSql has savepoint(), not begin(), so the live search
 * path previously failed with `sql.begin is not a function`.
 */

import { expect, test } from 'bun:test';
import type postgres from 'postgres';
import { PostgresEngine } from '../src/core/postgres-engine.ts';

test('withRlsScope maps nested engine transactions to savepoints', async () => {
  let savepoints = 0;

  const tx = (async () => []) as unknown as postgres.TransactionSql;
  tx.savepoint = (async <T>(
    cb: (sql: postgres.TransactionSql) => T | Promise<T>,
  ) => {
    savepoints += 1;
    return cb(tx);
  }) as postgres.TransactionSql['savepoint'];

  const pool = (async () => []) as unknown as ReturnType<typeof postgres>;
  pool.begin = (async <T>(
    cb: (sql: postgres.TransactionSql) => T | Promise<T>,
  ) => cb(tx)) as ReturnType<typeof postgres>['begin'];

  const engine = new PostgresEngine();
  Object.defineProperty(engine, '_sql', { value: pool, writable: true });

  const result = await engine.withRlsScope(['space-a'], (scopedEngine) =>
    scopedEngine.transaction(async () => 'ok'),
  );

  expect(result).toBe('ok');
  expect(savepoints).toBe(1);
});
