import { test } from "node:test";
import assert from "node:assert/strict";
import { translateBatch } from "../../src/background/api.js";
import { cacheKey } from "../../src/background/cache.js";
import { normalizeSettings, publicSettings } from "../../src/shared/settings.js";
import { reasoningParameters, reasoningSignature } from "../../src/shared/reasoning.js";

const official = {
  apiKey: "test-only-reasoning-secret",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
};
const segments = [{ id: "source", parts: ["Reasoning source."] }];

/** 只在注入的 HTTP 边界记录请求，不访问真实接口或使用用户密钥。 */
async function requestFor(provider) {
  let sent;
  await translateBatch({
    provider,
    targetLanguage: "zh-CN",
    segments,
    signal: new AbortController().signal,
    fetchImpl: async (_url, options) => {
      sent = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  translations: [{ id: "source", parts: ["推理译文。"] }],
                }),
              },
              finish_reason: "stop",
            },
          ],
        }),
      );
    },
  });
  return sent;
}

test("推理级别兼容旧设置：官方保持关闭，代理和 OpenAI 保持默认，保留其他数据", () => {
  const previous = {
    providers: {
      deepseek: { ...official },
      openai: { apiKey: "saved-openai-key", model: "custom-model" },
    },
    autoTranslateSites: ["example.com"],
    cacheEnabled: true,
    cacheLimitMb: 128,
    optimizeChineseFont: true,
    translationShortcut: "Alt+T",
  };
  const untouched = structuredClone(previous);
  const settings = normalizeSettings(previous);
  assert.deepEqual(previous, untouched);
  assert.equal(settings.providers.deepseek.reasoningEffort, "default");
  assert.equal(settings.providers.deepseek.thinkingMode, "disabled");
  assert.equal(settings.providers.openai.reasoningEffort, "default");
  assert.deepEqual(settings.providers.deepseek, {
    ...official,
    reasoningEffort: "default",
    thinkingMode: "disabled",
  });
  assert.equal(settings.providers.openai.apiKey, "saved-openai-key");
  assert.equal(settings.providers.openai.model, "custom-model");
  for (const key of [
    "autoTranslateSites",
    "cacheEnabled",
    "cacheLimitMb",
    "optimizeChineseFont",
    "translationShortcut",
  ])
    assert.deepEqual(settings[key], previous[key]);
  const proxy = normalizeSettings({
    providers: { deepseek: { ...official, baseUrl: "https://proxy.example/v1" } },
  });
  assert.equal(proxy.providers.deepseek.reasoningEffort, "default");
  for (const reasoningEffort of ["", "ultra", 1, {}, "HIGH"])
    assert.throws(
      () => normalizeSettings({ providers: { deepseek: { reasoningEffort } } }),
      /推理级别无效/,
    );
});

test("DeepSeek 官方的关闭、低、高、最高及接口默认准确映射到请求", async () => {
  for (const reasoningEffort of [undefined, "none", "default", "low", "high", "max"]) {
    const provider = { ...official, reasoningEffort };
    const sent = await requestFor(provider);
    const disabled = reasoningEffort === undefined || reasoningEffort === "none";
    const automatic = reasoningEffort === "default";
    assert.deepEqual(
      sent.thinking,
      automatic ? undefined : { type: disabled ? "disabled" : "enabled" },
    );
    assert.equal(sent.reasoning_effort, disabled || automatic ? undefined : reasoningEffort);
    assert.equal(sent.model, "deepseek-flash");
    assert.equal(sent.response_format.type, "json_object");
  }
});

test("OpenAI 与代理使用通用参数，默认不传，不误带 DeepSeek 的思考开关", async () => {
  for (const baseUrl of ["https://api.openai.com/v1", "https://proxy.example/v1"]) {
    for (const reasoningEffort of [
      undefined,
      "default",
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]) {
      const sent = await requestFor({
        ...official,
        baseUrl,
        model: "custom-reasoner",
        reasoningEffort,
      });
      assert.equal(
        sent.reasoning_effort,
        !reasoningEffort || reasoningEffort === "default" ? undefined : reasoningEffort,
      );
      assert.equal(sent.thinking, undefined);
    }
  }
  assert.deepEqual(
    reasoningParameters({ ...official, baseUrl: "https://api.deepseek.com.proxy.example" }),
    {},
  );
});

test("不同推理级别隔离缓存，旧默认及字典缓存键保持兼容且不暴露 Key", async () => {
  for (const baseUrl of [official.baseUrl, "https://proxy.example/v1"]) {
    const settings = normalizeSettings({ providers: { deepseek: { ...official, baseUrl } } });
    for (const dictionary of ["", "dictionary-digest"]) {
      settings.nameDictionarySignature = dictionary;
      const legacy = [settings.provider, baseUrl, official.model, settings.targetLanguage];
      if (dictionary) legacy.push(dictionary);
      assert.equal(publicSettings(settings).signature, JSON.stringify(legacy));
      const originalKey = await cacheKey(publicSettings(settings).signature, segments[0]);
      const keys = new Set();
      for (const effort of ["low", "high", "max"]) {
        const changed = {
          ...settings,
          providers: {
            ...settings.providers,
            deepseek: {
              ...settings.providers.deepseek,
              thinkingMode: "enabled",
              reasoningEffort: effort,
            },
          },
        };
        const config = publicSettings(changed);
        assert.equal(config.reasoningEffort, effort);
        assert.equal(config.reasoningSignature, effort);
        assert(!JSON.stringify(config).includes(official.apiKey));
        const key = await cacheKey(config.signature, segments[0]);
        assert.notEqual(key, originalKey);
        keys.add(key);
      }
      assert.equal(keys.size, 3);
      assert.equal(await cacheKey(publicSettings(settings).signature, segments[0]), originalKey);
    }
  }
  assert.equal(reasoningSignature({ ...official, reasoningEffort: "none" }), "");
  assert.equal(reasoningSignature({ ...official, reasoningEffort: "default" }), "default");
});

