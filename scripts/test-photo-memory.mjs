// 照片记忆纯函数单测：node scripts/test-photo-memory.mjs
import {
  DEFAULT_PHOTO_MEMORY,
  normalizePhotoMemoryConfig,
  normalizePhoto,
  addPhoto,
  removePhoto,
  prunePhotos,
  recallPhotos,
  formatPhotoBlock,
  photoStats
} from '../src/core/photo-memory.mjs';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`ok - ${name}`); }
  else { fail += 1; console.log(`FAIL - ${name}${detail ? ` :: ${detail}` : ''}`); }
}

const now = Date.UTC(2026, 10, 22, 4, 0, 0);

check('默认配置', DEFAULT_PHOTO_MEMORY.enabled === true && DEFAULT_PHOTO_MEMORY.maxPhotos === 300);
check('配置归一化', (() => {
  const c = normalizePhotoMemoryConfig({ maxPhotos: 5, recallLimit: 99, maxChars: 10 });
  return c.maxPhotos === 20 && c.recallLimit === 10 && c.maxChars === 200;
})());

check('太短的描述不入库', normalizePhoto({ key: 'private:1', description: '图' }) === null);
check('归一化字段', (() => {
  const p = normalizePhoto({
    key: 'private:1', at: now, messageId: 42, description: '  一只橘猫趴在窗台上晒太阳  ',
    people: ['小雪', '小雪', '主人'], tags: ['猫', '猫', '窗台'], caption: '下午发的'
  });
  return p && p.id.startsWith('ph_') && p.description === '一只橘猫趴在窗台上晒太阳'
    && p.people.length === 2 && p.tags.length === 2 && p.kind === 'image';
})());

let list = [];
let out = addPhoto(list, { key: 'private:1', at: now, messageId: 42, hash: 'h-cat', description: '一只橘猫趴在窗台上晒太阳' });
check('首次写入', out.added === true && out.photos.length === 1);
list = out.photos;
out = addPhoto(list, { key: 'private:1', at: now + 1000, messageId: 42, hash: 'h-cat', description: '一只橘猫趴在窗台上晒太阳' });
check('同 messageId 去重', out.added === false && out.photos.length === 1);
out = addPhoto(list, { key: 'private:1', at: now + 2000, messageId: 43, hash: 'h-cat', description: '一只橘猫趴在窗台上晒太阳，旁边还有一只狗' });
check('同图更完整描述补全', out.added === false && out.updated === true && out.photos[0].description.includes('狗'));
list = out.photos;

out = addPhoto(list, { key: 'group:9', at: now + 3000, messageId: 7, description: '群里发的火锅照片，红油翻滚' });
list = out.photos;
out = addPhoto(list, { key: 'group:9', at: now + 4000, messageId: 8, description: '生日蛋糕，插着两根蜡烛' });
list = out.photos;
check('不同会话各自入库', list.length === 3);

check('容量裁剪', (() => {
  let acc = [];
  for (let i = 0; i < 12; i += 1) acc = addPhoto(acc, { key: 'private:1', at: now + i, messageId: 100 + i, description: `第 ${i} 张测试照片` }, { maxPhotos: 5 }).photos;
  return acc.length === 5 && acc[0].description.includes('第 7');
})());

check('关键词回查', (() => {
  const got = recallPhotos(list, { key: 'private:1', query: '橘猫 窗台', limit: 3, now: now + 5000 });
  return got.length >= 1 && got[0].description.includes('橘猫');
})());
check('群聊只回本群照片', (() => {
  const got = recallPhotos(list, { key: 'group:9', query: '照片', limit: 5, now: now + 5000 });
  return got.every((p) => p.key === 'group:9');
})());
check('群聊查不到私聊照片', (() => {
  const got = recallPhotos(list, { key: 'group:9', query: '橘猫', limit: 5, now: now + 5000 });
  return got.length === 0;
})());
check('私聊可回自己的照片', (() => {
  const got = recallPhotos(list, { key: 'private:1', query: '火锅', limit: 5, now: now + 5000 });
  return got.length === 0; // 火锅是群里的，私聊不该看到
})());
check('空 query 返回最近', (() => {
  const got = recallPhotos(list, { key: 'private:1', limit: 2, now: now + 5000 });
  return got.length === 1 && got[0].key === 'private:1';
})());

