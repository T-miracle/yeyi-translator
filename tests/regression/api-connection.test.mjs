import { test } from "node:test";
import assert from "node:assert/strict";
import { translateBatch } from "../../src/background/api.js";
import * as api from "../../src/background/api.js";

test("作为上下文发送的中文片段不会出现在服务错误提示中", async () => {
  await assert.rejects(
    () =>
      translateBatch({
        provider: {
          apiKey: "test-only-secret",
          baseUrl: "https://proxy.example/v1",
          model: "custom-chat",
        },
        targetLanguage: "zh-CN",
        segments: [{ id: "context", parts: ["Read"], context: "中文参考一。 中文参考二。" }],
        signal: new AbortController().signal,
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: { message: "Invalid part: 中文参考二" } }), {
            status: 400,
          }),
      }),
    (error) => error.code === "REQUEST" && !error.message.includes("中文参考二"),
  );
});

/** 构造正常完成的模型响应。@param {Object[]} translations 模型返回的段落。@returns {Response} Chat Completions 响应。 */
function completionResponse(translations) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ translations }) }, finish_reason: "stop" }],
    }),
  );
}

test("页面队列模式遇到网络或格式失败只请求一次，不在后台重试或补译", async () => {
  for (const invalid of [true, false]) {
    let requests = 0;
    await assert.rejects(() =>
      translateBatch({
        provider: {
          apiKey: "test-only-secret",
          baseUrl: "https://proxy.example/v1",
          model: "custom-chat",
        },
        targetLanguage: "zh-CN",
        segments: [{ id: "body", parts: ["Read", "the guide"] }],
        signal: new AbortController().signal,
        deferRetries: true,
        retryDelayMs: 0,
        fetchImpl: async () => {
          requests++;
          return invalid
            ? completionResponse([{ id: "body", parts: ["合并译文"] }])
            : new Response("{}", { status: 503 });
        },
      }),
    );
    assert.equal(requests, 1);
  }
});

test("失败队列逐节点补译跳过整段请求，每轮每个节点只请求一次且完整上下文脱敏", async () => {
  const requests = [];
  await assert.rejects(
    () =>
      translateBatch({
        provider: {
          apiKey: "test-only-secret",
          baseUrl: "https://proxy.example/v1",
          model: "custom-chat",
        },
        targetLanguage: "zh-CN",
        segments: [{ id: "body", parts: ["Video", "Private sibling source.", "Audio"] }],
        signal: new AbortController().signal,
        deferRetries: true,
        retryFragments: true,
        retryDelayMs: 0,
        fetchImpl: async (_url, options) => {
          const body = JSON.parse(JSON.parse(options.body).messages[1].content);
          requests.push(body);
          return requests.length === 1
            ? completionResponse([{ id: "body", parts: ["视频"] }])
            : new Response(JSON.stringify({ error: { message: "Private sibling source." } }), {
                status: 503,
              });
        },
      }),
    (error) => !error.message.includes("Private sibling source."),
  );
  assert.equal(requests.length, 2);
  assert.deepEqual(
    requests.map((request) => request.segments[0].parts),
    [["Video"], ["Private sibling source."]],
  );
  assert.equal(requests[1].context, "VideoPrivate sibling source.Audio");
});

test("逐节点补译的服务错误不会回显整段中其他节点的原文", async () => {
  const sibling = "Private sibling original sentence.";
  let requests = 0;
  await assert.rejects(
    () =>
      translateBatch({
        provider: {
          apiKey: "test-only-secret",
          baseUrl: "https://proxy.example/v1",
          model: "custom-chat",
        },
        targetLanguage: "zh-CN",
        segments: [{ id: "media", parts: ["Video", sibling] }],
        signal: new AbortController().signal,
        fetchImpl: async () => {
          requests++;
          if (requests === 1) return completionResponse([{ id: "media", parts: ["合并译文"] }]);
          return new Response(
            JSON.stringify({ error: { message: `Bad fragment; context=${sibling}` } }),
            { status: 400 },
          );
        },
      }),
    (error) => error.code === "REQUEST" && !error.message.includes(sibling),
  );
  assert.equal(requests, 2);
});

test("逐节点补译取消后不再发送后续节点，单节点坏响应也不会无限重试", async () => {
  for (const cancel of [true, false]) {
    const controller = new AbortController();
    let requests = 0;
    await assert.rejects(
      () =>
        translateBatch({
          provider: {
            apiKey: "test-only-secret",
            baseUrl: "https://proxy.example/v1",
            model: "custom-chat",
          },
          targetLanguage: "zh-CN",
          segments: [{ id: "media", parts: ["Video", "Audio"] }],
          signal: controller.signal,
          fetchImpl: async () => {
            requests++;
            if (requests === 1) return completionResponse([{ id: "media", parts: ["合并译文"] }]);
            if (cancel) {
              controller.abort();
              return completionResponse([{ id: "media", parts: ["视频"] }]);
            }
            return completionResponse([]);
          },
        }),
      (error) =>
        cancel
          ? error.name === "AbortError" || error.code === "CANCELLED"
          : error.code === "OUTPUT_INVALID",
    );
    assert.equal(requests, 2);
  }
});