test("拆分开关后兼容已保存的组合档位，请求及缓存身份保持一致且读取不改写原配置", () => {
  for (const baseUrl of [official.baseUrl, "https://proxy.example/v1"]) {
    for (const reasoningEffort of [undefined, "none", "default", "low", "high", "max"]) {
      const previous = { ...official, baseUrl, reasoningEffort };
      const untouched = structuredClone(previous);
      const expectedRequest = reasoningParameters(previous);
      const expectedSignature = reasoningSignature(previous);
      const next = normalizeSettings({ providers: { deepseek: previous } });
      assert.deepEqual(previous, untouched);
      assert.deepEqual(reasoningParameters(next.providers.deepseek), expectedRequest);
      assert.equal(reasoningSignature(next.providers.deepseek), expectedSignature);
      assert.deepEqual(normalizeSettings(next), next);
    }
  }
});

test("关闭思考及接口默认时预选任何推理级别都不会开启或产生新缓存身份", async () => {
  for (const baseUrl of [official.baseUrl, "https://proxy.example/v1"]) {
    for (const thinkingMode of ["disabled", "default"]) {
      const signatures = new Set();
      for (const reasoningEffort of ["default", "low", "high", "max"]) {
        const provider = { ...official, baseUrl, thinkingMode, reasoningEffort };
        const sent = await requestFor(provider);
        assert.deepEqual(
          sent.thinking,
          thinkingMode === "disabled" && baseUrl === official.baseUrl
            ? { type: "disabled" }
            : undefined,
        );
        assert.equal(
          sent.reasoning_effort,
          thinkingMode === "disabled" && baseUrl !== official.baseUrl ? "none" : undefined,
        );
        signatures.add(reasoningSignature(provider));
      }
      assert.equal(signatures.size, 1);
    }
  }
});

test("只有明确开启思考才发送预选强度，默认强度与关闭或接口默认的缓存互相隔离", async () => {
  for (const reasoningEffort of ["default", "low", "high", "max"]) {
    const provider = { ...official, thinkingMode: "enabled", reasoningEffort };
    const sent = await requestFor(provider);
    assert.deepEqual(sent.thinking, { type: "enabled" });
    assert.equal(
      sent.reasoning_effort,
      reasoningEffort === "default" ? undefined : reasoningEffort,
    );
    assert.notEqual(
      reasoningSignature(provider),
      reasoningSignature({ ...provider, thinkingMode: "disabled" }),
    );
    assert.notEqual(
      reasoningSignature(provider),
      reasoningSignature({ ...provider, thinkingMode: "default" }),
    );
  }
  assert.throws(
    () => normalizeSettings({ providers: { deepseek: { thinkingMode: "invalid" } } }),
    /思考模式无效/,
  );
});

test("思考流只读取最终译文，推理内容不写入页面或返回结果", async () => {
  const events = [
    { choices: [{ delta: { reasoning_content: "Private reasoning tokens." } }] },
    {
      choices: [
        {
          delta: {
            content: JSON.stringify({ translations: [{ id: "source", parts: ["最终译文。"] }] }),
          },
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ];
  const result = await translateBatch({
    provider: { ...official, reasoningEffort: "high" },
    targetLanguage: "zh-CN",
    segments,
    signal: new AbortController().signal,
    fetchImpl: async () =>
      new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      ),
  });
  assert.deepEqual(result, [{ id: "source", parts: ["最终译文。"] }]);
});

test("推理级别在补译与重试中保持，接口不支持时保留错误且不静默降档", async () => {
  const sent = [];
  await assert.rejects(
    () =>
      translateBatch({
        provider: { ...official, reasoningEffort: "max" },
        targetLanguage: "zh-CN",
        segments: [{ id: "source", parts: ["Hello", "world"] }],
        signal: new AbortController().signal,
        fetchImpl: async (_url, options) => {
          sent.push(JSON.parse(options.body));
          if (sent.length === 1)
            return new Response(
              JSON.stringify({
                choices: [{ message: { content: '{"translations":[]}' }, finish_reason: "stop" }],
              }),
            );
          return new Response(
            JSON.stringify({
              error: { param: "reasoning_effort", message: "Unsupported effort max" },
            }),
            { status: 400 },
          );
        },
      }),
    /Unsupported effort max/,
  );
  assert.equal(sent.length, 2);
  assert(sent.every((body) => body.reasoning_effort === "max" && body.thinking.type === "enabled"));
});
