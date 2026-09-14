const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { ensureSchema } = require('../src/config/db');

// Must match SCHEMA_LOCK_KEY in src/config/db.js.
const SCHEMA_LOCK_KEY = 947213;

before(h.start);
after(h.stop);

test('schema setup gives up waiting on a lock that is never released', async () => {
  // Simulate the stuck lock a connection pooler can leave behind: another
  // session holds it for the whole call. Boot waits for the schema before the
  // port opens, so waiting forever here would mean the server never starts.
  const holder = await h.pool.getConnection();
  await holder.query('SELECT pg_advisory_lock(?)', [SCHEMA_LOCK_KEY]);
  try {
    const started = Date.now();
    const ready = await ensureSchema({ lockTimeoutMs: 1500, lockRetryMs: 100 });
    const elapsed = Date.now() - started;

    assert.equal(ready, true, 'the schema is still applied without the lock');
    assert.ok(elapsed >= 1400, `it should wait for the lock first (${elapsed}ms)`);
    assert.ok(elapsed < 15000, `it must give up rather than hang (${elapsed}ms)`);
  } finally {
    await holder.query('SELECT pg_advisory_unlock(?)', [SCHEMA_LOCK_KEY]);
    holder.release();
  }
});
