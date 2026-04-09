#!/usr/bin/env node

/**
 * ============================================================================
 * FILE LOC CHECKER
 * ============================================================================
 *
 * Enforces a maximum lines-of-code (LOC) limit per file.
 * Can check staged files (pre-commit) or scan the full project.
 *
 * Usage:
 *   node scripts/check-file-loc.js                    # Check staged files
 *   node scripts/check-file-loc.js --all              # Scan full project
 *   node scripts/check-file-loc.js --max=1500         # Custom limit
 *   node scripts/check-file-loc.js --warn-at=1500     # Warn threshold
 *   node scripts/check-file-loc.js --report           # Show all file sizes
 *
 * Exit codes:
 *   0 - All files within limit
 *   1 - One or more files exceed limit
 *
 * ============================================================================
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// Configuration
const MAX_LOC = parseInt(getArgValue('--max') || '2000', 10);
const WARN_AT = parseInt(getArgValue('--warn-at') || String(Math.floor(MAX_LOC * 0.8)), 10);
const CHECK_ALL = process.argv.includes('--all');
const REPORT_MODE = process.argv.includes('--report');

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs'];

const IGNORE_PATTERNS = [
  'node_modules',
  'dist',
  '.worktrees',
  'local_deploy',
  'debug-test-workspace',
  'release',
];

// Colors
const C = {
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
  bold: '\x1b[1m',
};

function getArgValue(argName) {
  const arg = process.argv.find(a => a.startsWith(argName + '='));
  return arg ? arg.split('=')[1] : null;
}

function isIgnored(filePath) {
  return IGNORE_PATTERNS.some(p => filePath.includes(p));
}

function hasValidExtension(filePath) {
  return EXTENSIONS.includes(path.extname(filePath));
}

function countLines(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return content.split('\n').length;
}

function getStagedFiles() {
  try {
    const result = execSync('git diff --cached --name-only --diff-filter=ACM', {
      encoding: 'utf8',
      cwd: ROOT_DIR,
    });
    return result
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(f => path.resolve(ROOT_DIR, f));
  } catch {
    return [];
  }
}

function getAllFiles(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!isIgnored(fullPath)) {
        results.push(...getAllFiles(fullPath));
      }
    } else if (hasValidExtension(entry.name) && !isIgnored(fullPath)) {
      results.push(fullPath);
    }
  }

  return results;
}

function formatPath(filePath) {
  return path.relative(ROOT_DIR, filePath);
}

function main() {
  console.log(`${C.cyan}[LOC CHECK]${C.reset} Max: ${C.bold}${MAX_LOC}${C.reset} lines | Warn: ${WARN_AT} lines`);
  console.log('');

  // Get files to check
  let files;
  if (CHECK_ALL) {
    files = getAllFiles(ROOT_DIR);
    console.log(`${C.dim}Scanning project (${files.length} files)...${C.reset}`);
  } else {
    files = getStagedFiles().filter(f => hasValidExtension(f) && !isIgnored(f));
    if (files.length === 0) {
      console.log(`${C.dim}No staged source files to check.${C.reset}`);
      process.exit(0);
    }
    console.log(`${C.dim}Checking ${files.length} staged file(s)...${C.reset}`);
  }
  console.log('');

  const violations = [];
  const warnings = [];
  const report = [];

  for (const file of files) {
    if (!fs.existsSync(file)) continue;

    const lines = countLines(file);
    const rel = formatPath(file);

    report.push({ file: rel, lines });

    if (lines > MAX_LOC) {
      violations.push({ file: rel, lines, over: lines - MAX_LOC });
    } else if (lines > WARN_AT) {
      warnings.push({ file: rel, lines, remaining: MAX_LOC - lines });
    }
  }

  // Report mode: show all files sorted by LOC
  if (REPORT_MODE) {
    report.sort((a, b) => b.lines - a.lines);
    console.log(`${C.bold}All files by LOC:${C.reset}`);
    for (const { file, lines } of report) {
      let color = C.green;
      if (lines > MAX_LOC) color = C.red;
      else if (lines > WARN_AT) color = C.yellow;
      console.log(`  ${color}${String(lines).padStart(5)}${C.reset}  ${file}`);
    }
    console.log('');
  }

  // Warnings
  if (warnings.length > 0) {
    console.log(`${C.yellow}[WARN]${C.reset} Approaching limit (>${WARN_AT} lines):`);
    for (const { file, lines, remaining } of warnings) {
      console.log(`  ${C.yellow}${String(lines).padStart(5)}${C.reset}  ${file}  ${C.dim}(${remaining} lines remaining)${C.reset}`);
    }
    console.log('');
  }

  // Violations
  if (violations.length > 0) {
    console.log(`${C.red}[FAIL]${C.reset} Files exceeding ${MAX_LOC} LOC limit:`);
    for (const { file, lines, over } of violations) {
      console.log(`  ${C.red}${String(lines).padStart(5)}${C.reset}  ${file}  ${C.red}(+${over} over limit)${C.reset}`);
    }
    console.log('');
    console.log(`${C.red}${C.bold}LOC check failed.${C.reset} ${violations.length} file(s) exceed the ${MAX_LOC} line limit.`);
    console.log(`${C.dim}Refactor large files before committing. Use --report to see all file sizes.${C.reset}`);
    process.exit(1);
  }

  console.log(`${C.green}[PASS]${C.reset} All files within ${MAX_LOC} LOC limit.`);
  process.exit(0);
}

main();
