import { collectGroups, compareDocumentOrder, createChunks } from "./model.js";
import { sendMessage } from "../shared/messaging.js";
import { visibleTranslationScope } from "./visibility.js";

const BATCH_MAX_SEGMENTS = 18;
const BATCH_MAX_CHARS = 4800;
const BATCH_WAIT_MS = 200;

/** 使用同一字符计量约束缓存预检与 API 批次，保留中文上下文的预算。 */
function chunkSize(chunk) {
  return chunk.parts.reduce((sum, part) => sum + part.length, 0) + (chunk.context?.length || 0);
}

/** 只发送原文片段与上下文，不将节点、排版记录或缓存结构传到后台。 */
function segmentsOf(tasks) {
  return tasks.map(({ chunk }) => ({
    id: chunk.id,
    parts: chunk.parts,
    ...(chunk.dictionaryOnly ? { dictionaryOnly: true } : {}),
    ...(chunk.context ? { context: chunk.context } : {}),
  }));
}

/**
 * 单个 frame 的整页翻译会话。原文、译文与缓存均只存在此页面的内存中。
 * @property {Map<Element,Object>} units 段落记录；通过实际 DOM 节点识别网站重渲染。
 * @property {WeakMap<Text,Object>} ownership 文本节点及其原文、最后写入值。
 * @property {Map<string,Object[]>} cache 此页面的有限译文缓存，刷新自然清空。
 */
export class TranslationEngine {
  /** @param {Function} onChange 接收可公开的进度。 */
  constructor(onChange) {
    /** @type {Function} 当前 frame 的公开进度回调。 */
    this.onChange = onChange;
    /** @type {Map<Element,Object>} 仍可能需要恢复的段落。 */
    this.units = new Map();
    /** @type {Map<Element,number>|null} 视口及上下预翻译窗口；0 为当前可视内容。 */
    this.scope = null;
    /** @type {WeakMap<Text,Object>} 节点原文与最后一次自有写入。 */
    this.ownership = new WeakMap();
    /** @type {Map<string,Object>} 当前页面的有限译文缓存。 */
    this.cache = new Map();
    /** @type {number} 缓存键及值占用的 UTF-16 字符数。 */
    this.cacheChars = 0;
    /** @type {number} 清理缓存后阻止旧请求重新写回页面缓存。 */
    this.cacheRevision = 0;
    /** @type {Object|null} 当前运行的脱敏配置快照。 */
    this.config = null;
    /** @type {'idle'|'translating'|'watching'|'paused'|'error'} 可显示的会话阶段。 */
    this.phase = "idle";
    /** @type {boolean} 是否调度请求并监测动态内容。 */
    this.active = false;
    /** @type {string} 迟到结果的隔离代号，停止后立即更新。 */
    this.runId = crypto.randomUUID();
    /** @type {number} 此页面中单调递增的段落标识序号。 */
    this.sequence = 0;
    /** @type {number} 当前运行尚未结束的批次数，上限为一，补译共用同一名额。 */
    this.workers = 0;
    /** @type {Object|null} 发送前检查的独立令牌，避免重入及旧会话回调干扰新会话。 */
    this.dispatchToken = null;
    /** @type {Set<Promise<void>>} 当前会话尚未完成的缓存预检。 */
    this.cacheLookups = new Set();
    /** @type {string} 可安全展示的最近错误。 */
    this.error = "";
    /** @type {ReturnType<typeof setTimeout>|null} 合并动态内容扫描的计时器。 */
    this.scanTimer = null;
    /** @type {ReturnType<typeof setTimeout>|null} 未满批次的固定聚合窗口，不随新增内容重置。 */
    this.batchTimer = null;
    /** @type {ReturnType<typeof setInterval>|null} 请求期间的 worker 保活计时器。 */
    this.keepAlive = null;
    /** @type {MutationObserver} 只在会话开启时订阅页面内容。 */
    this.observer = new MutationObserver((records) => {
      if (this.active && records.some((record) => !this.isOwnedMutation(record)))
        this.scheduleScan();
    });
    /** @type {Function} 捕获内部滚动容器的事件，视口模式更快扫描新露出的文字。 */
    this.onViewportChange = () => this.scheduleScan(this.config?.visibleOnly ? 60 : 400);
    /** @type {boolean} 子帧必须先确认外层页面中实际有交集。 */
    this.frameVisible = window === window.top;
    /** @type {IntersectionObserver|null} 浏览器负责跨域 iframe 的外层裁剪和滚动通知。 */
    this.frameObserver =
      window === window.top
        ? null
        : new IntersectionObserver((entries) => {
            const entry = entries[0];
            this.frameVisible =
              entry.isIntersecting &&
              entry.intersectionRect.width > 0 &&
              entry.intersectionRect.height > 0;
            if (this.active && this.config.visibleOnly) this.scheduleScan(0);
          });
  }

