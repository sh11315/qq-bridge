// 记忆系统 —— 业务服务层（§6 MCP 工具背后的实现，CLI 与测试共用）。
//
// 设计原则：
// - MCP server 无状态：每次操作都从磁盘重新读（load → materialize），写操作在 store 的
//   跨进程锁内完成 load → mutate → materialize → save，两个 DSH 实例看到一致的数据；
// - 所有方法同步（fs 同步 + 锁同步），MCP handler/CLI/测试调用方式一致；
// - 业务失败抛 MemoryError（code 便于排查），MCP 层统一转成 isError 文本，绝不 throw 到 transport；
// - 时间源可注入：`new MemoryService({ repoRoot, now: () => fixed })`，测试用。
import { decideMemoryLayer, decideRetierLayer, shouldPromoteToLong } from './layer-policy.mjs';
import {
  DAY_MS,
  DEFAULT_CONFIG,
  DEFAULT_PERSONA_STATE,
  ENTITY_TYPES,
  MEMORY_CATEGORIES,
  MEMORY_LAYERS,
  MEMORY_STATUSES,
  MEMORY_TIERS,
  RELATION_TYPES,
  MemoryError,
  clamp,
  computeStrength,
  depthProfile,
  detectContradiction,
  emptyEntity,
  emptyMemory,
  entityId,
  extractKeywords,
  extractMemoryCandidates,
  hebbianWeight,
  isDiaryMemory,
  isPermanent,
  materializeBrain,
  materializeMemory,
  isDayMemory,
  memoryId,
  memoryTier,
  normalizeSelf,
  SELF_NARRATIVE_LIMIT,
  SELF_VALUE_LIMIT,
  SELF_DIGEST_LIMIT,
  PERSONA_ANCHOR_MAX,
  PERSONA_APPROVE_COOLDOWN_MS,
  normalizeDepth,
  normalizeName,
  normalizePersonaState,
  normalizeRelationType,
  normalizeText,
  relationGroupOf,
  relationLabelOf,
  retentionOf,
  publicEntity,
  publicMemory,
  publicRelation,
  relationId,
  personaStateSnapshot,
  round2,
  scoreMemory,
  sha1,
  spreadingActivation,
  suggestedDepth,
  textRelevance,
  textSimilarity,
} from './model.mjs';
import {
  DEFAULT_EMOTION_TTL_MS,
  EMOTION_LABELS,
  activeEmotions,
  emotionPrompt,
  normalizeEmotion,
  pruneEmotions,
} from './emotion.mjs';
import { SALIENCE_TIERS, salienceScore, salienceTier } from './salience.mjs';
import { normalizeProposal, weeklyReview } from './self-upgrade.mjs';
import fsSync from 'node:fs';
import { MemoryStore } from './store.mjs';
import fs from 'node:fs';
import path from 'node:path';

const LIMITS = Object.freeze({
  text: 2000,
  title: 60,
  keywordCount: 10,
  keywordLength: 40,
  keywordsStored: 20,
  entityNameCount: 10,
  entityNameLength: 60,
  tagCount: 20,
  tagLength: 30,
  aliasCount: 20,
  aliasLength: 60,
  relationCount: 30,
  recallLogKeep: 10,
  seqsKeep: 200,
  queryLength: 200,
  dedupeThreshold: 0.82,
  touchDefaultLimit: 3,
  touchMaxLimit: 10,
  recallReinforceTop: 3,
  searchDefaultLimit: 8,
  searchMaxLimit: 50,
  recallDefaultLimit: 5,
  recallMaxLimit: 20,
});

