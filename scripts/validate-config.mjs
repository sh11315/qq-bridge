#!/usr/bin/env node
// Read-only config.json shape check. Never writes config.json.
//
// Exit codes: 0 = valid (warnings allowed), 1 = unreadable/invalid JSON or
// real schema error, 2 = usage error. `--strict` turns warnings into failure.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig, formatConfigReport } from '../src/config-schema.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const json = process.argv.includes('--json');
const strict = process.argv.includes('--strict');
const quiet = process.argv.includes('--quiet');
const configPath = path.resolve(ROOT, argValue('--config', 'config.json'));
const examplePath = path.resolve(ROOT, argValue('--example', 'config.example.json'));

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    const message = `${label} 无法读取或 JSON 无效：${err.message}`;
    if (json) console.log(JSON.stringify({ ok: false, errors: [message], warnings: [] }));
    else console.error(message);
    process.exit(1);
  }
}

if (!fs.existsSync(configPath)) {
  const message = `找不到 ${configPath}`;
  if (json) console.log(JSON.stringify({ ok: false, errors: [message], warnings: [] }));
  else console.error(message);
  process.exit(1);
}

const config = readJson(configPath, 'config.json');
const example = fs.existsSync(examplePath) ? readJson(examplePath, 'config.example.json') : null;
const result = validateConfig(config, example);

if (json) {
  console.log(JSON.stringify({ ok: result.errors.length === 0, ...result }, null, 2));
} else if (!quiet || result.warnings.length || result.errors.length) {
  console.log(formatConfigReport(result, path.relative(ROOT, configPath) || configPath));
}

if (result.errors.length) process.exit(1);
if (strict && result.warnings.length) process.exit(1);
process.exit(0);
