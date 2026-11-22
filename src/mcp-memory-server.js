// 记忆系统 MCP server（stdio，serverName: memory，§6：10 个工具）。
//
// 由 DSH 的 MCP 客户端 spawn（两个 DSH 实例会各起一个）。注意：
// - stdout 只走 MCP 协议，任何日志一律 console.error（stderr）；
// - 不用 `import.meta.url`（离线测试会 vm 执行本文件），仓库根用 process.argv[1] 推导；
// - 每个 handler 都兜住异常：业务失败返回 { isError: true, content:[{type:'text', text:'错误：…'}] }，
//   绝不 throw 到 transport；
// - 服务层每次操作都重新读盘（store 有跨进程锁），因此多进程/多实例看到同一份记忆库；
// - 根目录可用环境变量 QQBRIDGE_MEMORY_ROOT 覆盖（测试隔离用），否则从 argv[1] 推导。
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MemoryError } from './memory/model.mjs';
import { createService } from './memory/service.mjs';

const SERVER_VERSION = '0.2.1-r1';

/** 仓库根：QQBRIDGE_MEMORY_ROOT > argv[1] 的上一级 src 的父目录 > cwd。 */
function projectRoot() {
  try {
    const envRoot = String(process.env.QQBRIDGE_MEMORY_ROOT ?? '').trim();
    if (envRoot) return path.resolve(envRoot);
  } catch {
    /* ignore */
  }
  try {
    const entry = String(process.argv[1] ?? '');
    if (entry) {
      const dir = path.dirname(path.resolve(entry));
      if (path.basename(dir) === 'src') return path.dirname(dir);
    }
  } catch {
    /* ignore */
  }
  return process.cwd();
}

let serviceInstance = null;
function service() {
  if (!serviceInstance) serviceInstance = createService({ repoRoot: projectRoot() });
  return serviceInstance;
}

function jsonResult(result) {
  return { content: [{ type: 'text', text: JSON.stringify(result) }] };
}

function errorResult(error) {
  const message = error instanceof MemoryError ? error.message : error?.message ?? String(error);
  if (!(error instanceof MemoryError)) {
    console.error(`[memory] 未预期错误：${error?.stack ?? error}`);
  }
  return { content: [{ type: 'text', text: `错误：${message}` }], isError: true };
}

/** 统一 handler 包装：同步/异步都支持，异常转 isError 文本。 */
function handle(fn) {
  return async (args) => {
    try {
      return jsonResult(await fn(args && typeof args === 'object' ? args : {}));
    } catch (error) {
      return errorResult(error);
    }
  };
}

const LAYER = z.enum(['long', 'short']);
const CATEGORY = z.enum(['fact', 'preference', 'event', 'relationship', 'promise', 'topic', 'profile', 'other']);
const ENTITY_TYPE = z.enum(['person', 'group', 'topic', 'term', 'event', 'project', 'self']);
const RELATION = z.enum([
  'member_of',
  'likes',
  'knows',
  'discussed',
  'part_of',
  'owner_of',
  'related',
  'alias_of',
]);

const server = new McpServer({ name: 'memory', version: SERVER_VERSION });

// 逐条路由 v1.2：工具描述统一追加排他提示，避免模型把别的功能会话工具当可选项乱试。
{
  const registerTool = server.tool.bind(server);
  server.tool = (name, description, ...rest) => {
    const desc = typeof description === 'string' && !description.includes("仅当用户当前这条消息确实需要该能力时")
      ? description + "\n（仅当用户当前这条消息确实需要该能力时才调用；不要为了试探或浏览工具而调用；不属于本功能会话的工具已被隐藏或会被拒绝。）"
      : description;
    return registerTool(name, desc, ...rest);
  };
}

