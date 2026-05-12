const { createPatch } = require('diff');

const STATUS = Object.freeze({
  IN_SYNC: 'IN_SYNC',
  DIFFERENT: 'DIFFERENT',
  MISSING: 'MISSING',
});

function normalize(content) {
  if (content == null) return '';
  return String(content).replace(/\r\n/g, '\n').replace(/\s+$/g, '');
}

function computeStatus(currentContent, canonicalContent) {
  if (currentContent === null || currentContent === undefined) {
    return STATUS.MISSING;
  }
  if (normalize(currentContent) === normalize(canonicalContent)) {
    return STATUS.IN_SYNC;
  }
  return STATUS.DIFFERENT;
}

function buildPatch(currentContent, canonicalContent, status) {
  if (status === STATUS.IN_SYNC) return null;
  if (status === STATUS.MISSING) {
    return createPatch('CLAUDE.md', '', canonicalContent, 'no file', 'canonical');
  }
  return createPatch('CLAUDE.md', currentContent, canonicalContent, 'current', 'canonical');
}

module.exports = { STATUS, computeStatus, buildPatch, normalize };
