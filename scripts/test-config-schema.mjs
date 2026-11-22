#!/usr/bin/env node
// Read-only config schema: warnings must be loud, but never mutate the object.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateConfig, SCHEMA_VERSION } from '../src/config-schema.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));

// The example is the shape reference and must be clean against itself.
const clean = validateConfig(structuredClone(example), example);
assert.equal(clean.ok, true);
assert.equal(clean.errors.length, 0);
assert.equal(clean.warnings.length, 0);
assert.equal(clean.schemaVersion, SCHEMA_VERSION);

// Missing schemaVersion is a warning, not an error.
const noVersion = structuredClone(example);
delete noVersion.schemaVersion;
const r1 = validateConfig(noVersion, example);
assert.equal(r1.ok, true);
assert.equal(r1.schemaVersion, null);
assert.ok(r1.warnings.some((w) => w.includes('schemaVersion')));

// Unknown top-level key warns.
const unknown = structuredClone(example);
unknown.notARealKey = true;
const r2 = validateConfig(unknown, example);
assert.ok(r2.warnings.some((w) => w.includes('notARealKey')));

// Missing top-level key warns.
const missing = structuredClone(example);
delete missing.snowluma;
const r3 = validateConfig(missing, example);
assert.ok(r3.warnings.some((w) => w.includes('snowluma')));

// Top-level type mismatch warns.
const wrongType = structuredClone(example);
wrongType.consolePort = '7788';
const r4 = validateConfig(wrongType, example);
assert.ok(r4.warnings.some((w) => w.includes('consolePort') && w.includes('类型')));

// Non-object is a hard error.
const r5 = validateConfig([], example);
assert.equal(r5.ok, false);
assert.ok(r5.errors.length);

// Nested unknown keys are intentionally not warnings (feature extensions).
const nested = structuredClone(example);
nested.dsh = { ...nested.dsh, internal: { enabled: true } };
const r6 = validateConfig(nested, example);
assert.ok(!r6.warnings.some((w) => w.includes('dsh.internal')));

// Validation must not mutate the input.
const before = JSON.stringify(example);
validateConfig(structuredClone(example), example);
assert.equal(JSON.stringify(example), before);

console.log(`ALL PASS  tests=7 schemaVersion=${SCHEMA_VERSION}`);
