// 照片记忆：把「看过的一张图」从一次性描述变成可回查的长期条目。
//
// 设计边界：
//   · 文字描述是主体，原图可选（socialV2.photoMemory.storeOriginals）——开了就落
//     本机 state/media/photo-memory/<id>.<ext>，只在同一会话回查/控制台里用，
//     不会转发、不会进模型上下文；关掉时行为与旧版一致（只存文字）。
//   · 同一个会话内按 messageId / 内容指纹去重；跨会话不去重（同一张图在不同群
//     被重新发，仍算一次新的「看到」）。
//   · 群聊里只回查本群的照片；私聊照片不会漏到群聊（反之亦然）。
//   · 保留策略：keepDays + maxPhotos 双闸（prunePhotos），收藏的不清；清掉条目时
//     原图文件交给调用方 unlink，避免孤儿文件。

import crypto from 'node:crypto';

export const PHOTO_MEMORY_VERSION = 1;
export const DEFAULT_PHOTO_MEMORY = Object.freeze({
  enabled: true,
  maxPhotos: 300,
  recallLimit: 3,
  maxChars: 900,
  keepDays: 365,
  // 2026-11-22：可以存原图了（只存本机 state/media/photo-memory，按密码/隐私边界只在原会话回查时用）。
  storeOriginals: true,
  maxOriginalBytes: 8 * 1024 * 1024
});

const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

export function normalizePhotoMemoryConfig(raw = {}) {
  const merged = { ...DEFAULT_PHOTO_MEMORY, ...(raw && typeof raw === 'object' ? raw : {}) };
  return {
    enabled: merged.enabled !== false,
    maxPhotos: clampInt(merged.maxPhotos, 20, 5000, DEFAULT_PHOTO_MEMORY.maxPhotos),
    recallLimit: clampInt(merged.recallLimit, 1, 10, DEFAULT_PHOTO_MEMORY.recallLimit),
    maxChars: clampInt(merged.maxChars, 200, 4000, DEFAULT_PHOTO_MEMORY.maxChars),
    keepDays: clampInt(merged.keepDays, 1, 3650, DEFAULT_PHOTO_MEMORY.keepDays),
    storeOriginals: merged.storeOriginals !== false,
    maxOriginalBytes: clampInt(merged.maxOriginalBytes, 256 * 1024, 64 * 1024 * 1024, DEFAULT_PHOTO_MEMORY.maxOriginalBytes)
  };
}

function shortHash(text) {
  return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16);
}