server.tool(
  'recall',
  '检索长期记忆用于当前对话：按相关度/强度排序返回记忆，并把命中的前几条“重新激活”（重置衰减、重新计时）。聊到某个人、群、梗、历史事件、偏好、承诺、近期话题前先调用；返回 hint 说明库内概况和可继续做的动作。',
  {
    query: z.string().optional().describe('要回忆的话题/关键词；为空时按强度和近期活跃度返回最重要的记忆'),
    entity: z.string().optional().describe('按实体名/别名/id 过滤（回忆某个人或某个群时用）'),
    layer: LAYER.optional().describe('只查某一层：long=长期稳定（人物/关系/长期偏好），short=短期时效（近况/近期话题）'),
    date: z.string().optional().describe('按创建日期过滤，格式 YYYY-MM-DD（本地时区）。用户问「昨天/今天/某天」时用；日记记忆的标题格式是「日记·YYYY-MM-DD」'),
    since: z.string().optional().describe('起始日期（含），YYYY-MM-DD；与原 date 一起可查一段日期区间'),
    until: z.string().optional().describe('截止日期（含），YYYY-MM-DD'),
    category: CATEGORY.optional().describe('按分类过滤（日记用 event；偏好用 preference；人物档案用 profile）'),
    depth: z.number().int().min(0).max(3).optional().describe('扩散激活深度：0=只看字面/实体直达；1=默认一跳（~50ms）；2=习惯关联（~200ms）；3=深挖因果/跨域（~500ms）。线索只给一半、想多捞几条时调 2/3'),
    limit: z.number().int().min(1).max(20).optional().describe('返回条数，默认 5，最大 20'),
    reinforce: z.boolean().optional().describe('是否把命中的前 3 条重置衰减，默认 true；只浏览不想影响衰减时传 false'),
  },
  handle((args) => service().recall(args))
);

server.tool(
  'remember',
  '记住一条值得长期保留的信息：用户偏好、事实、承诺、人物关系、群梗、重要事件、近期话题。相似记忆会自动合并（保留更完整的文本并重新激活），返回 created=false 表示合并。日常对话中值得下次还记得的信息都应主动记录。',
  {
    text: z.string().min(1).max(2000).describe('记忆正文（必填，1~2000 字，一行讲清一个事实）'),
    title: z.string().max(60).optional().describe('短标题；缺省取正文前 30 字'),
    layer: LAYER.optional().describe('long=长期（人物/关系/长期偏好，衰减慢），short=短期（近况/近期话题，默认）'),
    category: CATEGORY.optional().describe('分类：fact/preference/event/relationship/promise/topic/profile/other（默认 other）'),
    keywords: z.array(z.string().max(40)).max(10).optional().describe('检索关键词，最多 10 个、每个 ≤40 字；缺省自动提取'),
    entityNames: z.array(z.string().max(60)).max(10).optional().describe('相关实体名（人物/群/梗/项目），会自动建立实体；最多 10 个'),
    relations: z
      .array(
        z.object({
          from: z.string().optional().describe('关系起点实体名（默认取 entityNames 第一个）'),
          to: z.string().describe('关系终点实体名'),
          relation: RELATION.optional().describe('关系类型，默认 related'),
          note: z.string().max(200).optional().describe('关系备注'),
        })
      )
      .max(30)
      .optional()
      .describe('要补充的实体关系（如 A member_of 群B）；也用于给已有实体补关系'),
    tags: z.array(z.string().max(30)).max(20).optional().describe('标签，最多 20 个；日记用 ["diary"]（会单独归档到 vault 的 日记/，不参与衰减/清理）'),
    protection: z.number().min(0).max(1).optional().describe('保护度 0~1；1=永久（不衰减、不会被遗忘），默认 0'),
    decayDays: z.number().int().min(1).max(3650).optional().describe('衰减天数 1~3650；缺省按 layer 用配置值（long 200 / short 30）'),
    validForMinutes: z.number().min(1).max(525600).optional().describe('有效分钟数：一次性事实（「今晚不关机」）到点自动失效、不再参与检索；优先级低于 expiresAt'),
    expiresAt: z.string().optional().describe('到期时间（ISO 字符串，如 2026-10-30T08:00:00+08:00）；到点后自动从检索里消失'),
    source: z
      .object({
        kind: z.string().optional().describe('来源类型：chat/seed/manual/import，默认 chat'),
        key: z.string().max(200).optional().describe('来源会话 key，如 group:123456；同文本不同来源会合并'),
        seqs: z.array(z.number()).max(200).optional().describe('来源消息 seq 列表，便于回溯'),
      })
      .optional()
      .describe('来源信息；缺省 key=manual。同一会话的消息建议带上 key'),
    supersedes: z
      .array(z.string().max(120))
      .max(20)
      .optional()
      .describe('显式声明这条新记忆取代哪些旧记忆 id（旧记忆会标记 superseded 并退出默认召回）。省略时按文本变更词+主题重叠自动检测'),
    dedupe: z.boolean().optional().describe('相似记忆自动合并，默认 true；明确要新建一条独立记忆时传 false'),
  },
  handle((args) => service().remember(args))
);

