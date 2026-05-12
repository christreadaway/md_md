const test = require('node:test');
const assert = require('node:assert/strict');
const { STATUS, computeStatus, buildPatch, normalize } = require('../lib/diff-status');

test('normalize trims trailing whitespace and unifies line endings', () => {
  assert.equal(normalize('hello\r\nworld\n'), 'hello\nworld');
  assert.equal(normalize('hello\nworld   \n\n'), 'hello\nworld');
  assert.equal(normalize(null), '');
  assert.equal(normalize(undefined), '');
});

test('computeStatus returns MISSING for null/undefined current', () => {
  assert.equal(computeStatus(null, 'canonical'), STATUS.MISSING);
  assert.equal(computeStatus(undefined, 'canonical'), STATUS.MISSING);
});

test('computeStatus returns IN_SYNC when contents match', () => {
  assert.equal(computeStatus('hello\n', 'hello'), STATUS.IN_SYNC);
  assert.equal(computeStatus('hello\r\nworld', 'hello\nworld'), STATUS.IN_SYNC);
  assert.equal(computeStatus('hello\n\n\n', 'hello'), STATUS.IN_SYNC);
});

test('computeStatus returns DIFFERENT when contents differ', () => {
  assert.equal(computeStatus('hello', 'world'), STATUS.DIFFERENT);
  assert.equal(computeStatus('foo\nbar', 'foo\nbaz'), STATUS.DIFFERENT);
});

test('buildPatch returns null for IN_SYNC', () => {
  assert.equal(buildPatch('a', 'a', STATUS.IN_SYNC), null);
});

test('buildPatch produces a patch for MISSING that shows additions', () => {
  const patch = buildPatch(null, 'canonical content', STATUS.MISSING);
  assert.ok(patch.includes('canonical content'));
  assert.ok(patch.includes('+'));
  assert.ok(patch.includes('no file'));
});

test('buildPatch produces a patch for DIFFERENT with both sides', () => {
  const patch = buildPatch('old', 'new', STATUS.DIFFERENT);
  assert.ok(patch.includes('current'));
  assert.ok(patch.includes('canonical'));
  assert.ok(patch.match(/-.*old/));
  assert.ok(patch.match(/\+.*new/));
});

test('empty string current is treated as DIFFERENT, not MISSING', () => {
  assert.equal(computeStatus('', 'canonical'), STATUS.DIFFERENT);
});

test('whitespace-only differences are ignored', () => {
  assert.equal(computeStatus('hello\n\n\n  ', 'hello'), STATUS.IN_SYNC);
});
