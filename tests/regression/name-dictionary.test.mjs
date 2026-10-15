import { test } from "node:test";
import assert from "node:assert/strict";
import { NameDictionary } from "../../src/background/name-dictionary.js";
import {
  normalizeNameEntries,
  nameDictionarySignature,
  matchingNames,
} from "../../src/shared/name-dictionary.js";
import { translateBatch } from "../../src/background/api.js";
import {
  TranslationCache,
  translateWithCache,
  lookupCachedTranslations,
} from "../../src/background/cache.js";
import { normalizeSettings, publicSettings } from "../../src/shared/settings.js";
import { createChunks } from "../../src/content/model.js";
import { cacheKey } from "../../src/background/cache.js";

const entry = { src: "Example Hero", dst: "示例角色", info: "测试角色" };
const other = { src: "Other Hero", dst: "另一角色", info: "" };

test("字典先于中文跳过生效，跨节点汉字人名及中文正文在本机替换", async () => {
  const dictionary = [
    { src: "桐生", dst: "Kiryu" },
    { src: "桐生一馬", dst: "桐生一马" },
    { src: "王小明", dst: "Wang Xiaoming" },
    { src: "Hero (A)+", dst: "指定角色" },
  ];
  for (const targetLanguage of ["zh-CN", "en"]) {
    const unit = {
      id: "han",
      nodes: [{ original: " 桐生" }, { original: "一馬与王小明见面，其他中文保留。 " }],
    };
    const segments = createChunks(unit, true);
    assert(segments.length && segments.every((segment) => segment.dictionaryOnly));
    const translated = await translateBatch({
      provider: { apiKey: "" },
      targetLanguage,
      segments,
      signal: new AbortController().signal,
      nameDictionary: dictionary,
      fetchImpl: () => assert.fail("本机字典检查不应请求 API"),
    });
    assert.equal(
      translated.flatMap((segment) => segment.parts).join(""),
      " 桐生一马与Wang Xiaoming见面，其他中文保留。 ",
    );
  }
  const translated = await translateBatch({
    provider: { apiKey: "" },
    targetLanguage: "zh-CN",
    segments: [
      { id: "literal", parts: ["这是 Hero (A)+，未命中部分保留。"], dictionaryOnly: true },
    ],
    signal: new AbortController().signal,
    nameDictionary: dictionary,
  });
  assert.deepEqual(translated[0].parts, ["这是 指定角色，未命中部分保留。"]);
});

test("空字典本机检查保持原文，停用时恢复中文跳过且普通外文仍请求翻译", async () => {
  const unit = { id: "han", nodes: [{ original: "王小明与其他中文。" }] };
  assert.deepEqual(createChunks(unit), []);
  const segments = createChunks(unit, true);
  const translated = await translateBatch({
    provider: { apiKey: "" },
    targetLanguage: "en",
    segments,
    signal: new AbortController().signal,
  });
  assert.deepEqual(translated[0].parts, ["王小明与其他中文。"]);
  const mixed = createChunks(
    { id: "mixed", nodes: [{ original: "王小明。 Read this guide before starting. 中文保留。" }] },
    true,
  );
  assert(mixed.some((segment) => segment.dictionaryOnly));
  assert(
    mixed.some(
      (segment) =>
        !segment.dictionaryOnly && segment.parts.includes("Read this guide before starting. "),
    ),
  );
});

test("本机字典片段与远程翻译片段缓存隔离，不接受无效本机标记", async () => {
  const segment = { id: "one", parts: ["王小明"] };
  assert.notEqual(
    await cacheKey("same", segment),
    await cacheKey("same", { ...segment, dictionaryOnly: true }),
  );
  await assert.rejects(
    () =>
      translateBatch({
        provider: {},
        targetLanguage: "zh-CN",
        segments: [{ ...segment, dictionaryOnly: "true" }],
        signal: new AbortController().signal,
      }),
    (error) => error.code === "BAD_INPUT",
  );
});

test("跨内联节点的人名仍进入字典提示，不跨段落误匹配，正则字符按字面匹配", () => {
  assert.deepEqual(matchingNames([entry], [{ parts: ["Meet Example", " Hero today."] }]), [entry]);
  assert.deepEqual(matchingNames([entry], [{ parts: ["Example"] }, { parts: [" Hero"] }]), []);
  const literal = { src: "Hero (A)+", dst: "指定角色", info: "" };
  assert.deepEqual(matchingNames([literal], [{ parts: ["Meet Hero (A)+."] }]), [literal]);
  assert.deepEqual(matchingNames([literal], [{ parts: ["Meet Hero AAA."] }]), []);
});

