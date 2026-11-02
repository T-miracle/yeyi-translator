import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isJapaneseText, translationProfile } from "../../src/shared/translation-profile.js";
import { createChunks } from "../../src/content/model.js";
import { translateBatch, validateSegments } from "../../src/background/api.js";
import {
  TranslationCache,
  cacheKey,
  lookupCachedTranslations,
  translateWithCache,
} from "../../src/background/cache.js";
import { normalizeSettings, publicSettings } from "../../src/shared/settings.js";

const provider = {
  apiKey: "test-only-japanese-secret",
  baseUrl: "https://proxy.example/v1",
  model: "custom-chat",
  thinkingMode: "disabled",
  reasoningEffort: "high",
};

/** 在 HTTP 边界记录真实构造的请求；不调用外部服务、不使用用户 Key。 */
async function capture(segments, options = {}) {
  const requests = [];
  const result = await translateBatch({
    provider,
    targetLanguage: "zh-CN",
    signal: new AbortController().signal,
    segments,
    ...options,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      const input = JSON.parse(body.messages.at(-1).content);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  translations: input.segments.map((segment) => ({
                    id: segment.id,
                    parts: segment.parts.map((part) => `译文：${part.trim()}`),
                  })),
                }),
              },
              finish_reason: "stop",
            },
          ],
        }),
      );
    },
  });
  return { requests, result };
}

test("本机识别平假名、片假名和半角日语，不把中文、韩文、网址路径当成日语", () => {
  for (const text of ["これ最高じゃんｗ", "マジ？", "ﾏｼﾞで？", "ﾜﾛﾀ", "え", "𛀁"]) {
    assert.equal(isJapaneseText(text), true, text);
  }
  for (const text of [
    "This is a forum post.",
    "这是论坛帖子，草原上的草。",
    "這是中文。",
    "最高品質",
    "한국어 설명입니다.",
    "sore na www",
    "2026 https://example.com/かな www.example.com/カナ",
    "😂！？ー",
  ]) {
    assert.equal(isJapaneseText(text), false, text);
  }
  assert(translationProfile({ parts: ["最高"], sourceLanguage: "ja" }));
  assert(translationProfile({ parts: ["最高"] }, ["これは", "だね"]));
  assert.equal(translationProfile({ parts: ["ハル"], dictionaryOnly: true }), "");
});

test("完整日语段落内的纯汉字节点不再误跳过，拆块后保留日语来源", () => {
  const unit = {
    id: "forum",
    nodes: [{ original: "これ" }, { original: "最高" }, { original: "じゃん。" }],
  };
  const chunks = createChunks(unit);
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0].parts, ["これ", "最高", "じゃん。"]);
  assert.equal(chunks[0].sourceLanguage, "ja");
  assert(unit.nodes.every((record) => record.fragments.every((fragment) => !fragment.preserve)));
  const long = createChunks({
    id: "long",
    nodes: [{ original: "これ" }, { original: "最高".repeat(1600) }],
  });
  assert(long.length > 1);
  assert(long.every((chunk) => chunk.sourceLanguage === "ja" && translationProfile(chunk)));
  validateSegments(long);
  assert.deepEqual(createChunks({ id: "chinese", nodes: [{ original: "这是最高品质。" }] }), []);
});

test("真实请求切换日语论坛提示词，混排只标记日语且不增加请求或开启思考", async () => {
  const segments = [
    { id: "english", parts: ["Welcome to the open web"] },
    { id: "japanese", parts: ["これ", "最高", "じゃん。"] },
    { id: "halfwidth", parts: ["ﾜﾛﾀｗ"] },
    { id: "chinese", parts: ["这是论坛中的中文。"] },
  ];
  const { requests, result } = await capture(segments);
  assert.equal(requests.length, 1);
  const sent = requests[0];
  const input = JSON.parse(sent.messages.at(-1).content);
  assert.deepEqual(input.japaneseSegmentIds, ["japanese", "halfwidth"]);
  assert.deepEqual(input.segments, segments);
  assert.match(sent.messages[0].content, /Japanese forum translation/);
  assert.match(sent.messages[0].content, /ONLY to those segments/);
  assert.match(sent.messages[0].content, /日译中额外要求/);
  assert.equal(sent.reasoning_effort, "none");
  assert.equal(sent.response_format.type, "json_object");
  assert.deepEqual(
    result.map((item) => item.id),
    segments.map((item) => item.id),
  );
  assert.equal(result[1].parts.length, 3);
});

test("非日语保持通用提示词，字典描述的日语不会改变正文翻译风格", async () => {
  const { requests } = await capture([{ id: "body", parts: ["Meet Example Hero today."] }], {
    nameDictionary: [{ src: "Example Hero", dst: "示例角色", info: "これは辞書の説明です。" }],
  });
  const input = JSON.parse(requests[0].messages.at(-1).content);
  assert.equal(input.japaneseSegmentIds, undefined);
  assert.doesNotMatch(requests[0].messages[0].content, /Japanese forum translation/);
  assert.equal(input.nameDictionary[0].dst, "示例角色");
});

