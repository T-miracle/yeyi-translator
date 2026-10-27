import { publicSettings } from "../shared/settings.js";
import { translateBatch, validateSegments, TranslationError } from "./api.js";
import { CACHE_FORMAT, validCacheEntry, validateCacheFile } from "../shared/cache-file.js";
import { translationProfile } from "../shared/translation-profile.js";

export const CACHE_PREFIX = "translationCache:v1:";
const INDEX_KEY = "translationCacheIndexV1";

/**
 * 本机持久译文缓存。每条记录单独保存，避免缓存增长后每次重写整个数据库。
 * 所有读写串行；清理/停用递增代号，阻止清理前启动的请求把旧结果写回。
 * 容量仅用于提示，绝不自动淘汰条目；任何操作都只访问独立的缓存命名空间。
 */
export class TranslationCache {
  constructor(storage = chrome.storage.local) {
    this.storage = storage;
    this.queue = Promise.resolve();
    this.revision = 0;
    this.warning = "";
  }

  /** 串行执行缓存操作，单次失败不阻塞后续清理或重试。 */
  serialize(work) {
    const task = this.queue.catch(() => {}).then(work);
    this.queue = task;
    return task;
  }

  /** 使旧网络请求持有的写入代号失效。 */
  invalidate() {
    this.revision++;
  }

  /** Chrome 130+ 直接枚举键，避免大缓存清理时读取全部译文；保留 Chrome 120 的兼容路径。 */
  async storageKeys() {
    return typeof this.storage.getKeys === "function"
      ? this.storage.getKeys()
      : Object.keys(await this.storage.get(null));
  }

  /** 读取索引；异常索引只从缓存前缀恢复，不改动任何设置。 */
  async keys() {
    const stored = await this.storage.get(INDEX_KEY);
    if (
      Array.isArray(stored[INDEX_KEY]) &&
      stored[INDEX_KEY].every(
        (key) =>
          typeof key === "string" &&
          key.startsWith(CACHE_PREFIX) &&
          /^[a-f0-9]{64}$/.test(key.slice(CACHE_PREFIX.length)),
      )
    )
      return [...new Set(stored[INDEX_KEY])];
    return (await this.storageKeys()).filter((key) => key.startsWith(CACHE_PREFIX));
  }

  /** 按需读取命中的条目，磁盘故障不影响正常翻译。 */
  async getMany(keys) {
    try {
      return await this.serialize(async () => {
        const stored = await this.storage.get(keys.map((key) => CACHE_PREFIX + key));
        return new Map(
          keys
            .filter((key) => validCacheEntry({ key, parts: stored[CACHE_PREFIX + key] }))
            .map((key) => [key, stored[CACHE_PREFIX + key]]),
        );
      });
    } catch {
      this.warning = "缓存读取失败，已继续调用翻译服务；已有缓存保留。";
      return new Map();
    }
  }

  /**
   * 合并前核对实际正文，索引仅用于枚举，不能把缺失正文误判为已有缓存。
   * 只有经过原文结构校验的翻译结果可修复无效正文或分片数量；导入始终保留本机正文。
   * 在串行队列内再次读取，保留先完成的有效译文；一次提交正文和索引，失败不预先删除数据。
   */
  async putMany(entries, revision = this.revision, { repairInvalid = false } = {}) {
    return this.serialize(async () => {
      if (revision !== this.revision) return { added: 0, skipped: entries.length, stale: true };
      const keys = new Set(await this.keys());
      const valid = entries.filter(validCacheEntry);
      const stored = await this.storage.get(valid.map((entry) => CACHE_PREFIX + entry.key));
      const updates = {};
      let added = 0;
      let indexChanged = false;
      for (const entry of valid) {
        const key = CACHE_PREFIX + entry.key;
        if (Object.hasOwn(updates, key)) continue;
        if (!keys.has(key)) {
          keys.add(key);
          indexChanged = true;
        }
        const previous = stored[key];
        const usable =
          validCacheEntry({ key: entry.key, parts: previous }) &&
          previous.length === entry.parts.length;
        if (previous !== undefined && (!repairInvalid || usable)) continue;
        updates[key] = [...entry.parts];
        added++;
      }
      if (revision !== this.revision) return { added: 0, skipped: entries.length, stale: true };
      if (added || indexChanged) await this.storage.set({ ...updates, [INDEX_KEY]: [...keys] });
      this.warning = "";
      return { added, skipped: entries.length - added };
    });
  }

  /** 获取浏览器实际计量的缓存大小，不包含 Key 或设置。 */
  stats() {
    return this.serialize(async () => {
      const keys = await this.keys();
      const bytes = keys.length ? await this.storage.getBytesInUse([...keys, INDEX_KEY]) : 0;
      return { count: keys.length, bytes, warning: this.warning, revision: this.revision };
    });
  }

