// 风格画像存储（JSON，原子写）；只存统计值与摘要，不存原话。
import fs from 'node:fs';
import path from 'node:path';

export function loadStyleProfiles(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.profiles && typeof parsed.profiles === 'object' && !Array.isArray(parsed.profiles)) {
      return { version: 1, profiles: parsed.profiles };
    }
  } catch {}
  return { version: 1, profiles: {} };
}

export function saveStyleProfiles(file, store) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, profiles: store?.profiles || {} }), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** 超过上限时按 updatedAt 淘汰最旧的画像。 */
export function pruneStyleProfiles(store, maxProfiles = 200) {
  const entries = Object.entries(store?.profiles || {});
  if (entries.length <= maxProfiles) return 0;
  entries.sort((a, b) => (Number(b[1]?.updatedAt) || 0) - (Number(a[1]?.updatedAt) || 0));
  const keep = entries.slice(0, maxProfiles);
  store.profiles = Object.fromEntries(keep);
  return entries.length - keep.length;
}

export function getStyleProfile(store, key) {
  return store?.profiles?.[String(key)] || null;
}

export function setStyleProfile(store, key, profile, maxProfiles = 200) {
  if (!store?.profiles) return null;
  store.profiles[String(key)] = profile;
  pruneStyleProfiles(store, maxProfiles);
  return profile;
}