server.tool(
  'search',
  '只读检索记忆（不重置衰减，适合浏览/核对/去重前检查）。与 recall 的区别：search 不改变记忆强度，recall 会强化命中的记忆。返回 memories 与命中总数 total。',
  {
    query: z.string().optional().describe('关键词；为空时按强度/新近度返回'),
    entity: z.string().optional().describe('按实体名/别名/id 过滤'),
    layer: LAYER.optional().describe('只看 long 或 short 层'),
    date: z.string().optional().describe('按创建日期过滤，格式 YYYY-MM-DD（本地时区）；「昨天/某天/日记」查询用'),
    since: z.string().optional().describe('起始日期（含），YYYY-MM-DD'),
    until: z.string().optional().describe('截止日期（含），YYYY-MM-DD'),
    category: CATEGORY.optional().describe('按分类过滤（fact/preference/event/relationship/promise/topic/profile/other）'),
    status: z.string().optional().describe('按状态过滤：active/fading/faded/archived/superseded，多个用逗号分隔'),
    depth: z.number().int().min(0).max(3).optional().describe('扩散激活深度 0~3，默认 1；0=只看字面/实体直达，2/3=沿关系与共激活突触多跳找回'),
    limit: z.number().int().min(1).max(50).optional().describe('返回条数，默认 8，最大 50'),
    includeFaded: z.boolean().optional().describe('是否包含 faded（已淡忘、等待清理）的记忆，默认 false'),
    includeSuperseded: z.boolean().optional().describe('是否包含被新决策取代（superseded）的旧记忆，默认 false；用户问“以前是怎么定的/历史”时传 true'),
  },
  handle((args) => service().search(args))
);

server.tool(
  'ingest',
  '零 LLM 抽取入库：把一段对话/笔记按规则切成候选事实（decision/promise/preference/error/todo）并逐条 remember。适合会话收尾时批量整理、或用户丢来一大段内容时入库；dryRun=true 只返回候选不改库。',
  {
    text: z.string().min(1).max(8000).describe('要整理的原文（一段对话/笔记/会议记录，1~8000 字）'),
    max: z.number().int().min(1).max(10).optional().describe('最多抽取几条候选，默认 6，最大 10'),
    layer: LAYER.optional().describe('入库层级，默认 short（短期）；长期偏好/决策可传 long'),
    dryRun: z.boolean().optional().describe('只看候选、不落库（先给用户确认时用），默认 false'),
  },
  handle((args) => service().ingest(args))
);

server.tool(
  'state',
  '读取当前人格状态（精力/心情）：返回感受词（如「有点乏」「平静」）和内部数值。注入提示词用感受词，不用数值；只读，不改变状态。',
  {},
  handle(() => service().state())
);

server.tool(
  'set_state',
  '更新自己当前的状态：精力/心情。会在对话里以感受词自然体现（不报数字）。用户说「你困不困/心情怎么样」，或自己聊累了、被夸/被怼情绪有变化时可以更新。',
  {
    energy: z.number().min(0).max(1).optional().describe('精力 0~1（0 非常累、1 精神很足）；缺省保持原值'),
    mood: z.number().min(-1).max(1).optional().describe('心情 -1~1（负数低落、正数愉快）；缺省保持原值'),
    reason: z.string().max(120).optional().describe('为什么变（一句话，便于回溯），如「聊到凌晨有点困」'),
  },
  handle((args) => service().updateState(args))
);

