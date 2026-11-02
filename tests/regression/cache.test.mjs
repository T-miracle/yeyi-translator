import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TranslationCache,
  translateWithCache,
  lookupCachedTranslations,
  cacheKey,
  CACHE_PREFIX,
} from "../../src/background/cache.js";
import { normalizeSettings, publicSettings } from "../../src/shared/settings.js";
import { validateCacheFile, cacheFileBatches } from "../../src/shared/cache-file.js";

/** 独立的存储边界替身，保留设置哨兵并支持注入写入失败。 */
class LocalStorage {
  constructor() {
    this.data = { settings: { secret: "keep-my-key" }, unrelated: "keep-me" };
    this.failWrite = false;
  }
  async get(keys) {
    if (keys === null) return structuredClone(this.data);
    return Object.fromEntries(
      (Array.isArray(keys) ? keys : [keys])
        .filter((key) => key in this.data)
        .map((key) => [key, structuredClone(this.data[key])]),
    );
  }
  async set(values) {
    if (this.failWrite) throw new Error("disk full");
    Object.assign(this.data, structuredClone(values));
  }
  async remove(keys) {
    for (const key of keys) delete this.data[key];
  }
  async getBytesInUse(keys) {
    return keys.reduce(
      (sum, key) =>
        sum + (key in this.data ? Buffer.byteLength(key + JSON.stringify(this.data[key])) : 0),
      0,
    );
  }
}
const settings = normalizeSettings({ cacheEnabled: true });
const signal = new AbortController().signal;
const segment = (id, text = "Read this paragraph.", context) => ({
  id,
  parts: [text],
  ...(context ? { context } : {}),
});

test("排队前查询只返回当前配置下结构匹配的命中，不写入缓存或请求网络", async () => {
  const storage = new LocalStorage();
  const cache = new TranslationCache(storage);
  const key = await cacheKey(publicSettings(settings).signature, segment("old"));
  await cache.putMany([{ key, parts: ["已缓存的译文"] }]);
  const before = structuredClone(storage.data);
  assert.deepEqual(
    await lookupCachedTranslations({
      cache,
      settings,
      segments: [segment("now"), segment("missing", "New source.")],
    }),
    [{ id: "now", parts: ["已缓存的译文"] }],
  );
  assert.deepEqual(
    await lookupCachedTranslations({
      cache,
      settings: { ...settings, cacheEnabled: false },
      segments: [segment("now")],
    }),
    [],
  );
  assert.deepEqual(
    await lookupCachedTranslations({
      cache,
      settings: { ...settings, targetLanguage: "ja" },
      segments: [segment("now")],
    }),
    [],
  );
  assert.deepEqual(storage.data, before);
});

test("旧设置迁移默认关闭可视区域和持久缓存，保留 Key、网站及模型", () => {
  const previous = {
    providers: { deepseek: { apiKey: "saved-key", model: "custom-model" } },
    autoTranslateSites: ["example.com"],
  };
  const next = normalizeSettings(previous);
  assert.equal(next.visibleOnly, false);
  assert.equal(next.cacheEnabled, false);
  assert.equal(next.cacheLimitMb, 512);
  assert.equal(next.providers.deepseek.apiKey, "saved-key");
  assert.equal(next.providers.deepseek.model, "custom-model");
  assert.deepEqual(next.autoTranslateSites, ["example.com"]);
  assert(!JSON.stringify(publicSettings(next)).includes("saved-key"));
  for (const cacheLimitMb of [0, -1, "invalid", Infinity, 10241])
    assert.throws(() => normalizeSettings({ cacheLimitMb }));
});

test("缓存跨实例复用，仅请求缺项，同批重复去重并使用本次片段 ID", async () => {
  const storage = new LocalStorage();
  let requests = [];
  const translate = async ({ segments }) => {
    requests.push(segments);
    return segments.map(({ id, parts }) => ({ id, parts: parts.map((part) => `译文：${part}`) }));
  };
  const first = await translateWithCache({
    cache: new TranslationCache(storage),
    settings,
    segments: [segment("old"), segment("duplicate")],
    signal,
    translate,
  });
  assert.equal(requests[0].length, 1);
  assert(first.every((item) => item.cacheHit === false));
  assert.deepEqual(
    first.map((item) => item.id),
    ["old", "duplicate"],
  );
  const next = await translateWithCache({
    cache: new TranslationCache(storage),
    settings,
    segments: [segment("new"), segment("missing", "Another paragraph.")],
    signal,
    translate,
  });
  assert.deepEqual(
    requests[1].map((item) => item.id),
    ["missing"],
  );
  assert.equal(next[0].id, "new");
  assert.equal(next[0].parts[0], "译文：Read this paragraph.");
  assert.deepEqual(
    next.map((item) => item.cacheHit),
    [true, false],
  );
  requests = [];
  const disabled = await translateWithCache({
    cache: new TranslationCache(storage),
    settings: { ...settings, cacheEnabled: false },
    segments: [segment("disabled")],
    signal,
    translate,
  });
  assert.equal(requests.length, 1);
  assert.equal(disabled[0].cacheHit, false);
  assert.equal((await new TranslationCache(storage).stats()).count, 2);
  assert(
    (await new TranslationCache(storage).exportData()).entries.every(
      (entry) => Object.keys(entry).sort().join() === "key,parts",
    ),
  );
});