function cleanText(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeOriginal(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const file = cleanText(raw.file, 260);
  if (!file) return null;
  const bytes = clampInt(raw.bytes, 1, 64 * 1024 * 1024, 0);
  return {
    file,
    bytes: bytes || 0,
    mime: cleanText(raw.mime, 60) || 'image/jpeg',
    width: clampInt(raw.width, 0, 20000, 0),
    height: clampInt(raw.height, 0, 20000, 0),
    at: Number.isFinite(Number(raw.at)) ? Number(raw.at) : 0
  };
}

/** 归一化一条照片记忆；返回 null 表示信息太少、不值得记。 */
export function normalizePhoto(raw = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const key = cleanText(raw.key, 80);
  const description = cleanText(raw.description ?? raw.scene ?? raw.text, 600);
  if (!key || description.length < 6) return null;
  const at = Number.isFinite(Number(raw.at)) ? Number(raw.at) : Date.now();
  const messageId = Number.isFinite(Number(raw.messageId)) ? Number(raw.messageId) : 0;
  const hash = cleanText(raw.hash, 80) || shortHash(`${key}|${messageId}|${description}`);
  const people = Array.isArray(raw.people)
    ? [...new Set(raw.people.map((p) => cleanText(p, 40)).filter(Boolean))].slice(0, 8)
    : [];
  const tags = Array.isArray(raw.tags)
    ? [...new Set(raw.tags.map((t) => cleanText(t, 24)).filter(Boolean))].slice(0, 12)
    : [];
  const id = cleanText(raw.id, 40) || `ph_${shortHash(`${key}|${messageId}|${hash}`).slice(0, 12)}`;
  const original = normalizeOriginal(raw.original);
  return {
    id,
    at,
    key,
    kind: raw.kind === 'sticker' ? 'sticker' : 'image',
    sender: cleanText(raw.sender, 40),
    messageId,
    hash,
    description,
    people,
    tags,
    caption: cleanText(raw.caption, 300),
    favorite: raw.favorite === true,
    ...(original ? { original } : {})
  };
}

/** 插入一条照片；同会话同 messageId 或同 hash 视为同一张，返回 added:false。 */
export function addPhoto(list, raw, options = {}) {
  const photos = Array.isArray(list) ? list.slice() : [];
  const storeOriginals = options.storeOriginals !== false;
  const photo = normalizePhoto(raw);
  if (!photo) return { photos, added: false, photo: null, reason: 'invalid' };
  if (!storeOriginals) delete photo.original;
  const duplicate = photos.find((item) => item
    && item.key === photo.key
    && ((photo.messageId && Number(item.messageId) === photo.messageId) || (photo.hash && item.hash === photo.hash)));
  if (duplicate) {
    // 新描述更完整时补全旧条目，但保留原来的时间与 id。
    let updated = false;
    if (photo.description.length > String(duplicate.description || '').length) {
      duplicate.description = photo.description;
      duplicate.people = [...new Set([...(duplicate.people || []), ...photo.people])].slice(0, 8);
      duplicate.tags = [...new Set([...(duplicate.tags || []), ...photo.tags])].slice(0, 12);
      updated = true;
    }
    // 旧条目当时没存原图、这次能拿到，就补上（反过来不覆盖已有原图）。
    if (storeOriginals && photo.original && !duplicate.original) {
      duplicate.original = photo.original;
      updated = true;
    }
    return { photos, added: false, updated, photo: duplicate };
  }
  photos.push(photo);
  const max = clampInt(options.maxPhotos, 1, 5000, DEFAULT_PHOTO_MEMORY.maxPhotos);
  let dropped = [];
  if (photos.length > max) {
    dropped = photos.splice(0, photos.length - max).filter(Boolean);
  }
  return { photos, added: true, photo, dropped };
}

/**
 * 保留策略：按 keepDays 老化 + maxPhotos 容量淘汰，**收藏的一律保留**。
 * 返回被清掉的条目（调用方据 item.original.file 删原图，避免孤儿文件）。
 */
export function prunePhotos(list, options = {}) {
  const photos = Array.isArray(list) ? list.filter(Boolean) : [];
  const keepDays = clampInt(options.keepDays, 1, 3650, DEFAULT_PHOTO_MEMORY.keepDays);
  const maxPhotos = clampInt(options.maxPhotos, 20, 5000, DEFAULT_PHOTO_MEMORY.maxPhotos);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const cutoff = now - keepDays * 86_400_000;
  const removed = [];
  const kept = [];
  for (const photo of photos) {
    const at = Number(photo.at) || 0;
    if (photo.favorite || !at || at >= cutoff) kept.push(photo);
    else removed.push({ ...photo, reason: 'expired' });
  }
  if (kept.length > maxPhotos) {
    // 保持原来的时间顺序：从最旧的开始淘汰非收藏项。
    const overflow = kept.length - maxPhotos;
    const pinned = kept.filter((p) => p.favorite);
    const rest = kept.filter((p) => !p.favorite);
    rest.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
    const evicted = rest.splice(0, Math.max(0, Math.min(overflow, rest.length)));
    for (const photo of evicted) removed.push({ ...photo, reason: 'capacity' });
    kept.length = 0;
    kept.push(...pinned, ...rest);
    kept.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
  }
  return {
    photos: kept,
    removed,
    removedFiles: removed.map((p) => (p.original && p.original.file) || '').filter(Boolean)
  };
}

export function removePhoto(list, id) {
  const photos = Array.isArray(list) ? list : [];
  const target = cleanText(id, 40);
  const next = photos.filter((item) => item && item.id !== target);
  return { photos: next, removed: next.length !== photos.length };
}

function tokensOf(text) {
  return [...new Set(String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((word) => word.length >= 2)
    .slice(0, 40))];
}

function keywordScore(photo, tokens) {
  const haystack = [photo.description, photo.caption, ...(photo.tags || []), ...(photo.people || [])]
    .join(' ')
    .toLowerCase();
  let hits = 0;
  for (const token of tokens) if (haystack.includes(token)) hits += 1;
  return hits;
}

/**
 * 回查照片。query 为空时按时间倒序返回最近的；有 query 时按关键词命中 + 会话匹配 + 新近度排序。
 * 群聊只返回同群的照片；私聊只返回私聊的照片。
 */
export function recallPhotos(list, options = {}) {
  const photos = (Array.isArray(list) ? list : []).filter((p) => p && p.description);
  const key = cleanText(options.key, 80);
  const isGroup = key.startsWith('group:');
  const limit = clampInt(options.limit, 1, 10, DEFAULT_PHOTO_MEMORY.recallLimit);
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const tokens = tokensOf(options.query);
  const since = Number.isFinite(Number(options.since)) ? Number(options.since) : 0;
  const candidates = photos.filter((photo) => {
    const photoKey = String(photo.key || '');
    if (!photoKey) return false;
    if (isGroup) return photoKey === key;
    return photoKey.startsWith('private:') || photoKey === key;
  }).filter((photo) => !since || photo.at >= since);
  const scored = candidates.map((photo) => {
    const ageDays = Math.max(0, (now - photo.at) / 86_400_000);
    const freshness = Math.exp(-ageDays / 60);
    const hits = tokens.length ? keywordScore(photo, tokens) : 0;
    const relevance = tokens.length ? Math.min(1, hits / Math.max(1, Math.min(4, tokens.length))) : 1;
    const sameKey = photo.key === key ? 0.25 : 0;
    const favorite = photo.favorite ? 0.1 : 0;
    return { photo, score: relevance * 0.6 + freshness * 0.2 + sameKey + favorite, hits };
  });
  scored.sort((a, b) => (b.score - a.score) || (b.photo.at - a.photo.at));
  const picked = (tokens.length ? scored.filter((item) => item.hits > 0) : scored).slice(0, limit);
  return picked.map((item) => item.photo);
}

function ymd(at) {
  const d = new Date(Number(at) || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 拼成注入用的【照片记忆】段；没有内容返回空字符串。 */
export function formatPhotoBlock(photos, options = {}) {
  const list = Array.isArray(photos) ? photos.filter((p) => p && p.description) : [];
  if (!list.length) return '';
  const maxChars = clampInt(options.maxChars, 200, 4000, DEFAULT_PHOTO_MEMORY.maxChars);
  const lines = ['【照片记忆】（你以前看过的图，可以自然提起；记不清就别编）'];
  for (const photo of list) {
    const people = Array.isArray(photo.people) && photo.people.length ? `｜相关：${photo.people.slice(0, 3).join('、')}` : '';
    const line = `- ${ymd(photo.at)}：${photo.description.slice(0, 160)}${people}`;
    if (lines.join('\n').length + line.length + 1 > maxChars) break;
    lines.push(line);
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

export function photoStats(list) {
  const photos = Array.isArray(list) ? list.filter(Boolean) : [];
  const byKey = {};
  for (const photo of photos) byKey[photo.key] = (byKey[photo.key] || 0) + 1;
  const withOriginals = photos.filter((p) => p.original && p.original.file);
  return {
    total: photos.length,
    favorites: photos.filter((p) => p.favorite).length,
    images: photos.filter((p) => p.kind !== 'sticker').length,
    stickers: photos.filter((p) => p.kind === 'sticker').length,
    originals: withOriginals.length,
    originalBytes: withOriginals.reduce((sum, p) => sum + (Number(p.original.bytes) || 0), 0),
    conversations: Object.keys(byKey).length,
    byKey,
    newestAt: photos.reduce((top, p) => Math.max(top, Number(p.at) || 0), 0)
  };
}
