// 记忆系统 —— 持久化层（§5 契约）。
//
// 职责：
// - 路径：<repo>/state/memory/brain.json（仓库根由调用方传入，绝不硬编码）；
// - 原子写：brain.json.<pid>.tmp → fsync → rename 覆盖；
// - 备份轮转：每次写前复制旧库到 state/memory/backups/brain-<ISO ts>.json，只留 backupKeep 份；
// - 跨进程锁：state/memory/brain.lock（wx 排他创建），抢不到重试 25×100ms，
//   持锁方超过 10s 视为陈旧并强制接管（先 rename 到 .stale-<ts> 再删）；
// - 损坏恢复：JSON 解析失败 → 坏文件改名 brain.corrupt-<ts>.json → 依次尝试最新备份 → 都没有则新建空库；
// - 事件日志：state/memory/events.jsonl 追加 {at,type,id,detail}，超过 eventLogKeepBytes 轮转为 .1。
//
// 两个 DSH 实例会同时各起一个 memory MCP server，所以“每次操作重新读盘 + 写前加锁”是必须的。
import fs from 'node:fs';
import path from 'node:path';
import { MemoryError, emptyBrain, normalizeBrainShape, normalizeConfig, normalizeText } from './model.mjs';

/** 同步睡眠：持锁重试路径是同步的（store 的 API 全部同步，MCP handler 里调用简单）。 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* 极端环境（无 SharedArrayBuffer）退化为忙等 */
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin */ }
  }
}

