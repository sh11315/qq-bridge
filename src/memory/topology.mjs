/**
 * 记忆系统 → 分域拓扑图（群聊 / 私信 / 黑话）。
 *
 * 与 vault.mjs 的「记忆大脑」全量图互补：
 *   - 记忆大脑（图谱/记忆大脑.svg / .canvas）：所有节点混在一张同心环图里；
 *   - 分域拓扑（图谱/拓扑-<scope>.svg / .canvas）：把同一份 brain 拆成三张可读的图
 *       · 群聊：QQ 群 + 群友 + 群聊来源的记忆
 *       · 私信：owner / 本人 + 私信话题 + 私信来源的记忆
 *       · 黑话：黑话词条 + 使用它们的人（+ 群 hub），不含记忆
 *
 * 纯数据渲染：输入 vault model（buildVaultModel 的返回值），输出 Map<相对路径, 内容>。
 * 不读写文件、不依赖时间，同一 model 多次渲染字节一致（便于测试）。
 *
 * 生成的文件头说明与 vault.mjs 一致，手改会被下一次刷新覆盖。
 */

/** 所有生成文件头的统一提示（与 vault.mjs 保持一致，独立导出避免循环引用）。 */
export const AUTO_GEN_NOTICE =
  '由 QQ Bridge 记忆系统自动生成，手改会被下一次刷新覆盖；要改记忆请让 bot 用 memory_update 或编辑 brain.json 前先备份';

const SVG_WIDTH = 1600;
const SVG_HEIGHT = 1000;
const SVG_RING_MIN_ARC = 82;
const SVG_RING_GAP = 172;
const SVG_HUB_OFFSET = 230;
const CANVAS_RING_MIN_ARC = 250;
const CANVAS_RING_GAP = 430;
const CANVAS_HUB_OFFSET = 640;
const CANVAS_NODE_WIDTH = 200;
const CANVAS_NODE_HEIGHT = 84;
const CANVAS_MEMORY_WIDTH = 210;
const CANVAS_MEMORY_HEIGHT = 92;

/** 分域定义：id / 标题 / 文件名前缀 / 说明。 */
export const TOPOLOGY_SCOPES = [
  { id: 'group', title: '群聊拓扑', fileBase: '图谱/拓扑-群聊', subtitle: 'QQ 群 · 群友 · 群聊记忆' },
  { id: 'private', title: '私信拓扑', fileBase: '图谱/拓扑-私信', subtitle: 'owner · 私信话题 · 私信记忆' },
  { id: 'slang', title: '黑话拓扑', fileBase: '图谱/拓扑-黑话', subtitle: '黑话词条 · 使用它们的人' },
];