const block = formatPhotoBlock(recallPhotos(list, { key: 'private:1', query: '橘猫', limit: 3, now: now + 5000 }), { maxChars: 900 });
check('注入块含标题与日期', block.includes('【照片记忆】') && block.includes('橘猫'));
check('空列表注入为空', formatPhotoBlock([], {}) === '');

check('删除', (() => {
  const id = list.find((p) => p.key === 'group:9').id;
  const r = removePhoto(list, id);
  return r.removed === true && r.photos.length === list.length - 1;
})());

check('统计', (() => {
  const s = photoStats(list);
  return s.total === 3 && s.conversations === 2 && s.newestAt > 0;
})());

// ── 原图 + 保留策略（2026-11-22）──────────────────────────────────────────
const original = { file: 'state/media/photo-memory/qm_1_1.jpg', bytes: 4096, mime: 'image/jpeg', width: 640, height: 480 };
check('原图字段归一化', (() => {
  const p = normalizePhoto({ key: 'private:1', description: '一只鲸鱼穿着蓝色雨衣', messageId: 7, hash: 'hh', original });
  return p && p.original && p.original.file === original.file && p.original.bytes === 4096;
})());
check('storeOriginals=false 时剥离原图', (() => {
  const r = addPhoto([], { key: 'private:1', description: '一只鲸鱼穿着蓝色雨衣', messageId: 8, hash: 'h8', original }, { storeOriginals: false });
  return r.added === true && !r.photo.original;
})());
check('重复补全时可补上原图', (() => {
  const first = addPhoto([], { key: 'private:1', description: '一只鲸鱼穿着蓝色雨衣', messageId: 9, hash: 'h9' });
  const again = addPhoto(first.photos, { key: 'private:1', description: '一只鲸鱼穿着蓝色雨衣', messageId: 9, hash: 'h9', original });
  return again.added === false && again.updated === true && again.photo.original && again.photo.original.file === original.file;
})());
check('保留策略按天淘汰且保留收藏', (() => {
  const old = { ...normalizePhoto({ key: 'private:1', description: '很久以前的照片记忆', messageId: 10, hash: 'h10' }), at: now - 400 * 86400000 };
  const pinned = { ...normalizePhoto({ key: 'private:1', description: '很久以前但收藏了的照片', messageId: 11, hash: 'h11', favorite: true }), at: now - 400 * 86400000 };
  const fresh = { ...normalizePhoto({ key: 'private:1', description: '今天的照片记忆', messageId: 12, hash: 'h12' }), at: now };
  const r = prunePhotos([old, pinned, fresh], { keepDays: 365, maxPhotos: 300, now });
  return r.photos.length === 2 && r.removed.length === 1 && r.removed[0].messageId === 10
    && r.photos.some((p) => p.favorite);
})());
check('保留策略按容量淘汰最旧的非收藏项', (() => {
  const mk = (id, at) => ({ ...normalizePhoto({ key: 'private:1', description: `第${id}张照片的记忆`, messageId: id, hash: `c${id}` }), at });
  const many = [];
  for (let i = 0; i < 21; i += 1) many.push(mk(21 + i, now - (21 - i) * 1000));
  const r = prunePhotos(many, { keepDays: 3650, maxPhotos: 20, now });
  return r.photos.length === 20 && r.removed.length === 1 && r.removed[0].messageId === 21;
})());
check('统计含原图数量与体积', (() => {
  const r = addPhoto([], { key: 'private:1', description: '一只鲸鱼穿着蓝色雨衣', messageId: 14, hash: 'h14', original });
  const s = photoStats(r.photos);
  return s.originals === 1 && s.originalBytes === 4096;
})());

console.log(`\n照片记忆单测：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
