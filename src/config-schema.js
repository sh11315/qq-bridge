// Read-only config schema checks.
//
// There is no migration here on purpose: a typo or a missing section must be
// reported, never silently rewritten. `config.example.json` is the shape
// reference; `schemaVersion` is the only field this module owns.

export const SCHEMA_VERSION = 1;

// Sections whose nested keys are worth checking. Top-level keys are always
// checked; checking every nested key of every section would be noisy because
// the example intentionally omits optional fields.
const CRITICAL_SECTIONS = [
  'dsh',
  'snowluma',
  'adminTurnTools',
  'allow',
  'deny',
  'socialV2',
  'webSearch',
  'api',
  'unifiedConsole',
];

function kindOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isPlainObject(value) {
  return kindOf(value) === 'object';
}

/**
 * Validate a parsed config object against the example shape.
 * Returns warnings and errors; `ok` is false only for real errors
 * (non-object config), not for schema warnings.
 */
export function validateConfig(config, example, { expectedVersion = SCHEMA_VERSION } = {}) {
  const warnings = [];
  const errors = [];
  const unknownTopLevel = [];
  const missingTopLevel = [];
  if (!isPlainObject(config)) {
    return {
      ok: false,
      schemaVersion: null,
      expectedVersion,
      warnings,
      errors: ['config 顶层必须是对象'],
      unknownTopLevel,
      missingTopLevel,
    };
  }
  const actualVersion = Number.isInteger(config.schemaVersion) ? config.schemaVersion : null;
  if (actualVersion === null) {
    warnings.push(`缺少 schemaVersion（按 0 处理；当前程序期望 ${expectedVersion}）`);
  } else if (actualVersion > expectedVersion) {
    warnings.push(`schemaVersion=${actualVersion} 高于当前程序支持的 ${expectedVersion}`);
  } else if (actualVersion < expectedVersion) {
    warnings.push(`schemaVersion=${actualVersion} 低于当前程序支持的 ${expectedVersion}（只告警，不自动迁移）`);
  }

  if (!isPlainObject(example)) {
    return { ok: true, schemaVersion: actualVersion, expectedVersion, warnings, errors, unknownTopLevel, missingTopLevel };
  }

  const exampleKeys = Object.keys(example);
  const configKeys = Object.keys(config);
  for (const key of configKeys) {
    if (!(key in example)) {
      unknownTopLevel.push(key);
      warnings.push(`未知顶层字段：${key}`);
    }
  }
  for (const key of exampleKeys) {
    if (!(key in config) && key !== 'schemaVersion') {
      missingTopLevel.push(key);
      warnings.push(`缺少顶层字段：${key}（会走默认值）`);
    }
  }

  // Nested unknown keys are not warnings: the example intentionally omits
  // feature-specific extensions (dsh.internal, socialV2.memory, ...). Only
  // top-level shape is treated as the contract, plus type checks for keys the
  // example does document.

  // Type checks only where the example has a definite value, so a null
  // placeholder in the example does not reject a valid real value.
  for (const key of exampleKeys) {
    const ex = example[key];
    if (!(key in config) || ex === null) continue;
    const exKind = kindOf(ex);
    const curKind = kindOf(config[key]);
    if (exKind !== curKind && curKind !== 'null') {
      warnings.push(`类型不符：${key} 期望 ${exKind}，实际 ${curKind}`);
    }
  }
  for (const section of CRITICAL_SECTIONS) {
    const ex = example[section];
    const cur = config[section];
    if (!isPlainObject(ex) || !isPlainObject(cur)) continue;
    for (const key of Object.keys(ex)) {
      if (!(key in cur) || ex[key] === null) continue;
      const exKind = kindOf(ex[key]);
      const curKind = kindOf(cur[key]);
      if (exKind !== curKind && curKind !== 'null') {
        warnings.push(`类型不符：${section}.${key} 期望 ${exKind}，实际 ${curKind}`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    schemaVersion: actualVersion,
    expectedVersion,
    warnings,
    errors,
    unknownTopLevel,
    missingTopLevel,
  };
}

export function formatConfigReport(result, label = 'config') {
  const lines = [`配置校验：${label}`];
  lines.push(`schemaVersion：${result.schemaVersion ?? '缺失'}（期望 ${result.expectedVersion}）`);
  if (result.errors.length) {
    lines.push(`错误 ${result.errors.length}：`);
    for (const item of result.errors) lines.push(`  - ${item}`);
  }
  if (result.warnings.length) {
    lines.push(`警告 ${result.warnings.length}：`);
    for (const item of result.warnings) lines.push(`  - ${item}`);
  } else {
    lines.push('警告 0');
  }
  return lines.join('\n');
}