const ENTITY_COLORS = {
  group: '#4d8dff',
  person: '#2f9e59',
  self: '#d95fbf',
  topic: '#e08a1e',
  term: '#8b6cf0',
  project: '#6f7bd9',
};
const ENTITY_TYPE_LABELS = {
  group: '群聊',
  person: '群友',
  self: '本人',
  topic: '话题',
  term: '黑话',
  project: '项目',
};
const MEMORY_COLORS = { permanent: '#d9a514', long: '#3d7ff0', short: '#7a869a' };
const MEMORY_LAYER_LABELS = { permanent: '永久记忆', long: '长期记忆', short: '短期记忆' };
const DEFAULT_ENTITY_COLOR = '#8a94a6';

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncate(value, max) {
  const text = String(value ?? '');
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, max - 1).join('')}…`;
}

function memorySourceKey(memory) {
  const source = memory && memory.source;
  return source && typeof source.key === 'string' ? source.key : '';
}

function entitySourceKey(entity) {
  const source = entity && entity.source;
  return source && typeof source.key === 'string' ? source.key : '';
}

function memoryLayer(memory) {
  if (memory && memory.permanent) return 'permanent';
  return memory && memory.vaultLayer === 'short' ? 'short' : 'long';
}

function entityColor(entity) {
  return ENTITY_COLORS[entity.type] || DEFAULT_ENTITY_COLOR;
}

function makeEntityNode(entity) {
  return {
    id: `e:${entity.id}`,
    kind: 'entity',
    type: entity.type,
    name: entity.displayName || entity.name,
    color: entityColor(entity),
    colorCode: null,
  };
}

function makeMemoryNode(memory) {
  const layer = memoryLayer(memory);
  return {
    id: `m:${memory.id}`,
    kind: 'memory',
    type: 'memory',
    layer,
    name: memory.displayTitle || memory.title,
    relPath: memory.relPath,
    color: MEMORY_COLORS[layer],
    colorCode: layer,
  };
}

function relationPairs(model) {
  return Array.isArray(model && model.relations) ? model.relations : [];
}

function entityById(model, id) {
  return model.entitiesById && model.entitiesById.get ? model.entitiesById.get(id) : null;
}

/** 群聊：群 hub + 群成员（person/self）+ 群聊来源记忆。 */
function buildGroupGraph(model) {
  const groups = model.entities.filter((entity) => entity.type === 'group');
  const groupIds = new Set(groups.map((entity) => entity.id));
  const personIds = new Set();
  for (const relation of relationPairs(model)) {
    if (relation.relation !== 'member_of') continue;
    if (groupIds.has(relation.to)) personIds.add(relation.from);
    else if (groupIds.has(relation.from)) personIds.add(relation.to);
  }
  const memories = model.memories.filter((memory) => memorySourceKey(memory).startsWith('group:'));
  for (const memory of memories) {
    for (const id of memory.entityIds || []) {
      const entity = entityById(model, id);
      if (entity && (entity.type === 'person' || entity.type === 'self')) personIds.add(id);
    }
  }
  personIds.forEach((id) => {
    if (!entityById(model, id)) personIds.delete(id);
  });
  const nodes = [];
  for (const id of groupIds) {
    const entity = entityById(model, id);
    if (entity) nodes.push(makeEntityNode(entity));
  }
  for (const id of personIds) {
    const entity = entityById(model, id);
    if (entity) nodes.push(makeEntityNode(entity));
  }
  for (const memory of memories) nodes.push(makeMemoryNode(memory));
  return finishGraph(model, {
    id: 'group',
    title: '群聊拓扑',
    subtitle: 'QQ 群 · 群友 · 群聊记忆',
    hubs: [...groupIds].map((id) => `e:${id}`),
    nodes,
    rings: [
      { ids: [...personIds].map((id) => `e:${id}`), radius: 300 },
      { ids: memories.map((memory) => `m:${memory.id}`), radius: 560 },
    ],
    memoryEdges: true,
  });
}

/** 私信：owner/本人 hub + 与 owner 相连的人/话题 + 私信来源记忆。 */
function buildPrivateGraph(model) {
  const selfs = model.entities.filter((entity) => entity.type === 'self');
  const hubEntities = selfs.length
    ? selfs
    : model.entities.filter((entity) => entity.type === 'person' && entitySourceKey(entity).startsWith('private:'));
  if (hubEntities.length === 0) return null;
  const hubIds = new Set(hubEntities.map((entity) => entity.id));
  const personIds = new Set();
  const topicIds = new Set();
  for (const relation of relationPairs(model)) {
    const fromInside = hubIds.has(relation.from);
    const toInside = hubIds.has(relation.to);
    if (!fromInside && !toInside) continue;
    const otherId = fromInside ? relation.to : relation.from;
    const entity = entityById(model, otherId);
    if (!entity || hubIds.has(otherId)) continue;
    if (entity.type === 'person' || entity.type === 'self') personIds.add(otherId);
    else if (entity.type === 'topic') topicIds.add(otherId);
  }
  const memories = model.memories.filter((memory) => memorySourceKey(memory).startsWith('private:'));
  for (const memory of memories) {
    for (const id of memory.entityIds || []) {
      const entity = entityById(model, id);
      if (!entity) continue;
      if (entity.type === 'topic') topicIds.add(id);
      else if (entity.type === 'person' || entity.type === 'self') personIds.add(id);
    }
  }
  for (const id of [...personIds]) if (!entityById(model, id)) personIds.delete(id);
  for (const id of [...topicIds]) if (!entityById(model, id)) topicIds.delete(id);
  const nodes = [];
  for (const entity of hubEntities) nodes.push(makeEntityNode(entity));
  for (const id of personIds) {
    const entity = entityById(model, id);
    if (entity) nodes.push(makeEntityNode(entity));
  }
  for (const id of topicIds) {
    const entity = entityById(model, id);
    if (entity) nodes.push(makeEntityNode(entity));
  }
  for (const memory of memories) nodes.push(makeMemoryNode(memory));
  return finishGraph(model, {
    id: 'private',
    title: '私信拓扑',
    subtitle: 'owner · 私信话题 · 私信记忆',
    hubs: [...hubIds].map((id) => `e:${id}`),
    nodes,
    rings: [
      { ids: [...topicIds].map((id) => `e:${id}`), radius: 280 },
      { ids: [...personIds].map((id) => `e:${id}`), radius: 450 },
      { ids: memories.map((memory) => `m:${memory.id}`), radius: 660 },
    ],
    memoryEdges: true,
  });
}

/** 黑话：term + 与 term 相连的实体（人/群/项目），不含记忆。 */
function buildSlangGraph(model) {
  const terms = model.entities.filter((entity) => entity.type === 'term');
  if (terms.length === 0) return null;
  const termIds = new Set(terms.map((entity) => entity.id));
  const linkedIds = new Set();
  for (const relation of relationPairs(model)) {
    if (termIds.has(relation.from) || termIds.has(relation.to)) {
      linkedIds.add(relation.from);
      linkedIds.add(relation.to);
    }
  }
  if (linkedIds.size === 0) return null;
  const hubEntities = model.entities.filter((entity) => entity.type === 'group' && linkedIds.has(entity.id));
  const hubIds = new Set(hubEntities.map((entity) => entity.id));
  const otherIds = [...linkedIds].filter((id) => !termIds.has(id) && !hubIds.has(id));
  const nodes = [];
  for (const entity of hubEntities) nodes.push(makeEntityNode(entity));
  for (const entity of terms) nodes.push(makeEntityNode(entity));
  for (const id of otherIds) {
    const entity = entityById(model, id);
    if (!entity) continue;
    nodes.push(makeEntityNode(entity));
  }
  return finishGraph(model, {
    id: 'slang',
    title: '黑话拓扑',
    subtitle: '黑话词条 · 使用它们的人',
    hubs: [...hubIds].map((id) => `e:${id}`),
    nodes,
    rings: [
      { ids: terms.map((entity) => `e:${entity.id}`), radius: 320 },
      { ids: otherIds.filter((id) => entityById(model, id)).map((id) => `e:${id}`), radius: 600 },
    ],
    memoryEdges: false,
  });
}

/**
 * 补齐 edges：只保留两端都在 nodes 里的关系；memoryEdges=true 时再补「记忆 ↔ 实体」的浅色连线。
 * @returns {object|null} 节点不足 2 个时返回 null（避免生成空图）
 */
function finishGraph(model, draft) {
  const ids = new Set(draft.nodes.map((node) => node.id));
  if (ids.size < 2) return null;
  const byId = new Map(draft.nodes.map((node) => [node.id, node]));
  const edges = [];
  const seen = new Set();
  for (const relation of relationPairs(model)) {
    const from = `e:${relation.from}`;
    const to = `e:${relation.to}`;
    if (!ids.has(from) || !ids.has(to)) continue;
    if (!byId.has(from) || !byId.has(to)) continue;
    const key = `${from}>${to}:${relation.relation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      id: `r:${relation.id}`,
      from,
      to,
      label: relation.relation,
      color: '#b9c3d3',
      weight: Number(relation.weight) || 1,
    });
  }
  if (draft.memoryEdges) {
    const memories = model.memories.filter((memory) => ids.has(`m:${memory.id}`));
    for (const memory of memories) {
      for (const id of memory.entityIds || []) {
        const entityNodeId = `e:${id}`;
        if (!ids.has(entityNodeId)) continue;
        const key = `m:${memory.id}>${entityNodeId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          id: `me:${memory.id}:${id}`,
          from: `m:${memory.id}`,
          to: entityNodeId,
          label: '',
          color: '#e3d4ac',
          weight: 0.5,
          memoryEdge: true,
        });
      }
    }
  }
  return {
    id: draft.id,
    title: draft.title,
    subtitle: draft.subtitle,
    hubs: draft.hubs,
    nodes: draft.nodes,
    edges,
    rings: draft.rings,
  };
}

function buildGraph(model, scopeId) {
  if (scopeId === 'group') return buildGroupGraph(model);
  if (scopeId === 'private') return buildPrivateGraph(model);
  if (scopeId === 'slang') return buildSlangGraph(model);
  throw new Error(`buildTopologyFiles: 未知 scope「${scopeId}」`);
}

/**
 * 把 graph 的节点摆到同心环上。文字说明：hub 在中心（多个 hub 左右并排），
 * 每一环按 minArc 保证最小弧距，内环放不下时自动外扩（回退到更大半径）。
 *
 * @returns {Map<string, {x: number, y: number}>}
 */
function layoutGraph(graph, options) {
  const positions = new Map();
  const hubs = graph.hubs.filter((id) => graph.nodes.some((node) => node.id === id));
  if (hubs.length === 1) {
    positions.set(hubs[0], { x: 0, y: 0 });
  } else if (hubs.length > 1) {
    const radius = options.hubOffset;
    hubs.forEach((id, index) => {
      const angle = -Math.PI / 2 + (index / hubs.length) * Math.PI * 2;
      positions.set(id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    });
  }
  let previousRadius = hubs.length > 0 ? options.hubOffset : 0;
  graph.rings.forEach((ring, ringIndex) => {
    const ids = ring.ids.filter((id) => graph.nodes.some((node) => node.id === id) && !positions.has(id));
    if (ids.length === 0) return;
    const count = ids.length;
    const radius = Math.max(
      Number(ring.radius) || 0,
      (count * options.minArc) / (Math.PI * 2),
      previousRadius + (ringIndex === 0 && hubs.length === 0 ? options.minArc : options.gap),
    );
    const phase = -Math.PI / 2 + (ringIndex % 2 === 1 ? Math.PI / count : 0);
    ids.forEach((id, index) => {
      const angle = phase + (index / count) * Math.PI * 2;
      positions.set(id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
    });
    previousRadius = radius;
  });
  // 兜底：万一有节点没排进环（不该发生），摆在外圈避免重叠。
  for (const node of graph.nodes) {
    if (positions.has(node.id)) continue;
    const index = positions.size;
    const angle = -Math.PI / 2 + (index / Math.max(1, graph.nodes.length)) * Math.PI * 2;
    positions.set(node.id, { x: Math.cos(angle) * (previousRadius + options.gap), y: Math.sin(angle) * (previousRadius + options.gap) });
  }
  return positions;
}

function memoryNodeTitle(node) {
  return truncate(node.name, 14);
}

/**
 * 把布局整体缩放到画布安全区（只用于 SVG；Canvas 坐标无限大不会裁切）。
 * 环半径是按节点数算的，节点很少时单点环会顶到标题区，这里统一收进 maxX/maxY。
 */
function fitPositions(positions, maxX, maxY) {
  let scale = 1;
  for (const position of positions.values()) {
    if (Math.abs(position.x) > 0) scale = Math.min(scale, maxX / Math.abs(position.x));
    if (Math.abs(position.y) > 0) scale = Math.min(scale, maxY / Math.abs(position.y));
  }
  if (scale >= 1) return 1;
  for (const position of positions.values()) {
    position.x *= scale;
    position.y *= scale;
  }
  return scale;
}

function renderSvg(graph) {
  const positions = layoutGraph(graph, {
    minArc: SVG_RING_MIN_ARC,
    gap: SVG_RING_GAP,
    hubOffset: SVG_HUB_OFFSET,
  });
  fitPositions(positions, 690, 392);
  const showEdgeLabels = graph.edges.length <= 30;
  const parts = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" role="img" aria-label="${escapeXml(graph.title)}">`);
  parts.push(`<!-- ${AUTO_GEN_NOTICE} -->`);
  parts.push(`<defs><pattern id="topo-grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M 40 0 L 0 0 0 40" fill="none" stroke="#e7ecf3" stroke-width="1"/></pattern></defs>`);
  parts.push(`<rect width="${SVG_WIDTH}" height="${SVG_HEIGHT}" fill="#f6f8fb"/>`);
  parts.push(`<rect width="${SVG_WIDTH}" height="${SVG_HEIGHT}" fill="url(#topo-grid)"/>`);
  parts.push(`<g transform="translate(${SVG_WIDTH / 2} ${SVG_HEIGHT / 2 + 30})">`);
  for (const edge of graph.edges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) continue;
    const memoryEdge = edge.memoryEdge ? ' stroke-dasharray="4 4"' : '';
    const width = edge.memoryEdge ? 1 : Math.min(2.4, 0.9 + (Number(edge.weight) || 1) * 0.25);
    parts.push(`<line x1="${from.x.toFixed(1)}" y1="${from.y.toFixed(1)}" x2="${to.x.toFixed(1)}" y2="${to.y.toFixed(1)}" stroke="${edge.color}" stroke-width="${width.toFixed(2)}" opacity="0.75"${memoryEdge}/>`);
    if (edge.label && showEdgeLabels && edge.label !== 'member_of' && edge.label !== 'related') {
      parts.push(`<text x="${((from.x + to.x) / 2).toFixed(1)}" y="${((from.y + to.y) / 2 - 3).toFixed(1)}" font-size="9" fill="#8a94a6" text-anchor="middle">${escapeXml(edge.label)}</text>`);
    }
  }
  for (const node of graph.nodes) {
    const position = positions.get(node.id);
    if (!position) continue;
    const isHub = graph.hubs.includes(node.id);
    const isMemory = node.kind === 'memory';
    const radius = isHub ? 14 : isMemory ? 7 : 9;
    parts.push(`<circle cx="${position.x.toFixed(1)}" cy="${position.y.toFixed(1)}" r="${radius}" fill="${node.color}" stroke="#ffffff" stroke-width="${isHub ? 3 : 1.5}"/>`);
    const label = isMemory ? memoryNodeTitle(node) : truncate(node.name, isHub ? 18 : 14);
    parts.push(`<text x="${position.x.toFixed(1)}" y="${(position.y - radius - 7).toFixed(1)}" font-size="${isHub ? 15 : 11}" font-weight="${isHub ? 600 : 500}" fill="#2b3445" text-anchor="middle">${escapeXml(label)}</text>`);
  }
  parts.push(`</g>`);
  // 标题与统计
  parts.push(`<text x="${SVG_WIDTH / 2}" y="58" font-size="30" font-weight="700" fill="#1f2937" text-anchor="middle">${escapeXml(graph.title)}</text>`);
  parts.push(`<text x="${SVG_WIDTH / 2}" y="86" font-size="13" fill="#6b7280" text-anchor="middle">${escapeXml(graph.subtitle)} · 节点 ${graph.nodes.length} · 连线 ${graph.edges.length} · Obsidian vault 自动生成</text>`);
  // 图例
  const presentTypes = new Set(graph.nodes.filter((node) => node.kind === 'entity').map((node) => node.type));
  const legend = [];
  for (const type of ['group', 'person', 'self', 'topic', 'term', 'project']) {
    if (presentTypes.has(type)) legend.push({ label: ENTITY_TYPE_LABELS[type] || type, color: ENTITY_COLORS[type] });
  }
  const layers = new Set(graph.nodes.filter((node) => node.kind === 'memory').map((node) => node.layer));
  for (const layer of ['permanent', 'long', 'short']) {
    if (layers.has(layer)) legend.push({ label: MEMORY_LAYER_LABELS[layer], color: MEMORY_COLORS[layer] });
  }
  if (graph.nodes.some((node) => node.kind === 'memory')) legend.push({ label: '记忆连线', color: '#e3d4ac' });
  let legendX = SVG_WIDTH / 2 - (legend.length * 130) / 2;
  for (const item of legend) {
    parts.push(`<circle cx="${legendX.toFixed(1)}" cy="948" r="6" fill="${item.color}"/>`);
    parts.push(`<text x="${(legendX + 12).toFixed(1)}" y="952" font-size="12" fill="#4b5563">${escapeXml(item.label)}</text>`);
    legendX += 130;
  }
  parts.push(`<text x="${SVG_WIDTH / 2}" y="984" font-size="10" fill="#9aa4b2" text-anchor="middle">金色=永久 · 蓝色=长期 · 灰色=短期 · 绿色=实体 · 双击 vault 里的 .canvas 可拖动交互</text>`);
  parts.push(`</svg>`);
  return `${parts.join('\n')}\n`;
}

