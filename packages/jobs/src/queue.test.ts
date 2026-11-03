import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { boundSql } from './queue.js';

const dialect = new PgDialect();

describe('boundSql', () => {
  it('binds each $n to its value, in place', () => {
    const query = dialect.sqlToQuery(boundSql('select $2, $1 where x = $2', ['a', 'b']));
    expect(query.sql).toBe('select $1, $2 where x = $3');
    expect(query.params).toEqual(['b', 'a', 'b']);
  });

  it('binds an array as one value', () => {
    const query = dialect.sqlToQuery(boundSql('select * from t where id = any($1)', [['x', 'y']]));
    expect(query.params).toEqual([['x', 'y']]);
  });

  it('refuses a placeholder without a value', () => {
    expect(() => boundSql('select $3', ['a'])).toThrow(RangeError);
  });
});