function uniqueList(list) {
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const value = normalizeText(item);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

// 日期过滤：按 createdAt 的**本地日期**（进程时区，本机 Asia/Shanghai）比较。
// 用于「昨天/几号/日记」这类检索，避免只靠关键词去撞正文。
const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function localDateKey(ts) {
  const date = new Date(Number(ts) || 0);
  if (!Number.isFinite(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeDateKey(raw, field) {
  const text = normalizeText(raw);
  if (!text) return null;
  const match = DATE_KEY_RE.exec(text);
  if (!match) throw new MemoryError(`${field} 需要 YYYY-MM-DD 格式（例如 2026-10-27）：${text}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(year, month - 1, day);
  if (check.getFullYear() !== year || check.getMonth() !== month - 1 || check.getDate() !== day) {
    throw new MemoryError(`${field} 不是合法日期：${text}`);
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function normalizeCategoryFilter(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const text = normalizeText(raw);
  if (!MEMORY_CATEGORIES.includes(text)) {
    throw new MemoryError(`category 无效：${text}（可选 ${MEMORY_CATEGORIES.join('/')}）`);
  }
  return text;
}

/**
 * 记忆服务：remember / search / recall / touch / pin / update / forget / entity / link / graph / stats
 * / materialize / seed。
 */
export class MemoryService {
  /**
   * @param {object} options
   * @param {string} [options.repoRoot] 仓库根（与 store 二选一）
   * @param {MemoryStore} [options.store] 复用已有 store（测试/CLI）
   * @param {(() => number)|number} [options.now] 时间源
   * @param {string} [options.stateDir] 覆盖 state 目录
   */
  constructor({ repoRoot, store, now = Date.now, stateDir } = {}) {
    this.now = typeof now === 'function' ? () => Number(now()) : () => Number(now) || Date.now();
    this.store = store ?? new MemoryStore({ repoRoot, now: this.now, stateDir });
    this._lastMutation = null;
  }

  paths() {
    return this.store.paths();
  }

  vaultDir() {
    return this.store.resolveVaultDir(this.store.load().config.vaultDir);
  }

  /** 只读物化快照（不落盘、不 purge）。 */
  snapshot() {
    const brain = this.store.load();
    materializeBrain(brain, this.now(), brain.config, { purge: false });
    return brain;
  }

  /** 供 CLI / vault：返回 {brain, vaultDir, now}（brain 已物化）。 */
  vaultContext() {
    const brain = this.snapshot();
    return { brain, vaultDir: this.store.resolveVaultDir(brain.config.vaultDir), now: this.now() };
  }

  /**
   * 写事务：锁 + load + materialize(含归档) + fn + save + 事件日志。
   * fn(brain, ctx) 里通过 ctx.event(type,id,detail) 登记事件；抛错则不落盘。
   */
  _mutate(fn) {
    return this.store.withLock(() => {
      const now = this.now();
      const brain = this.store.load();
      const config = brain.config;
      const events = [];
      const ctx = {
        now,
        config,
        event: (type, id = null, detail = null) => events.push({ type, id, detail }),
      };
      const materialized = materializeBrain(brain, now, config, { archive: true });
      for (const archived of materialized.archived) {
        events.push({ type: 'archive', id: archived.id, detail: { reason: archived.reason || 'decayed', title: archived.title, layer: archived.layer } });
      }
      // v1.6：materialize 会改 status/purgeAfter/fadingSince 等字段，但没有单独事件；
      // 增量 journal 需要把这些改动一起落盘，否则回放后宽限期会被重置。
      for (const id of materialized.changedIds || []) {
        if (!brain.memories[id]) continue;
        events.push({ type: 'update', id, detail: { fields: ['materialize'] } });
      }
      if (materialized.changed) events.push({ type: 'decay', id: null, detail: { archived: materialized.archived.length } });
      const result = fn(brain, ctx);
      materializeBrain(brain, now, config);
      brain.updatedAt = now;
      this.store.save(brain, { events });
      for (const event of events) {
        this.store.appendEvent(event, { at: now, keepBytes: config.eventLogKeepBytes });
      }
      this._lastMutation = { at: now, events, purged: [], archived: materialized.archived };
      return result;
    });
  }

  // -------------------------------------------------------------------------
  // 输入清洗
  // -------------------------------------------------------------------------

  _cleanText(value, { field = 'text', max = LIMITS.text } = {}) {
    const text = normalizeText(value);
    if (!text) throw new MemoryError(`${field} 不能为空`);
    if (text.length > max) throw new MemoryError(`${field} 过长（最多 ${max} 字符，实际 ${text.length}）`);
    return text;
  }

  _cleanTitle(value, fallback = '') {
    const title = normalizeText(value);
    if (!title) return normalizeText(fallback).slice(0, LIMITS.title);
    return title.slice(0, LIMITS.title);
  }

  _cleanList(value, { max = 10, itemMax = 30, field = 'list' } = {}) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new MemoryError(`${field} 需要字符串数组`);
    const out = [];
    const seen = new Set();
    for (const item of value) {
      if (item === undefined || item === null) continue;
      const clean = normalizeText(item).slice(0, itemMax);
      if (!clean) continue;
      const key = clean.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(clean);
      if (out.length >= max) break;
    }
    return out;
  }

  _cleanLayer(value, { allowNull = true } = {}) {
    if (value === undefined || value === null || value === '') {
      if (allowNull) return null;
      throw new MemoryError('layer 不能为空');
    }
    if (!MEMORY_LAYERS.includes(value)) {
      throw new MemoryError(`layer 无效：${value}（可选 ${MEMORY_LAYERS.join('/')}）`);
    }
    return value;
  }

  _cleanCategory(value) {
    if (value === undefined || value === null || value === '') return null;
    if (!MEMORY_CATEGORIES.includes(value)) {
      throw new MemoryError(`category 无效：${value}（可选 ${MEMORY_CATEGORIES.join('/')}）`);
    }
    return value;
  }

  _cleanSource(raw, { defaultKind = 'chat', defaultKey = 'manual' } = {}) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const key = normalizeText(source.key ?? source.sourceKey ?? defaultKey).slice(0, 200) || defaultKey;
    const kindRaw = normalizeText(source.kind ?? defaultKind).slice(0, 40) || defaultKind;
    const createdBy = normalizeText(source.createdBy ?? 'bot').slice(0, 40) || 'bot';
    const seqs = Array.isArray(source.seqs)
      ? source.seqs.map((n) => Number(n)).filter((n) => Number.isFinite(n)).slice(-LIMITS.seqsKeep)
      : [];
    return { kind: kindRaw, key, seqs, createdBy };
  }

  _mergeSource(existing, incoming) {
    const out = existing && typeof existing === 'object' ? { ...existing } : { ...incoming };
    const keys = new Set(
      [...(Array.isArray(out.keys) ? out.keys : []), out.key, incoming.key].filter(Boolean).map((k) => normalizeText(k))
    );
    out.kind = out.kind || incoming.kind;
    out.key = out.key || incoming.key;
    if (keys.size > 1) out.keys = [...keys];
    const seqs = new Set([...(Array.isArray(out.seqs) ? out.seqs : []), ...(incoming.seqs ?? [])].map(Number));
    out.seqs = [...seqs].filter((n) => Number.isFinite(n)).slice(-LIMITS.seqsKeep);
    if (!out.createdBy && incoming.createdBy) out.createdBy = incoming.createdBy;
    return out;
  }

  // -------------------------------------------------------------------------
  // 实体 / 关系
  // -------------------------------------------------------------------------

  /** 按 ent_id / 名字 / 别名找实体。 */
  _findEntityByNameOrId(brain, ref) {
    if (ref === undefined || ref === null) return null;
    const raw = normalizeText(ref);
    if (!raw) return null;
    if (brain.entities[raw]) return brain.entities[raw];
    const needle = normalizeName(raw);
    if (!needle) return null;
    for (const entity of Object.values(brain.entities)) {
      if (!entity) continue;
      if (normalizeName(entity.name) === needle) return entity;
      if (Array.isArray(entity.aliases) && entity.aliases.some((alias) => normalizeName(alias) === needle)) return entity;
    }
    return null;
  }

  _createEntity(brain, { name, type = 'topic', aliases = [], tags = [], note = '', source = null }, ctx) {
    const cleanName = normalizeText(name).slice(0, LIMITS.entityNameLength);
    const cleanType = ENTITY_TYPES.includes(type) ? type : 'topic';
    const id = entityId(cleanType, cleanName);
    if (brain.entities[id]) return brain.entities[id];
    const entity = emptyEntity({ type: cleanType, name: cleanName, now: ctx.now }, source ?? null);
    entity.id = id;
    entity.aliases = uniqueList(aliases).slice(0, LIMITS.aliasCount);
    entity.tags = uniqueList(tags);
    entity.note = typeof note === 'string' ? note.slice(0, 500) : '';
    entity.mentionCount = 1;
    entity.firstSeenAt = ctx.now;
    entity.lastMentionedAt = ctx.now;
    entity.createdAt = ctx.now;
    entity.updatedAt = ctx.now;
    brain.entities[id] = entity;
    ctx.event('entity', id, { created: true, name: entity.name, type: entity.type });
    return entity;
  }

  _touchEntityMention(entity, ctx, { seed = false } = {}) {
    if (seed) {
      entity.mentionCount = Math.max(1, Number(entity.mentionCount) || 1);
    } else {
      entity.mentionCount = (Number(entity.mentionCount) || 1) + 1;
    }
    entity.lastMentionedAt = ctx.now;
    entity.updatedAt = ctx.now;
    // v1.6：实体提及也需要事件，增量 journal 才能回放 mentionCount。
    ctx.event('entity', entity.id, { mentionCount: entity.mentionCount, updated: true, seed });
    return entity;
  }

  _upsertRelation(
    brain,
    { from, to, relation, note = '', weight = 1, source = null, incrementWeight = true },
    ctx
  ) {
    if (!from || !to) throw new MemoryError('关系需要 from 和 to', 'BAD_RELATION');
    // v1.4：关系类型统一归一（20 类规范名 + knows/related/alias_of 等旧类型）。
    const relationType = normalizeRelationType(relation);
    if (from === to && relationType !== 'alias_of') return null;
    const id = relationId(from, relationType, to);
    const existing = brain.relations.find((item) => item?.id === id);
    if (existing) {
      if (incrementWeight) existing.weight = Math.min(99, (Number(existing.weight) || 1) + 1);
      if (typeof note === 'string' && note) existing.note = note.slice(0, 200);
      existing.updatedAt = ctx.now;
      ctx.event('link', id, { relation: relationType, updated: true });
      return existing;
    }
    const rel = {
      id,
      from,
      to,
      relation: relationType,
      weight: clamp(Number(weight) || 1, 1, 99),
      note: typeof note === 'string' ? note.slice(0, 200) : '',
      source: source && typeof source === 'object' ? source : null,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    };
    brain.relations.push(rel);
    ctx.event('link', id, { from, to, relation: relationType });
    return rel;
  }

  /** 记忆 ↔ 实体挂接（不存在则 upsert 为 topic 实体）。 */
  _attachEntities(brain, memory, entityNames, ctx, { seed = false } = {}) {
    const ids = new Set(Array.isArray(memory.entityIds) ? memory.entityIds : []);
    if (entityNames === undefined) {
      memory.entityIds = [...ids].slice(0, ctx.config.maxMemoriesPerEntityLink);
      return memory.entityIds;
    }
    const names = this._cleanList(entityNames, {
      max: LIMITS.entityNameCount,
      itemMax: LIMITS.entityNameLength,
      field: 'entityNames',
    });
    for (const name of names) {
      let entity = this._findEntityByNameOrId(brain, name);
      if (!entity) {
        entity = this._createEntity(brain, { name, type: 'topic' }, ctx);
      } else {
        this._touchEntityMention(entity, ctx, { seed });
      }
      ids.add(entity.id);
    }
    memory.entityIds = [...ids].slice(0, ctx.config.maxMemoriesPerEntityLink);
    return memory.entityIds;
  }

  /** remember 附带的关系：{from?, to, relation?, note?}，默认从第一条记忆实体连到 to。 */
  _attachRelations(brain, memory, rawRelations, ctx) {
    if (!Array.isArray(rawRelations) || !rawRelations.length) return [];
    const out = [];
    const defaultFromId = Array.isArray(memory.entityIds) ? memory.entityIds[0] : null;
    for (const item of rawRelations.slice(0, LIMITS.relationCount)) {
      if (!item || typeof item !== 'object') continue;
      const toRef = item.to ?? item.toName ?? item.target;
      if (toRef === undefined || toRef === null || !normalizeText(toRef)) continue;
      let from = null;
      if (item.from !== undefined && item.from !== null) {
        from = this._findEntityByNameOrId(brain, item.from);
        if (!from) from = this._createEntity(brain, { name: String(item.from), type: 'topic' }, ctx);
      } else if (defaultFromId) {
        from = brain.entities[defaultFromId] ?? null;
      }
      if (!from) continue;
      let to = this._findEntityByNameOrId(brain, toRef);
      if (!to) to = this._createEntity(brain, { name: String(toRef), type: 'topic' }, ctx);
      const relation = this._upsertRelation(
        brain,
        { from: from.id, to: to.id, relation: item.relation, note: item.note ?? '', weight: item.weight ?? 1 },
        ctx
      );
      if (relation) out.push(relation);
    }
    return out;
  }

  /** entity 工具的写实现（seed 复用）。 */
  _applyEntity(brain, raw = {}, ctx, { seed = false } = {}) {
    const name = normalizeText(raw.name).slice(0, LIMITS.entityNameLength);
    if (!name) throw new MemoryError('entity.name 不能为空');
    const requestedType = raw.type === undefined || raw.type === null || raw.type === '' ? null : String(raw.type);
    if (requestedType && !ENTITY_TYPES.includes(requestedType)) {
      throw new MemoryError(`实体 type 无效：${requestedType}（可选 ${ENTITY_TYPES.join('/')}）`);
    }
    const aliases = this._cleanList(raw.aliases ?? [], {
      max: LIMITS.aliasCount,
      itemMax: LIMITS.aliasLength,
      field: 'aliases',
    });
    const tags = this._cleanList(raw.tags ?? [], { max: LIMITS.tagCount, itemMax: LIMITS.tagLength, field: 'tags' });
    const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, 500) : undefined;
    const source = raw.source ? this._cleanSource(raw.source, { defaultKind: 'chat', defaultKey: 'manual' }) : null;

    const sameName = this._findEntityByNameOrId(brain, name);
    const notices = [];
    const relationsOut = [];
    let entity;
    let created = false;

    if (sameName && (!requestedType || sameName.type === requestedType)) {
      entity = sameName;
      entity.aliases = uniqueList([...(Array.isArray(entity.aliases) ? entity.aliases : []), ...aliases]).slice(
        0,
        LIMITS.aliasCount
      );
      entity.tags = uniqueList([...(Array.isArray(entity.tags) ? entity.tags : []), ...tags]);
      if (note !== undefined && note) entity.note = note;
      if (source && !entity.source) entity.source = source;
      this._touchEntityMention(entity, ctx, { seed });
    } else if (sameName && requestedType && sameName.type !== requestedType) {
      entity = this._createEntity(brain, { name, type: requestedType, aliases, tags, note: note ?? '', source }, ctx);
      created = true;
      const aliasRelation = this._upsertRelation(
        brain,
        { from: entity.id, to: sameName.id, relation: 'alias_of', note: `同名不同类别（已有 ${sameName.type}）` },
        ctx
      );
      if (aliasRelation) relationsOut.push(aliasRelation);
      notices.push(`已存在同名 ${sameName.type} 实体「${sameName.name}」，新建 ${requestedType} 实体并建立 alias_of 关系`);
    } else {
      entity = this._createEntity(brain, { name, type: requestedType ?? 'topic', aliases, tags, note: note ?? '', source }, ctx);
      created = true;
    }

    for (const item of Array.isArray(raw.relations) ? raw.relations.slice(0, LIMITS.relationCount) : []) {
      if (!item || typeof item !== 'object') continue;
      const toRef = item.to ?? item.toName ?? item.target;
      if (toRef === undefined || toRef === null || !normalizeText(toRef)) continue;
      let target = this._findEntityByNameOrId(brain, toRef);
      if (!target) {
        target = this._createEntity(brain, { name: String(toRef), type: 'topic' }, ctx);
        notices.push(`关系目标「${normalizeText(toRef)}」不存在，已创建 topic 实体`);
      } else if (!seed) {
        this._touchEntityMention(target, ctx);
      }
      const relation = this._upsertRelation(
        brain,
        { from: entity.id, to: target.id, relation: item.relation, note: item.note ?? '', weight: item.weight ?? 1, source },
        ctx
      );
      if (relation) relationsOut.push(relation);
    }

    ctx.event('entity', entity.id, {
      created,
      name: entity.name,
      type: entity.type,
      relationCount: relationsOut.length,
      seed,
    });
    return {
      ok: true,
      created,
      entity: publicEntity(entity),
      relations: relationsOut.map(publicRelation),
      notices,
    };
  }

  // -------------------------------------------------------------------------
  // remember
  // -------------------------------------------------------------------------

  /** remember 的写实现（seed 复用）。 */
  _applyRemember(brain, raw = {}, ctx) {
    const text = this._cleanText(raw.text, { field: 'text', max: LIMITS.text });
    const tags = this._cleanList(raw.tags ?? [], { max: LIMITS.tagCount, itemMax: LIMITS.tagLength, field: 'tags' });
    const isDiary = tags.some((tag) => String(tag).trim().toLowerCase() === 'diary');
    const protection = raw.protection === undefined || raw.protection === null ? 0 : clamp(Number(raw.protection), 0, 1);
    const category = this._cleanCategory(raw.category) ?? (isDiary ? 'event' : ctx.config.defaultCategory);
    // 2026-11-22 层级策略：不再直接采信调用方给的 layer，统一走 decideMemoryLayer
    // （日层/日记/承诺/长期偏好/关系/档案/永久 → 长期；事件/事实/话题 → 短期，被反复想起才升级）。
    // 之前模型习惯性传 layer:'long'，长期层被一次性事件灌满；这里只把它当「意愿」，由策略裁决。
    const layer = decideMemoryLayer({
      requested: this._cleanLayer(raw.layer),
      category,
      isDiary,
      isDay: category === 'day',
      permanent: raw.permanent === true,
      protection,
      activationCount: 0,
    });
    const title = this._cleanTitle(raw.title, text.slice(0, 30));
    const keywordsGiven =
      raw.keywords === undefined || raw.keywords === null
        ? null
        : this._cleanList(raw.keywords, {
            max: LIMITS.keywordCount,
            itemMax: LIMITS.keywordLength,
            field: 'keywords',
          });
    const keywords =
      keywordsGiven && keywordsGiven.length
        ? keywordsGiven
        : extractKeywords(`${title} ${text}`, { limit: LIMITS.keywordCount });
    const decayDays =
      raw.decayDays === undefined || raw.decayDays === null
        ? layer === 'long'
          ? ctx.config.decayDaysLong
          : ctx.config.decayDaysShort
        : clamp(Math.round(Number(raw.decayDays)) || 1, 1, 3650);
    const source = this._cleanSource(raw.source, { defaultKind: 'chat', defaultKey: 'manual' });
    // 有效期：expiresAt（毫秒或 ISO）优先，其次 validForMinutes/validForDays；
    // 「今晚不关机」这种一次性事实不该跟常驻事实一样躺到 200 天后。
    let expiresAt = 0;
    if (raw.expiresAt !== undefined && raw.expiresAt !== null && raw.expiresAt !== '') {
      expiresAt = typeof raw.expiresAt === 'number' ? raw.expiresAt : (Number.isFinite(Date.parse(String(raw.expiresAt))) ? Date.parse(String(raw.expiresAt)) : 0);
    } else if (raw.validForMinutes !== undefined && raw.validForMinutes !== null) {
      expiresAt = ctx.now + Math.max(1, Number(raw.validForMinutes) || 0) * 60 * 1000;
    } else if (raw.validForDays !== undefined && raw.validForDays !== null) {
      expiresAt = ctx.now + Math.max(1, Number(raw.validForDays) || 0) * 24 * 3600 * 1000;
    }
    expiresAt = Math.max(0, Math.round(expiresAt) || 0);
    const dedupe = raw.dedupe !== false;
    const identity = memoryId(text, source.key);

    // 1) 同 id（同文本 + 同来源）或同层高相似度 → 合并
    let existing = brain.memories[identity] ?? null;
    if (!existing && dedupe) {
      let best = null;
      let bestScore = 0;
      for (const candidate of Object.values(brain.memories)) {
        if (!candidate || candidate.layer !== layer) continue;
        if (candidate.status === 'archived') continue;
        const similarity = textSimilarity(text, candidate.text);
        if (similarity >= LIMITS.dedupeThreshold && similarity > bestScore) {
          best = candidate;
          bestScore = similarity;
        }
      }
      existing = best;
    }

    if (existing) {
      const newLen = normalizeText(text).length;
      if (newLen > normalizeText(existing.text).length) {
        existing.text = text;
        if (title) existing.title = title;
      }
      existing.keywords = uniqueList([...(Array.isArray(existing.keywords) ? existing.keywords : []), ...keywords]).slice(
        0,
        LIMITS.keywordsStored
      );
      existing.tags = uniqueList([...(Array.isArray(existing.tags) ? existing.tags : []), ...tags]);
      if (!existing.category || existing.category === 'other') existing.category = category;
      existing.protection = Math.max(Number(existing.protection) || 0, protection);
      existing.permanent = isPermanent(existing);
      existing.decayDays = Math.max(1, Number(existing.decayDays) || decayDays);
      existing.decayCurve = existing.decayCurve === 'ebbinghaus' || ctx.config.decayCurve === 'ebbinghaus' ? 'ebbinghaus' : 'linear';
      existing.source = this._mergeSource(existing.source, source);
      if (expiresAt > 0) existing.expiresAt = expiresAt;
      this._attachEntities(brain, existing, raw.entityNames, ctx);
      if (raw.relations) this._attachRelations(brain, existing, raw.relations, ctx);
      this._activate(existing, ctx.now);
      if (existing.permanent) {
        existing.strength = 1;
        existing.status = 'active';
        existing.fadingSince = null;
        existing.purgeAfter = null;
      }
      existing.updatedAt = ctx.now;
      ctx.event('remember', existing.id, { merged: true, layer: existing.layer, source: source.key });
      const superseded = this._applySupersede(brain, existing, raw, ctx);
      return {
        ok: true,
        id: existing.id,
        created: false,
        mergedInto: existing.id,
        superseded,
        memory: publicMemory(existing),
      };
    }

    // 2) 新建
    this._enforceMaxMemories(brain, ctx, layer);
    const memory = emptyMemory({
      text,
      title,
      layer,
      category,
      keywords,
      tags,
      protection,
      decayDays,
      decayCurve: ctx.config.decayCurve,
      expiresAt,
      source,
      now: ctx.now,
    });
    memory.id = identity;
    brain.memories[memory.id] = memory;
    this._attachEntities(brain, memory, raw.entityNames, ctx);
    if (raw.relations) this._attachRelations(brain, memory, raw.relations, ctx);
    ctx.event('remember', memory.id, { title: memory.title, layer: memory.layer, source: source.key });
    const superseded = this._applySupersede(brain, memory, raw, ctx);
    return { ok: true, id: memory.id, created: true, superseded, memory: publicMemory(memory) };
  }

  /**
   * v1.3 矛盾降权（新压旧）：把被新记忆取代的旧记忆标记 superseded。
   * - 显式 raw.supersedes（id 列表）优先；
   * - 否则用 detectContradiction 启发式扫描（新文本含变更词 + 主题重叠），避免误杀；
   * - 永久记忆/日记/已归档/已降权不参与；不删除，保留时间线。
   * @returns {string[]} 被降权的旧记忆 id
   */
  _applySupersede(brain, memory, raw = {}, ctx) {
    const superseded = [];
    const reasons = new Map();
    const explicit = Array.isArray(raw.supersedes)
      ? raw.supersedes.map((id) => normalizeText(id)).filter(Boolean).slice(0, 20)
      : [];
    for (const id of explicit) {
      const target = brain.memories[id];
      if (!target || target.id === memory.id) continue;
      if (['archived', 'superseded'].includes(target.status)) continue;
      reasons.set(target.id, 'explicit');
    }
    // 启发式：只认「最像的少数几条」，且候选一多就说明主题泛化（易误杀），宁可不动。
    const heuristic = [];
    for (const candidate of Object.values(brain.memories)) {
      if (!candidate || candidate.id === memory.id) continue;
      if (reasons.has(candidate.id)) continue;
      if (isPermanent(candidate) || isDiaryMemory(candidate)) continue;
      if (['archived', 'superseded'].includes(candidate.status)) continue;
      const verdict = detectContradiction(candidate, memory);
      if (verdict.conflict && verdict.score >= 0.4) {
        heuristic.push({ id: candidate.id, score: verdict.score, reason: verdict.reason });
      }
    }
    heuristic.sort((a, b) => b.score - a.score);
    if (heuristic.length > 0 && heuristic.length <= 2) {
      for (const item of heuristic) reasons.set(item.id, `${item.reason}（score=${item.score}）`);
    }
    if (!reasons.size) return superseded;
    const supersedes = new Set(Array.isArray(memory.supersedes) ? memory.supersedes : []);
    for (const [id, reason] of reasons) {
      const target = brain.memories[id];
      target.status = 'superseded';
      target.supersededBy = memory.id;
      target.supersededAt = Number(ctx.now);
      target.deprioritized = true;
      target.updatedAt = Number(ctx.now);
      superseded.push(id);
      supersedes.add(id);
      ctx.event('supersede', id, { by: memory.id, reason: String(reason).slice(0, 160), title: target.title });
    }
    // v1.4：冲突落成 SUPERSEDES 突触（第 5 类关系），图谱/召回能直接看到「新压旧」。
    if (!Array.isArray(brain.synapses)) brain.synapses = [];
    for (const id of superseded) {
      const pair = [memory.id, id].sort();
      const synId = `syn_${sha1(pair.join('|') + '|SUPERSEDES').slice(0, 16)}`;
      const existing = brain.synapses.find((synapse) => synapse && synapse.id === synId);
      if (existing) {
        existing.coactivations = (Number(existing.coactivations) || 0) + 1;
        existing.lastAt = Number(ctx.now);
        existing.updatedAt = Number(ctx.now);
        ctx.event('synapse', synId, { from: pair[0], to: pair[1], type: 'SUPERSEDES', updated: true });
      } else {
        brain.synapses.push({
          id: synId,
          from: pair[0],
          to: pair[1],
          type: 'SUPERSEDES',
          coactivations: 1,
          weight: 1,
          lastAt: Number(ctx.now),
          createdAt: Number(ctx.now),
          updatedAt: Number(ctx.now),
        });
        ctx.event('synapse', synId, { from: pair[0], to: pair[1], type: 'SUPERSEDES' });
      }
    }
    memory.supersedes = [...supersedes].slice(0, 20);
    ctx.event('supersede', memory.id, { superseded, reason: 'new-supersedes-old', count: superseded.length });
    return superseded;
  }

  /**
   * v1.3 Hebbian 学习：recall 命中的记忆两两建立/加强共激活突触。
   * 只记 top 5 内两两关系（最多 10 条边），事件只在新建边时写，避免日志膨胀。
   * @returns {{learned: number, total: number}}
   */
  _recordCoactivation(ids = []) {
    const clean = [...new Set(ids.map((id) => normalizeText(id)).filter(Boolean))].slice(0, 5);
    if (clean.length < 2) return { learned: 0, total: 0 };
    const result = this._mutate((brain, ctx) => {
      if (!Array.isArray(brain.synapses)) brain.synapses = [];
      const byId = new Map(brain.synapses.map((synapse) => [synapse.id, synapse]));
      let learned = 0;
      for (let i = 0; i < clean.length; i += 1) {
        for (let j = i + 1; j < clean.length; j += 1) {
          if (!brain.memories[clean[i]] || !brain.memories[clean[j]]) continue;
          const pair = [clean[i], clean[j]].sort();
          const id = `syn_${sha1(pair.join('|') + '|COACTIVATED').slice(0, 16)}`;
          const existing = byId.get(id);
          if (existing) {
            existing.coactivations = (Number(existing.coactivations) || 0) + 1;
            existing.weight = hebbianWeight(existing.coactivations);
            existing.lastAt = Number(ctx.now);
            existing.updatedAt = Number(ctx.now);
            // v1.6：已有突触的权重变化也要事件，否则增量 journal 回放会丢。
            ctx.event('synapse', id, { from: pair[0], to: pair[1], coactivations: existing.coactivations, updated: true });
          } else {
            const synapse = {
              id,
              from: pair[0],
              to: pair[1],
              type: 'COACTIVATED',
              coactivations: 1,
              weight: hebbianWeight(1),
              lastAt: Number(ctx.now),
              createdAt: Number(ctx.now),
              updatedAt: Number(ctx.now),
            };
            brain.synapses.push(synapse);
            byId.set(id, synapse);
            learned += 1;
            ctx.event('synapse', id, { from: pair[0], to: pair[1], coactivations: 1 });
          }
        }
      }
      ctx.event('recall', null, { coactivated: clean, newSynapses: learned });
      return { learned, total: brain.synapses.length };
    });
    return result;
  }

  _activate(memory, now) {
    memory.baseStrength = 1;
    memory.strength = 1;
    memory.status = 'active';
    memory.fadingSince = null;
    memory.purgeAfter = null;
    memory.lastActivatedAt = Number(now);
    memory.activationCount = (Number(memory.activationCount) || 0) + 1;
    // 2026-11-22 层级策略：短期记忆被反复想起（激活次数够）才升长期，避免「随手写就长期」。
    if (shouldPromoteToLong(memory)) {
      memory.layer = 'long';
      memory.decayDays = Math.max(1, Number(DEFAULT_CONFIG.decayDaysLong) || 200);
    }
    return memory;
  }

  /**
   * §4/v1.6 maxMemories：超限时归档最弱/最久未激活的非永久、非日记记忆。
   * v1.6 起容量按层拆分：long / short 各自独立配额，别让长期记忆和短记忆互相抢名额；
   * 短期层保持高淘汰（默认 5000），长期层默认 20000。永久记忆与日记不占配额。
   */
  _enforceMaxMemories(brain, ctx, layer = 'short') {
    const which = layer === 'long' ? 'long' : 'short';
    const configured = which === 'long' ? ctx.config.maxMemoriesLong : ctx.config.maxMemoriesShort;
    const cap = Math.max(
      1,
      Number(configured) || (which === 'long' ? DEFAULT_CONFIG.maxMemoriesLong : DEFAULT_CONFIG.maxMemoriesShort)
    );
    const candidates = () =>
      Object.values(brain.memories).filter(
        (memory) =>
          memory &&
          !isPermanent(memory) &&
          !isDiaryMemory(memory) &&
          memory.status !== 'archived' &&
          (memory.layer === 'long' ? 'long' : 'short') === which
      );
    let count = candidates().length + 1; // 即将新增的这条
    while (count > cap) {
      const list = candidates();
      list.sort(
        (a, b) =>
          (Number(a.strength) || 0) - (Number(b.strength) || 0) ||
          (Number(a.lastActivatedAt) || 0) - (Number(b.lastActivatedAt) || 0)
      );
      const victim = list[0];
      if (!victim) {
        throw new MemoryError(`记忆库已满（${which} 层 ${cap} 条且全部为永久记忆），无法新增`, 'CAPACITY');
      }
      victim.status = 'archived';
      victim.archivedAt = Number(ctx.now);
      victim.archivedReason = 'capacity';
      victim.updatedAt = Number(ctx.now);
      count -= 1;
      ctx.event('archive', victim.id, { reason: 'capacity', layer: which, title: victim.title });
    }
  }

  remember(raw = {}) {
    return this._mutate((brain, ctx) => this._applyRemember(brain, raw, ctx));
  }

  // -------------------------------------------------------------------------
  // search / recall
  // -------------------------------------------------------------------------

  /**
   * 只读检索（不重置衰减）。§6.3
   * @returns {{memories: object[], total: number}}
   */
  search(raw = {}) {
    const brain = this.snapshot();
    const now = this.now();
    const query = normalizeText(raw.query).slice(0, LIMITS.queryLength);
    const limit = clamp(Number(raw.limit ?? LIMITS.searchDefaultLimit) || LIMITS.searchDefaultLimit, 1, LIMITS.searchMaxLimit);
    const layer = this._cleanLayer(raw.layer);
    let statuses = null;
    if (raw.status !== undefined && raw.status !== null && raw.status !== '') {
      const list = (Array.isArray(raw.status) ? raw.status : String(raw.status).split(/[,\s]+/)).filter(Boolean);
      const invalid = list.filter((item) => !MEMORY_STATUSES.includes(item));
      if (invalid.length) {
        throw new MemoryError(`status 无效：${invalid.join(',')}（可选 ${MEMORY_STATUSES.join('/')}）`);
      }
      statuses = new Set(list);
    }
    let entityRef = null;
    if (raw.entity !== undefined && raw.entity !== null && normalizeText(raw.entity)) {
      entityRef = this._findEntityByNameOrId(brain, raw.entity);
      if (!entityRef) {
        return { memories: [], total: 0, hint: `没有找到实体「${normalizeText(raw.entity)}」` };
      }
    }
    // 三路召回之「实体」路（2026-10-28）：query 里直接提到实体名/别名时，即使正文词面不重合也召回。
    const queryLower = query.toLowerCase();
    const queryEntityIds = new Set();
    if (query && !entityRef) {
      for (const entity of Object.values(brain.entities || {})) {
        if (!entity) continue;
        const names = [entity.name, ...(Array.isArray(entity.aliases) ? entity.aliases : [])].filter(Boolean);
        const matched = names.some((name) => {
          const text = normalizeText(name).toLowerCase();
          return text.length >= 2 && queryLower.includes(text);
        });
        if (matched) queryEntityIds.add(entity.id);
      }
    }
    // 2026-10-28 新增：按日期/分类过滤（日记、昨天、几号这类检索用）。
    const dateKey = normalizeDateKey(raw.date, 'date');
    const sinceKey = normalizeDateKey(raw.since, 'since');
    const untilKey = normalizeDateKey(raw.until, 'until');
    if (sinceKey && untilKey && sinceKey > untilKey) {
      throw new MemoryError('since 不能晚于 until');
    }
    const category = normalizeCategoryFilter(raw.category);
    // v1.3 扩散激活（多跳召回）：depth 0 不扩散；1=默认一跳；2 ~200ms；3 ~500ms 深挖。
    // 种子 = query 直接命中的实体 + 字面相关度 ≥0.5 的记忆，沿实体/关系/共激活突触扩散。
    const depth = normalizeDepth(raw.depth, 1);
    const depthInfo = depthProfile(depth);
    let activation = {};
    if (depth > 0 && query) {
      const seedMemoryIds = [];
      for (const memory of Object.values(brain.memories)) {
        if (!memory || memory.status === 'archived' || memory.status === 'superseded') continue;
        if (textRelevance(query, memory) >= 0.5) seedMemoryIds.push(memory.id);
      }
      const spread = spreadingActivation(
        brain,
        { memoryIds: seedMemoryIds.slice(0, 8), entityIds: [...queryEntityIds] },
        { hops: depthInfo.hops, decay: 0.5 }
      );
      activation = spread.memories || {};
    }
    const includeFaded = raw.includeFaded === true || Boolean(statuses?.has('faded'));
    const includeArchived = Boolean(statuses?.has('archived'));
    const includeSuperseded = raw.includeSuperseded === true || Boolean(statuses?.has('superseded'));
    const results = [];
    for (const memory of Object.values(brain.memories)) {
      if (!memory) continue;
      if (memory.status === 'archived' && !includeArchived) continue;
      if (memory.status === 'superseded' && !includeSuperseded) continue;
      if (statuses) {
        if (!statuses.has(memory.status)) continue;
      } else {
        if (memory.status === 'faded' && !includeFaded) continue;
      }
      if (layer && memory.layer !== layer) continue;
      // 过了有效期的记忆不再参与检索（除非显式要翻旧账）：一次性事实到点就让它安静。
      const expiresAt = Number(memory.expiresAt) || 0;
      if (expiresAt > 0 && expiresAt <= now && raw.includeExpired !== true) continue;
      if (category && memory.category !== category) continue;
      if (dateKey || sinceKey || untilKey) {
        const memoryDate = localDateKey(memory.createdAt);
        if (dateKey && memoryDate !== dateKey) continue;
        if (sinceKey && memoryDate < sinceKey) continue;
        if (untilKey && memoryDate > untilKey) continue;
      }
      if (entityRef && !(Array.isArray(memory.entityIds) ? memory.entityIds : []).includes(entityRef.id)) continue;
      const memoryEntityIds = Array.isArray(memory.entityIds) ? memory.entityIds : [];
      const matchedEntities = queryEntityIds.size ? memoryEntityIds.filter((id) => queryEntityIds.has(id)).length : 0;
      const entityHit = entityRef ? 1 : clamp(matchedEntities / Math.max(1, Math.min(queryEntityIds.size, 2)), 0, 1);
      const relevance = query ? textRelevance(query, memory) : 0;
      const activationScore = Number(activation[memory.id]) || 0;
      // 有 query 时只返回“文本/实体/扩散激活确实相关”的记忆：排序公式里的强度/层级/新近度只决定
      // 相关记忆的先后，不能让完全无关的记忆靠强度挤进结果（那种结果对模型是误导）。
      if (query && entityHit <= 0 && relevance <= 0 && activationScore <= 0) continue;
      const score =
        scoreMemory(memory, { query, now, entityHit }) + depthInfo.activationWeight * activationScore;
      results.push({ memory, score });
    }
    results.sort(
      (a, b) =>
        b.score - a.score ||
        (Number(b.memory.updatedAt) || 0) - (Number(a.memory.updatedAt) || 0) ||
        String(a.memory.id).localeCompare(String(b.memory.id))
    );
    return {
      memories: results.slice(0, limit).map((item) => publicMemory(item.memory)),
      total: results.length,
      depth,
      depthProfile: { name: depthInfo.name, hops: depthInfo.hops },
      depthSource: raw.depth === undefined || raw.depth === null ? 'suggested' : 'explicit',
      suggestedDepth: suggestedDepth(query),
      activated: Object.keys(activation).length,
    };
  }

  /** §6.1 recall：search 排序 → 前 3 条 touch → 返回；v1.3 再对命中集做 Hebbian 共激活学习。 */
  recall(raw = {}) {
    const query = normalizeText(raw.query).slice(0, LIMITS.queryLength);
    const limit = clamp(
      Number(raw.limit ?? LIMITS.recallDefaultLimit) || LIMITS.recallDefaultLimit,
      1,
      LIMITS.recallMaxLimit
    );
    const found = this.search({
      query,
      entity: raw.entity,
      layer: raw.layer,
      date: raw.date,
      since: raw.since,
      until: raw.until,
      category: raw.category,
      depth: raw.depth,
      limit,
      includeFaded: false,
    });
    let memories = found.memories;
    const reinforced = [];
    if (raw.reinforce !== false && memories.length) {
      const top = memories.slice(0, LIMITS.recallReinforceTop).map((memory) => memory.id);
      try {
        const touched = this.touch({ ids: top, query: query || undefined });
        for (const item of touched.touched) reinforced.push(item.id);
      } catch (error) {
        // recall 的核心价值是“查到”，强化失败不影响返回；只记 stderr（MCP 层会看到，但不污染 stdout）。
        console.error(`[memory/service] recall 强化失败：${error?.message ?? error}`);
      }
    }
    // v1.3：被同一轮召回的记忆两两建立共激活突触（Hebbian：一起激发就连起来）。
    let learned = 0;
    if (raw.reinforce !== false && memories.length >= 2) {
      const top = memories.slice(0, 5).map((memory) => memory.id);
      try {
        learned = this._recordCoactivation(top).learned;
      } catch (error) {
        console.error(`[memory/service] 共激活学习失败：${error?.message ?? error}`);
      }
    }
    if (reinforced.length) {
      const fresh = this.snapshot();
      memories = memories.map((memory) => (fresh.memories[memory.id] ? publicMemory(fresh.memories[memory.id]) : memory));
    }
    const brain = this.snapshot();
    return {
      memories,
      reinforced,
      learned,
      depth: found.depth,
      depthProfile: found.depthProfile,
      suggestedDepth: found.suggestedDepth,
      hint: this._recallHint(brain, memories, reinforced, query, learned),
    };
  }

  _recallHint(brain, memories, reinforced, query, learned = 0) {
    const all = Object.values(brain.memories).filter(Boolean);
    const total = all.length;
    if (!memories.length) {
      if (!total) {
        return '记忆库还是空的（0 条记忆）。当前对话里值得长期保留的信息，可以先用 remember 记下来。';
      }
      return `没有找到和当前话题相关的记忆（库内共 ${total} 条）。可以换个关键词/实体再查，或用 remember 记下新信息。`;
    }
    const permanentCount = memories.filter((memory) => memory.permanent).length;
    const fadingCount = memories.filter((memory) => memory.status === 'fading').length;
    const parts = [
      `找到 ${memories.length} 条相关记忆（库内共 ${total} 条）`,
      reinforced.length
        ? `已强化 ${reinforced.length} 条：强度重置为 1，衰减重新计时`
        : '本次只读检索，未重置衰减',
    ];
    if (learned) parts.push(`共激活学习：新建 ${learned} 条突触，下次同类话题更容易一起召回`);
    if (permanentCount) parts.push(`其中 ${permanentCount} 条为永久记忆`);
    if (fadingCount) parts.push(`${fadingCount} 条已进入淡忘边缘，再提起即可唤醒`);
    if (query) parts.push(`query=「${query}」`);
    return `${parts.join('；')}。`;
  }

  /**
   * v1.3 ingest：零 LLM 抽取入库（对应视频里的 nmem_auto / 三阶段收尾）。
   * 把一段对话/笔记按规则切成候选事实（decision/promise/preference/error/todo），逐条 remember。
   * @returns {{ok:boolean, dryRun?:boolean, candidates:object[], created:number, merged:number, ids:string[], superseded:string[]}}
   */
  ingest(raw = {}) {
    const text = this._cleanText(raw.text, { field: 'text', max: 8000 });
    const max = clamp(Number(raw.max) || 6, 1, 10);
    const candidates = extractMemoryCandidates(text, { max });
    if (raw.dryRun === true) {
      return { ok: true, dryRun: true, candidates, created: 0, merged: 0, ids: [], superseded: [] };
    }
    if (!candidates.length) {
      return { ok: true, candidates, created: 0, merged: 0, ids: [], superseded: [] };
    }
    const ids = [];
    let created = 0;
    let merged = 0;
    const superseded = [];
    for (const candidate of candidates) {
      try {
        const result = this.remember({
          text: candidate.text,
          title: candidate.text.slice(0, 28),
          category: candidate.category,
          tags: ['auto', ...(candidate.tags || [])],
          layer: raw.layer || 'short',
          source: raw.source,
          keywords: raw.keywords,
        });
        ids.push(result.id);
        if (result.created) created += 1;
        else merged += 1;
        for (const id of result.superseded || []) if (!superseded.includes(id)) superseded.push(id);
      } catch (error) {
        console.error(`[memory/service] ingest 候选落库失败：${error?.message ?? error}`);
      }
    }
    return { ok: true, candidates, created, merged, ids, superseded };
  }

  // -------------------------------------------------------------------------
  // touch / pin / update / forget
  // -------------------------------------------------------------------------

  /** §6.4 touch：重置衰减（baseStrength=1、重新计时）。ids 与 query 可同时给。 */
  touch(raw = {}) {
    const ids = Array.isArray(raw.ids)
      ? raw.ids.map((id) => normalizeText(id)).filter(Boolean).slice(0, 50)
      : raw.id
        ? [normalizeText(raw.id)].filter(Boolean)
        : [];
    const query = normalizeText(raw.query).slice(0, LIMITS.queryLength);
    const limit = clamp(
      Number(raw.limit ?? LIMITS.touchDefaultLimit) || LIMITS.touchDefaultLimit,
      1,
      LIMITS.touchMaxLimit
    );
    if (!ids.length && !query) throw new MemoryError('touch 需要 ids 或 query（至少一个）');
    const targets = [...new Set(ids)];
    if (query) {
      const found = this.search({ query, limit, includeFaded: true });
      for (const memory of found.memories) if (!targets.includes(memory.id)) targets.push(memory.id);
    }
    if (!targets.length) return { touched: [], missed: ids };
    return this._mutate((brain, ctx) => {
      const touched = [];
      const missed = [];
      const seen = new Set();
      for (const id of targets) {
        const memory = brain.memories[id];
        if (!memory || memory.status === 'archived' || memory.status === 'superseded') {
          missed.push(id);
          continue;
        }
        if (seen.has(id)) continue;
        seen.add(id);
        this._activate(memory, ctx.now);
        if (memory.permanent) {
          memory.strength = 1;
          memory.status = 'active';
          memory.fadingSince = null;
          memory.purgeAfter = null;
        }
        if (query) {
          memory.recallLog = [
            ...(Array.isArray(memory.recallLog) ? memory.recallLog : []),
            { at: ctx.now, query },
          ].slice(-LIMITS.recallLogKeep);
        }
        memory.updatedAt = ctx.now;
        ctx.event('touch', id, { query: query || undefined });
        touched.push({ id, title: memory.title, strength: memory.strength });
      }
      return { touched, missed: missed.filter((id) => !touched.some((item) => item.id === id)) };
    });
  }

  /** §6.5 pin：protection=1 → permanent（备注 1 永久保留）；protection=0 取消永久。 */
  pin(raw = {}) {
    const id = raw.id === undefined || raw.id === null ? null : normalizeText(raw.id);
    const query = normalizeText(raw.query).slice(0, LIMITS.queryLength);
    const protection = raw.protection === undefined || raw.protection === null ? 1 : clamp(Number(raw.protection), 0, 1);
    if (!id && !query) throw new MemoryError('pin 需要 id 或 query（至少一个）');
    let targetId = id;
    if (!targetId) {
      const found = this.search({ query, limit: 1 });
      targetId = found.memories[0]?.id ?? null;
    }
    if (!targetId) {
      throw new MemoryError(`没有找到要 pin 的记忆${query ? `（query=「${query}」）` : ''}`, 'NOT_FOUND');
    }
    return this._mutate((brain, ctx) => {
      const memory = brain.memories[targetId];
      if (!memory) throw new MemoryError(`记忆不存在：${targetId}`, 'NOT_FOUND');
      memory.protection = protection;
      memory.permanent = isPermanent(memory);
      // v1.3：手动 pin 一条被矛盾降权的旧记忆 = 明确恢复它，解除冻结。
      if (memory.status === 'superseded') {
        memory.status = 'active';
        memory.supersededBy = null;
        memory.supersededAt = null;
        memory.deprioritized = false;
        this._activate(memory, ctx.now);
      }
      if (memory.permanent) {
        memory.strength = 1;
        memory.status = 'active';
        memory.fadingSince = null;
        memory.purgeAfter = null;
      } else if (memory.status !== 'archived') {
        materializeMemory(memory, ctx.now, ctx.config);
      }
      if (typeof raw.note === 'string' && raw.note.trim()) memory.note = raw.note.trim().slice(0, 200);
      memory.updatedAt = ctx.now;
      ctx.event('pin', memory.id, { protection: memory.protection, permanent: memory.permanent });
      return {
        ok: true,
        id: memory.id,
        protection: memory.protection,
        permanent: memory.permanent,
        note: typeof memory.note === 'string' ? memory.note : null,
      };
    });
  }

  /** §6.6 update：改文本不影响衰减计时（除非 resetDecay:true）。 */
  update(raw = {}) {
    const id = raw.id === undefined || raw.id === null ? null : normalizeText(raw.id);
    if (!id) throw new MemoryError('update 需要 id');
    return this._mutate((brain, ctx) => {
      const memory = brain.memories[id];
      if (!memory) throw new MemoryError(`记忆不存在：${id}`, 'NOT_FOUND');
      const changed = [];
      if (raw.title !== undefined) {
        memory.title = this._cleanTitle(raw.title, memory.text.slice(0, 30));
        changed.push('title');
      }
      if (raw.text !== undefined) {
        const text = this._cleanText(raw.text, { field: 'text', max: LIMITS.text });
        if (text !== memory.text) {
          memory.text = text;
          changed.push('text');
        }
      }
      if (raw.layer !== undefined) {
        memory.layer = this._cleanLayer(raw.layer, { allowNull: false });
        if (raw.decayDays === undefined) {
          memory.decayDays = memory.layer === 'long' ? ctx.config.decayDaysLong : ctx.config.decayDaysShort;
        }
        changed.push('layer');
      }
      if (raw.category !== undefined) {
        memory.category = this._cleanCategory(raw.category) ?? ctx.config.defaultCategory;
        changed.push('category');
      }
      if (raw.keywords !== undefined) {
        memory.keywords = this._cleanList(raw.keywords, {
          max: LIMITS.keywordCount,
          itemMax: LIMITS.keywordLength,
          field: 'keywords',
        });
        changed.push('keywords');
      }
      if (raw.tags !== undefined) {
        memory.tags = this._cleanList(raw.tags, { max: LIMITS.tagCount, itemMax: LIMITS.tagLength, field: 'tags' });
        changed.push('tags');
      }
      if (raw.decayDays !== undefined) {
        memory.decayDays = clamp(Math.round(Number(raw.decayDays)) || 1, 1, 3650);
        changed.push('decayDays');
      }
      if (raw.protection !== undefined) {
        memory.protection = clamp(Number(raw.protection), 0, 1);
        memory.permanent = isPermanent(memory);
        changed.push('protection');
      }
      if (raw.entityNames !== undefined) {
        this._attachEntities(brain, memory, raw.entityNames, ctx);
        changed.push('entityIds');
      }
      if (raw.resetDecay === true) {
        this._activate(memory, ctx.now);
        changed.push('resetDecay');
      }
      memory.updatedAt = ctx.now;
      ctx.event('update', memory.id, { fields: changed });
      return { ok: true, id: memory.id, memory: publicMemory(memory) };
    });
  }

  /** §6.7 forget：archive（默认，保留但不再展示）或 purge（彻底删除，记 tombstone 事件）。 */
  forget(raw = {}) {
    const ids = Array.isArray(raw.ids)
      ? raw.ids.map((id) => normalizeText(id)).filter(Boolean)
      : raw.id
        ? [normalizeText(raw.id)].filter(Boolean)
        : [];
    const query = normalizeText(raw.query).slice(0, LIMITS.queryLength);
    const mode = raw.mode === 'purge' ? 'purge' : 'archive';
    const force = raw.force === true;
    if (!ids.length && !query) throw new MemoryError('forget 需要 id 或 query（至少一个）');
    const targets = [...new Set(ids)];
    if (query) {
      const found = this.search({ query, limit: 5, includeFaded: true });
      for (const memory of found.memories) if (!targets.includes(memory.id)) targets.push(memory.id);
    }
    if (!targets.length) return { ok: true, forgotten: [], refused: [] };
    return this._mutate((brain, ctx) => {
      const forgotten = [];
      const refused = [];
      for (const id of targets) {
        const memory = brain.memories[id];
        if (!memory) {
          refused.push({ id, reason: 'not_found' });
          continue;
        }
        if (isPermanent(memory) && !force) {
          refused.push({ id, reason: 'permanent' });
          continue;
        }
        if (mode === 'purge') {
          delete brain.memories[id];
          ctx.event('purge', id, { reason: 'forget', title: memory.title, layer: memory.layer });
        } else {
          memory.status = 'archived';
          memory.archivedAt = ctx.now;
          memory.fadingSince = null;
          memory.purgeAfter = null;
          memory.updatedAt = ctx.now;
          ctx.event('forget', id, { mode, title: memory.title });
        }
        forgotten.push(id);
      }
      return { ok: true, forgotten, refused };
    });
  }

  // -------------------------------------------------------------------------
  // entity / link / graph / stats / materialize / seed
  // -------------------------------------------------------------------------

  /** §6.8 entity：upsert 实体 + 关系；同名不同类别新建并 alias_of。 */
  entity(raw = {}) {
    return this._mutate((brain, ctx) => this._applyEntity(brain, raw, ctx));
  }

  /** link：实体间关系（不在 MCP 10 工具内，服务层/CLI 用）。 */
  link(raw = {}) {
    const fromRef = raw.from ?? raw.fromId;
    const toRef = raw.to ?? raw.toId;
    if (!fromRef || !toRef) throw new MemoryError('link 需要 from 和 to');
    // v1.4：20 种规范关系 + 旧式别名自动归一（member_of→PART_OF、likes→PREFERRED 等）。
    const relationType =
      raw.relation === undefined || raw.relation === null ? 'related' : normalizeRelationType(raw.relation);
    return this._mutate((brain, ctx) => {
      let from = this._findEntityByNameOrId(brain, fromRef);
      if (!from) from = this._createEntity(brain, { name: String(fromRef), type: 'topic' }, ctx);
      let to = this._findEntityByNameOrId(brain, toRef);
      if (!to) to = this._createEntity(brain, { name: String(toRef), type: 'topic' }, ctx);
      const relation = this._upsertRelation(
        brain,
        { from: from.id, to: to.id, relation: relationType, note: raw.note ?? '', weight: raw.weight ?? 1 },
        ctx
      );
      return { ok: true, relation: publicRelation(relation) };
    });
  }

  /** §6.9 graph：实体邻域（BFS depth 1~3）+ 关系 + 关联记忆。 */
  graph(raw = {}) {
    const brain = this.snapshot();
    const limit = clamp(Number(raw.limit ?? 30) || 30, 1, 100);
    const depth = clamp(Number(raw.depth ?? 1) || 1, 1, 3);
    const entity = raw.entity ? this._findEntityByNameOrId(brain, raw.entity) : null;
    if (raw.entity && !entity) {
      return { entities: [], relations: [], memories: [], hint: `没有找到实体「${normalizeText(raw.entity)}」` };
    }
    const keep = new Set();
    if (entity) {
      keep.add(entity.id);
      let frontier = new Set([entity.id]);
      for (let level = 0; level < depth && keep.size < limit; level += 1) {
        const next = new Set();
        for (const relation of brain.relations) {
          if (frontier.has(relation.from)) next.add(relation.to);
          if (frontier.has(relation.to)) next.add(relation.from);
        }
        for (const id of next) if (keep.size < limit) keep.add(id);
        frontier = next;
      }
    } else {
      const ranked = Object.values(brain.entities).sort(
        (a, b) =>
          (Number(b.mentionCount) || 0) - (Number(a.mentionCount) || 0) ||
          (Number(b.lastMentionedAt) || 0) - (Number(a.lastMentionedAt) || 0)
      );
      for (const item of ranked.slice(0, limit)) keep.add(item.id);
    }
    const entities = [...keep]
      .map((id) => brain.entities[id])
      .filter(Boolean)
      .map((item) => ({ id: item.id, type: item.type, name: item.name, mentionCount: item.mentionCount }));
    const relations = brain.relations
      .filter((relation) => keep.has(relation.from) && keep.has(relation.to))
      .slice(0, limit * 3)
      .map((relation) => ({
        id: relation.id,
        from: relation.from,
        to: relation.to,
        relation: relation.relation,
        weight: relation.weight,
      }));
    let memories = Object.values(brain.memories)
      .filter((memory) => memory && (Array.isArray(memory.entityIds) ? memory.entityIds : []).some((id) => keep.has(id)))
      .sort((a, b) => (Number(b.strength) || 0) - (Number(a.strength) || 0))
      .slice(0, limit)
      .map((memory) => ({
        id: memory.id,
        title: memory.title,
        layer: memory.layer,
        strength: memory.strength,
        status: memory.status,
      }));
    if (!entity && !memories.length) {
      memories = Object.values(brain.memories)
        .filter((memory) => memory && memory.status !== 'archived')
        .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
        .slice(0, Math.min(limit, 10))
        .map((memory) => ({
          id: memory.id,
          title: memory.title,
          layer: memory.layer,
          strength: memory.strength,
          status: memory.status,
        }));
    }
    return { entities, relations, memories };
  }

  /** §6.10 stats。 */
  // -------------------------------------------------------------------------
  // v1.5-lite：人格状态（精力 / 心情）
  // 时间驱动的漂移在 model.personaStateSnapshot 里算；这里只负责读写与事件。
  // -------------------------------------------------------------------------

  state() {
    const brain = this.snapshot();
    const now = this.now();
    return { ok: true, at: now, state: personaStateSnapshot(brain.state, now) };
  }

  updateState(raw = {}) {
    const hasEnergy = raw.energy !== undefined && raw.energy !== null && raw.energy !== '';
    const hasMood = raw.mood !== undefined && raw.mood !== null && raw.mood !== '';
    if (!hasEnergy && !hasMood) throw new MemoryError('updateState 需要 energy 或 mood 至少一个');
    let saved = null;
    const now = this.now();
    this._mutate((brain, ctx) => {
      const current = normalizePersonaState(brain.state, ctx.now);
      const next = normalizePersonaState(
        {
          energy: hasEnergy ? clamp(Number(raw.energy), 0.05, 0.95) : current.energy,
          mood: hasMood ? clamp(Number(raw.mood), -1, 1) : current.mood,
          updatedAt: ctx.now,
        },
        ctx.now,
      );
      brain.state = next;
      saved = personaStateSnapshot(next, ctx.now);
      ctx.event('state', null, {
        energy: next.energy,
        mood: next.mood,
        reason: String(raw.reason || '').slice(0, 120),
      });
      return saved;
    });
    return { ok: true, at: now, state: saved };
  }

﻿  // ── v1.5-lite 第二批：自述（只增不改）与人设建议（需主人批准） ───────────────
  narratives({ limit = 20 } = {}) {
    const brain = this.snapshot();
    const self = normalizeSelf(brain.self);
    const items = [...self.narratives].slice(-Math.max(1, Math.min(50, Number(limit) || 20))).reverse();
    return {
      ok: true,
      total: self.narratives.length,
      items,
      anchor: self.anchor,
      values: [...self.values].reverse(),
      digests: [...self.digests].reverse(),
      persona: self.persona,
    };
  }

  addSelfNarrative(raw = {}) {
    return this._mutate((brain, ctx) => {
      const text = this._cleanText(raw.text, { field: '自述', max: 600 });
      if (text.length < 2) throw new MemoryError('自述内容太短（至少 2 个字）', 'INVALID_SELF_NARRATIVE');
      brain.self = normalizeSelf(brain.self);
      if (brain.self.narratives.length >= SELF_NARRATIVE_LIMIT) brain.self.narratives.shift();
      const item = { id: `self_${sha1(`${text}|${ctx.now}`).slice(0, 12)}`, text, at: ctx.now };
      brain.self.narratives.push(item);
      ctx.event('self', item.id, { text: text.slice(0, 120) });
      return { ok: true, at: ctx.now, narrative: item, total: brain.self.narratives.length };
    });
  }

  setAnchor(raw = {}) {
    return this._mutate((brain, ctx) => {
      const text = this._cleanText(raw.text, { field: '人设锚点', max: PERSONA_ANCHOR_MAX });
      brain.self = normalizeSelf(brain.self);
      brain.self.anchor = text.slice(0, PERSONA_ANCHOR_MAX);
      ctx.event('anchor', 'set', { length: text.length });
      return { ok: true, at: ctx.now, anchor: brain.self.anchor };
    });
  }

  addValue(raw = {}) {
    return this._mutate((brain, ctx) => {
      const text = this._cleanText(raw.text, { field: '在乎的', max: 300 });
      if (text.length < 2) throw new MemoryError('内容太短（至少 2 个字）', 'INVALID_VALUE');
      brain.self = normalizeSelf(brain.self);
      const exists = brain.self.values.some((item) => item.text === text);
      if (!exists) {
        if (brain.self.values.length >= SELF_VALUE_LIMIT) brain.self.values.shift();
        const item = { id: `val_${sha1(`${text}|${ctx.now}`).slice(0, 12)}`, text, at: ctx.now, by: raw.by ? String(raw.by).slice(0, 20) : 'self' };
        brain.self.values.push(item);
        ctx.event('value', item.id, { text: text.slice(0, 120) });
      }
      return { ok: true, at: ctx.now, total: brain.self.values.length };
    });
  }

  selfDigest(raw = {}) {
    const now = this.now();
    const brain = this.snapshot();
    const self = normalizeSelf(brain.self);
    const min = Math.max(3, Number(raw.min) || 30);
    if (raw.dryRun === true && raw.force !== true && self.narratives.length < min) {
      return { ok: true, skipped: true, reason: 'not-enough', total: self.narratives.length, min, at: now };
    }
    if (self.narratives.length < min && raw.force !== true) {
      return { ok: true, skipped: true, reason: 'not-enough', total: self.narratives.length, min, at: now };
    }
    const picked = self.narratives.slice(-Math.max(min, 30));
    const seen = new Set();
    const lines = [];
    for (const item of picked) {
      const line = String(item.text || '').replace(/\s+/g, ' ').trim();
      if (!line) continue;
      const key = line.slice(0, 18);
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(line);
    }
    const count = picked.length;
    const nth = self.digests.length + 1;
    const head = `【自述·回炉 第${nth}次｜${new Date(now).toLocaleDateString('sv-SE')}】共 ${count} 条：`;
    let body = lines.join('；');
    if (body.length > 1100) body = `${body.slice(0, 1090)}…`;
    const text = `${head}\n${body}`;
    if (raw.dryRun === true) return { ok: true, dryRun: true, at: now, count, text };
    return this._mutate((brain2, ctx) => {
      brain2.self = normalizeSelf(brain2.self);
      const digest = { id: `dig_${sha1(`${count}|${ctx.now}`).slice(0, 12)}`, text, at: ctx.now, count };
      brain2.self.digests.push(digest);
      if (brain2.self.digests.length > SELF_DIGEST_LIMIT) brain2.self.digests.shift();
      ctx.event('self-digest', digest.id, { count, total: brain2.self.digests.length });
      return { ok: true, at: ctx.now, digest, total: brain2.self.digests.length, count };
    });
  }

  setPersona(raw = {}) {
    return this._mutate((brain, ctx) => {
      const text = this._cleanText(raw.text, { field: '人设建议', max: 400 });
      if (text.length < 4) throw new MemoryError('人设建议太短（至少 4 个字）', 'INVALID_PERSONA');
      brain.self = normalizeSelf(brain.self);
      brain.self.persona = { text, status: 'pending', at: ctx.now, by: raw.by ? String(raw.by).slice(0, 40) : 'self', approvedAt: Number(brain.self.persona.approvedAt) || 0 };
      ctx.event('persona', 'pending', { text: text.slice(0, 120) });
      return { ok: true, at: ctx.now, persona: brain.self.persona };
    });
  }

  resolvePersona(raw = {}) {
    return this._mutate((brain, ctx) => {
      const status = String(raw.status || '').trim();
      if (!['approved', 'rejected'].includes(status)) throw new MemoryError('status 只能是 approved 或 rejected', 'INVALID_PERSONA_STATUS');
      brain.self = normalizeSelf(brain.self);
      if (!brain.self.persona.text) throw new MemoryError('还没有人设建议', 'NO_PERSONA');
      if (status === 'approved') {
        const last = Number(brain.self.persona.approvedAt) || 0;
        if (last && ctx.now - last < PERSONA_APPROVE_COOLDOWN_MS) {
          throw new MemoryError(`人设改太快了：距离上次批准还不到 ${Math.round(PERSONA_APPROVE_COOLDOWN_MS / 3_600_000)} 小时`, 'PERSONA_COOLDOWN');
        }
        brain.self.persona.approvedAt = ctx.now;
      }
      brain.self.persona.status = status;
      brain.self.persona.at = ctx.now;
      brain.self.persona.by = raw.by ? String(raw.by).slice(0, 40) : 'owner';
      ctx.event('persona', status, { text: brain.self.persona.text.slice(0, 120) });
      return { ok: true, at: ctx.now, persona: brain.self.persona };
    });
  }

  dayDigest(raw = {}) {
    const now = this.now();
    const date = String(raw.date || '').trim() || new Date(now - 86400000).toLocaleDateString('sv-SE');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new MemoryError('date 格式应为 YYYY-MM-DD', 'INVALID_DATE');
    const brain = this.snapshot();
    const existing = Object.values(brain.memories).filter(Boolean).find((memory) => isDayMemory(memory) && Array.isArray(memory.tags) && memory.tags.includes(date));
    if (existing && raw.force !== true) return { ok: true, skipped: true, reason: 'already-exists', id: existing.id, date };
    const dayStart = new Date(`${date}T00:00:00`).getTime();
    const dayEnd = dayStart + 86400000;
    const entries = Object.values(brain.memories).filter((memory) => {
      if (!memory || !memory.id || memory.category === 'day' || isDiaryMemory(memory)) return false;
      const at = Number(memory.updatedAt) || Number(memory.createdAt) || 0;
      return at >= dayStart && at < dayEnd;
    });
    const lines = entries.slice(0, 14).map((memory) => {
      const title = String(memory.title || memory.text || '').replace(/\s+/g, ' ').slice(0, 40);
      const summary = String(memory.text || '').replace(/\s+/g, ' ').slice(0, 60);
      return `- ${title}${summary && summary !== title ? `：${summary}` : ''}`;
    });
    // 2026-11-22 层级策略：没记录的那一天不生成日层。
    // 旧版会写一条「当天共 0 条记录：- 没有特别的记录」并落长期层，长期层就是这样被灌水的。
    if (entries.length === 0) {
      if (raw.dryRun === true) return { ok: true, dryRun: true, skipped: true, reason: 'empty-day', date, count: 0 };
      return { ok: true, skipped: true, reason: 'empty-day', date, count: 0 };
    }
    const text = `【日层 ${date}】当天共 ${entries.length} 条记录：\n${lines.join('\n') || '- 没有特别的记录'}`;
    if (raw.dryRun === true) return { ok: true, dryRun: true, date, count: entries.length, text };
    if (existing) this.forget({ id: existing.id, mode: 'purge', reason: 'day-digest-force' });
    const record = this.remember({
      text,
      title: `日层 ${date} 摘要`,
      layer: 'long',
      category: 'day',
      tags: ['day', date],
      keywords: ['日层', date],
      protection: 0,
      dedupe: false,
      source: { kind: 'system', key: 'day-digest', createdBy: 'day-digest' },
    });
    return { ok: true, date, count: entries.length, id: record.id, created: !record.merged, text };
  }


  /**
   * 存量层级迁移（2026-11-22，配合 layer-policy 上线）：
   * - 空日层摘要（「当天共 0 条记录」）归档，不再占长期层和注入名额；
   * - 事件/事实/话题误落长期层的降到短期，走 30 天淡出；被反复想起的会自己升回来；
   * - dryRun 只统计不落盘。
   */
  retierMemories(raw = {}) {
    const dryRun = raw.dryRun === true;
    return this._mutate((brain, ctx) => {
      const changes = [];
      for (const memory of Object.values(brain.memories)) {
        if (!memory || !memory.id) continue;
        if (memory.category === 'day' && /当天共\s*0\s*条记录/.test(String(memory.text || ''))) {
          changes.push({ id: memory.id, action: 'archive-empty-day', title: memory.title });
          if (!dryRun) {
            memory.status = 'archived';
            memory.archivedAt = ctx.now;
            memory.archivedReason = 'empty-day';
            ctx.event('archive', memory.id, { reason: 'empty-day', title: memory.title, layer: memory.layer });
          }
          continue;
        }
        const decision = decideRetierLayer(memory);
        if (!decision) continue;
        changes.push({
          id: memory.id,
          action: decision.reason,
          from: memory.layer,
          to: decision.layer,
          title: memory.title,
        });
        if (!dryRun) {
          memory.layer = decision.layer;
          memory.decayDays =
            decision.layer === 'long'
              ? Math.max(1, Number(ctx.config.decayDaysLong) || 200)
              : Math.max(1, Number(ctx.config.decayDaysShort) || 30);
          memory.updatedAt = ctx.now;
          ctx.event('update', memory.id, { fields: ['layer', 'decayDays'], from: memory.layer, to: decision.layer, reason: decision.reason });
        }
      }
      return { ok: true, dryRun, changed: changes.length, changes: changes.slice(0, 200) };
    });
  }

  // ── v1.7 情绪运行时 ────────────────────────────────────────────────
  /** 当前仍然有效的情绪（24h 内），带一句"感受词"提示。 */
  emotion() {
    const brain = this.snapshot();
    const now = this.now();
    const active = activeEmotions(brain.emotions, now);
    const latest = active.length ? active[active.length - 1] : null;
    const prompt = latest ? emotionPrompt(latest, now) : null;
    return {
      ok: true,
      at: now,
      emotion: latest
        ? {
            id: latest.id,
            label: latest.label,
            intensity: latest.intensity,
            at: latest.at,
            expiresAt: latest.expiresAt,
            source: latest.source,
            note: latest.note,
            pad: latest.pad || null,
          }
        : null,
      history: active.slice(-8).map((item) => ({
        id: item.id,
        label: item.label,
        intensity: item.intensity,
        at: item.at,
        expiresAt: item.expiresAt,
        source: item.source,
        note: item.note,
      })),
      active: active.length,
      prompt,
      labels: EMOTION_LABELS,
      ttlMs: DEFAULT_EMOTION_TTL_MS,
    };
  }

  /** 写一条情绪（机器人自己或主人代填）；过期的顺手剪掉，最多留 60 条。 */
  setEmotion(raw = {}) {
    const now = this.now();
    const emotion = normalizeEmotion(raw, now);
    return this._mutate((brain, ctx) => {
      if (!Array.isArray(brain.emotions)) brain.emotions = [];
      const pruned = pruneEmotions(brain.emotions, now);
      brain.emotions = pruned.kept.filter((item) => item.id !== emotion.id).slice(-59);
      brain.emotions.push(emotion);
      ctx.event('emotion', emotion.id, {
        label: emotion.label,
        intensity: emotion.intensity,
        expired: pruned.expired.length,
      });
      return {
        ok: true,
        at: now,
        emotion,
        expired: pruned.expired.length,
        prompt: emotionPrompt(emotion, now),
      };
    });
  }

  // ── v1.7 自升级提案（外部卡尺） ────────────────────────────────────
  proposals(raw = {}) {
    const brain = this.snapshot();
    const self = normalizeSelf(brain.self);
    const wanted = typeof raw.status === 'string' ? raw.status.trim() : '';
    const items = self.proposals
      .filter((proposal) => !wanted || proposal.status === wanted)
      .slice()
      .sort((left, right) => (Number(right.createdAt) || 0) - (Number(left.createdAt) || 0));
    const counts = { pending: 0, approved: 0, rejected: 0 };
    for (const proposal of self.proposals) counts[proposal.status] = (counts[proposal.status] || 0) + 1;
    return {
      ok: true,
      at: this.now(),
      pending: items.filter((proposal) => proposal.status === 'pending'),
      decided: items.filter((proposal) => proposal.status !== 'pending'),
      counts,
      toneHints: self.toneHints,
      selfReview: self.lastReview || null,
      lastReview: self.lastReview || null,
    };
  }

  /** 扫描最近自己的话，按外部卡尺生成候选（默认只读；dryRun 不写）。 */
  selfReview(raw = {}) {
    const brain = this.snapshot();
    const now = this.now();
    const days = Math.max(1, Math.min(90, Number(raw.days) || 7));
    const since = now - days * DAY_MS;
    const items = Object.values(brain.memories)
      .filter((memory) => memory && memory.status !== 'archived' && Number(memory.createdAt) >= since)
      .sort((left, right) => (Number(right.createdAt) || 0) - (Number(left.createdAt) || 0))
      .slice(0, 400)
      .map((memory) => ({
        text: [memory.title, memory.text].filter(Boolean).join('：'),
        at: Number(memory.createdAt) || now,
      }));
    const self = normalizeSelf(brain.self);
    const review = weeklyReview({ items, existing: self.proposals, now, days });
    const proposals = (Array.isArray(review.proposals) ? review.proposals : [])
      .map((proposal) => normalizeProposal(proposal, now))
      .filter(Boolean);
    if (raw.dryRun === true) {
      return {
        ok: true,
        at: now,
        dryRun: true,
        days,
        scanned: items.length,
        scan: review.scan || null,
        drift: review.drift || null,
        proposals,
      };
    }
    return this._mutate((draft, ctx) => {
      const current = normalizeSelf(draft.self);
      const known = new Set(current.proposals.map((proposal) => proposal.id));
      const added = [];
      for (const proposal of proposals) {
        if (known.has(proposal.id)) continue;
        known.add(proposal.id);
        added.push(proposal);
      }
      current.proposals = [...current.proposals, ...added].slice(-30);
      current.lastReview = { at: now, days, scanned: items.length, added: added.length };
      draft.self = current;
      ctx.event('self-review', null, { days, scanned: items.length, added: added.length });
      return {
        ok: true,
        at: now,
        days,
        scanned: items.length,
        scan: review.scan || null,
        drift: review.drift || null,
        added,
        proposals: current.proposals,
      };
    });
  }

  /** 主人批准/驳回一条提案；批准的语气类提案会写入 toneHints（醒来时注入）。 */
  resolveProposal(raw = {}) {
    const now = this.now();
    const id = normalizeText(raw.id);
    const status = normalizeText(raw.status || raw.decision || 'approved').toLowerCase();
    if (!id) throw new MemoryError('E_BAD_INPUT', '需要 id');
    if (!['approved', 'rejected'].includes(status)) {
      throw new MemoryError('E_BAD_INPUT', 'status 只能是 approved / rejected');
    }
    return this._mutate((brain, ctx) => {
      const self = normalizeSelf(brain.self);
      const proposal = self.proposals.find((item) => item.id === id);
      if (!proposal) throw new MemoryError('E_NOT_FOUND', '没有这条提案：' + id);
      if (proposal.status !== 'pending') {
        return { ok: true, at: now, proposal, unchanged: true, toneHints: self.toneHints };
      }
      proposal.status = status;
      proposal.decidedAt = now;
      proposal.by = normalizeText(raw.by) || 'owner';
      if (raw.externalScore != null && Number.isFinite(Number(raw.externalScore))) {
        proposal.externalScore = clamp(Number(raw.externalScore), 0, 1);
      }
      if (status === 'approved') {
        const text = (proposal.title + (proposal.detail ? '：' + proposal.detail : '')).slice(0, 300);
        self.toneHints = [...self.toneHints, text].slice(-20);
      }
      brain.self = self;
      ctx.event('proposal', proposal.id, { status, by: proposal.by });
      return { ok: true, at: now, proposal, toneHints: self.toneHints };
    });
  }

  /** 一个月测试台：读 trial.json / trial-report.json。 */
  trialInfo() {
    const dir = this.paths().memoryDir;
    const readJson = (name) => {
      try {
        return JSON.parse(fsSync.readFileSync(path.join(dir, name), 'utf8'));
      } catch {
        return null;
      }
    };
    const trial = readJson('trial.json');
    const report = readJson('trial-report.json');
    return { ok: true, at: this.now(), trial, report };
  }

  /** v1.6：把增量 journal 合并回 brain.json（回滚/维护前调用）。 */
  compact() {
    const { brain: _brain, ...meta } = this.store.compactNow();
    return { ok: true, ...meta, at: this.now() };
  }

  stats() {
    const brain = this.snapshot();
    const now = this.now();
    const config = brain.config;
    const memories = Object.values(brain.memories).filter(Boolean);
    const byLayer = { long: 0, short: 0 };
    const byTier = { working: 0, 'short-term': 0, episodic: 0, 'long-term': 0 };
    let permanent = 0;
    let fading = 0;
    let faded = 0;
    let active = 0;
    let archived = 0;
    let superseded = 0;
    let deprioritized = 0;
    let diary = 0;
    for (const memory of memories) {
      const diaryMemory = isDiaryMemory(memory);
      const tier = memoryTier(memory, now);
      byTier[tier] = (byTier[tier] || 0) + 1;
      if (diaryMemory) diary += 1;
      else if (memory.layer === 'long') byLayer.long += 1;
      else byLayer.short += 1;
      if (isPermanent(memory)) permanent += 1;
      if (memory.deprioritized) deprioritized += 1;
      switch (memory.status) {
        case 'fading':
          if (!diaryMemory) fading += 1;
          break;
        case 'faded':
          if (!diaryMemory) faded += 1;
          break;
        case 'archived':
          archived += 1;
          break;
        case 'superseded':
          superseded += 1;
          break;
        default:
          active += 1;
      }
    }
    const synapses = Array.isArray(brain.synapses) ? brain.synapses : [];
    const relationGroups = { temporal: 0, causal: 0, semantic: 0, emotional: 0, conflict: 0, legacy: 0 };
    for (const relation of Array.isArray(brain.relations) ? brain.relations : []) {
      const group = relationGroupOf(relation && relation.relation);
      relationGroups[group] = (relationGroups[group] || 0) + 1;
    }
    // v1.4：冲突突触（SUPERSEDES）也计入冲突大类，否则实体关系里看不到矛盾。
    for (const synapse of synapses) {
      if (synapse && synapse.type === 'SUPERSEDES') relationGroups.conflict += 1;
    }
    return {
      ok: true,
      total: memories.length,
      byLayer,
      capacity: {
        long: Number(config.maxMemoriesLong) || DEFAULT_CONFIG.maxMemoriesLong,
        short: Number(config.maxMemoriesShort) || DEFAULT_CONFIG.maxMemoriesShort,
      },
      byTier,
      state: personaStateSnapshot(brain.state, now),
      self: { narratives: normalizeSelf(brain.self).narratives.length, persona: normalizeSelf(brain.self).persona },
      emotions: (() => {
        const list = activeEmotions(brain.emotions, now);
        return { active: list.length, latest: list.length ? list[list.length - 1].label : null };
      })(),
      proposals: (() => {
        const counts = { pending: 0, approved: 0, rejected: 0 };
        for (const proposal of normalizeSelf(brain.self).proposals) {
          counts[proposal.status] = (counts[proposal.status] || 0) + 1;
        }
        return counts;
      })(),
      relationGroups,
      diary,
      permanent,
      fading,
      faded,
      active,
      archived,
      superseded,
      deprioritized,
      entities: Object.keys(brain.entities).length,
      relations: brain.relations.length,
      synapses: synapses.length,
      strongSynapses: synapses.filter((synapse) => synapse && (Number(synapse.weight) || 0) >= 0.5).length,
      depthProfiles: [0, 1, 2, 3].map((depth) => {
        const profile = depthProfile(depth);
        return { depth: profile.depth, name: profile.name, latency: profile.latency, hops: profile.hops };
      }),
      protectionLine: config.protectionLine,
      decayDays: { long: config.decayDaysLong, short: config.decayDaysShort },
      vaultDir: this.store.resolveVaultDir(config.vaultDir),
      nextDecayHint: this._nextDecayHint(brain, now),
    };
  }

  /**
   * 只读：按关键度给记忆排队（核心 / 重要 / 普通），供 memory__salience 查询。
   * 不写盘、不 touch、不改变任何衰减状态；分数只回答「这条值不值得留得久」。
   */
  salience({ limit = 20, tier = '' } = {}) {
    const brain = this.snapshot();
    const now = this.now();
    const relationDegree = new Map();
    for (const relation of Array.isArray(brain.relations) ? brain.relations : []) {
      if (!relation) continue;
      for (const side of [relation.from, relation.to, relation.source, relation.target]) {
        const id = String(side ?? '');
        if (id) relationDegree.set(id, (relationDegree.get(id) || 0) + 1);
      }
    }
    const counts = { core: 0, important: 0, normal: 0 };
    const scored = [];
    const entities = brain.entities || {};
    for (const memory of Object.values(brain.memories)) {
      if (!memory || !memory.id || memory.status !== 'active') continue;
      const entityTypes = {};
      for (const id of Array.isArray(memory.entityIds) ? memory.entityIds : []) {
        const type = entities[id]?.type || 'other';
        entityTypes[type] = (entityTypes[type] || 0) + 1;
      }
      const score = salienceScore(memory, {
        relations: relationDegree.get(String(memory.id)) || 0,
        entityTypes,
      });
      const key = salienceTier(score);
      counts[key] = (counts[key] || 0) + 1;
      scored.push({ memory, score, tier: key });
    }
    scored.sort((a, b) => b.score - a.score);
    const wanted = String(tier || '').trim().toLowerCase();
    const filtered = wanted && SALIENCE_TIERS[wanted] ? scored.filter((item) => item.tier === wanted) : scored;
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    return {
      ok: true,
      at: now,
      tiers: Object.values(SALIENCE_TIERS).map((item) => ({
        key: item.key,
        label: item.label,
        min: item.min,
        decayFactor: item.decayFactor,
      })),
      counts,
      total: scored.length,
      items: filtered.slice(0, safeLimit).map((item) => ({
        id: item.memory.id,
        title: item.memory.title,
        tier: item.tier,
        score: item.score,
        category: item.memory.category,
        layer: item.memory.layer,
        protection: Number(item.memory.protection) || 0,
        activationCount: Number(item.memory.activationCount) || 0,
      })),
    };
  }

  _nextDecayHint(brain, now) {    const config = brain.config;
    const candidates = [];
    for (const memory of Object.values(brain.memories)) {
      if (!memory || isPermanent(memory) || memory.status === 'archived') continue;
      if (memory.status === 'faded') {
        if (Number(memory.purgeAfter) > 0) {
          candidates.push({
            at: Number(memory.purgeAfter),
            title: memory.title,
            kind: 'purge',
            strength: Number(memory.strength) || 0,
          });
        }
        continue;
      }
      const strength = Number.isFinite(Number(memory.strength)) ? Number(memory.strength) : computeStrength(memory, now);
      if (strength <= config.fadeThreshold) continue;
      const decayDays = Math.max(1, Number(memory.decayDays) || config.decayDaysShort);
      const daysToFade = (strength - config.fadeThreshold) * decayDays;
      candidates.push({
        at: now + daysToFade * DAY_MS,
        title: memory.title,
        kind: 'fade',
        strength,
        layer: memory.layer,
      });
    }
    if (!candidates.length) {
      return Object.keys(brain.memories).length
        ? '所有记忆都在保护线以上或已永久保留，暂无即将淡忘的记忆。'
        : '记忆库为空（0 条），可用 remember 记录当前重要信息。';
    }
    candidates.sort((a, b) => a.at - b.at);
    const soonest = candidates[0];
    const days = Math.max(0, (soonest.at - now) / DAY_MS);
    const dayText = days < 1 ? `${Math.max(1, Math.round(days * 24))} 小时` : `${Math.round(days)} 天`;
    if (soonest.kind === 'purge') {
      return `最近一条边缘记忆（「${soonest.title}」）约 ${dayText}后将被清理；被重新提起的回忆建议尽快 touch。`;
    }
    return `最近一条将淡忘的记忆「${soonest.title}」约 ${dayText}后进入边缘（当前强度 ${round2(soonest.strength)}），${soonest.layer === 'long' ? '长期层' : '短期层'}；再次提起会自动重置衰减。`;
  }

  /** 每日维护：物化衰减/状态机并把过期边缘记忆归档（不删除）。 */
  materialize() {
    const result = this._mutate((brain, ctx) => {
      const total = Object.keys(brain.memories).length;
      ctx.event('decay', null, { manual: true, total });
      return { ok: true, total };
    });
    const stats = this.stats();
    const archived = (this._lastMutation?.archived ?? []).map((item) => item.id);
    return {
      ok: true,
      total: stats.total,
      purged: [],
      archived,
      stats,
    };
  }

  /**
   * 夜间巩固（replay，2026-10-28）：short→long 提升、近重复归档、关键词噪声清理。
   * 只做低风险整理：不删除、不新建；矛盾合并仍交给 update。
   */
  consolidate() {
    const result = this._mutate((brain, ctx) => {
      const now = ctx.now;
      const memories = Object.values(brain.memories).filter(Boolean);
      const NOISE = new Set(['一条', '内容', '做的', '这个', '那个', '这里', '那里', '一下', '一点', '东西', '事情', '时候', '现在', '今天', '昨天', '上次', '这次', '然后', '就是', '好像', '感觉', '觉得', '真的', '非常', '因为', '所以', '但是', '可以', '没有', '还是', '已经', '什么', '怎么', '为什么', '我们', '你们', '他们']);
      const keywordCleaned = [];
      for (const memory of memories) {
        if (memory.status === 'archived') continue;
        const before = Array.isArray(memory.keywords) ? memory.keywords : [];
        const after = before.filter((word) => {
          const value = normalizeText(word);
          if (!value || value.length < 2) return false;
          return !NOISE.has(value);
        });
        if (after.length !== before.length) {
          memory.keywords = after;
          memory.updatedAt = now;
          keywordCleaned.push(memory.id);
          // journal 增量只保存「有事件指向」的记忆，关键词清理也要发事件，否则这次修改会丢。
          ctx.event('update', memory.id, { fields: ['keywords'], consolidated: 'keyword-clean' });
        }
      }
      const promoted = [];
      for (const memory of memories) {
        if (memory.status !== 'active' || isDiaryMemory(memory) || isPermanent(memory)) continue;
        if (memory.layer !== 'short') continue;
        if ((Number(memory.activationCount) || 0) < 3) continue;
        if ((Number(memory.strength) || computeStrength(memory, now)) < 0.5) continue;
        memory.layer = 'long';
        memory.decayDays = Number(brain.config?.decayDaysLong) || DEFAULT_CONFIG.decayDaysLong;
        memory.updatedAt = now;
        promoted.push(memory.id);
        ctx.event('update', memory.id, { fields: ['layer'], consolidated: 'promote-long' });
      }
      const active = memories.filter((m) => m && m.status !== 'archived' && !isDiaryMemory(m) && !isPermanent(m));
      const deduped = [];
      for (let i = 0; i < active.length; i += 1) {
        for (let j = i + 1; j < active.length; j += 1) {
          const a = active[i];
          const b = active[j];
          if (!a || !b || a.status === 'archived' || b.status === 'archived') continue;
          if (a.category !== b.category) continue;
          const sim = textSimilarity(`${a.title}\n${a.text}`, `${b.title}\n${b.text}`);
          if (sim < 0.92) continue;
          const weight = (m) => (Number(m.activationCount) || 0) * 1000 + (Number(m.updatedAt) || 0);
          const [keep, drop] = weight(a) >= weight(b) ? [a, b] : [b, a];
          drop.status = 'archived';
          drop.archivedAt = now;
          drop.archivedReason = 'duplicate';
          drop.mergedInto = keep.id;
          drop.updatedAt = now;
          deduped.push({ id: drop.id, mergedInto: keep.id, similarity: round2(sim), title: drop.title });
          ctx.event('archive', drop.id, { reason: 'duplicate', mergedInto: keep.id, title: drop.title });
        }
      }
      // v1.6：同主题+同类别进展聚合（时间合并）——只保留最新 N 条，其余归档，默认留最新 3 条 + 1 条摘要。
      const keepLatest = Math.max(1, Number(ctx.config.progressKeep) || DEFAULT_CONFIG.progressKeep);
      const mergeMin = Math.max(2, Number(ctx.config.progressMergeMin) || DEFAULT_CONFIG.progressMergeMin);
      const byTopic = new Map();
      for (const memory of Object.values(brain.memories)) {
        if (!memory || memory.status === 'archived') continue;
        if (isDiaryMemory(memory) || isDayMemory(memory) || isPermanent(memory)) continue;
        if (memory.category !== 'fact' && memory.category !== 'preference' && memory.category !== 'decision') continue;
        if (Array.isArray(memory.tags) && memory.tags.includes('progress-summary')) continue;
        const entityIds = Array.isArray(memory.entityIds) ? memory.entityIds : [];
        const topicId = entityIds.find((id) => brain.entities[id] && brain.entities[id].type === 'topic') || null;
        if (!topicId) continue;
        const key = `${topicId}|${memory.category}`;
        const bucket = byTopic.get(key) || [];
        bucket.push(memory);
        byTopic.set(key, bucket);
      }
      const timeMerged = [];
      for (const [key, bucket] of byTopic) {
        if (bucket.length < mergeMin) continue;
        const [topicId, category] = key.split('|');
        const topicName = (brain.entities[topicId] && brain.entities[topicId].name) || '主题';
        bucket.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
        const rest = bucket.slice(keepLatest);
        if (!rest.length) continue;
        const summaryId = memoryId(`progress-summary:${key}`, 'auto');
        let summary = brain.memories[summaryId];
        const lines = rest
          .slice(0, 12)
          .map((m) => `- ${new Date(Number(m.updatedAt) || now).toISOString().slice(0, 10)} ${String(m.title || m.text).slice(0, 40)}`);
        const text = `「${topicName}」${category} 进展摘要（合并 ${rest.length} 条，原文已归档）：\n${lines.join('\n')}`;
        if (!summary) {
          summary = emptyMemory({ text, title: `进展摘要 · ${topicName}`, layer: 'long', category: 'fact', tags: ['progress-summary', 'auto'], now });
          summary.id = summaryId;
          summary.entityIds = [topicId];
          summary.activationCount = 1;
          brain.memories[summaryId] = summary;
        } else {
          summary.text = text;
          summary.status = 'active';
          summary.updatedAt = now;
          summary.archivedAt = null;
          summary.archivedReason = null;
          summary.mergedInto = null;
        }
        for (const memory of rest) {
          memory.status = 'archived';
          memory.archivedAt = now;
          memory.archivedReason = 'time-merge';
          memory.mergedInto = summaryId;
          memory.updatedAt = now;
          ctx.event('archive', memory.id, { reason: 'time-merge', mergedInto: summaryId, title: memory.title });
          timeMerged.push({ id: memory.id, mergedInto: summaryId, title: memory.title });
        }
        ctx.event('update', summaryId, { fields: ['text'], consolidated: 'time-merge-summary' });
      }
      const duplicateRate = active.length ? round2(deduped.length / active.length) : 0;
      const summary = { at: now, promoted: promoted.length, deduped: deduped.length, timeMerged: timeMerged.length, keywordCleaned: keywordCleaned.length, duplicateRate, total: Object.keys(brain.memories).length };
      ctx.event('consolidate', null, summary);
      return { ...summary, promotedIds: promoted, dedupedItems: deduped, timeMergedItems: timeMerged, keywordCleanedIds: keywordCleaned };
    });
    try {
      const paths = this.store.paths();
      fs.mkdirSync(paths.memoryDir, { recursive: true });
      fs.writeFileSync(path.join(paths.memoryDir, 'last-consolidation.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    } catch {
      // metrics 落盘失败不阻断巩固结果。
    }
    return result;
  }

  /** §7 seed：按 entities → relations → memories 顺序幂等导入。 */
  seed(seedData = {}) {
    if (!seedData || typeof seedData !== 'object') throw new MemoryError('seed 需要一个对象（seed.json 内容）');
    const summary = this._mutate((brain, ctx) => {
      const out = {
        entities: { created: 0, updated: 0 },
        relations: { created: 0, updated: 0 },
        memories: { created: 0, merged: 0 },
        skipped: 0,
        errors: [],
      };
      for (const rawEntity of Array.isArray(seedData.entities) ? seedData.entities : []) {
        try {
          const result = this._applyEntity(
            brain,
            { ...rawEntity, type: rawEntity?.type ?? 'topic', relations: [] },
            ctx,
            { seed: true }
          );
          if (result.created) out.entities.created += 1;
          else out.entities.updated += 1;
        } catch (error) {
          out.skipped += 1;
          out.errors.push(`entity ${rawEntity?.name ?? '?'}: ${error?.message ?? error}`);
        }
      }
      for (const rawRelation of Array.isArray(seedData.relations) ? seedData.relations : []) {
        try {
          const fromRaw = rawRelation?.from;
          const toRaw = rawRelation?.to;
          if (!normalizeText(fromRaw) || !normalizeText(toRaw)) {
            out.skipped += 1;
            continue;
          }
          let from = this._findEntityByNameOrId(brain, fromRaw);
          if (!from) {
            from = this._createEntity(brain, { name: String(fromRaw), type: 'topic' }, ctx);
            out.entities.created += 1;
          }
          let to = this._findEntityByNameOrId(brain, toRaw);
          if (!to) {
            to = this._createEntity(brain, { name: String(toRaw), type: 'topic' }, ctx);
            out.entities.created += 1;
          }
          const before = brain.relations.length;
          this._upsertRelation(
            brain,
            {
              from: from.id,
              to: to.id,
              relation: rawRelation?.relation,
              note: rawRelation?.note ?? '',
              weight: rawRelation?.weight ?? 1,
              source: { kind: 'seed', key: rawRelation?.source?.key ?? 'seed' },
              incrementWeight: false,
            },
            ctx
          );
          if (brain.relations.length > before) out.relations.created += 1;
          else out.relations.updated += 1;
        } catch (error) {
          out.skipped += 1;
          out.errors.push(`relation ${rawRelation?.from ?? '?'}->${rawRelation?.to ?? '?'}: ${error?.message ?? error}`);
        }
      }
      for (const rawMemory of Array.isArray(seedData.memories) ? seedData.memories : []) {
        try {
          const result = this._applyRemember(
            brain,
            {
              ...rawMemory,
              source: { ...(rawMemory?.source ?? {}), kind: 'seed', key: rawMemory?.source?.key ?? 'seed' },
              dedupe: rawMemory?.dedupe !== false,
            },
            ctx
          );
          if (result.created) out.memories.created += 1;
          else out.memories.merged += 1;
        } catch (error) {
          out.skipped += 1;
          out.errors.push(`memory ${rawMemory?.title ?? rawMemory?.text?.slice?.(0, 20) ?? '?'}: ${error?.message ?? error}`);
        }
      }
      ctx.event('seed', 'seed', {
        entities: out.entities,
        relations: out.relations,
        memories: out.memories,
        skipped: out.skipped,
      });
      return out;
    });
    return { ok: true, ...summary, stats: this.stats() };
  }

  /** 按 id 取单条记忆（调试/CLI 用）。 */
  getMemory(id) {
    const brain = this.snapshot();
    return brain.memories[normalizeText(id)] ? publicMemory(brain.memories[normalizeText(id)]) : null;
  }

  /** 按名字/id 取实体（调试/CLI 用）。 */
  getEntity(ref) {
    const brain = this.snapshot();
    return publicEntity(this._findEntityByNameOrId(brain, ref));
  }

  /** 最近事件（调试/CLI 用）。 */
  recentEvents({ limit = 50 } = {}) {
    return this.store.readEvents({ limit });
  }
}

export function createService(options) {
  return new MemoryService(options);
}

export { MemoryError };
