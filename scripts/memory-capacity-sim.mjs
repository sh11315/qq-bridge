#!/usr/bin/env node
// 记忆容量 vs 衰减：一天一天地仿真「写入 → 线性衰减 → 超容量按最旧淘汰」。
// 口径：强度从 1 线性掉到 0 用 D 天，掉到 0 算自然衰减；超容量时淘汰最旧（最弱）的那条。
// 快写法：按出生日排队，强度只由年龄决定，不逐条改强度。
// 用法：node scripts/memory-capacity-sim.mjs [--capacity 20000] [--days 400] [--json]

const argNum = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const CAPACITY = argNum('--capacity', 20000);
const DECAY_DAYS = argNum('--decay', 200);
const DAYS = argNum('--days', 400);
const WRITES = process.argv.includes('--writes')
  ? process.argv[process.argv.indexOf('--writes') + 1].split(',').map(Number)
  : [20, 50, 100, 200, 500, 1000, 3000];
const AS_JSON = process.argv.includes('--json');

function simulate(dailyWrites) {
  let born = []; // 出生日，按时间排好序；head 之后的才是还活着的
  let head = 0;
  const ageHist = new Int32Array(DECAY_DAYS + 2);
  let capacityDeaths = 0;
  let decayDeaths = 0;

  for (let day = 1; day <= DAYS; day++) {
    for (let i = 0; i < dailyWrites; i++) born.push(day);

    // 自然衰减：年龄到 D 天就掉光了
    while (head < born.length && day - born[head] >= DECAY_DAYS) {
      ageHist[Math.min(DECAY_DAYS, day - born[head])]++;
      decayDeaths++;
      head++;
    }
    // 超容量：淘汰最旧的（线性衰减下就是最弱的）
    while (born.length - head > CAPACITY) {
      ageHist[Math.min(DECAY_DAYS, day - born[head])]++;
      capacityDeaths++;
      head++;
    }
    // 队列空了就把指针收回去，别让数组无限长
    if (head > 200000 && head * 2 > born.length) {
      born = born.slice(head);
      head = 0;
    }
  }

  const total = capacityDeaths + decayDeaths;
  let median = 0;
  let seen = 0;
  for (let age = 0; age < ageHist.length; age++) {
    seen += ageHist[age];
    if (seen >= total / 2) { median = age; break; }
  }
  return {
    dailyWrites,
    population: born.length - head,
    capacityDeaths,
    decayDeaths,
    capacityShare: total ? capacityDeaths / total : 0,
    medianLifespanDays: median,
  };
}

const rows = WRITES.map(simulate);
const criticalWrites = Math.round((2 * CAPACITY) / DECAY_DAYS);

if (AS_JSON) {
  console.log(JSON.stringify({ capacity: CAPACITY, decayDays: DECAY_DAYS, days: DAYS, criticalWrites, rows }, null, 2));
} else {
  console.log(`容量 ${CAPACITY} 条 · 线性衰减 ${DECAY_DAYS} 天 · 仿真 ${DAYS} 天`);
  console.log(`临界写入量约 ${criticalWrites} 条/天：低于它靠衰减自然清，高于它开始靠容量淘汰\n`);
  console.log('日写入  稳态人口  容量淘汰  自然衰减  容量占比  寿命中位数');
  for (const r of rows) {
    console.log([
      String(r.dailyWrites).padStart(5),
      String(r.population).padStart(8),
      String(r.capacityDeaths).padStart(8),
      String(r.decayDeaths).padStart(8),
      `${(r.capacityShare * 100).toFixed(1)}%`.padStart(8),
      `${r.medianLifespanDays} 天`.padStart(10),
    ].join('  '));
  }
  console.log('\n结论：配额按「一天写多少条」定，C ≈ 2 × 日写入 × 衰减天数；');
  console.log('      现在库不到一百条，20000 的配额够用好几年，先掉的一定是没人再提起的那些。');
}