/** 独立存储替身，设置和缓存哨兵用于确认字典不覆盖其他业务数据。 */
class Storage {
  constructor() {
    this.data = {
      settings: { sentinel: "keep-settings" },
      "translationCache:v1:sentinel": ["keep-cache"],
    };
    this.fail = false;
    this.writes = 0;
  }
  async get(keys) {
    return Object.fromEntries(
      (Array.isArray(keys) ? keys : [keys])
        .filter((key) => key in this.data)
        .map((key) => [key, structuredClone(this.data[key])]),
    );
  }
  async set(values) {
    if (this.fail) throw new Error("disk full");
    this.writes++;
    Object.assign(this.data, structuredClone(values));
  }
}

test("AiNiee 三字段及 regex:false 格式兼容，坏行或正则启用拒绝整份导入", async () => {
  assert.deepEqual(
    normalizeNameEntries([{ src: " Example Hero ", dst: " 示例角色 ", regex: false }]),
    [{ ...entry, info: "" }],
  );
  const storage = new Storage();
  const dictionary = new NameDictionary(storage);
  await dictionary.importData([entry]);
  const before = structuredClone(storage.data);
  for (const data of [
    { entries: [other] },
    [other, { src: "bad", dst: 1 }],
    [other, { ...entry, regex: true }],
    [other, { ...entry, info: null }],
  ]) {
    await assert.rejects(async () => dictionary.importData(data));
    assert.deepEqual(storage.data, before);
  }
  await dictionary.importData([{ src: "Untranslated Hero", dst: "" }]);
  assert.equal((await dictionary.read()).entries.length, 2);
});

test("并发导入合并最新条目，重复与大小写差异保留本机原文及描述", async () => {
  const storage = new Storage();
  const dictionary = new NameDictionary(storage);
  await dictionary.importData([entry]);
  const results = await Promise.all([
    dictionary.importData([
      { ...entry, src: entry.src.toLowerCase(), dst: "不应覆盖", info: "不应覆盖" },
      other,
      other,
    ]),
    dictionary.importData([{ src: "Third Hero", dst: "第三角色" }]),
  ]);
  assert.equal(results[0].added, 1);
  assert.equal(results[0].skipped, 2);
  assert.equal((await dictionary.read()).entries.length, 3);
  assert.deepEqual((await dictionary.read()).entries[0], entry);
  assert.deepEqual(storage.data.settings, { sentinel: "keep-settings" });
  assert.deepEqual(storage.data["translationCache:v1:sentinel"], ["keep-cache"]);
});

test("存储失败不丢旧数据，失败后的队列仍可继续，异常格式绝不重置", async () => {
  const storage = new Storage();
  const dictionary = new NameDictionary(storage);
  await dictionary.importData([entry]);
  const before = structuredClone(storage.data);
  storage.fail = true;
  await assert.rejects(() => dictionary.importData([other]), /disk full/);
  assert.deepEqual(storage.data, before);
  storage.fail = false;
  await dictionary.importData([other]);
  storage.data.nameDictionary.version = 99;
  const corrupted = structuredClone(storage.data);
  await assert.rejects(() => dictionary.read(), /格式异常/);
  await assert.rejects(() => dictionary.importData([entry]), /格式异常/);
  assert.deepEqual(storage.data, corrupted);
});

test("多设置页修改或删除过期条目会被拒绝，重命名不覆盖其他人名", async () => {
  const dictionary = new NameDictionary(new Storage());
  await dictionary.importData([entry, other]);
  const changed = { ...entry, dst: "新译名" };
  await dictionary.saveEntry(changed, entry);
  await assert.rejects(
    () => dictionary.saveEntry({ ...entry, dst: "过期译名" }, entry),
    /其他设置页/,
  );
  await assert.rejects(() => dictionary.saveEntry(null, entry), /其他设置页/);
  await assert.rejects(
    () => dictionary.saveEntry({ ...changed, src: other.src }, changed),
    /原文已存在/,
  );
  assert.deepEqual((await dictionary.read()).entries, [changed, other]);
  await dictionary.setEnabled(false);
  assert.deepEqual((await dictionary.read()).entries, [changed, other]);
  await dictionary.saveEntry(null, changed);
  assert.deepEqual((await dictionary.read()).entries, [other]);
});

test("字典摘要稳定且不泄露条目，空字典和停用保持旧缓存键兼容", async () => {
  const base = normalizeSettings();
  const hash = await nameDictionarySignature({ enabled: true, entries: [entry, other] });
  assert.equal(hash, await nameDictionarySignature({ enabled: true, entries: [other, entry] }));
  assert.notEqual(
    hash,
    await nameDictionarySignature({ enabled: true, entries: [{ ...entry, dst: "新译名" }, other] }),
  );
  assert.equal(await nameDictionarySignature({ enabled: false, entries: [entry] }), "");
  assert.equal(
    await nameDictionarySignature({ enabled: true, entries: [{ ...entry, dst: "" }] }),
    "",
  );
  const config = publicSettings({
    ...base,
    nameDictionary: [entry],
    nameDictionarySignature: hash,
  });
  assert(!JSON.stringify(config).includes(entry.src));
  assert(!JSON.stringify(config).includes(entry.dst));
  assert.notEqual(config.signature, publicSettings(base).signature);
  assert.equal(
    publicSettings({ ...base, nameDictionarySignature: "" }).signature,
    publicSettings(base).signature,
  );
});