  /** 清理只删除缓存前缀，失败时不会先清空索引，更不会清除配置。 */
  clear() {
    this.invalidate();
    return this.serialize(async () => {
      const keys = (await this.storageKeys()).filter((key) => key.startsWith(CACHE_PREFIX));
      await this.storage.remove([...keys, INDEX_KEY]);
      this.warning = "";
      return { count: 0, bytes: 0, warning: "" };
    });
  }

  /** 导出只含内容摘要和译文，绝不包含 API Key、站点名单或服务设置。 */
  exportData() {
    return this.serialize(async () => {
      const keys = await this.keys();
      const stored = await this.storage.get(keys);
      const entries = keys
        .map((key) => ({ key: key.slice(CACHE_PREFIX.length), parts: stored[key] }))
        .filter(validCacheEntry);
      return { format: CACHE_FORMAT, version: 1, entries };
    });
  }

  /** 完整校验后合并导入；格式错误不会发生任何写入。 */
  importData(data, revision = this.revision) {
    validateCacheFile(data);
    return this.putMany(data.entries, revision).then((result) => {
      if (result.stale)
        throw new TranslationError("CACHE_CHANGED", "缓存已被清理或停用，导入已停止，请重新导入。");
      return result;
    });
  }
}

/** 以配置、原文和专用提示词版本生成摘要；仅日语使用新身份，其他旧缓存保持兼容。 */
export async function cacheKey(signature, segment) {
  const profile = translationProfile(segment);
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      signature,
      segment.parts,
      segment.context || "",
      ...(segment.dictionaryOnly ? [true] : []),
      ...(profile ? [["prompt", profile]] : []),
    ]),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/** 查询并核对分片结构，供排队前预检和请求前的并发兜底复用。 */
async function matchingCache(cache, settings, segments) {
  const signature = publicSettings(settings).signature;
  const keys = await Promise.all(segments.map((segment) => cacheKey(signature, segment)));
  const hits = await cache.getMany(keys);
  segments.forEach((segment, index) => {
    // 导入文件的摘要无法反推原文结构；复用前核对数量，避免错误文件破坏页面排版。
    if (hits.get(keys[index])?.length !== segment.parts.length) hits.delete(keys[index]);
  });
  return { keys, hits };
}

/**
 * 只读查询当前文本的缓存命中，不调用 API、不新增队列，也不暴露整库或配置。
 * 保留本轮临时 ID，内容脚本可立即渲染命中项，只让缺项进入待翻译队列。
 */
export async function lookupCachedTranslations({ cache, settings, segments }) {
  validateSegments(segments);
  if (!settings.cacheEnabled) return [];
  const { keys, hits } = await matchingCache(cache, settings, segments);
  return segments.flatMap((segment, index) =>
    hits.has(keys[index]) ? [{ id: segment.id, parts: hits.get(keys[index]) }] : [],
  );
}

/**
 * 验证请求后只把未命中的片段发往 API，再按本次 ID 还原完整响应。
 * 同批相同原文合并为一次请求；仅持久化 API 已校验成功的结果。
 * 缓存故障只提示，不把已成功的翻译误报为失败。
 */
export async function translateWithCache({
  cache,
  settings,
  segments,
  signal,
  retryFragments = false,
  translate = translateBatch,
}) {
  validateSegments(segments);
  const request = {
    provider: settings.providers[settings.provider],
    targetLanguage: settings.targetLanguage,
    nameDictionary: settings.nameDictionary || [],
    segments,
    signal,
    // 页面重试统一由内容脚本的失败队列调度；不改变缓存键、文件格式或已有条目。
    deferRetries: true,
    retryFragments,
  };
  if (!settings.cacheEnabled) return translate(request);
  const revision = cache.revision;
  const { keys, hits } = await matchingCache(cache, settings, segments);
  const missing = new Map();
  segments.forEach((segment, index) => {
    if (!hits.has(keys[index])) missing.set(keys[index], segment);
  });
  if (signal.aborted) throw new TranslationError("CANCELLED", "翻译已停止。");
  if (missing.size) {
    const translated = await translate({ ...request, segments: [...missing.values()] });
    const results = new Map(translated.map((item) => [item.id, item.parts]));
    const entries = [...missing].map(([key, segment]) => ({ key, parts: results.get(segment.id) }));
    entries.forEach(({ key, parts }) => hits.set(key, parts));
    if (!signal.aborted) {
      try {
        await cache.putMany(entries, revision, { repairInvalid: true });
      } catch {
        cache.warning = "缓存写入失败，已保留现有缓存；本次译文仍可正常阅读。请检查本机存储空间。";
      }
    }
  }
  return segments.map((segment, index) => ({ id: segment.id, parts: hits.get(keys[index]) }));
}
