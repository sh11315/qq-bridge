// 图片 dHash（difference hash，64 bit）+ 汉明距离 + 近似去重判定。
//
// 用途：收藏表情前判断“这张是不是已经收过了”，避免同一张图因重新压缩/换名
// 被重复收进库。只做 9x8 灰度差值，不需要图像解码库；像素由 ffmpeg 提供。

const HASH_RE = /^[0-9a-f]{16}$/;

/**
 * 9x8 灰度（行优先，72 字节）→ 16 位十六进制 dHash。
 * 每行 9 个像素两两比较，得到 8 bit，共 64 bit。
 */
export function dhashFromGray(gray) {
  if (!gray || gray.length < 72) throw new Error('dHash 需要 9x8=72 字节灰度图');
  let hex = '';
  for (let row = 0; row < 8; row += 1) {
    let byte = 0;
    for (let col = 0; col < 8; col += 1) {
      const left = gray[row * 9 + col];
      const right = gray[row * 9 + col + 1];
      byte = (byte << 1) | (left > right ? 1 : 0);
    }
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/** 两个 dHash 的汉明距离（0…64）。 */
export function hammingHex(a, b) {
  const left = String(a ?? '').toLowerCase();
  const right = String(b ?? '').toLowerCase();
  if (!HASH_RE.test(left) || !HASH_RE.test(right)) return 64;
  let diff = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let count = 0;
  while (diff) {
    count += Number(diff & 1n);
    diff >>= 1n;
  }
  return count;
}

/**
 * 在表情库里找近似重复。
 * @param {Array} entries 条目需带 dhash 字段（没有的跳过）
 * @param {string} hash 16 位十六进制
 * @param {number} threshold 允许的汉明距离，默认 6（越小越严格）
 * @returns {{entry:object,distance:number}|null}
 */
export function findNearDuplicate(entries, hash, threshold = 6) {
  const target = String(hash ?? '').toLowerCase();
  if (!HASH_RE.test(target)) return null;
  const limit = Math.max(0, Number(threshold) || 0);
  let best = null;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const other = String(entry?.dhash ?? '').toLowerCase();
    if (!HASH_RE.test(other)) continue;
    const distance = hammingHex(target, other);
    if (!best || distance < best.distance) best = { entry, distance };
  }
  return best && best.distance <= limit ? best : null;
}