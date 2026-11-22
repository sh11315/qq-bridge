// 记忆系统 MCP server 验收测试（§6）：以 DSH 同样的方式用 stdio 拉起 src/mcp-memory-server.js，
// 走真实 MCP 协议调用 26 个工具，校验返回结构、错误处理、跨进程并发与落盘位置。
//
// 隔离原则：每个 server 进程都用环境变量 QQBRIDGE_MEMORY_ROOT 指向 os.tmpdir() 下的临时仓库，
// 绝不写真实仓库的 state/memory。测试结束删除临时目录。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MemoryStore } from '../src/memory/store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const SERVER_SCRIPT = path.join(ROOT, 'src', 'mcp-memory-server.js');
const EXPECTED_TOOLS = ['consolidate', 'day', 'decide_proposal', 'digest', 'emotion', 'entity', 'forget', 'graph', 'ingest', 'persona', 'pin', 'proposals', 'recall', 'remember', 'salience', 'search', 'self', 'self_review', 'set_emotion', 'set_state', 'state', 'stats', 'touch', 'trial', 'update', 'value'];

let passed = 0;
const failures = [];
const cleanups = [];

function section(title) {
  console.log(`\n# ${title}`);
}

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`not ok - ${name}`);
    console.log(String(error?.stack ?? error).split('\n').slice(0, 8).join('\n'));
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`not ok - ${name}`);
    console.log(String(error?.stack ?? error).split('\n').slice(0, 8).join('\n'));
  }
}

/** 启动一个与 DSH 等价的内存 MCP client（临时仓库由 env 注入）。 */
async function startClient(repo, label) {
  const transport = new StdioClientTransport({
    command: NODE,
    args: [SERVER_SCRIPT],
    cwd: ROOT,
    env: { ...process.env, QQBRIDGE_MEMORY_ROOT: repo },
    stderr: 'pipe',
  });
  const stderrChunks = [];
  if (transport.stderr) transport.stderr.on('data', (chunk) => stderrChunks.push(String(chunk)));
  const client = new Client({ name: `dsh-memory-test-${label}`, version: '0.0.0' });
  await client.connect(transport);
  cleanups.push(async () => {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
  });
  return { client, transport, stderrText: () => stderrChunks.join('') };
}

function parseResult(result) {
  assert.ok(result && Array.isArray(result.content), 'MCP 返回必须有 content 数组');
  assert.equal(result.content[0]?.type, 'text');
  return JSON.parse(result.content[0].text);
}

async function callOk(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, `${name} 不应失败：${result.content?.[0]?.text}`);
  return parseResult(result);
}

/** 业务错误：MCP 层返回 isError + “错误：…” 文本（不 throw 到 transport）。 */
async function callError(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, `${name} 应返回 isError`);
  assert.match(result.content[0].text, /^错误：/, `错误文本格式不对：${result.content[0].text}`);
  return result.content[0].text;
}

/** 参数校验错误：SDK 在调用 handler 之前拒绝，转为 isError 的 CallToolResult（不走 transport 异常）。 */
async function expectInvalidParams(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, `${name} 参数校验应返回 isError`);
  assert.match(result.content[0].text, /Input validation error|Invalid arguments|Invalid params/i);
}

const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-memory-mcp-'));
const sentencePool = [
  '春天的樱花在公园里开成一片粉色的云，游客排队拍照。',
  '图书馆新到的一批天文科普读物被借阅一空。',
  '早餐店换了新老板，豆浆的味道比以前甜了一点。',
  '周日下午体育馆有一场羽毛球友谊赛，记得带球拍。',
  '地铁四号线延伸段预计明年夏天正式开通。',
  '冰箱里的酸奶后天过期，今晚得处理掉。',
  '这本书讲的是二战期间破译密码的真实故事。',
  '楼下的橘猫生了三只小猫，见人就往纸箱里钻。',
  '公司年会一等奖是一台轻薄的笔记本电脑。',
  '台风过境后海边满地都是断枝和贝壳。',
  '菜市场的西红柿便宜了两块钱，买了一大袋。',
  '纪录片拍的是高原牧民一年四季的迁徙生活。',
];