function sideFromDelta(dx, dy) {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

function oppositeSide(side) {
  if (side === 'right') return 'left';
  if (side === 'left') return 'right';
  if (side === 'top') return 'bottom';
  return 'top';
}

function renderCanvas(graph) {
  const positions = layoutGraph(graph, {
    minArc: CANVAS_RING_MIN_ARC,
    gap: CANVAS_RING_GAP,
    hubOffset: CANVAS_HUB_OFFSET,
  });
  const nodes = [];
  for (const node of graph.nodes) {
    const position = positions.get(node.id);
    if (!position) continue;
    const isMemory = node.kind === 'memory';
    const width = isMemory ? CANVAS_MEMORY_WIDTH : CANVAS_NODE_WIDTH;
    const height = isMemory ? CANVAS_MEMORY_HEIGHT : CANVAS_NODE_HEIGHT;
    const typeLabel = isMemory ? MEMORY_LAYER_LABELS[node.layer] : ENTITY_TYPE_LABELS[node.type] || node.type;
    const lines = [`**${node.name}**`, '', typeLabel];
    if (isMemory && node.relPath) lines.push('', `[[${node.relPath}|打开记忆]]`);
    nodes.push({
      id: `topo-${graph.id}-${node.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`,
      type: 'text',
      text: lines.join('\n'),
      x: Math.round(position.x - width / 2),
      y: Math.round(position.y - height / 2),
      width,
      height,
      color: node.color,
    });
  }
  const nodeIdByGraphId = new Map(
    graph.nodes.map((node) => [node.id, `topo-${graph.id}-${node.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`]),
  );
  const edges = [];
  for (const edge of graph.edges) {
    const from = nodeIdByGraphId.get(edge.from);
    const to = nodeIdByGraphId.get(edge.to);
    const fromPos = positions.get(edge.from);
    const toPos = positions.get(edge.to);
    if (!from || !to || !fromPos || !toPos) continue;
    const side = sideFromDelta(toPos.x - fromPos.x, toPos.y - fromPos.y);
    const canvasEdge = {
      id: `topo-${graph.id}-edge-${edges.length + 1}`,
      fromNode: from,
      fromSide: side,
      toNode: to,
      toSide: oppositeSide(side),
    };
    if (edge.label) canvasEdge.label = edge.label;
    if (edge.memoryEdge) canvasEdge.color = '#e3d4ac';
    edges.push(canvasEdge);
  }
  const canvas = {
    nodes,
    edges: edges.length > 0 ? edges : [],
  };
  return `${JSON.stringify(canvas, null, 2)}\n`;
}

/**
 * 生成本次 brain 对应的分域拓扑文件。
 *
 * @param {object} model buildVaultModel(brain, { now }) 的返回值
 * @returns {Map<string, string>} 相对 vaultDir 的 POSIX 路径 → 文件内容
 */
export function buildTopologyFiles(model) {
  if (!model || typeof model !== 'object' || !Array.isArray(model.entities) || !Array.isArray(model.memories)) {
    throw new TypeError('buildTopologyFiles: 需要 buildVaultModel 返回的 model');
  }
  const files = new Map();
  for (const scope of TOPOLOGY_SCOPES) {
    const graph = buildGraph(model, scope.id);
    if (!graph) continue;
    files.set(`${scope.fileBase}.svg`, renderSvg(graph));
    files.set(`${scope.fileBase}.canvas`, renderCanvas(graph));
  }
  return files;
}

/**
 * 供 00-记忆大脑.md 使用：返回本 brain 下实际会生成的分域拓扑列表（含节点/连线数）。
 * @returns {{id: string, title: string, subtitle: string, svgPath: string, canvasPath: string, nodes: number, edges: number}[]}
 */
export function topologySummary(model) {
  const summary = [];
  if (!model || typeof model !== 'object' || !Array.isArray(model.entities)) return summary;
  for (const scope of TOPOLOGY_SCOPES) {
    const graph = buildGraph(model, scope.id);
    if (!graph) continue;
    summary.push({
      id: scope.id,
      title: graph.title,
      subtitle: graph.subtitle,
      svgPath: `${scope.fileBase}.svg`,
      canvasPath: `${scope.fileBase}.canvas`,
      nodes: graph.nodes.length,
      edges: graph.edges.length,
    });
  }
  return summary;
}