test("补译中途鉴权失败不返回半份结果，也不继续请求剩余节点", async () => {
  let requests = 0;
  await assert.rejects(
    () =>
      translateBatch({
        provider: {
          apiKey: "test-only-secret",
          baseUrl: "https://proxy.example/v1",
          model: "custom-chat",
        },
        targetLanguage: "zh-CN",
        segments: [{ id: "media", parts: ["Video", "Audio", "Codec"] }],
        signal: new AbortController().signal,
        fetchImpl: async () => {
          requests++;
          if (requests === 1) return completionResponse([{ id: "media", parts: ["合并译文"] }]);
          if (requests === 2) return completionResponse([{ id: "media", parts: ["视频"] }]);
          return new Response("{}", { status: 401 });
        },
      }),
    (error) => error.code === "AUTH" && error.fatal,
  );
  assert.equal(requests, 3);
});

test("技术名称、已有中文及英文目标正文原样返回时不触发漏译重试", async () => {
  for (const [targetLanguage, source] of [
    ["zh-CN", "AVC, HEVC, AV1"],
    ["zh-CN", "Windows Linux macOS"],
    ["zh-CN", "开始前准确预览将要下载的内容。"],
    ["en", "Preview exactly what will be downloaded before starting."],
  ]) {
    let requests = 0;
    const result = await translateBatch({
      provider: {
        apiKey: "test-only-secret",
        baseUrl: "https://proxy.example/v1",
        model: "custom-chat",
      },
      targetLanguage,
      segments: [{ id: "unchanged", parts: [source] }],
      signal: new AbortController().signal,
      fetchImpl: async () => {
        requests++;
        return completionResponse([{ id: "unchanged", parts: [source] }]);
      },
    });
    assert.equal(requests, 1);
    assert.equal(result[0].parts[0], source);
  }
});

test("中文翻译原样返回整句英文时重新补译", async () => {
  const source = "Preview exactly what will be downloaded before starting.";
  let requests = 0;
  const result = await translateBatch({
    provider: {
      apiKey: "test-only-secret",
      baseUrl: "https://proxy.example/v1",
      model: "custom-chat",
    },
    targetLanguage: "zh-CN",
    segments: [{ id: "preview", parts: [source] }],
    signal: new AbortController().signal,
    retryDelayMs: 0,
    fetchImpl: async () => {
      requests++;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  translations: [
                    {
                      id: "preview",
                      parts: [requests === 1 ? source : "开始前准确预览将要下载的内容。"],
                    },
                  ],
                }),
              },
              finish_reason: "stop",
            },
          ],
        }),
      );
    },
  });
  assert.equal(requests, 2);
  assert.equal(result[0].parts[0], "开始前准确预览将要下载的内容。");
});

test("媒体单元格的 parts 被模型合并后，按文本节点补译并保留全部行与标点", async () => {
  const source = [
    "Video",
    ": 8K, 4K, HDR, Dolby Vision",
    "Audio",
    ": Hi-Res Lossless, Dolby Atmos",
    "Codec",
    ": AVC, HEVC, AV1",
    "\n",
    "Preview exactly what will be downloaded before starting.",
  ];
  const dictionary = new Map([
    [source[0], "视频"],
    [source[1], ": 8K、4K、HDR、杜比视界"],
    [source[2], "音频"],
    [source[3], ": 高解析度无损、杜比全景声"],
    [source[4], "编码"],
    [source[5], ": AVC、HEVC、AV1"],
    [source[7], "开始前准确预览将要下载的内容。"],
  ]);
  const requests = [];
  const result = await translateBatch({
    provider: {
      apiKey: "test-only-secret",
      baseUrl: "https://proxy.example/v1",
      model: "custom-chat",
    },
    targetLanguage: "zh-CN",
    segments: [{ id: "media", parts: source }],
    signal: new AbortController().signal,
    fetchImpl: async (_url, request) => {
      const payload = JSON.parse(JSON.parse(request.body).messages.at(-1).content);
      requests.push(payload);
      const translations = payload.segments.map((segment) => ({
        id: segment.id,
        parts:
          segment.parts.length > 1
            ? ["视频、音频和编码。"]
            : segment.parts.map((part) => dictionary.get(part) || part),
      }));
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: JSON.stringify({ translations }) }, finish_reason: "stop" },
          ],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  });
  assert.deepEqual(result, [
    { id: "media", parts: source.map((part) => dictionary.get(part) || part) },
  ]);
  assert.equal(requests.length, 8);
  for (const payload of requests.slice(1)) {
    assert.equal(payload.segments[0].parts.length, 1);
    assert.equal(payload.context, source.join(""));
  }
});