server.tool(
  'touch',
  '重新激活记忆：把强度重置为 1、衰减重新计时（用户再次提起某件事、确认某个旧记忆仍有效时用）。返回 touched（含新强度）和 missed（没找到/已归档的 id）。',
  {
    ids: z.array(z.string()).max(50).optional().describe('记忆 id 列表（recall/search 返回的 id）'),
    query: z.string().optional().describe('或按关键词找记忆再激活；与 ids 可同时给'),
    limit: z.number().int().min(1).max(10).optional().describe('query 模式最多激活几条，默认 3，最大 10'),
  },
  handle((args) => service().touch(args))
);

server.tool(
  'pin',
  '把记忆固定为永久（protection=1：永不衰减、不会被 forget），或取消永久（protection=0）。用户明确说“记住别忘/永远记住”，或长期重要的人设/关系/承诺，适合 pin。返回 ok/id/protection/permanent。',
  {
    id: z.string().optional().describe('记忆 id；与 query 二选一'),
    query: z.string().optional().describe('按关键词找到要固定的记忆（取最相关一条）'),
    protection: z.number().min(0).max(1).optional().describe('保护度，默认 1=永久；传 0 取消永久'),
    note: z.string().max(200).optional().describe('给这条记忆补一句备注'),
  },
  handle((args) => service().pin(args))
);

server.tool(
  'update',
  '修改已存在的记忆（标题/正文/层级/分类/关键词/标签/衰减天数/保护度/关联实体）。改正文不会重置衰减计时，除非 resetDecay=true。注意区分：更新已有记忆用本工具，新信息用 remember。',
  {
    id: z.string().describe('要修改的记忆 id（必填）'),
    title: z.string().max(60).optional().describe('新标题'),
    text: z.string().min(1).max(2000).optional().describe('新正文'),
    layer: LAYER.optional().describe('新层级 long/short'),
    category: CATEGORY.optional().describe('新分类'),
    keywords: z.array(z.string().max(40)).max(10).optional().describe('新关键词（整体替换，每个 ≤40 字）'),
    tags: z.array(z.string().max(30)).max(20).optional().describe('新标签（整体替换）'),
    decayDays: z.number().int().min(1).max(3650).optional().describe('新衰减天数'),
    protection: z.number().min(0).max(1).optional().describe('新保护度；1=永久'),
    entityNames: z.array(z.string().max(60)).max(10).optional().describe('要追加关联的实体名'),
    resetDecay: z.boolean().optional().describe('是否同时重置衰减计时，默认 false'),
  },
  handle((args) => service().update(args))
);

server.tool(
  'forget',
  '遗忘记忆：默认 mode=archive 归档（不再展示、记录保留），mode=purge 彻底删除（不可恢复）。永久记忆默认拒绝，需 force=true。用户要求“忘掉这个”时使用。',
  {
    id: z.string().optional().describe('要遗忘的记忆 id；与 ids/query 三选一'),
    ids: z.array(z.string()).max(50).optional().describe('批量遗忘的记忆 id 列表'),
    query: z.string().optional().describe('按关键词找到要遗忘的记忆（最相关的几条）'),
    mode: z.enum(['archive', 'purge']).optional().describe('archive=归档（默认，可保留记录），purge=彻底删除（不可恢复）'),
    force: z.boolean().optional().describe('是否强制遗忘永久记忆，默认 false'),
  },
  handle((args) => service().forget(args))
);