try {
  section('连接与工具清单');
  const main = await startClient(tmpRepo, 'main');
  await checkAsync('stdio 握手成功，列出 26 个工具且带描述与对象 schema', async () => {
    const { tools } = await main.client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, EXPECTED_TOOLS, `工具集合不符：${names.join(',')}`);
    assert.equal(tools.length, 26);
    for (const tool of tools) {
      assert.equal(typeof tool.description, 'string');
      assert.ok(tool.description.length >= 20, `${tool.name} 的描述太短`);
      assert.ok(tool.inputSchema && typeof tool.inputSchema === 'object');
      assert.equal(tool.inputSchema.type, 'object');
    }
  });

  section('consolidate / 归档');
  await checkAsync('consolidate：空库也能运行并返回指标结构', async () => {
    const result = await callOk(main.client, 'consolidate');
    assert.equal(typeof result.promoted, 'number');
    assert.equal(typeof result.deduped, 'number');
    assert.equal(typeof result.keywordCleaned, 'number');
    assert.equal(typeof result.duplicateRate, 'number');
    assert.equal(result.total, 0);
  });

  section('v1.5-lite 人格状态');
  await checkAsync('state / set_state：读写状态且返回感受词', async () => {
    const before = await callOk(main.client, 'state');
    assert.equal(before.ok, true);
    assert.equal(typeof before.state.energyWord, 'string');
    const updated = await callOk(main.client, 'set_state', { energy: 0.35, mood: -0.4, reason: 'mcp 测试' });
    assert.equal(updated.ok, true);
    assert.equal(updated.state.energy, 0.35);
    assert.equal(updated.state.mood, -0.4);
    const after = await callOk(main.client, 'stats');
    assert.equal(typeof after.state.energyWord, 'string');
  });

  await checkAsync('salience：只读分级返回三档与条目，可按 tier 过滤', async () => {
    const all = await callOk(main.client, 'salience', { limit: 5 });
    assert.equal(all.ok, true);
    assert.equal(typeof all.counts.core, 'number');
    assert.ok(Array.isArray(all.items));
    const core = await callOk(main.client, 'salience', { tier: 'core' });
    assert.ok(core.items.every((item) => item.tier === 'core'));
    assert.equal(typeof core.tiers[0].decayFactor, 'number');
  });

  await checkAsync('value / digest：记「在乎的」并能回炉自述', async () => {
    const added = await callOk(main.client, 'value', { text: '他在乎的是我有没有自己改自己。' });
    assert.equal(added.ok, true);
    assert.equal(added.total, 1);
    const list = await callOk(main.client, 'value');
    assert.ok(Array.isArray(list.values) && list.values.length === 1);
    const digest = await callOk(main.client, 'digest', { force: true });
    assert.equal(digest.ok, true);
    assert.equal(typeof digest.count, 'number');
    assert.equal(typeof digest.total, 'number');
  });

  section('stats / remember / 去重');
  await checkAsync('stats：空库返回完整统计结构', async () => {
    const stats = await callOk(main.client, 'stats');
    assert.equal(stats.ok, true);
    assert.equal(stats.total, 0);
    assert.deepEqual(stats.byLayer, { long: 0, short: 0 });
    assert.equal(stats.permanent, 0);
    assert.equal(stats.entities, 0);
    assert.equal(stats.relations, 0);
    assert.ok(stats.vaultDir.endsWith('memory-vault'), `vaultDir 不符：${stats.vaultDir}`);
    assert.equal(typeof stats.decayDays.long, 'number');
    assert.equal(typeof stats.decayDays.short, 'number');
    assert.equal(typeof stats.nextDecayHint, 'string');
  });

  let firstMemoryId = null;
  await checkAsync('remember：创建记忆，返回 ok/id/created 与 §3 字段', async () => {
    const created = await callOk(main.client, 'remember', {
      text: '小明喜欢喝冰美式，不加糖。',
      layer: 'long',
      category: 'preference',
      entityNames: ['小明'],
      keywords: ['冰美式', '口味'],
      protection: 0.5,
      source: { key: 'group:1001', seqs: [11, 12] },
    });
    assert.equal(created.ok, true);
    assert.equal(created.created, true);
    assert.match(created.id, /^mem_[0-9a-f]{12}$/);
    assert.equal(created.memory.text, '小明喜欢喝冰美式，不加糖。');
    assert.equal(created.memory.layer, 'long');
    assert.equal(created.memory.status, 'active');
    assert.equal(created.memory.strength, 1);
    assert.equal(created.memory.protection, 0.5);
    assert.ok(Array.isArray(created.memory.entityIds) && created.memory.entityIds.length === 1);
    firstMemoryId = created.id;
  });

  await checkAsync('remember：同文本再次写入合并（created=false、总数不变）', async () => {
    const again = await callOk(main.client, 'remember', {
      text: '小明喜欢喝冰美式，不加糖。',
      layer: 'long',
      source: { key: 'group:1002', seqs: [99] },
    });
    assert.equal(again.created, false);
    assert.equal(again.mergedInto, firstMemoryId);
    const stats = await callOk(main.client, 'stats');
    assert.equal(stats.total, 1);
  });

  let secondMemoryId = null;
  await checkAsync('remember：relations 建立实体关系，返回 memory 关联实体', async () => {
    const created = await callOk(main.client, 'remember', {
      text: '周五下午三点在会议室讨论新版本文案。',
      layer: 'short',
      category: 'event',
      entityNames: ['文案组', '会议室'],
      relations: [{ to: '会议室', relation: 'part_of' }],
    });
    assert.equal(created.created, true);
    secondMemoryId = created.id;
    assert.equal(created.memory.layer, 'short');
    assert.equal(created.memory.entityIds.length, 2);
    const graph = await callOk(main.client, 'graph', { entity: '会议室' });
    assert.ok(graph.relations.some((relation) => relation.relation === 'PART_OF'));
  });

  section('search / recall / touch');
  await checkAsync('search：只读检索返回 memories+total 且不重置衰减', async () => {
    const before = await callOk(main.client, 'search', { query: '小明' });
    assert.equal(before.total, 1);
    assert.equal(before.memories.length, 1);
    assert.equal(before.memories[0].id, firstMemoryId);
    const after = await callOk(main.client, 'search', { query: '小明' });
    assert.equal(after.memories[0].strength, before.memories[0].strength);
    const all = await callOk(main.client, 'search', {});
    assert.ok(all.total >= 2);
    assert.equal(typeof all.memories[0].text, 'string');
  });

  await checkAsync('recall：返回前 3 条强化，reinforced 与 hint 有效', async () => {
    const recalled = await callOk(main.client, 'recall', { query: '小明', limit: 5 });
    assert.ok(recalled.memories.length >= 1);
    assert.equal(recalled.memories[0].id, firstMemoryId);
    assert.ok(recalled.reinforced.includes(firstMemoryId));
    assert.equal(typeof recalled.hint, 'string');
    assert.ok(recalled.hint.length > 0);
    const fresh = await callOk(main.client, 'search', { query: '小明' });
    assert.equal(fresh.memories[0].strength, 1, 'recall 应把命中记忆强度重置为 1');
  });

  await checkAsync('touch：命中返回新强度，未知 id 进 missed', async () => {
    const touched = await callOk(main.client, 'touch', { ids: [firstMemoryId, 'mem_000000000000'] });
    assert.equal(touched.touched.length, 1);
    assert.equal(touched.touched[0].id, firstMemoryId);
    assert.equal(touched.touched[0].strength, 1);
    assert.deepEqual(touched.missed, ['mem_000000000000']);
  });

  section('v1.3 扩散激活 / 矛盾降权 / ingest');
  await checkAsync('remember：新决定自动把旧记忆标 superseded，默认检索不再返回，includeSuperseded 可查', async () => {
    const old = await callOk(main.client, 'remember', { text: '鉴权方案用 JWT token。', category: 'fact' });
    const fresh = await callOk(main.client, 'remember', {
      text: '鉴权方案改用 Session，JWT 不再用了。',
      category: 'fact',
    });
    assert.ok(Array.isArray(fresh.superseded) && fresh.superseded.includes(old.id));
    const normal = await callOk(main.client, 'search', { query: '鉴权' });
    assert.ok(!normal.memories.some((memory) => memory.id === old.id));
    const explicit = await callOk(main.client, 'search', { query: '鉴权', includeSuperseded: true });
    assert.ok(explicit.memories.some((memory) => memory.id === old.id));
    const stats = await callOk(main.client, 'stats');
    assert.ok(stats.superseded >= 1);
    assert.ok(stats.deprioritized >= 1);
  });

  await checkAsync('search：depth 0/2 的扩散激活能带回共享实体的间接记忆', async () => {
    const direct = await callOk(main.client, 'remember', {
      text: '桥接项目跑在 DSH 3080 端口。',
      entityNames: ['桥接项目'],
      category: 'fact',
    });
    const indirect = await callOk(main.client, 'remember', {
      text: '桥接项目前端走 3100 端口调试。',
      entityNames: ['桥接项目'],
      category: 'fact',
    });
    const shallow = await callOk(main.client, 'search', { query: 'DSH', depth: 0 });
    assert.deepEqual(shallow.memories.map((memory) => memory.id), [direct.id]);
    const deep = await callOk(main.client, 'search', { query: 'DSH', depth: 2 });
    assert.ok(deep.memories.some((memory) => memory.id === indirect.id));
    assert.equal(deep.depth, 2);
    assert.equal(deep.depthProfile.name, 'Habit');
    assert.ok(deep.activated >= 1);
  });

  await checkAsync('ingest：dryRun 只返回候选，正式入库带 auto 标签', async () => {
    const text = '今天决定以后都用 SQLite。我喜欢喝冰美式。刚才报错了，登录失败。';
    const dry = await callOk(main.client, 'ingest', { text, dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.ok(dry.candidates.length >= 2);
    assert.ok(dry.candidates.some((candidate) => candidate.kind === 'decision'));
    const before = await callOk(main.client, 'stats');
    const real = await callOk(main.client, 'ingest', { text });
    assert.ok(real.created >= 2);
    const after = await callOk(main.client, 'stats');
    assert.equal(after.total, before.total + real.created);
    const stored = await callOk(main.client, 'search', { query: '冰美式', limit: 5 });
    assert.ok(stored.memories.some((memory) => memory.tags.includes('auto')));
  });

  section('pin / update / forget');
  await checkAsync('pin：protection=1 变为永久，stats.permanent 同步', async () => {
    const pinned = await callOk(main.client, 'pin', { id: firstMemoryId, protection: 1, note: '长期偏好' });
    assert.equal(pinned.ok, true);
    assert.equal(pinned.permanent, true);
    const stats = await callOk(main.client, 'stats');
    assert.equal(stats.permanent, 1);
  });

  await checkAsync('update：修改标题/关键词，返回更新后的 memory', async () => {
    const updated = await callOk(main.client, 'update', {
      id: firstMemoryId,
      title: '小明口味',
      keywords: ['冰美式', '不加糖'],
      tags: ['偏好'],
    });
    assert.equal(updated.ok, true);
    assert.equal(updated.id, firstMemoryId);
    assert.equal(updated.memory.title, '小明口味');
    assert.deepEqual(updated.memory.keywords, ['冰美式', '不加糖']);
  });

  await checkAsync('forget：永久记忆拒绝（refused），force+purge 才删除', async () => {
    const refused = await callOk(main.client, 'forget', { id: firstMemoryId });
    assert.equal(refused.forgotten.length, 0);
    assert.equal(refused.refused[0].reason, 'permanent');
    const forced = await callOk(main.client, 'forget', { id: firstMemoryId, mode: 'purge', force: true });
    assert.deepEqual(forced.forgotten, [firstMemoryId]);
    const stats = await callOk(main.client, 'stats');
    assert.equal(stats.permanent, 0);
    const gone = await callOk(main.client, 'search', { query: '小明', includeFaded: true });
    assert.equal(gone.total, 0);
  });

  await checkAsync('forget：archive 归档后从默认检索消失、可按 status 查回', async () => {
    const archived = await callOk(main.client, 'forget', { id: secondMemoryId, mode: 'archive' });
    assert.deepEqual(archived.forgotten, [secondMemoryId]);
    const normal = await callOk(main.client, 'search', { query: '文案' });
    assert.equal(normal.total, 0);
    const archivedSearch = await callOk(main.client, 'search', { query: '文案', status: 'archived' });
    assert.equal(archivedSearch.total, 1);
    assert.equal(archivedSearch.memories[0].status, 'archived');
  });

  section('entity / graph / stats');
  await checkAsync('entity：新建实体+别名+关系，返回实体与关系', async () => {
    const result = await callOk(main.client, 'entity', {
      name: '测试群',
      type: 'group',
      aliases: ['测试群聊'],
      note: '测试用群',
      relations: [{ to: '测试项目', relation: 'owner_of' }],
    });
    assert.equal(result.ok, true);
    assert.match(result.entity.id, /^ent_[0-9a-f]{12}$/);
    assert.equal(result.entity.type, 'group');
    assert.ok(result.entity.aliases.includes('测试群聊'));
    assert.equal(result.relations.length, 1);
    const alias = await callOk(main.client, 'entity', { name: '测试群聊' });
    assert.equal(alias.created, false);
    assert.equal(alias.entity.id, result.entity.id);
  });

  await checkAsync('graph：实体邻域与全局概览都返回实体/关系/记忆', async () => {
    const local = await callOk(main.client, 'graph', { entity: '测试群', depth: 2 });
    assert.ok(local.entities.some((entity) => entity.name === '测试群'));
    assert.ok(local.relations.length >= 1);
    const global = await callOk(main.client, 'graph', { limit: 10 });
    assert.ok(global.entities.length >= 2);
    const fields = ['id', 'type', 'name', 'mentionCount'];
    for (const field of fields) assert.ok(field in global.entities[0], `实体缺字段 ${field}`);
  });

  await checkAsync('stats：与写入数据一致（total/entities/relations/byLayer）', async () => {
    const stats = await callOk(main.client, 'stats');
    assert.equal(stats.ok, true);
    assert.ok(stats.total >= 1);
    assert.ok(stats.entities >= 3);
    assert.ok(stats.relations >= 2);
    assert.ok(stats.byLayer.long + stats.byLayer.short === stats.total);
    assert.equal(typeof stats.protectionLine, 'number');
    assert.equal(typeof stats.nextDecayHint, 'string');
  });

  section('错误处理（不 throw 到 transport）');
  await checkAsync('业务错误：pin 不存在的 id 返回 isError 文本，server 仍存活', async () => {
    const text = await callError(main.client, 'pin', { id: 'mem_000000000000' });
    assert.match(text, /记忆不存在/);
    const stats = await callOk(main.client, 'stats');
    assert.equal(stats.ok, true, '业务错误后 server 仍应响应');
  });

  await checkAsync('参数校验：空 text / 非法 layer 被拒绝，且不影响后续调用', async () => {
    await expectInvalidParams(main.client, 'remember', { text: '' });
    await expectInvalidParams(main.client, 'remember', { text: '合法文本', layer: 'bogus' });
    const stats = await callOk(main.client, 'stats');
    assert.equal(stats.ok, true);
  });

  section('并发：两个 DSH 实例各起一个 server 同时写同一个记忆库');
  await checkAsync('两个 client 各写 5 条，锁+原子写后总数一致，无 tmp/lock 残留', async () => {
    const before = (await callOk(main.client, 'stats')).total;
    const second = await startClient(tmpRepo, 'second');
    const writeBatch = async (client, offset) => {
      for (let index = 0; index < 5; index += 1) {
        await callOk(client, 'remember', {
          text: sentencePool[offset + index],
          source: { key: `group:${offset}`, seqs: [index] },
        });
      }
    };
    await Promise.all([writeBatch(main.client, 0), writeBatch(second.client, 5)]);
    assert.notEqual(second.stderrText().includes('未预期错误'), true, second.stderrText());
    const one = await callOk(main.client, 'stats');
    const two = await callOk(second.client, 'stats');
    assert.equal(one.total, before + 10, `并发写应新增 10 条，实际 ${one.total}（before=${before}）`);
    assert.equal(two.total, one.total, '两个进程应看到同一份记忆库');
    const memoryDir = path.join(tmpRepo, 'state', 'memory');
    const leftovers = fs.readdirSync(memoryDir).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, [], '不应残留 .tmp 临时文件');
    assert.equal(fs.existsSync(path.join(memoryDir, 'brain.lock')), false, '操作结束后不应残留锁文件');
  });

  section('落盘隔离');
  await checkAsync('brain.json 落在临时仓库 state/memory 下且结构合法', async () => {
    const brainPath = path.join(tmpRepo, 'state', 'memory', 'brain.json');
    assert.equal(fs.existsSync(brainPath), true, '临时仓库应生成 brain.json');
    const brain = JSON.parse(fs.readFileSync(brainPath, 'utf8'));
    assert.equal(brain.version, 1);
    assert.ok(brain.memories && Object.keys(brain.memories).length >= 1);
    // v1.6 起采用增量 journal：brain.json 是基线快照，最新写入可能还在 journal 中。
    // 用同一份仓库根重新加载（基线+回放 journal）再与 stats 对比，才是逻辑上的记忆库内容。
    const store = new MemoryStore({ repoRoot: tmpRepo });
    const loaded = store.load();
    const stats = await callOk(main.client, 'stats');
    assert.equal(Object.keys(loaded.memories).length, stats.total);
    assert.ok(loaded.config && typeof loaded.config.decayDaysLong === 'number');
    assert.equal(fs.existsSync(path.join(tmpRepo, 'state', 'memory', 'journal.jsonl')), true, '增量写入后应存在 journal.jsonl');
  });

  await checkAsync('server stderr 无未预期错误/启动失败（stdout 只走协议）', async () => {
    // 若 server 往 stdout 写日志，MCP client 的 JSON-RPC 解析会失败，上面的调用就不可能全部成功；
    // 这里再确认 stderr 里没有未预期异常。
    const stderrText = main.stderrText();
    assert.notEqual(stderrText.includes('未预期错误'), true, stderrText);
    assert.notEqual(stderrText.includes('启动失败'), true, stderrText);
  });
} finally {
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch {
      /* ignore */
    }
  }
  try {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  } catch {
    /* Windows 上偶发占用，忽略 */
  }
}

console.log(`\n总计：${passed} 项通过，${failures.length} 项失败`);
if (failures.length) {
  console.log('失败项：');
  for (const failure of failures) console.log(` - ${failure.name}`);
  process.exitCode = 1;
}