test("README 表格中的表情、逗号和数字即使被模型清空也不会拖累整批译文", () => {
  const segments = [{ id: "readme", parts: ["🎨 ", "Modern UI", ", ", "2026", "8K"] }];
  const content = JSON.stringify({
    translations: [{ id: "readme", parts: ["", "现代界面", "", "", "8K"] }],
  });
  assert.deepEqual(api.parseTranslations(content, segments), [
    { id: "readme", parts: ["🎨 ", "现代界面", ", ", "2026", "8K"] },
  ]);
});

test("正文被清空或缺少片段时仍拒绝响应，避免用空白覆盖原文", () => {
  const segments = [{ id: "readme", parts: ["🎨 ", "Modern UI"] }];
  for (const parts of [["", ""], ["现代界面"], [null, "现代界面"]])
    assert.throws(
      () =>
        api.parseTranslations(
          JSON.stringify({ translations: [{ id: "readme", parts }] }),
          segments,
        ),
      (error) => error.code === "OUTPUT_INVALID",
    );
});

test("HTTP 400 的模型不存在错误保留可诊断的信息并引导获取模型", async () => {
  await assert.rejects(
    () =>
      translateBatch({
        provider: {
          apiKey: "test-only-secret",
          baseUrl: "https://api.deepseek.com",
          model: "DeepSeek-V41-Flash",
        },
        targetLanguage: "zh-CN",
        segments: [{ id: "connection", parts: ["Hello, world!"] }],
        signal: new AbortController().signal,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              error: {
                type: "invalid_request_error",
                code: "model_not_found",
                param: "model",
                message:
                  "Model 'DeepSeek-V41-Flash' does not exist. Query /models to find available models.",
              },
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          ),
      }),
    (error) => {
      assert.match(error.message, /DeepSeek-V41-Flash/);
      assert.match(error.message, /获取模型/);
      assert(!error.message.includes("test-only-secret"));
      return true;
    },
  );
});

test("模型列表从 GET /models 返回真实 ID，兼容根地址、/v1 和完整端点", async () => {
  for (const [baseUrl, expected] of [
    ["https://api.deepseek.com", "https://api.deepseek.com/models"],
    ["https://api.openai.com/v1/", "https://api.openai.com/v1/models"],
    ["https://proxy.example/v1/chat/completions", "https://proxy.example/v1/models"],
  ]) {
    const models = await api.listModels({
      provider: { apiKey: "test-only-secret", baseUrl },
      fetchImpl: async (url, request) => {
        assert.equal(url, expected);
        assert.equal(request.method, "GET");
        assert.equal(request.headers.Authorization, "Bearer test-only-secret");
        assert.equal(request.body, undefined);
        return new Response(
          JSON.stringify({
            object: "list",
            data: [
              {
                id: "deepseek-flash",
                name: "DeepSeek-V4.1-Flash",
                object: "model",
                owned_by: "deepseek",
              },
              { id: "custom-chat", object: "model", owned_by: "custom" },
              { id: "deepseek-flash", object: "model", owned_by: "deepseek" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });
    assert.deepEqual(models, [
      { id: "custom-chat", name: "custom-chat" },
      { id: "deepseek-flash", name: "DeepSeek-V4.1-Flash" },
    ]);
  }
});

test("连接错误保留参数原因，同时脱敏 Key、编码后的 Key 和原文", async () => {
  const key = "sk-test/key+with=digits";
  const source = "Private original paragraph.";
  await assert.rejects(
    () =>
      translateBatch({
        provider: { apiKey: key, baseUrl: "https://proxy.example/v1", model: "custom-chat" },
        targetLanguage: "zh-CN",
        segments: [{ id: "private", parts: [source] }],
        signal: new AbortController().signal,
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              error: {
                code: "unsupported_parameter",
                param: "response_format",
                message: `response_format is unsupported; key=${key}; encoded=${encodeURIComponent(key)}; source=${source}; Authorization: Bearer sk-another-private-key-1234`,
              },
            }),
            { status: 400 },
          ),
      }),
    (error) => {
      assert.match(error.message, /response_format is unsupported/);
      assert(!error.message.includes(key));
      assert(!error.message.includes(encodeURIComponent(key)));
      assert(!error.message.includes(source));
      assert(!error.message.includes("sk-another-private-key-1234"));
      return true;
    },
  );
});

test("接口未提供模型列表时明确允许手动配置，鉴权失败不会重试", async () => {
  for (const [status, body, expected] of [
    [404, { error: { message: "Not Found" } }, /手动填写模型 ID/],
    [401, { error: { message: "Invalid key test-only-secret" } }, /API Key 无效/],
  ]) {
    let requests = 0;
    await assert.rejects(
      () =>
        api.listModels({
          provider: { apiKey: "test-only-secret", baseUrl: "https://proxy.example/v1" },
          fetchImpl: async () => {
            requests++;
            return new Response(JSON.stringify(body), { status });
          },
        }),
      (error) => {
        assert.match(error.message, expected);
        assert(!error.message.includes("test-only-secret"));
        return true;
      },
    );
    assert.equal(requests, 1);
  }
});
