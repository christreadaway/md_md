const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createAppLogger } = require('../lib/logger');

function tmpLogDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-md-logger-'));
}

test('createAppLogger creates the log file', () => {
  const dir = tmpLogDir();
  const logger = createAppLogger({ logsDir: dir, runTimestamp: 'test-1' });
  logger.log('info', 'hello');
  assert.ok(fs.existsSync(path.join(dir, 'run-test-1.log')));
});

test('log buffer assigns increasing ids', () => {
  const dir = tmpLogDir();
  const logger = createAppLogger({ logsDir: dir, runTimestamp: 'test-2' });
  logger.log('info', 'a');
  logger.log('info', 'b');
  logger.log('info', 'c');
  const all = logger.getEntriesSince(0);
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((e) => e.id), [1, 2, 3]);
});

test('getEntriesSince filters correctly', () => {
  const dir = tmpLogDir();
  const logger = createAppLogger({ logsDir: dir, runTimestamp: 'test-3' });
  logger.log('info', 'a');
  logger.log('info', 'b');
  logger.log('info', 'c');
  const since1 = logger.getEntriesSince(1);
  assert.equal(since1.length, 2);
  assert.equal(since1[0].msg, 'b');
});

test('buffer caps at 1000 entries', () => {
  const dir = tmpLogDir();
  const logger = createAppLogger({ logsDir: dir, runTimestamp: 'test-4' });
  for (let i = 0; i < 1500; i++) logger.log('info', `msg ${i}`);
  assert.equal(logger.size(), 1000);
  const last = logger.getEntriesSince(0);
  assert.equal(last[last.length - 1].msg, 'msg 1499');
});

test('unknown level falls back to info without throwing', () => {
  const dir = tmpLogDir();
  const logger = createAppLogger({ logsDir: dir, runTimestamp: 'test-5' });
  assert.doesNotThrow(() => logger.log('weird', 'still logged'));
  assert.equal(logger.size(), 1);
});

test('clear empties the buffer', () => {
  const dir = tmpLogDir();
  const logger = createAppLogger({ logsDir: dir, runTimestamp: 'test-6' });
  logger.log('info', 'a');
  logger.clear();
  assert.equal(logger.size(), 0);
});