test("预检之后写入的缓存由后台二次核对标记为命中，不误报新翻译", async () => {
  const cache = new TranslationCache(new LocalStorage());
  const segments = [segment("same")];
  assert.deepEqual(await lookupCachedTranslations({ cache, settings, segments }), []);
  await cache.putMany([
    {
      key: await cacheKey(publicSettings(settings).signature, segments[0]),
      parts: ["其他页面刚保存的译文"],
    },
  ]);
  const result = await translateWithCache({
    cache,
    settings,
    segments,
    signal,
    translate: async () => assert.fail("已有缓存不应调用翻译接口"),
  });
  assert.deepEqual(result, [{ id: "same", parts: ["其他页面刚保存的译文"], cacheHit: true }]);
});

test("缓存区分端点、模型、语言、上下文与内联分片，不依赖 API Key 或排版", async () => {
  const original = publicSettings(settings).signature;
  const key = await cacheKey(original, segment("one"));
  assert.equal(key, await cacheKey(original, segment("two")));
  for (const variant of [
    { ...settings, targetLanguage: "ja" },
    { ...settings, provider: "openai" },
    {
      ...settings,
      providers: {
        ...settings.providers,
        deepseek: { ...settings.providers.deepseek, model: "other" },
      },
    },
    {
      ...settings,
      providers: {
        ...settings.providers,
        deepseek: { ...settings.providers.deepseek, baseUrl: "https://other.example/v1" },
      },
    },
  ])
    assert.notEqual(key, await cacheKey(publicSettings(variant).signature, segment("one")));
  assert.notEqual(
    key,
    await cacheKey(original, segment("one", "Read this paragraph.", "中文参考")),
  );
  assert.notEqual(
    key,
    await cacheKey(original, { id: "one", parts: ["Read ", "this paragraph."] }),
  );
  const changedKey = normalizeSettings({
    ...settings,
    mode: "replace",
    providers: {
      ...settings.providers,
      deepseek: { ...settings.providers.deepseek, apiKey: "different-secret" },
    },
  });
  assert.equal(original, publicSettings(changedKey).signature);
});

test("超过容量阈值继续追加且不淘汰，导入导出仅包含缓存并保留本机结果", async () => {
  const storage = new LocalStorage();
  const cache = new TranslationCache(storage);
  const key = "a".repeat(64);
  await cache.putMany([{ key, parts: ["甲".repeat(400000)] }]);
  assert((await cache.stats()).bytes > 1024 * 1024);
  await cache.putMany([{ key: "b".repeat(64), parts: ["新增译文"] }]);
  assert.equal((await cache.stats()).count, 2);
  const exported = await cache.exportData();
  assert(!JSON.stringify(exported).includes("keep-my-key"));
  const anotherStorage = new LocalStorage();
  const another = new TranslationCache(anotherStorage);
  await another.putMany([{ key, parts: ["保留本机译文"] }]);
  assert.deepEqual(await another.importData(exported), { added: 1, skipped: 1 });
  assert.deepEqual((await another.getMany([key])).get(key), ["保留本机译文"]);
  const before = structuredClone(anotherStorage.data);
  assert.throws(() =>
    another.importData({
      ...exported,
      entries: [...exported.entries, { key: "bad", parts: ["bad"] }],
    }),
  );
  assert.deepEqual(anotherStorage.data, before);
  await another.clear();
  assert.deepEqual(anotherStorage.data, {
    settings: { secret: "keep-my-key" },
    unrelated: "keep-me",
  });
});