  /** 返回可展示的进度，永远不包括原文和密钥。@returns {Object} 本 frame 状态。 */
  getState() {
    const units = [...this.units.values()].filter((unit) => unit.element.isConnected);
    return {
      phase: this.phase,
      active: this.active,
      total: units.length,
      done: units.filter((unit) => unit.chunks.every((chunk) => chunk.state === "done")).length,
      failed: units.filter((unit) => unit.chunks.some((chunk) => chunk.state === "failed")).length,
      mode: this.config?.mode || "bilingual",
      targetLanguage: this.config?.targetLanguage || "zh-CN",
      provider: this.config?.provider || "deepseek",
      error: this.error,
    };
  }

  /** 发布当前状态。@returns {void} 无返回值。 */
  publish() {
    this.onChange(this.getState());
  }

  /** 判断变更是否由扩展自己的显示节点或译文写入产生。@param {MutationRecord} record DOM 变更。@returns {boolean} 是否可忽略。 */
  isOwnedMutation(record) {
    const element =
      record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
    if (element?.closest("[data-yeyi-owned]")) return true;
    if (record.type === "characterData") {
      const entry = this.ownership.get(record.target);
      return Boolean(entry && record.target.data === entry.lastWritten);
    }
    return (
      record.type === "childList" &&
      [...record.addedNodes, ...record.removedNodes].every(
        (node) => node.nodeType === Node.ELEMENT_NODE && node.hasAttribute("data-yeyi-owned"),
      )
    );
  }