const provider = {
  apiKey: "fixture-secret-names",
  model: "mock",
  baseUrl: "https://translator.example/v1",
};
const signal = new AbortController().signal;
const response = (translations) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ translations }) }, finish_reason: "stop" }],
    }),
  );

test("独立人名无需 API 且保留空白，混合批次只发送剩余正文", async () => {
  const requests = [];
  const result = await translateBatch({
    provider,
    targetLanguage: "zh-CN",
    signal,
    nameDictionary: [entry, other],
    segments: [
      { id: "name", parts: ["  example hero\n", "!"] },
      { id: "body", parts: ["Read this guide."] },
    ],
    fetchImpl: async (_url, request) => {
      requests.push(JSON.parse(request.body));
      return response([{ id: "body", parts: ["阅读这份指南。"] }]);
    },
  });
  assert.deepEqual(result, [
    { id: "name", parts: ["  示例角色\n", "!"] },
    { id: "body", parts: ["阅读这份指南。"] },
  ]);
  const user = JSON.parse(requests[0].messages.at(-1).content);
  assert.deepEqual(user.segments, [{ id: "body", parts: ["Read this guide."] }]);
  assert.equal(user.nameDictionary, undefined);
  assert.deepEqual(
    await translateBatch({
      provider: { ...provider, apiKey: "" },
      targetLanguage: "zh-CN",
      signal,
      nameDictionary: [entry],
      segments: [{ id: "local", parts: [entry.src] }],
      fetchImpl: () => assert.fail("人名不应请求 API"),
    }),
    [{ id: "local", parts: [entry.dst] }],
  );
});

test("正文只发送命中的字典条目，固定独立内联节点且描述仅作为 JSON 数据", async () => {
  const named = { ...entry, info: "测试描述：<script>不执行</script>" };
  const result = await translateBatch({
    provider,
    targetLanguage: "zh-CN",
    signal,
    nameDictionary: [named, other],
    segments: [{ id: "paragraph", parts: ["Meet ", entry.src, " today."] }],
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      const user = JSON.parse(body.messages.at(-1).content);
      assert.deepEqual(user.nameDictionary, [named]);
      assert(!body.messages[0].content.includes(named.info));
      return response([{ id: "paragraph", parts: ["今天认识", "模型错误的译名", "。"] }]);
    },
  });
  assert.deepEqual(result, [{ id: "paragraph", parts: ["今天认识 ", entry.dst, " 。"] }]);
});

test("逐节点补译保留字典，服务错误不回显字典译文或描述", async () => {
  const privateEntry = { ...entry, info: "Private dictionary note" };
  let calls = 0;
  await assert.rejects(
    () =>
      translateBatch({
        provider,
        targetLanguage: "zh-CN",
        signal,
        retryDelayMs: 0,
        nameDictionary: [privateEntry],
        segments: [{ id: "fragment", parts: ["Meet Example Hero today.", "Read the guide."] }],
        fetchImpl: async (_url, request) => {
          calls++;
          const body = JSON.parse(request.body);
          assert.deepEqual(JSON.parse(body.messages.at(-1).content).nameDictionary, [privateEntry]);
          if (calls === 1) return response([{ id: "fragment", parts: ["错误的合并译文"] }]);
          return new Response(
            JSON.stringify({ error: { message: `${privateEntry.dst}: ${privateEntry.info}` } }),
            { status: 400 },
          );
        },
      }),
    (error) =>
      error.code === "REQUEST" &&
      !error.message.includes(privateEntry.info) &&
      !error.message.includes(privateEntry.dst),
  );
  assert.equal(calls, 2);
});

test("变更人名字典隔离持久缓存，旧缓存保留，停用后仍可复用原有译文", async () => {
  const storage = new Storage();
  const cache = new TranslationCache(storage);
  const base = normalizeSettings({ cacheEnabled: true });
  const segments = [{ id: "name", parts: [entry.src] }];
  const translate = async (request) => [
    { id: "name", parts: [request.nameDictionary[0]?.dst || "普通译文"] },
  ];
  await translateWithCache({ cache, settings: base, segments, signal, translate });
  const settings = {
    ...base,
    nameDictionary: [entry],
    nameDictionarySignature: await nameDictionarySignature({ enabled: true, entries: [entry] }),
  };
  assert.deepEqual(await lookupCachedTranslations({ cache, settings, segments }), []);
  assert.deepEqual(await translateWithCache({ cache, settings, segments, signal, translate }), [
    { id: "name", parts: [entry.dst] },
  ]);
  assert.deepEqual(await lookupCachedTranslations({ cache, settings: base, segments }), [
    { id: "name", parts: ["普通译文"] },
  ]);
  assert.equal((await cache.exportData()).entries.length, 2);
});
