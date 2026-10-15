import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const dictionary = new Map([
  ["Home", "首页"],
  ["Explore", "探索"],
  ["Open menu", "打开菜单"],
  ["Welcome to the open web", "欢迎来到开放网络"],
  ["Read", "阅读"],
  ["the guide", "指南"],
  ["and explore.", "并探索。"],
  ["Read the guide and explore.", "阅读指南并探索。"],
  ["This article preserves", "这篇文章保留"],
  ["important details", "重要细节"],
  ["and useful links.", "与有用的链接。"],
  ["Planet", "星球"],
  ["Distance", "距离"],
  ["Earth", "地球"],
  ["One astronomical unit", "一个天文单位"],
  ["This paragraph is below the first screen.", "这段文字位于首屏下方。"],
  ["Dynamic paragraph.", "动态段落。"],
  ["Updated paragraph.", "更新后的段落。"],
  ["Frame paragraph.", "框架中的段落。"],
  ["Hello, world!", "你好，世界！"],
  ["Standard Videos", "普通视频"],
  ["Bangumi", "番剧"],
  ["Movies", "电影"],
  ["Courses", "课程"],
  ["Interactive Videos", "互动视频"],
  ["Audio (au/am)", "音频（au/am）"],
  ["User Space", "用户空间"],
  ["Favorites", "收藏夹"],
  ["Weekly Must-Watch", "每周必看"],
  ["Subscriptions", "订阅"],
  ["Watch Later", "稍后观看"],
  ["History", "历史记录"],
  ["Video", "视频"],
  ["Audio", "音频"],
  ["Codec", "编码"],
  [": 8K, 4K, HDR, Dolby Vision", "：8K、4K、HDR、杜比视界"],
  [": Hi-Res Lossless, Dolby Atmos", "：高解析度无损、杜比全景声"],
  [": AVC, HEVC, AV1", "：AVC、HEVC、AV1"],
  ["Preview exactly what will be downloaded before starting.", "开始前准确预览将要下载的内容。"],
]);

/** 启动独立测试服务；模拟数据与生产入口完全隔离。@returns {Promise<Object>} 服务地址、请求记录与行为控制。 */
export async function startServer() {
  const fixture = await readFile(new URL("fixture.html", import.meta.url), "utf8");
  const readme = await readFile(new URL("readme.html", import.meta.url), "utf8");
  const requests = [];
  const modelRequests = [];
  const state = { mode: "success", transientRemaining: 0, malformedAt: -1, delayMs: 0 };
  const sockets = new Set();
  const server = createServer(async (request, response) => {
    if (request.url === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url.endsWith("/models")) {
      modelRequests.push({
        path: request.url,
        method: request.method,
        authorization: request.headers.authorization,
      });
      const status = request.url.startsWith("/no-models/") ? 404 : 200;
      const data = request.url.startsWith("/v1/")
        ? [
            { id: "gpt-4.1-mini", object: "model", owned_by: "openai" },
            { id: "gpt-4.1", object: "model", owned_by: "openai" },
          ]
        : request.url.startsWith("/old/")
          ? [{ id: "old-chat", name: "Old model", object: "model", owned_by: "custom" }]
          : [
              {
                id: "deepseek-flash",
                name: "DeepSeek-V4.1-Flash",
                object: "model",
                owned_by: "deepseek",
              },
              {
                id: "deepseek-v4-pro",
                name: "DeepSeek-V4-Pro",
                object: "model",
                owned_by: "deepseek",
              },
            ];
      setTimeout(
        () => {
          if (!response.destroyed) {
            response.writeHead(status, { "Content-Type": "application/json" });
            response.end(
              JSON.stringify(
                status === 200 ? { object: "list", data } : { error: { message: "Not Found" } },
              ),
            );
          }
        },
        request.url.startsWith("/old/") ? 1400 : 0,
      );
      return;
    }
    if (!request.url.endsWith("/chat/completions")) {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      if (request.url === "/viewport-frames") response.end(state.frameDocument || "");
      else if (request.url === "/readme") response.end(readme);
      else if (request.url === "/frame")
        response.end(
          '<!doctype html><html lang="en"><body><p id="frameText">Frame paragraph.</p></body></html>',
        );
      else if (request.url === "/long")
        response.end(
          fixture.replace(
            '<div id="dynamic"></div>',
            `<div id="dynamic"></div>${Array.from({ length: 45 }, (_, index) => `<p class="long-paragraph">Long paragraph ${index}: ${"A longer passage about reading across languages. ".repeat(4)}</p>`).join("")}`,
          ),
        );
      else response.end(fixture);
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({
      path: request.url,
      method: request.method,
      authorization: request.headers.authorization,
      body,
    });
    if (["DeepSeek-V41-Flash", "missing-model"].includes(body.model)) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            code: "model_not_found",
            param: "model",
            message: `Model '${body.model}' does not exist.`,
          },
        }),
      );
      return;
    }
    if (state.mode === "auth") {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { code: "invalid_api_key" } }));
      return;
    }
    if (state.mode === "quota") {
      response.writeHead(429, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { code: "insufficient_quota" } }));
      return;
    }
    if (state.transientRemaining > 0) {
      state.transientRemaining--;
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end('{"error":{"type":"server_error"}}');
      return;
    }
    const segments = JSON.parse(
      body.messages.find((message) => message.role === "user").content,
    ).segments;
    const content =
      state.mode === "malformed" ||
      state.malformedAt === requests.length ||
      (state.malformedText &&
        segments.some((segment) =>
          segment.parts.some((part) => part.includes(state.malformedText)),
        ))
        ? '{"translations":[]}'
        : JSON.stringify({
            translations: segments.map((segment) => ({
              id: segment.id,
              parts:
                state.mode === "mergeParts" && segment.parts.length > 1
                  ? ["模型合并后的译文"]
                  : segment.parts.map((part) =>
                      state.mode === "emptyNonLanguage" && !/\p{L}/u.test(part)
                        ? ""
                        : state.mode === "injection"
                          ? '<img src="invalid" onerror="document.body.dataset.injected=1">'
                          : dictionary.get(part.trim().replace(/\s+/g, " ")) ||
                            `译文：${part.trim()}`,
                    ),
            })),
          });
    const delayMs = state.delayMs;
    setTimeout(() => {
      if (response.destroyed) return;
      if (state.mode === "json") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }),
        );
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
      });
      let stream =
        'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\r\n\r\n';
      for (let index = 0; index < content.length; index += 13)
        stream += `data: ${JSON.stringify({ choices: [{ delta: { content: content.slice(index, index + 13) }, finish_reason: null }] })}\r\n\r\n`;
      stream +=
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n';
      const bytes = Buffer.from(stream);
      response.write(bytes.subarray(0, 157));
      setTimeout(() => response.end(bytes.subarray(157)), 5);
    }, delayMs);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    modelRequests,
    state,
    close: async () => {
      sockets.forEach((socket) => socket.destroy());
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
