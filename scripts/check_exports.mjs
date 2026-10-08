#!/usr/bin/env node
/**
 * ESM Export Consistency Checker
 * Parses import statements from server.js and lib/*.js files,
 * verifies each named import from local modules exists in the source module's exports.
 * Usage: node scripts/check_exports.mjs
 * Exit code: 0 = all OK, 1 = missing exports found
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, extname, basename, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
// UWAGA: `join(__filename, '..')` daje "<plik>/.." i wypycha ROOT o jeden poziom
// za daleko (skrypt leży w scripts/, więc ROOT musi być katalogiem skryptu).
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const LIB_DIR = join(ROOT, 'lib');
const SERVER_FILE = join(ROOT, 'server.js');

// Regex patterns for ESM imports and exports
const IMPORT_REGEX = /import\s+(?:(?:\{([^}]+)\})|(?:\* as (\w+))|(\w+))\s+from\s+['"]([^'"]+)['"]/g;
const EXPORT_NAMED_REGEX = /export\s+\{\s*([^}]+)\s*\}/g;
// UWAGA: brakujący `(?:async\s+)?` powodował fałszywe BRAK dla każdego
// `export async function X` — a takich eksportów jest w tym repo dużo.
const EXPORT_DECL_REGEX =
  /^\s*export\s+(?:async\s+)?(?:const|function|class|let|var)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_DEFAULT_REGEX = /export\s+default\s+/g;
const RE_EXPORT_REGEX = /export\s+\{\s*([^}]+)\s*\}\s+from\s+['"]([^'"]+)['"]/g;

// Cache for parsed exports
const exportCache = new Map();

/**
 * Parse all exports from a module file
 */
function parseExports(filePath) {
  if (exportCache.has(filePath)) {
    return exportCache.get(filePath);
  }

  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      exportCache.set(filePath, new Set());
      return new Set();
    }
    throw err;
  }

  const exports = new Set();

  // Named exports: export { foo, bar }
  for (const match of content.matchAll(EXPORT_NAMED_REGEX)) {
    const names = match[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim());
    for (const name of names) {
      if (name) exports.add(name);
    }
  }

  // Declaration exports: export const/function/class foo
  for (const match of content.matchAll(EXPORT_DECL_REGEX)) {
    exports.add(match[1]);
  }

  // Re-exports: export { foo, bar } from './module'
  for (const match of content.matchAll(RE_EXPORT_REGEX)) {
    const names = match[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim());
    for (const name of names) {
      if (name) exports.add(name);
    }
  }

  exportCache.set(filePath, exports);
  return exports;
}

/**
 * Resolve a local import specifier to an actual file path
 */
function resolveImport(specifier, fromFile) {
  if (!specifier.startsWith('.')) {
    return null; // External package, skip
  }

  const fromDir = dirname(fromFile);
  let resolved = join(fromDir, specifier);

  // `statSync` z opcją { throwIfNoExist: false } nie rzuca ENOENT — bez tego
  // skrypt wywalał się na pierwszym nieistniejącym module zamiast raportować BRAK.
  const safeIsFile = (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };

  // Try with .js extension
  if (!extname(resolved)) {
    const withJs = resolved + '.js';
    if (safeIsFile(withJs)) {
      return withJs;
    }
    const withMjs = resolved + '.mjs';
    if (safeIsFile(withMjs)) {
      return withMjs;
    }
  } else if (safeIsFile(resolved)) {
    return resolved;
  }

  return null;
}

/**
 * Parse all imports from a file
 */
function parseImports(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const imports = [];

  for (const match of content.matchAll(IMPORT_REGEX)) {
    const [, namedImports, namespaceImport, defaultImport, specifier] = match;
    const resolved = resolveImport(specifier, filePath);

    if (!resolved) continue; // External package

    if (namedImports) {
      const names = namedImports.split(',').map(n => n.trim().split(/\s+as\s+/)[0].trim());
      for (const name of names) {
        if (name) imports.push({ name, specifier, resolved, file: filePath });
      }
    } else if (defaultImport) {
      imports.push({ name: 'default', specifier, resolved, file: filePath });
    } else if (namespaceImport) {
      imports.push({ name: '*', specifier, resolved, file: filePath });
    }
  }

  return imports;
}

/**
 * Get all JS files to check
 */
function getFilesToCheck() {
  const files = [SERVER_FILE];
  const libFiles = readdirSync(LIB_DIR)
    .filter(f => (f.endsWith('.js') || f.endsWith('.mjs')) && !f.endsWith('.bak'))
    .map(f => join(LIB_DIR, f));
  return [...files, ...libFiles];
}

/**
 * Main check function
 */
function checkExports() {
  const files = getFilesToCheck();
  const results = [];
  let hasErrors = false;

  for (const file of files) {
    const imports = parseImports(file);
    for (const imp of imports) {
      const sourceExports = parseExports(imp.resolved);
      const exists = sourceExports.has(imp.name);
      const status = exists ? 'OK' : 'BRAK';
      if (!exists) hasErrors = true;

      results.push({
        file: file.replace(ROOT + '/', ''),
        imported: imp.name,
        from: imp.resolved.replace(ROOT + '/', ''),
        status
      });
    }
  }

  // Print table
  const colWidths = {
    file: Math.max(4, ...results.map(r => r.file.length)),
    imported: Math.max(9, ...results.map(r => r.imported.length)),
    from: Math.max(4, ...results.map(r => r.from.length)),
    status: 4
  };

  const header = ` ${'Plik'.padEnd(colWidths.file)} | ${'Import'.padEnd(colWidths.imported)} | ${'Modu\u0142'.padEnd(colWidths.from)} | ${'Status'} `;
  const sep = '-'.repeat(header.length);

  console.log(header);
  console.log(sep);

  for (const r of results) {
    const statusStr = r.status === 'OK' ? '\x1b[32mOK\x1b[0m' : '\x1b[31mBRAK\x1b[0m';
    console.log(` ${r.file.padEnd(colWidths.file)} | ${r.imported.padEnd(colWidths.imported)} | ${r.from.padEnd(colWidths.from)} | ${statusStr} `);
  }

  console.log(sep);
  const okCount = results.filter(r => r.status === 'OK').length;
  const brakCount = results.filter(r => r.status === 'BRAK').length;
  console.log(`\nSuma: ${okCount} OK, ${brakCount} BRAK`);

  return !hasErrors;
}

const allOk = checkExports();
process.exit(allOk ? 0 : 1);