server.tool(
  'entity',
  '维护实体档案：人物、群、梗、术语、事件、项目。可补别名/备注/标签并建立关系（member_of/likes/knows/discussed/part_of/owner_of/related）。同名不同类别会新建实体并自动建立 alias_of。返回实体档案与关系列表。',
  {
    name: z.string().min(1).max(60).describe('实体名（必填）'),
    type: ENTITY_TYPE.optional().describe('类型：person/group/topic/term/event/project/self；缺省 topic'),
    aliases: z.array(z.string().max(60)).max(20).optional().describe('别名/昵称，最多 20 个'),
    note: z.string().max(500).optional().describe('备注：人物印象、梗的含义、群的定位等'),
    tags: z.array(z.string().max(30)).max(20).optional().describe('标签'),
    relations: z
      .array(
        z.object({
          to: z.string().describe('关系目标实体名（不存在时自动创建）'),
          relation: RELATION.optional().describe('关系类型，默认 related'),
          note: z.string().max(200).optional().describe('关系备注'),
        })
      )
      .max(30)
      .optional()
      .describe('从本实体出发的关系列表'),
  },
  handle((args) => service().entity(args))
);

server.tool(
  'graph',
  '查看实体关系图：返回实体、关系、以及关联的记忆（用于了解某人/某群的社交关系和相关历史）。给 entity 时按 depth 广度扩展邻居；不给时返回提及最多的实体和最近记忆。',
  {
    entity: z.string().optional().describe('中心实体名/别名/id；缺省返回全局概览'),
    depth: z.number().int().min(1).max(3).optional().describe('扩展层数 1~3，默认 1'),
    limit: z.number().int().min(1).max(100).optional().describe('最多返回的实体数，默认 30，最大 100'),
  },
  handle((args) => service().graph(args))
);

server.tool(
  'consolidate',
  '运行一次夜间巩固（replay）：把反复提起的短期记忆升级为长期、把近重复记忆归档、清洗无意义的关键词，并写 state/memory/last-consolidation.json 指标。只做低风险整理，不删除、不新建记忆。',
  {},
  handle(() => service().consolidate())
);

server.tool(
  'stats',
  '查看记忆库统计：总数、层级分布、永久/淡忘数量、实体/关系数、保护线、衰减参数、vault 目录和“最近一条将淡忘的记忆”提示。不修改任何数据。',
  {},
  handle(() => service().stats())
);

server.tool(
  'salience',
  '查看记忆的关键度分级（只读）：按硬指标（永久/承诺/人物/锚词/反复提起/图里连接）给每条记忆打分，分成核心/重要/普通三档，只影响留多久，不改检索排序。可传 tier 只看某一档。',
  {
    tier: z.enum(['core', 'important', 'normal']).optional().describe('只看某一档：core 核心 / important 重要 / normal 普通'),
    limit: z.number().int().min(1).max(100).optional().describe('最多返回条数，默认 20'),
  },
  handle((args) => service().salience(args))
);

server.tool(
  'self',
  '自述与人设。不带 text 时查看自述列表与人设建议状态；带 text 时写一条自述（只增不改、随写随生效）。人设主线不能直接改，只能提交建议（用 persona 工具，会自动按护栏采纳）。',
  {
    text: z.string().max(600).optional().describe('要写进自述的一句话（只增不改）'),
    limit: z.number().int().min(1).max(50).optional().describe('查看时返回的条数'),
  },
  handle((args) => (args.text ? service().addSelfNarrative({ text: args.text }) : service().narratives({ limit: args.limit })))
);

server.tool(
  'persona',
  '人设主线（会自动采纳）。text=提交一条人设建议（进入 pending，桥接层按护栏自动批准，不必等主人点批）；status=approved/rejected 仍可用于手动批准或驳回已提交的建议。',
  {
    text: z.string().max(400).optional().describe('人设建议内容'),
    status: z.enum(['approved', 'rejected']).optional().describe('手动批准/驳回（一般不需要）'),
  },
  handle((args) => {
    if (args.status) return service().resolvePersona({ status: args.status });
    if (!args.text) throw new Error('persona 需要 text 或 status');
    return service().setPersona({ text: args.text });
  })
);

server.tool(
  'value',
  '记住「他在乎什么 / 我认同什么」这类方向性判断（比流水账重要）。写一条价值取向；不带 text 时查看已记录的价值清单。',
  {
    text: z.string().max(300).optional().describe('要记住的价值取向（如「他在乎的是我说话有没有变」）'),
  },
  handle((args) => { const svc = service(); if (args.text) return svc.addValue({ text: args.text }); const list = svc.narratives({ limit: 1 }); return { ok: true, values: list.values }; })
);