test("清理和停用阻止迟到请求写回缓存，存储故障不丢失成功译文", async () => {
  for (const action of ["clear", "disable", "failure"]) {
    const storage = new LocalStorage();
    const cache = new TranslationCache(storage);
    let complete;
    const started = new Promise((resolve) => {
      complete = resolve;
    });
    let release;
    const pending = translateWithCache({
      cache,
      settings,
      segments: [segment("pending")],
      signal,
      translate: () => {
        complete();
        return new Promise((resolve) => {
          release = () => resolve([{ id: "pending", parts: ["成功译文"] }]);
        });
      },
    });
    await started;
    if (action === "clear") await cache.clear();
    if (action === "disable") cache.invalidate();
    if (action === "failure") storage.failWrite = true;
    release();
    assert.deepEqual(await pending, [{ id: "pending", parts: ["成功译文"], cacheHit: false }]);
    assert.equal((await cache.stats()).count, 0);
    assert.equal(storage.data.settings.secret, "keep-my-key");
    if (action === "failure") assert(cache.warning.includes("写入失败"));
  }
});

test("并行导入、写入无覆盖，清理损坏索引仍只删除缓存", async () => {
  const storage = new LocalStorage();
  const cache = new TranslationCache(storage);
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      cache.putMany([{ key: index.toString(16).padStart(64, "0"), parts: [String(index)] }]),
    ),
  );
  assert.equal((await cache.stats()).count, 20);
  storage.data.translationCacheIndexV1 = ["settings"];
  storage.data[CACHE_PREFIX + "orphan"] = ["孤立缓存"];
  await cache.clear();
  assert.deepEqual(storage.data, { settings: { secret: "keep-my-key" }, unrelated: "keep-me" });
});

