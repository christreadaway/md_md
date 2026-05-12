const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createStorage } = require('../lib/storage');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-md-storage-'));
}

test('readCanonical returns empty string when file does not exist', () => {
  const dir = tmpDir();
  const storage = createStorage({ dataDir: dir });
  assert.equal(storage.readCanonical(), '');
});

test('writeCanonical persists content and readCanonical returns it', () => {
  const dir = tmpDir();
  const storage = createStorage({ dataDir: dir });
  storage.writeCanonical('hello world');
  assert.equal(storage.readCanonical(), 'hello world');
});

test('hasCanonical reflects existence and non-empty content', () => {
  const dir = tmpDir();
  const storage = createStorage({ dataDir: dir });
  assert.equal(storage.hasCanonical(), false);
  storage.writeCanonical('   ');
  assert.equal(storage.hasCanonical(), false, 'whitespace-only counts as empty');
  storage.writeCanonical('content');
  assert.equal(storage.hasCanonical(), true);
});

test('ensureDirs creates data and logs dirs', () => {
  const dir = tmpDir();
  fs.rmSync(dir, { recursive: true, force: true });
  const storage = createStorage({ dataDir: dir });
  storage.ensureDirs();
  assert.ok(fs.existsSync(dir));
  assert.ok(fs.existsSync(path.join(dir, 'logs')));
});

test('canonical content with newlines and unicode round-trips', () => {
  const dir = tmpDir();
  const storage = createStorage({ dataDir: dir });
  const content = 'line 1\nline 2\nemoji: ☕\nem-dash: —';
  storage.writeCanonical(content);
  assert.equal(storage.readCanonical(), content);
});
