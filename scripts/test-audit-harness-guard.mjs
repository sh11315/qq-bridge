#!/usr/bin/env node
// The audit harness does exact string surgery on bridge.js. If the marker
// moves, it must fail loudly instead of evaluating main() against a real gateway.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertBridgeConnectMarker,
  assertBridgeReturnBlock,
  BRIDGE_CONNECT_MARKER,
  BRIDGE_RETURN_BLOCK_MARKER,
} from './audit-bridge-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(ROOT, 'src', 'bridge.js'), 'utf8');

assert.throws(() => assertBridgeConnectMarker(''), /bot\.connect\(\) marker not found/);
assert.throws(() => assertBridgeReturnBlock(''), /main\(\) return block not injected/);

assert.equal(assertBridgeConnectMarker(`${BRIDGE_CONNECT_MARKER}\n`), undefined);
assert.equal(assertBridgeReturnBlock(`return { ${BRIDGE_RETURN_BLOCK_MARKER} };`), undefined);

// Real bridge must still satisfy the pre-injection marker. The return-block
// marker only exists after the harness injects it, so it is checked on the
// synthetic string above.
assert.equal(assertBridgeConnectMarker(source), undefined);

console.log('ALL PASS  tests=5');
