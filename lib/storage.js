const fs = require('fs');
const path = require('path');

function createStorage({ dataDir }) {
  const canonicalPath = path.join(dataDir, 'canonical.md');
  const logsDir = path.join(dataDir, 'logs');

  function ensureDirs() {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });
  }

  function readCanonical() {
    if (!fs.existsSync(canonicalPath)) return '';
    return fs.readFileSync(canonicalPath, 'utf8');
  }

  function writeCanonical(content) {
    ensureDirs();
    fs.writeFileSync(canonicalPath, content, 'utf8');
  }

  function hasCanonical() {
    return fs.existsSync(canonicalPath) && readCanonical().trim().length > 0;
  }

  return { canonicalPath, logsDir, ensureDirs, readCanonical, writeCanonical, hasCanonical };
}

module.exports = { createStorage };