test("日语专用请求保持人名字典优先，独立人名在本机完成且不丢失空白", async () => {
  const named = { src: "ハル", dst: "小春", info: "论坛角色" };
  const { requests, result } = await capture(
    [
      { id: "local", parts: [" ハル "] },
      { id: "body", parts: ["ハル", "ってマジ？"] },
    ],
    { nameDictionary: [named] },
  );
  assert.equal(requests.length, 1);
  const input = JSON.parse(requests[0].messages.at(-1).content);
  assert.deepEqual(input.japaneseSegmentIds, ["body"]);
  assert.deepEqual(input.nameDictionary, [named]);
  assert.deepEqual(
    input.segments.map((segment) => segment.id),
    ["body"],
  );
  assert.deepEqual(result[0], { id: "local", parts: [" 小春 "] });
  assert.equal(result[1].parts[0], "小春");
});

test("日语补译沿用段落判定，纯汉字片段和其他目标语言仍使用正确的专用提示词", async () => {
  const { requests } = await capture(
    [{ id: "split", parts: ["最高", "品質"], sourceLanguage: "ja" }],
    { retryFragments: true, deferRetries: true },
  );
  assert.equal(requests.length, 2);
  for (const request of requests) {
    const input = JSON.parse(request.messages.at(-1).content);
    assert.deepEqual(input.japaneseSegmentIds, ["split"]);
    assert.equal(input.segments[0].sourceLanguage, "ja");
    assert.equal(input.context, "最高品質");
  }
  for (const targetLanguage of ["zh-TW", "en"]) {
    const { requests } = await capture([{ id: "ja", parts: ["それな。"] }], { targetLanguage });
    const prompt = requests[0].messages[0].content;
    assert.match(prompt, /Japanese forum translation/);
    if (targetLanguage === "zh-TW") assert.match(prompt, /確實/);
    else assert.doesNotMatch(prompt, /日译中额外要求/);
  }
  for (const sourceLanguage of ["ja-JP", "en", true, {}]) {
    assert.throws(
      () => validateSegments([{ id: "bad", parts: ["source"], sourceLanguage }]),
      (error) => error.code === "BAD_INPUT",
    );
  }
});

/** 保存真实缓存条目，并用哨兵确保设置、字典及旧缓存不被覆盖。 */
class Storage {
  constructor() {
    this.data = {
      settings: { apiKey: "keep-my-key", autoTranslateSites: ["example.com"] },
      nameDictionary: { entries: [{ src: "ハル", dst: "小春" }] },
    };
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
    Object.assign(this.data, structuredClone(values));
  }
}

/** 按已发布版本的算法生成摘要，验证升级后只隔离新日语译文。 */
const legacyKey = (signature, segment) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        signature,
        segment.parts,
        segment.context || "",
        ...(segment.dictionaryOnly ? [true] : []),
      ]),
    )
    .digest("hex");

test("升级仅隔离日语旧缓存，英文继续命中，新日语可复用且 Key、字典、旧译文完整保留", async () => {
  const settings = normalizeSettings({ cacheEnabled: true, providers: { deepseek: provider } });
  const beforeSettings = structuredClone(settings);
  const signature = publicSettings(settings).signature;
  const japanese = { id: "ja", parts: ["マジで？"] };
  const english = { id: "en", parts: ["Welcome to the open web"] };
  const previousJa = legacyKey(signature, japanese);
  const previousEn = legacyKey(signature, english);
  assert.notEqual(await cacheKey(signature, japanese), previousJa);
  assert.equal(await cacheKey(signature, english), previousEn);
  const localName = { id: "name", parts: ["ハル"], dictionaryOnly: true };
  assert.equal(await cacheKey(signature, localName), legacyKey(signature, localName));
  const storage = new Storage();
  const cache = new TranslationCache(storage);
  await cache.putMany([
    { key: previousJa, parts: ["旧日语译文"] },
    { key: previousEn, parts: ["欢迎来到开放网络"] },
  ]);
  const before = structuredClone(storage.data);
  assert.deepEqual(
    await lookupCachedTranslations({ cache, settings, segments: [japanese, english] }),
    [{ id: "en", parts: ["欢迎来到开放网络"] }],
  );
  let calls = 0;
  const options = {
    cache,
    settings,
    segments: [japanese, english],
    signal: new AbortController().signal,
    translate: async ({ segments }) => {
      calls++;
      assert.deepEqual(segments, [japanese]);
      return [{ id: "ja", parts: ["真的假的？"] }];
    },
  };
  const translated = await translateWithCache(options);
  assert.deepEqual(translated, [
    { id: "ja", parts: ["真的假的？"], cacheHit: false },
    { id: "en", parts: ["欢迎来到开放网络"], cacheHit: true },
  ]);
  assert.deepEqual(
    await translateWithCache(options),
    translated.map((item) => ({ ...item, cacheHit: true })),
  );
  assert.equal(calls, 1);
  for (const [key, value] of Object.entries(before)) {
    if (key !== "translationCacheIndexV1") assert.deepEqual(storage.data[key], value);
  }
  assert.equal((await cache.exportData()).entries.length, 3);
  assert.deepEqual(settings, beforeSettings);
});