server.tool(
  'digest',
  '自述回炉：把最近的自述压缩成一段摘要（原文保留，只增不减），避免「只加不减糊成一坨客气话」。默认攒够 30 条才做；dryRun 只预览，force 可强制。',
  {
    dryRun: z.boolean().optional().describe('只预览不落库'),
    force: z.boolean().optional().describe('不足 30 条也强制回炉'),
  },
  handle((args) => service().selfDigest(args))
);

server.tool(
  'day',
  '日层压缩：把某一天压成一小段“那阵子大概发生了什么”，每天一条、不参与衰减、注入时不占普通名额。默认压缩昨天；dryRun 只预览。',
  {
    date: z.string().max(10).optional().describe('YYYY-MM-DD，默认昨天'),
    dryRun: z.boolean().optional().describe('只预览不落库'),
    force: z.boolean().optional().describe('覆盖当天已存在的日层'),
  },
  handle((args) => service().dayDigest(args))
);

server.tool(
  'emotion',
  '查看机器人当前情绪（24 小时内有效，过期自动不再复读）与最近历史。情绪用感受词表达，不念标签数值。',
  {},
  handle(() => service().emotion())
);

server.tool(
  'set_emotion',
  '记下一条此刻的情绪（机器人自己或主人代填）：label 必填，intensity 0~1，note 可选；也可以给 PAD 三维（p 愉悦 / a 唤醒 / d 掌控，各 -1~1）区分「烦躁」和「低落」这类同强度不同底色。24 小时后自动过期、不再复读。',
  {
    label: z.string().max(20).describe('烦躁/低落/平静/开心/疲惫/紧张/兴奋/委屈'),
    intensity: z.number().min(0).max(1).optional().describe('强度 0~1，默认 0.5'),
    pad: z
      .object({
        p: z.number().min(-1).max(1).optional().describe('愉悦度 -1~1'),
        a: z.number().min(-1).max(1).optional().describe('唤醒度 -1~1'),
        d: z.number().min(-1).max(1).optional().describe('掌控感 -1~1'),
      })
      .optional()
      .describe('PAD 三维，缺省按 label 基准值补'),
    note: z.string().max(120).optional().describe('一句备注'),
  },
  handle((args) => service().setEmotion(args))
);

server.tool(
  'proposals',
  '查看自升级提案（机器人自己提的候选改动；默认由桥接层按护栏自动采纳，主人也可以手动驳回）。返回 pending / decided 两组；外部卡尺分数由主人给。',
  {
    status: z.enum(['pending', 'approved', 'rejected']).optional().describe('只看某一状态'),
  },
  handle((args) => service().proposals(args))
);

server.tool(
  'decide_proposal',
  '主人批准或驳回一条自升级提案：id + decision(approved/rejected)；可给 externalScore 作为外部卡尺。',
  {
    id: z.string().max(80).describe('提案 id'),
    decision: z.enum(['approved', 'rejected']).describe('主人决定'),
    externalScore: z.number().min(0).max(1).optional().describe('外部卡尺分数（可选）'),
  },
  handle((args) => service().resolveProposal({ id: args.id, status: args.decision, by: 'owner', externalScore: args.externalScore }))
);

server.tool(
  'self_review',
  '按外部卡尺扫描机器人最近的话（客服腔/问句收尾/主动过多），生成候选提案。默认写入待主人批准的提案；dryRun 只预览。',
  {
    days: z.number().int().min(1).max(90).optional().describe('回看天数，默认 7'),
    dryRun: z.boolean().optional().describe('只预览不落库'),
  },
  handle((args) => service().selfReview(args))
);

server.tool(
  'trial',
  '查看一个月测试台（/api/memory/trial 同源）：开始时间、天数、唤醒统计、开封探针、漂移指标。',
  {},
  handle(() => service().trialInfo())
);

try {
  await server.connect(new StdioServerTransport());
} catch (error) {
  console.error(`[memory] MCP server 启动失败：${error?.stack ?? error}`);
  process.exitCode = 1;
}