test("导入的分片数量不符时重新翻译并修复缓存，后续重启不再重复请求", async () => {
  const storage = new LocalStorage();
  const cache = new TranslationCache(storage);
  const key = await cacheKey(publicSettings(settings).signature, segment("source"));
  await cache.putMany([{ key, parts: ["错误分片一", "错误分片二"] }]);
  let calls = 0;
  const result = await translateWithCache({
    cache,
    settings,
    segments: [segment("source")],
    signal,
    translate: async () => {
      calls++;
      return [{ id: "source", parts: ["正确译文"] }];
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(result[0].parts, ["正确译文"]);
  assert.deepEqual(
    await lookupCachedTranslations({
      cache: new TranslationCache(storage),
      settings,
      segments: [segment("next-day")],
    }),
    [{ id: "next-day", parts: ["正确译文"] }],
  );
  assert.equal((await cache.stats()).count, 1);
  assert.deepEqual(storage.data.settings, { secret: "keep-my-key" });
});

for (const broken of [undefined, null, "invalid", [123]]) {
  test(`索引存在但正文${broken === undefined ? "缺失" : "损坏：" + JSON.stringify(broken)}时补写，跨实例复用`, async () => {
    const storage = new LocalStorage();
    const key = await cacheKey(publicSettings(settings).signature, segment("source"));
    storage.data.translationCacheIndexV1 = [CACHE_PREFIX + key];
    if (broken !== undefined) storage.data[CACHE_PREFIX + key] = broken;
    let calls = 0;
    for (let visit = 0; visit < 3; visit++) {
      const result = await translateWithCache({
        cache: new TranslationCache(storage),
        settings,
        segments: [segment(`visit-${visit}`)],
        signal,
        translate: async ({ segments }) => {
          calls++;
          return [{ id: segments[0].id, parts: ["已修复译文"] }];
        },
      });
      assert.deepEqual(result, [
        { id: `visit-${visit}`, parts: ["已修复译文"], cacheHit: visit > 0 },
      ]);
    }
    assert.equal(calls, 1);
    assert.equal((await new TranslationCache(storage).stats()).count, 1);
    assert.equal(storage.data.settings.secret, "keep-my-key");
    assert.equal(storage.data.unrelated, "keep-me");
  });
}

test("索引漏记时导入仍保留已有正文；未核对原文结构的导入不覆盖本机分片", async () => {
  const storage = new LocalStorage();
  const key = "d".repeat(64);
  storage.data.translationCacheIndexV1 = [];
  storage.data[CACHE_PREFIX + key] = ["本机第一片", "本机第二片"];
  const cache = new TranslationCache(storage);
  const result = await cache.importData({
    format: "yeyi-translation-cache",
    version: 1,
    entries: [{ key, parts: ["导入的一片"] }],
  });
  assert.deepEqual(result, { added: 0, skipped: 1 });
  assert.deepEqual((await cache.getMany([key])).get(key), ["本机第一片", "本机第二片"]);
  assert.equal((await cache.stats()).count, 1);
});

test("修复写入失败保留全部原数据，恢复存储后可修复且正常译文不被并发请求覆盖", async () => {
  const storage = new LocalStorage();
  const cache = new TranslationCache(storage);
  const key = await cacheKey(publicSettings(settings).signature, segment("source"));
  await cache.putMany([{ key, parts: ["异常一", "异常二"] }]);
  const before = structuredClone(storage.data);
  storage.failWrite = true;
  const options = {
    cache,
    settings,
    segments: [segment("source")],
    signal,
  };
  const failedWrite = await translateWithCache({
    ...options,
    translate: async () => [{ id: "source", parts: ["成功译文"] }],
  });
  assert.deepEqual(failedWrite[0].parts, ["成功译文"]);
  assert.deepEqual(storage.data, before);
  assert.match(cache.warning, /写入失败/);
  storage.failWrite = false;

  const pending = [];
  const translate = () => new Promise((resolve) => pending.push(resolve));
  const first = translateWithCache({ ...options, translate });
  const second = translateWithCache({ ...options, translate });
  while (pending.length < 2) await new Promise((resolve) => setImmediate(resolve));
  pending[0]([{ id: "source", parts: ["先保存的正确译文"] }]);
  await first;
  pending[1]([{ id: "source", parts: ["迟到的另一份译文"] }]);
  await second;
  assert.deepEqual((await cache.getMany([key])).get(key), ["先保存的正确译文"]);
  assert.deepEqual(storage.data.settings, before.settings);
  assert.equal(storage.data.unrelated, before.unrelated);
});

for (const action of ["clear", "disable"]) {
  test(`修复重新读取正文期间${action === "clear" ? "清理" : "停用"}缓存，不写回旧请求`, async () => {
    const storage = new LocalStorage();
    const cache = new TranslationCache(storage);
    const key = await cacheKey(publicSettings(settings).signature, segment("source"));
    await cache.putMany([{ key, parts: ["异常一", "异常二"] }]);
    const before = structuredClone(storage.data);
    const read = storage.get.bind(storage);
    let reads = 0;
    const started = Promise.withResolvers();
    const blocked = Promise.withResolvers();
    storage.get = async (keys) => {
      const result = await read(keys);
      if (Array.isArray(keys) && keys.includes(CACHE_PREFIX + key) && ++reads === 2) {
        started.resolve();
        await blocked.promise;
      }
      return result;
    };
    const pending = translateWithCache({
      cache,
      settings,
      segments: [segment("source")],
      signal,
      translate: async () => [{ id: "source", parts: ["迟到的修复译文"] }],
    });
    await started.promise;
    const cleared = action === "clear" ? cache.clear() : cache.invalidate();
    blocked.resolve();
    await Promise.all([pending, cleared]);
    if (action === "clear") {
      assert.equal((await cache.stats()).count, 0);
      assert.equal(storage.data[CACHE_PREFIX + key], undefined);
    } else {
      assert.deepEqual(storage.data, before);
    }
    assert.deepEqual(storage.data.settings, before.settings);
    assert.equal(storage.data.unrelated, before.unrelated);
  });
}

test("大文件完整验证后分批导入，单条异常与中途清理均有明确错误", async () => {
  const entries = Array.from({ length: 8 }, (_, index) => ({
    key: index.toString(16).padStart(64, "0"),
    parts: ["x".repeat(1_900_000)],
  }));
  const data = { format: "yeyi-translation-cache", version: 1, entries };
  validateCacheFile(data);
  const batches = [...cacheFileBatches(entries)];
  assert.equal(batches.length, 4);
  assert.deepEqual(batches.flat(), entries);
  for (const batch of batches) assert(JSON.stringify(batch).length * 6 < 64 * 1024 * 1024);
  assert.throws(() =>
    validateCacheFile({ ...data, entries: [{ ...entries[0], parts: ["x".repeat(2_000_001)] }] }),
  );
  const cache = new TranslationCache(new LocalStorage());
  const revision = cache.revision;
  await cache.importData({ ...data, entries: batches[0] }, revision);
  await cache.clear();
  await assert.rejects(
    () => cache.importData({ ...data, entries: batches[1] }, revision),
    (error) => error.code === "CACHE_CHANGED",
  );
  assert.equal((await cache.stats()).count, 0);
});

test("新版浏览器清理只枚举键，不读取大缓存正文，也不触碰设置", async () => {
  const storage = new LocalStorage();
  storage.getKeys = async () => Object.keys(storage.data);
  const originalGet = storage.get.bind(storage);
  storage.get = async (keys) => {
    assert.notEqual(keys, null);
    return originalGet(keys);
  };
  const cache = new TranslationCache(storage);
  await cache.putMany([{ key: "c".repeat(64), parts: ["已保存的译文"] }]);
  assert.equal((await cache.stats()).count, 1);
  await cache.clear();
  assert.deepEqual(storage.data, { settings: { secret: "keep-my-key" }, unrelated: "keep-me" });
});