  /** 开始观察网页真实内容的变化。@returns {void} 无返回值。 */
  observe() {
    if (this.active && document.body)
      this.observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: [
          "hidden",
          "class",
          "style",
          "aria-hidden",
          "translate",
          "contenteditable",
        ],
      });
  }

  /** 批量写入时暂时停止观察，避免把自己的译文重新送去翻译。@param {Function} mutation 同步 DOM 操作。@returns {void} 无返回值。 */
  mutate(mutation) {
    const pending = this.observer.takeRecords();
    if (pending.some((record) => !this.isOwnedMutation(record))) this.scheduleScan();
    this.observer.disconnect();
    try {
      mutation();
    } finally {
      this.observe();
    }
  }

  /** 把频繁的 DOM 更新合并到一次扫描。@returns {void} 无返回值。 */
  scheduleScan(delay = 400) {
    if (this.scanTimer || !this.active) return;
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      if (this.active) {
        this.scan();
        this.pump();
      }
    }, delay);
  }

  /** 清空页面复用缓存，保留当前显示的译文和原文恢复记录。 */
  clearCache() {
    this.cacheRevision++;
    this.dispatchToken = null;
    this.cacheLookups = new Set();
    this.cache.clear();
    this.cacheChars = 0;
    for (const unit of this.units.values())
      for (const chunk of unit.chunks)
        if (["unchecked", "checking"].includes(chunk.state)) chunk.state = "pending";
    this.pump();
  }

  /** 视口内容优先，其余按距离排序；整页模式继续使用文档顺序。 */
  compareUnits(first, second) {
    return (
      (this.scope?.get(first.element) || 0) - (this.scope?.get(second.element) || 0) ||
      compareDocumentOrder(first.element, second.element)
    );
  }

  /**
   * 独立于网络批次读取缓存：命中立即完成并渲染，缺项才变为 pending。
   * 未检查项保持 checking，不占用翻译批次；分页读取仍可在旧网络请求期间处理新增缓存命中。
   * 停止、切换配置、清理或网站替换节点后，迟到查询不能覆盖新会话与页面内容。
   */
  async lookupCache(tasks, runId, revision) {
    const current = () => this.active && this.runId === runId && this.cacheRevision === revision;
    try {
      let index = 0;
      while (index < tasks.length && current()) {
        const batch = [];
        let length = 0;
        while (index < tasks.length && batch.length < BATCH_MAX_SEGMENTS) {
          const task = tasks[index];
          const size = chunkSize(task.chunk);
          if (batch.length && length + size > BATCH_MAX_CHARS) break;
          batch.push(task);
          length += size;
          index++;
        }
        const cached = await sendMessage({
          type: "LOOKUP_CACHE",
          runId,
          signature: this.config.signature,
          segments: segmentsOf(batch),
        });
        if (!current()) return;
        const hits = new Map(cached.map((item) => [item.id, item.parts]));
        this.mutate(() => {
          for (const { unit, chunk } of batch) {
            if (this.units.get(unit.element) !== unit || chunk.state !== "checking") continue;
            const parts = hits.get(chunk.id);
            if (!parts) {
              chunk.state = "pending";
              continue;
            }
            chunk.translated = parts;
            chunk.state = "done";
            if (unit.chunks.every((item) => item.state === "done")) {
              this.remember(unit);
              this.renderUnit(unit);
            }
          }
        });
        this.publish();
      }
      if (this.config.visibleOnly) this.scheduleScan(60);
    } catch (error) {
      if (!current()) return;
      if (error.fatal) {
        this.error = error.message;
        this.stop(false);
        this.phase = "error";
        this.publish();
        return;
      }
      // 查询异常只回退到正常翻译，不覆盖或删除持久缓存。
      for (const { unit, chunk } of tasks)
        if (this.units.get(unit.element) === unit && chunk.state === "checking")
          chunk.state = "pending";
    } finally {
      if (current()) this.pump();
    }
  }

  /** 撤回段落的自有写入；网站后来修改的文字绝不会被旧原文覆盖。@param {Object} unit 段落。@returns {void} 无返回值。 */
  restoreUnit(unit) {
    unit.anchor?.remove();
    unit.anchor = null;
    for (const record of unit.nodes) {
      if (record.node.isConnected && record.node.data === record.lastWritten)
        record.node.data = record.original;
      record.lastWritten = record.original;
    }
  }

  /** 按模式渲染完整段落；译文仅通过 textContent / Text.data 写入。@param {Object} unit 段落。@returns {void} 无返回值。 */
  renderUnit(unit) {
    if (!unit.element.isConnected || !unit.chunks.every((chunk) => chunk.state === "done")) return;
    if (
      unit.nodes.some(
        (record) =>
          !record.node.isConnected ||
          (record.node.data !== record.original && record.node.data !== record.lastWritten),
      )
    ) {
      this.scheduleScan();
      return;
    }
    const fragments = unit.nodes.map((record) =>
      record.fragments.map((fragment) => (fragment.preserve ? fragment.text : "")),
    );
    for (const chunk of unit.chunks)
      chunk.translated.forEach((part, index) => {
        const { nodeIndex, fragmentIndex } = chunk.locations[index];
        fragments[nodeIndex][fragmentIndex] += part;
      });
    const translated = fragments.map((parts) => parts.join(""));
    this.restoreUnit(unit);
    if (this.config.mode === "replace") {
      unit.nodes.forEach((record, index) => {
        record.node.data = translated[index];
        record.lastWritten = translated[index];
      });
    } else if (
      translated.join("").trim() !==
      unit.nodes
        .map((record) => record.original)
        .join("")
        .trim()
    ) {
      const anchor = document.createElement("span");
      anchor.dataset.yeyiOwned = "translation";
      anchor.lang = this.config.targetLanguage;
      anchor.setAttribute("dir", "auto");
      anchor.style.cssText =
        "display:block!important;position:static!important;font-size:0.95em!important;line-height:1.65!important;margin:0.35em 0 0!important;padding:0.28em 0 0!important;border:0!important;border-top:1px dashed color-mix(in srgb,currentColor 24%,transparent)!important;opacity:0.88!important;white-space:pre-wrap!important;overflow-wrap:anywhere!important;text-align:inherit!important;font-family:inherit!important;color:inherit!important;background:transparent!important;";
      anchor.textContent = translated.join("");
      unit.element.append(anchor);
      unit.anchor = anchor;
    }
  }

  /** 缓存键包含服务、模型、目标语言及完整节点原文。@param {Object} unit 段落。@returns {string} 内存键。 */
  cacheKey(unit) {
    return `${this.config.signature}\n${JSON.stringify(unit.nodes.map((record) => record.original))}`;
  }

  /** 保存有限缓存，避免无限滚动页面持续占用内存。@param {Object} unit 完成的段落。@returns {void} 无返回值。 */
  remember(unit) {
    const key = this.cacheKey(unit);
    if (this.cache.has(key)) return;
    const value = unit.chunks.map((chunk) => [...chunk.translated]);
    const size = key.length + JSON.stringify(value).length;
    if (size > 200_000) return;
    this.cache.set(key, { value, size });
    this.cacheChars += size;
    while (this.cacheChars > 2_000_000 || this.cache.size > 1500) {
      const oldest = this.cache.keys().next().value;
      this.cacheChars -= this.cache.get(oldest).size;
      this.cache.delete(oldest);
    }
  }

  /** 重新协调可见 DOM 和记录；失效段落的迟到结果会被忽略。@returns {Promise<void>|undefined} 本次缓存预检完成，可在合批发送前等待新增缺项入队。 */
  scan() {
    if (this.config.visibleOnly && !this.frameVisible) return;
    const groups = collectGroups(document, this.ownership);
    this.scope = this.config.visibleOnly ? visibleTranslationScope(groups) : null;
    this.mutate(() => {
      for (const [element, unit] of this.units) {
        const nodes = groups.get(element);
        const unchanged =
          nodes &&
          nodes.length === unit.nodes.length &&
          nodes.every(
            (record, index) =>
              record.node === unit.nodes[index].node &&
              record.original === unit.nodes[index].original,
          );
        if (!unchanged) {
          this.restoreUnit(unit);
          this.units.delete(element);
        }
      }
      for (const [element, records] of groups) {
        if (this.units.has(element)) {
          const unit = this.units.get(element);
          if (
            unit.chunks.every((chunk) => chunk.state === "done") &&
            this.config.mode === "bilingual" &&
            unit.anchor &&
            !unit.anchor.isConnected
          )
            this.renderUnit(unit);
          continue;
        }
        const unit = {
          id: `u${++this.sequence}`,
          element,
          anchor: null,
          nodes: records.map((record) => ({ ...record, lastWritten: record.original })),
          chunks: [],
        };
        if (this.scope && !this.scope.has(element)) continue;
        unit.chunks = createChunks(unit, Boolean(this.config.nameDictionarySignature));
        unit.nodes.forEach((record) => this.ownership.set(record.node, record));
        const cached = this.cache.get(this.cacheKey(unit));
        if (cached && cached.value.length === unit.chunks.length) {
          unit.chunks.forEach((chunk, index) => {
            chunk.translated = cached.value[index];
            chunk.state = "done";
          });
          this.renderUnit(unit);
        } else if (this.config.cacheEnabled) {
          for (const chunk of unit.chunks) chunk.state = "unchecked";
        }
        if (!unit.chunks.length) this.renderUnit(unit);
        this.units.set(element, unit);
      }
    });
    const lookups = [...this.units.values()]
      .filter((unit) => !this.scope || this.scope.has(unit.element))
      .sort((first, second) => this.compareUnits(first, second))
      .flatMap((unit) =>
        unit.chunks
          .filter((chunk) => chunk.state === "unchecked")
          .map((chunk) => {
            chunk.state = "checking";
            return { unit, chunk };
          }),
      );
    const lookup = lookups.length
      ? this.lookupCache(lookups, this.runId, this.cacheRevision)
      : undefined;
    if (lookup) {
      const pending = this.cacheLookups;
      pending.add(lookup);
      void lookup.finally(() => pending.delete(lookup));
    }
    this.publish();
    return lookup;
  }

  /** 开始或继续整页翻译。@param {Object} config 后台提供的脱敏配置。@param {boolean} [retry] 是否重新排队失败片段。@returns {void} 无返回值。 */
  start(config, retry = true) {
    const changed = this.config?.signature !== config.signature;
    this.stop(false);
    if (changed) {
      this.mutate(() => {
        for (const unit of this.units.values()) this.restoreUnit(unit);
      });
      this.units.clear();
      this.ownership = new WeakMap();
    }
    this.config = { ...config };
    this.runId = crypto.randomUUID();
    this.dispatchToken = null;
    this.cacheLookups = new Set();
    this.active = true;
    if (config.visibleOnly && this.frameObserver) {
      this.frameVisible = false;
      this.frameObserver.observe(document.documentElement);
    }
    this.phase = "translating";
    this.error = "";
    this.workers = 0;
    for (const unit of this.units.values()) {
      for (const chunk of unit.chunks)
        if (
          ["inflight", "unchecked", "checking", "pending"].includes(chunk.state) ||
          (retry && chunk.state === "failed")
        )
          chunk.state = config.cacheEnabled ? "unchecked" : "pending";
    }
    this.mutate(() => {
      for (const unit of this.units.values()) this.renderUnit(unit);
    });
    this.observe();
    document.addEventListener("scroll", this.onViewportChange, { capture: true, passive: true });
    window.addEventListener("resize", this.onViewportChange, { passive: true });
    // Chrome MV3 的空闲计时由扩展消息重置；只在有网络请求时维持会话。
    this.keepAlive = setInterval(() => {
      if (this.workers) sendMessage({ type: "PING" }).catch(() => {});
    }, 20_000);
    this.scan();
    this.pump();
  }

  /** 停止请求和新内容监测，保留已完成的译文。@param {boolean} [notify] 是否发布暂停状态。@returns {void} 无返回值。 */
  stop(notify = true) {
    const oldRun = this.runId;
    this.active = false;
    this.runId = crypto.randomUUID();
    this.dispatchToken = null;
    this.cacheLookups = new Set();
    this.observer.disconnect();
    this.frameObserver?.disconnect();
    document.removeEventListener("scroll", this.onViewportChange, true);
    window.removeEventListener("resize", this.onViewportChange);
    clearTimeout(this.scanTimer);
    this.scanTimer = null;
    clearTimeout(this.batchTimer);
    this.batchTimer = null;
    clearInterval(this.keepAlive);
    this.keepAlive = null;
    for (const unit of this.units.values())
      for (const chunk of unit.chunks)
        if (["inflight", "unchecked", "checking"].includes(chunk.state)) chunk.state = "pending";
    sendMessage({ type: "CANCEL_RUN", runId: oldRun }).catch(() => {});
    if (notify) {
      this.phase = "paused";
      this.publish();
    }
  }

  /** 恢复原文并停止监测；保留仅当前页有效的缓存供再次使用。@returns {void} 无返回值。 */
  restore() {
    this.stop(false);
    this.mutate(() => {
      for (const unit of this.units.values()) this.restoreUnit(unit);
    });
    this.units.clear();
    this.scope = null;
    this.ownership = new WeakMap();
    this.phase = "idle";
    this.error = "";
    this.publish();
  }

  /** 即时切换排版，使用同一批译文。@param {'bilingual'|'replace'} mode 新模式。@returns {void} 无返回值。 */
  setMode(mode) {
    if (!this.config) return;
    this.config.mode = mode === "replace" ? "replace" : "bilingual";
    this.mutate(() => {
      for (const unit of this.units.values()) this.renderUnit(unit);
    });
    if (this.config.visibleOnly) this.scheduleScan(60);
    this.publish();
  }

  /**
   * 每批发送前协调页面、最新视口和全部缓存预检；等待期间的 DOM 变化也必须重新扫描。
   * @param {boolean} flush 是否允许发送未满批次。
   * @returns {Promise<void>} 检查和派发完成，不等待翻译响应。
   */
  async dispatchBatch(flush) {
    const token = {};
    const runId = this.runId;
    this.dispatchToken = token;
    try {
      while (this.active && this.runId === runId && this.dispatchToken === token) {
        clearTimeout(this.scanTimer);
        this.scanTimer = null;
        this.scan();
        if (this.cacheLookups.size) {
          await Promise.all([...this.cacheLookups]);
          continue;
        }
        const { tasks, full } = this.nextBatch();
        if (!tasks.length || (!full && !flush)) return;
        for (const { chunk } of tasks) chunk.state = "inflight";
        this.workers++;
        this.phase = "translating";
        void this.runBatch(tasks, runId);
        return;
      }
    } finally {
      if (this.dispatchToken === token) {
        this.dispatchToken = null;
        this.pump();
      }
    }
  }

  /**
   * 按阅读顺序或视口优先级预选未缓存片段，不提前占用任务。
   * 达到片段或字符预算即视为满批；不足时继续等待其他扫描结果，发送时才标记 inflight。
   * @returns {{tasks:Object[],full:boolean}} 当前批次与是否应立即发送。
   */
  nextBatch() {
    if (this.config.visibleOnly && !this.frameVisible) return { tasks: [], full: false };
    const candidates = [...this.units.values()]
      .filter(
        (unit) =>
          unit.element.isConnected && unit.chunks.some((chunk) => chunk.state === "pending"),
      )
      .filter((unit) => !this.scope || this.scope.has(unit.element))
      .sort((first, second) => this.compareUnits(first, second));
    const tasks = [];
    let length = 0;
    for (const unit of candidates) {
      for (const chunk of unit.chunks) {
        if (chunk.state !== "pending") continue;
        const size = chunkSize(chunk);
        if (tasks.length && length + size > BATCH_MAX_CHARS) return { tasks, full: true };
        tasks.push({ unit, chunk });
        length += size;
        if (tasks.length >= BATCH_MAX_SEGMENTS || length >= BATCH_MAX_CHARS)
          return { tasks, full: true };
      }
    }
    return { tasks, full: false };
  }

  /**
   * 满批立即发送；不足一批时只启动一次 200 毫秒窗口，避免逐条更新产生零散请求或持续延后。
   * 满批和窗口到期统一经过发送前检查；命中照常即时显示。
   * 同一会话始终只有一个网络批次，拆批补译也共享此名额。
   * @param {boolean} [flush] 是否已等完聚合窗口，允许发送尾批。
   * @returns {void} 无返回值。
   */
  pump(flush = false) {
    if (!this.active) return;
    if (!this.workers && !this.dispatchToken) {
      const { tasks, full } = this.nextBatch();
      if (!tasks.length || full || flush) {
        clearTimeout(this.batchTimer);
        this.batchTimer = null;
        if (tasks.length) {
          void this.dispatchBatch(flush);
        }
      } else if (!this.batchTimer) {
        const runId = this.runId;
        const timer = setTimeout(() => {
          if (!this.active || this.runId !== runId || this.batchTimer !== timer) return;
          this.batchTimer = null;
          void this.dispatchBatch(true);
        }, BATCH_WAIT_MS);
        this.batchTimer = timer;
      }
    }
    if (!this.workers)
      this.phase =
        this.batchTimer ||
        this.dispatchToken ||
        [...this.units.values()].some((unit) =>
          unit.chunks.some((chunk) => chunk.state === "checking"),
        )
          ? "translating"
          : "watching";
    this.publish();
  }

  /** 请求批次；输出不完整时二分缩小失败范围，单片段失败仍保留原文供手动重试。@param {Object[]} tasks 片段任务。@param {string} runId 运行代号。@param {boolean} [subBatch] 是否共用父批次的并发名额。@returns {Promise<void>} 批次及其补译结束。 */
  async runBatch(tasks, runId, subBatch = false) {
    if (!this.active || runId !== this.runId) return;
    if (subBatch) {
      this.scan();
      tasks = tasks.filter(({ unit, chunk }) => {
        if (this.units.get(unit.element) !== unit) return false;
        if (this.scope && !this.scope.has(unit.element)) {
          chunk.state = "pending";
          return false;
        }
        return true;
      });
      if (!tasks.length) return;
    }
    const cacheRevision = this.cacheRevision;
    try {
      const translated = await sendMessage({
        type: "TRANSLATE_BATCH",
        runId,
        signature: this.config.signature,
        segments: segmentsOf(tasks),
      });
      if (!this.active || runId !== this.runId) return;
      const results = new Map(translated.map((item) => [item.id, item.parts]));
      this.mutate(() => {
        for (const { unit, chunk } of tasks) {
          if (this.units.get(unit.element) !== unit) continue;
          chunk.translated = results.get(chunk.id);
          chunk.state = "done";
          if (unit.chunks.every((item) => item.state === "done")) {
            if (cacheRevision === this.cacheRevision) this.remember(unit);
            this.renderUnit(unit);
          }
        }
      });
      if (this.config.visibleOnly) this.scheduleScan(60);
    } catch (error) {
      if (!this.active || runId !== this.runId) return;
      // 格式错误只说明当前响应不可用；缩小批次后，其他段落仍可能正常返回。
      // 每次任务数减半，最小到单片段即停止，避免坏响应触发无限重试。
      if (
        ["OUTPUT_INVALID", "OUTPUT_INCOMPLETE", "OUTPUT_UNTRANSLATED"].includes(error.code) &&
        tasks.length > 1
      ) {
        const middle = Math.ceil(tasks.length / 2);
        await this.runBatch(tasks.slice(0, middle), runId, true);
        await this.runBatch(tasks.slice(middle), runId, true);
        return;
      }
      for (const { unit, chunk } of tasks)
        if (this.units.get(unit.element) === unit) chunk.state = "failed";
      this.error = error.message;
      if (error.fatal) {
        this.stop(false);
        this.phase = "error";
        this.publish();
      }
    } finally {
      // 停止后开始的新会话有独立计数，旧请求不能递减新会话的并发量。
      if (!subBatch && runId === this.runId) {
        this.workers--;
        this.pump();
      }
    }
  }
}