function timestampForFile(now) {
  return new Date(Number(now)).toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

/**
 * 记忆库存储。
 *
 * @example
 *   const store = new MemoryStore({ repoRoot: 'C:\\...\\qq-bridge-full' });
 *   store.withLock(() => { const brain = store.load(); ...; store.save(brain); });
 */
export class MemoryStore {
  /**
   * @param {object} options
   * @param {string} options.repoRoot 仓库根（必填；MCP 用 process.argv[1] 推导，测试用 os.tmpdir()）
   * @param {(() => number)|number} [options.now] 时间源（测试可注入）
   * @param {string} [options.stateDir] 覆盖 state 目录（默认 <repoRoot>/state）
   * @param {number} [options.lockRetries] 覆盖锁重试次数（默认 25）
   * @param {number} [options.lockRetryDelayMs] 覆盖锁重试间隔（默认 100ms）
   * @param {number} [options.staleLockMs] 覆盖陈旧锁阈值（默认 10000ms）
   * @param {number} [options.journalMaxBytes] 增量 journal 触发 compact 的字节阈值（默认 1MB）
   */
  constructor({
    repoRoot,
    now = Date.now,
    stateDir,
    lockRetries = 25,
    lockRetryDelayMs = 100,
    staleLockMs = 10_000,
    journalMaxBytes = 1_048_576,
  } = {}) {
    if (!repoRoot || typeof repoRoot !== 'string') {
      throw new MemoryError('MemoryStore 需要 repoRoot（仓库根目录）', 'BAD_STORE_OPTIONS');
    }
    this.repoRoot = path.resolve(repoRoot);
    this.stateDir = path.resolve(stateDir ?? path.join(this.repoRoot, 'state'));
    this.memoryDir = path.join(this.stateDir, 'memory');
    this.brainPath = path.join(this.memoryDir, 'brain.json');
    this.configPath = path.join(this.memoryDir, 'config.json');
    this.lockPath = path.join(this.memoryDir, 'brain.lock');
    this.backupsDir = path.join(this.memoryDir, 'backups');
    this.eventsPath = path.join(this.memoryDir, 'events.jsonl');
    // v1.6：增量持久化——append-only journal + 定期 compact（全量快照后截断）。
    this.journalPath = path.join(this.memoryDir, 'journal.jsonl');
    this.journalMaxBytes = Math.max(64 * 1024, Number(journalMaxBytes) || 1_048_576);
    this._now = typeof now === 'function' ? now : () => Number(now) || Date.now();
    this.lockRetries = Math.max(1, Number(lockRetries) || 25);
    this.lockRetryDelayMs = Math.max(1, Number(lockRetryDelayMs) || 100);
    this.staleLockMs = Math.max(1000, Number(staleLockMs) || 10_000);
    this.staleBreaks = 0;
    this.lastRecovery = null;
    this.lastLoadWarning = null;
  }

  now() {
    return Number(this._now());
  }

  paths() {
    return {
      repoRoot: this.repoRoot,
      stateDir: this.stateDir,
      memoryDir: this.memoryDir,
      brainPath: this.brainPath,
      configPath: this.configPath,
      lockPath: this.lockPath,
      backupsDir: this.backupsDir,
      eventsPath: this.eventsPath,
      journalPath: this.journalPath,
    };
  }

  ensureDirs() {
    fs.mkdirSync(this.backupsDir, { recursive: true });
  }

  /** 读 state/memory/config.json（不存在/损坏 → {}）。 */
  readConfigFile() {
    try {
      if (!fs.existsSync(this.configPath)) return {};
      const parsed = readJsonFile(this.configPath);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return normalizeConfig(parsed);
    } catch (error) {
      this.lastLoadWarning = `config.json 解析失败，已使用默认配置：${error?.message ?? error}`;
      console.error(`[memory/store] ${this.lastLoadWarning}`);
      return {};
    }
  }

  /** 合并配置：config.json 覆盖 brain.config（§3/§4）。 */
  resolveConfig(brainConfig) {
    const fileConfig = this.readConfigFile();
    return normalizeConfig({ ...(brainConfig && typeof brainConfig === 'object' ? brainConfig : {}), ...fileConfig });
  }

  /**
   * 读库（不写盘）。文件不存在 → 返回空库（首次写入时落盘）。
   * 解析失败 → 损坏恢复；任何情况下都不向 MCP 层抛异常。
   */
  load() {
    this.ensureDirs();
    if (!fs.existsSync(this.brainPath)) {
      const config = this.resolveConfig();
      const brain = emptyBrain(this.now(), config);
      // 极端情况：只有 journal 没有全量快照（compact 前崩溃）→ 从空库回放 journal。
      this._applyJournal(brain);
      return normalizeBrainShape(brain, { now: this.now() });
    }
    try {
      const parsed = readJsonFile(this.brainPath);
      // v1.6：先回放增量 journal，再归一化（journal 里是写后快照片段，可重复回放）。
      this._applyJournal(parsed);
      const brain = normalizeBrainShape(parsed, { now: this.now() });
      brain.config = this.resolveConfig(brain.config);
      return brain;
    } catch (error) {
      return this._recoverCorrupt(error);
    }
  }

  /**
   * 损坏恢复：坏文件改名 → 从新到旧尝试备份 → 全失败则新建空库。
   * 全过程只 console.error（stdout 必须留给 MCP 协议）。
   */
  _recoverCorrupt(cause) {
    const now = this.now();
    let corruptPath = null;
    try {
      corruptPath = `${this.brainPath.replace(/\.json$/, '')}.corrupt-${timestampForFile(now)}-${process.pid}.json`;
      fs.renameSync(this.brainPath, corruptPath);
    } catch (error) {
      corruptPath = null;
      console.error(`[memory/store] 损坏文件改名失败：${error?.message ?? error}`);
    }
    console.error(
      `[memory/store] brain.json 损坏（${cause?.message ?? cause}），已改名 ${corruptPath ?? '（失败）'}，开始尝试备份恢复`
    );

    for (const backupPath of this._listBackups()) {
      try {
        const parsed = readJsonFile(backupPath);
        const brain = normalizeBrainShape(parsed, { now });
        brain.config = this.resolveConfig(brain.config);
        this.lastRecovery = { at: now, corruptPath, restoredFrom: backupPath, ok: true };
        this._writeAtomic(brain, { skipBackup: true });
        this._truncateJournal();
        this.appendEvent(
          { type: 'recover', id: 'brain', detail: { corruptPath, restoredFrom: path.basename(backupPath) } },
          { at: now }
        );
        console.error(`[memory/store] 已从备份恢复：${backupPath}`);
        return brain;
      } catch (error) {
        console.error(`[memory/store] 备份不可用 ${backupPath}：${error?.message ?? error}`);
      }
    }

    const config = this.resolveConfig();
    const brain = emptyBrain(now, config);
    this.lastRecovery = { at: now, corruptPath, restoredFrom: null, ok: true };
    try {
      this._writeAtomic(brain, { skipBackup: true });
      this._truncateJournal();
      this.appendEvent({ type: 'recover', id: 'brain', detail: { corruptPath, restoredFrom: null } }, { at: now });
    } catch (error) {
      console.error(`[memory/store] 新建空库落盘失败：${error?.message ?? error}`);
    }
    console.error('[memory/store] 没有可用备份，已新建空记忆库');
    return brain;
  }

  /**
   * 备份文件列表：新 → 旧。
   * 按 mtime 排（同一毫秒多次备份时会加 -1/-2 序号，纯文件名字典序不可靠），
   * 同一 mtime 再按文件名兜底。
   */
  _listBackups() {
    try {
      const names = fs.readdirSync(this.backupsDir).filter((name) => /^brain-.*\.json$/.test(name));
      return names
        .map((name) => {
          const fullPath = path.join(this.backupsDir, name);
          let mtime = 0;
          try {
            mtime = fs.statSync(fullPath).mtimeMs;
          } catch {
            mtime = 0;
          }
          return { name, fullPath, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name))
        .map((item) => item.fullPath);
    } catch {
      return [];
    }
  }

  _pruneBackups(keep) {
    const keepCount = Math.max(1, Number(keep) || 5);
    const backups = this._listBackups(); // 新 → 旧
    for (const backupPath of backups.slice(keepCount)) {
      try {
        fs.unlinkSync(backupPath);
      } catch {
        /* 轮转失败不影响主流程 */
      }
    }
  }

  _backupExisting(keep) {
    if (!fs.existsSync(this.brainPath)) return;
    try {
      const size = fs.statSync(this.brainPath).size;
      if (size <= 0) return;
      fs.mkdirSync(this.backupsDir, { recursive: true });
      const target = path.join(this.backupsDir, `brain-${timestampForFile(this.now())}.json`);
      // 同一毫秒多次写：加序号避免覆盖
      let candidate = target;
      let n = 1;
      while (fs.existsSync(candidate)) {
        candidate = target.replace(/\.json$/, `-${n}.json`);
        n += 1;
      }
      fs.copyFileSync(this.brainPath, candidate);
      this._pruneBackups(keep);
    } catch (error) {
      console.error(`[memory/store] 备份失败（继续写入）：${error?.message ?? error}`);
    }
  }

  /** 原子写：tmp → fsync → rename。 */
  _writeAtomic(brain, { skipBackup = false } = {}) {
    this.ensureDirs();
    const json = `${JSON.stringify(brain, null, 2)}\n`;
    const tmpPath = `${this.brainPath}.${process.pid}.tmp`;
    try {
      const fd = fs.openSync(tmpPath, 'w');
      try {
        fs.writeFileSync(fd, json, 'utf8');
        try {
          fs.fsyncSync(fd);
        } catch {
          /* 某些文件系统不支持 fsync，忽略 */
        }
      } finally {
        fs.closeSync(fd);
      }
      // Windows 上 rename 覆盖偶发 EPERM（杀毒/索引占用），重试几次
      for (let attempt = 0; ; attempt += 1) {
        try {
          fs.renameSync(tmpPath, this.brainPath);
          break;
        } catch (error) {
          if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error;
          sleepSync(50);
        }
      }
    } finally {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * 落盘（调用方必须已在 withLock 内，或明确接受竞态）。
   * - 默认：全量原子写 + 备份轮转 + 截断 journal（compact）。
   * - v1.6 增量：传 { events } 时只把本次变更追加到 journal.jsonl（append-only），
   *   超过 journalMaxBytes 才做一次全量 compact；写盘成本从 O(全库) 降到 O(变更)。
   */
  save(brain, { events = null } = {}) {
    if (!brain || typeof brain !== 'object') throw new MemoryError('save 需要 brain 快照', 'BAD_STORE_OPTIONS');
    this.ensureDirs();
    brain.version = Number(brain.version) || 1;
    brain.config = normalizeConfig(brain.config);
    brain.updatedAt = this.now();
    if (Array.isArray(events) && events.length && this._journalEnabled() && fs.existsSync(this.brainPath)) {
      this._appendJournal(this._buildJournalPatch(brain, events));
      if (this._journalBytes() > this.journalMaxBytes) this._compactJournal(brain);
      return brain;
    }
    this._backupExisting(brain.config.backupKeep);
    this._writeAtomic(brain);
    this._truncateJournal();
    return brain;
  }

  _journalEnabled() {
    return this.journalEnabled !== false;
  }

  /**
   * 主动 compact：把当前「全量快照 + journal」合并后写回 brain.json 并清空 journal。
   * 供运维/测试在并发写结束后显式落盘（日常由 save 的阈值自动触发）。
   */
  compactNow() {
    return this.withLock(() => {
      const journalBytes = this._journalBytes();
      const brain = this.load();
      this._backupExisting(brain.config.backupKeep);
      this._writeAtomic(brain);
      this._truncateJournal();
      return { brain, compacted: journalBytes > 0, journalBytes };
    });
  }

  _journalBytes() {
    try {
      return fs.existsSync(this.journalPath) ? fs.statSync(this.journalPath).size : 0;
    } catch {
      return 0;
    }
  }

  /** 从事件列表提取本次变更对象，生成 journal 记录（state/self/config 每次全带，体积很小）。 */
  _buildJournalPatch(brain, events) {
    const memoryIds = new Set();
    const entityIds = new Set();
    const relationIds = new Set();
    const synapseIds = new Set();
    const removedMemories = [];
    for (const event of events) {
      if (!event || !event.id) continue;
      switch (event.type) {
        case 'entity':
          entityIds.add(event.id);
          break;
        case 'link':
          relationIds.add(event.id);
          break;
        case 'synapse':
          synapseIds.add(event.id);
          break;
        case 'purge':
          removedMemories.push(event.id);
          break;
        default:
          if (brain.memories[event.id]) memoryIds.add(event.id);
          break;
      }
    }
    const patch = {
      at: this.now(),
      memories: {},
      entities: {},
      relations: [],
      synapses: [],
      removedMemories,
      state: brain.state ?? null,
      self: brain.self ?? null,
      emotions: Array.isArray(brain.emotions) ? brain.emotions : [],
      config: brain.config,
    };
    for (const id of memoryIds) patch.memories[id] = brain.memories[id];
    for (const id of entityIds) if (brain.entities[id]) patch.entities[id] = brain.entities[id];
    if (relationIds.size) {
      const wanted = new Set(relationIds);
      patch.relations = (Array.isArray(brain.relations) ? brain.relations : []).filter((rel) => rel && wanted.has(rel.id));
    }
    if (synapseIds.size) {
      const wanted = new Set(synapseIds);
      patch.synapses = (Array.isArray(brain.synapses) ? brain.synapses : []).filter((syn) => syn && wanted.has(syn.id));
    }
    return patch;
  }

  _appendJournal(patch) {
    try {
      fs.appendFileSync(this.journalPath, `${JSON.stringify(patch)}\n`, 'utf8');
    } catch (error) {
      console.error(`[memory/store] journal 追加失败（回退全量写）：${error?.message ?? error}`);
      this._truncateJournal();
      throw error;
    }
  }

  _truncateJournal() {
    try {
      if (fs.existsSync(this.journalPath)) fs.unlinkSync(this.journalPath);
    } catch {
      /* 截断失败不影响主流程 */
    }
  }

  _compactJournal(brain) {
    this._backupExisting(brain.config.backupKeep);
    this._writeAtomic(brain);
    this._truncateJournal();
  }

  /** 回放 journal.jsonl 到 brain 对象（upsert 全量对象、删 purge 项；坏行跳过）。 */
  _applyJournal(brain) {
    if (!fs.existsSync(this.journalPath)) return;
    let text = '';
    try {
      text = fs.readFileSync(this.journalPath, 'utf8');
    } catch {
      return;
    }
    const lines = text.split('\n').filter(Boolean);
    for (const line of lines) {
      let patch = null;
      try {
        patch = JSON.parse(line);
      } catch {
        continue;
      }
      if (!patch || typeof patch !== 'object') continue;
      if (patch.memories && typeof patch.memories === 'object') {
        for (const [id, memory] of Object.entries(patch.memories)) brain.memories[id] = memory;
      }
      if (patch.entities && typeof patch.entities === 'object') {
        for (const [id, entity] of Object.entries(patch.entities)) brain.entities[id] = entity;
      }
      if (Array.isArray(patch.relations)) {
        for (const rel of patch.relations) {
          const index = brain.relations.findIndex((item) => item && rel && item.id === rel.id);
          if (index >= 0) brain.relations[index] = rel;
          else brain.relations.push(rel);
        }
      }
      if (Array.isArray(patch.synapses)) {
        brain.synapses = Array.isArray(brain.synapses) ? brain.synapses : [];
        for (const syn of patch.synapses) {
          const index = brain.synapses.findIndex((item) => item && syn && item.id === syn.id);
          if (index >= 0) brain.synapses[index] = syn;
          else brain.synapses.push(syn);
        }
      }
      if (Array.isArray(patch.removedMemories)) {
        for (const id of patch.removedMemories) delete brain.memories[id];
      }
      if (patch.state) brain.state = patch.state;
      if (patch.self) brain.self = patch.self;
      if (Array.isArray(patch.emotions)) brain.emotions = patch.emotions;
      if (patch.config) brain.config = { ...(brain.config || {}), ...patch.config };
    }
  }

  // -------------------------------------------------------------------------
  // 跨进程锁
  // -------------------------------------------------------------------------

  /**
   * 抢锁并执行 fn（同步）。失败抛 MemoryError('LOCK_TIMEOUT')。
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  withLock(fn) {
    const release = this.acquireLock();
    try {
      return fn();
    } finally {
      release();
    }
  }

  /** @returns {() => void} 释放函数 */
  acquireLock() {
    this.ensureDirs();
    const token = `${process.pid}:${this.now()}:${Math.random().toString(36).slice(2, 10)}`;
    for (let attempt = 0; attempt <= this.lockRetries; attempt += 1) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx');
        try {
          fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: this.now(), token }), 'utf8');
        } finally {
          fs.closeSync(fd);
        }
        let released = false;
        return () => {
          if (released) return;
          released = true;
          try {
            const current = readJsonFile(this.lockPath);
            if (current?.token !== token) return; // 已被接管，别删别人的锁
          } catch {
            return;
          }
          try {
            fs.unlinkSync(this.lockPath);
          } catch {
            /* 已被删除 */
          }
        };
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          throw new MemoryError(`创建记忆库锁失败：${error?.message ?? error}`, 'LOCK_ERROR');
        }
        const broke = this._breakStaleLock();
        if (attempt >= this.lockRetries) {
          throw new MemoryError(
            `记忆库被其他进程占用（${this.lockPath}），等待 ${this.lockRetries}×${this.lockRetryDelayMs}ms 超时`,
            'LOCK_TIMEOUT'
          );
        }
        sleepSync(broke ? 10 : this.lockRetryDelayMs);
      }
    }
    // 逻辑上不可达
    throw new MemoryError('记忆库加锁失败', 'LOCK_TIMEOUT');
  }

  /** 陈旧锁接管：mtime 超过 staleLockMs → rename 到 .stale-<ts> 再删除。 */
  _breakStaleLock() {
    try {
      const stat = fs.statSync(this.lockPath);
      const staleMs = this.staleLockMs;
      if (this.now() - stat.mtimeMs <= staleMs) return false;
      const stalePath = `${this.lockPath}.stale-${this.now()}`;
      try {
        fs.renameSync(this.lockPath, stalePath);
      } catch {
        return false;
      }
      try {
        fs.unlinkSync(stalePath);
      } catch {
        /* ignore */
      }
      this.staleBreaks += 1;
      console.error(`[memory/store] 接管陈旧锁（mtime ${new Date(stat.mtimeMs).toISOString()}）`);
      return true;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // 事件日志
  // -------------------------------------------------------------------------

  /**
   * 追加事件 {at,type,id,detail}。超过 keepBytes 时轮转为 events.jsonl.1（只保留 1 份）。
   * @param {{type: string, id?: string|null, detail?: any}} event
   */
  appendEvent(event, { at, keepBytes } = {}) {
    if (!event?.type) return;
    this.ensureDirs();
    const line = `${JSON.stringify({
      at: Number(at ?? event.at ?? this.now()),
      type: String(event.type),
      id: event.id ?? null,
      detail: event.detail ?? null,
    })}\n`;
    const limit = Math.max(1024, Number(keepBytes ?? this.readConfigFile().eventLogKeepBytes) || 5_242_880);
    try {
      if (fs.existsSync(this.eventsPath)) {
        const size = fs.statSync(this.eventsPath).size;
        if (size + Buffer.byteLength(line, 'utf8') > limit) {
          const rotated = `${this.eventsPath}.1`;
          try {
            if (fs.existsSync(rotated)) fs.unlinkSync(rotated);
          } catch {
            /* ignore */
          }
          try {
            fs.renameSync(this.eventsPath, rotated);
          } catch {
            /* 轮转失败不阻塞追加 */
          }
        }
      }
      fs.appendFileSync(this.eventsPath, line, 'utf8');
    } catch (error) {
      console.error(`[memory/store] 事件日志写入失败：${error?.message ?? error}`);
    }
  }

  /** 读事件日志（调试/CLI 用），返回最近 limit 条。 */
  readEvents({ limit = 100 } = {}) {
    try {
      if (!fs.existsSync(this.eventsPath)) return [];
      const lines = fs.readFileSync(this.eventsPath, 'utf8').split('\n').filter(Boolean);
      return lines
        .slice(-Math.max(1, Number(limit) || 100))
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /** 健康检查（MCP stats / CLI 用）：不创建任何文件。 */
  inspect() {
    return {
      ...this.paths(),
      exists: fs.existsSync(this.brainPath),
      brainBytes: fs.existsSync(this.brainPath) ? fs.statSync(this.brainPath).size : 0,
      backupCount: this._listBackups().length,
      lockPresent: fs.existsSync(this.lockPath),
      eventsBytes: fs.existsSync(this.eventsPath) ? fs.statSync(this.eventsPath).size : 0,
      journalBytes: this._journalBytes(),
    };
  }

  /** 供 CLI/调试：把相对 state/ 的 vaultDir 解析为绝对路径。 */
  resolveVaultDir(vaultDir = 'memory-vault') {
    const configured = normalizeText(vaultDir) || 'memory-vault';
    return path.resolve(this.stateDir, configured);
  }
}

export function createStore(options) {
  return new MemoryStore(options);
}
