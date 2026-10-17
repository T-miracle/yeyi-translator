import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

let browser;
let source;

before(async () => {
  const result = await build({
    entryPoints: ["src/content/engine.js"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "translationEngineModule",
  });
  source = result.outputFiles[0].text;
  browser = await chromium.launch({ headless: true, channel: "chromium" });
});

after(async () => browser?.close());

/** 创建真实 DOM 中的翻译引擎，保留每次请求供测试控制响应时序。@returns {Promise<import('@playwright/test').Page>} 已启动翻译且首批请求未返回的页面。 */
async function startPage() {
  const page = await browser.newPage();
  await page.route("http://127.0.0.1/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en"><style>p{height:100px}</style><body><main>${Array.from({ length: 40 }, (_, index) => `<p>Paragraph ${index}</p>`).join("")}</main></body></html>`,
    }),
  );
  await page.goto("http://127.0.0.1/");
  await page.addScriptTag({ content: source });
  await page.evaluate(() => {
    globalThis.requests = [];
    globalThis.chrome = {
      runtime: {
        sendMessage(message) {
          if (message.type !== "TRANSLATE_BATCH") return Promise.resolve({ ok: true, data: null });
          return new Promise((resolve) => requests.push({ message, resolve }));
        },
      },
    };
    window.scrollTo(0, 2500);
    globalThis.engine = new translationEngineModule.TranslationEngine(() => {});
    engine.start({ signature: "order-test", targetLanguage: "zh-CN", mode: "bilingual" });
  });
  return page;
}

/** 返回某批次中原文段落的顺序。@param {import('@playwright/test').Page} page 测试页面。@param {number} index 请求下标。@returns {Promise<string[]>} 该批各段原文。 */
async function batchTexts(page, index) {
  return page.evaluate(
    (index) => requests[index].message.segments.map((segment) => segment.parts.join("")),
    index,
  );
}

/** 释放指定请求，模拟成功或结构错误响应。@param {import('@playwright/test').Page} page 测试页面。@param {number} index 请求下标。@param {boolean} [fail] 是否返回结构错误以触发补译。@returns {Promise<void>} 响应已释放。 */
async function complete(page, index, fail = false) {
  await page.evaluate(
    ({ index, fail }) => {
      const request = requests[index];
      request.resolve(
        fail
          ? { ok: false, error: { code: "OUTPUT_INVALID", message: "测试不完整响应" } }
          : {
              ok: true,
              data: request.message.segments.map((segment) => ({
                id: segment.id,
                parts: segment.parts.map((part) => `译文：${part}`),
              })),
            },
      );
    },
    { index, fail },
  );
}

test("即使从页面中部启动也从顶部逐批翻译，前一批完成前不发送后一批", async () => {
  const page = await startPage();
  try {
    assert.equal((await batchTexts(page, 0))[0], "Paragraph 0");
    assert.equal(await page.evaluate(() => requests.length), 1);
    assert.equal(await page.locator("[data-yeyi-owned=translation]").count(), 0);
    await complete(page, 0);
    await expect.poll(() => page.evaluate(() => requests.length)).toBe(2);
    assert.deepEqual(
      await batchTexts(page, 1),
      Array.from({ length: 18 }, (_, index) => `Paragraph ${index + 18}`),
    );
    await expect(page.locator("p [data-yeyi-owned=translation]")).toHaveCount(18);
    await complete(page, 1);
    await expect.poll(() => page.evaluate(() => requests.length)).toBe(3);
    assert.deepEqual(await batchTexts(page, 2), [
      "Paragraph 36",
      "Paragraph 37",
      "Paragraph 38",
      "Paragraph 39",
    ]);
  } finally {
    await page.close();
  }
});

test("新插入顶部的段落按页面位置优先，不按加入队列的时间排到末尾", async () => {
  const page = await startPage();
  try {
    await page.evaluate(() => {
      const paragraph = document.createElement("p");
      paragraph.textContent = "New first paragraph";
      document.querySelector("main").prepend(paragraph);
      engine.scan();
      window.scrollTo(0, 3500);
    });
    await complete(page, 0);
    await expect.poll(() => page.evaluate(() => requests.length)).toBe(2);
    assert.equal((await batchTexts(page, 1))[0], "New first paragraph");
    assert.equal((await batchTexts(page, 1))[1], "Paragraph 18");
  } finally {
    await page.close();
  }
});

test("上方批次失败进入低优先级队列，下方待译内容先完成", async () => {
  const page = await startPage();
  try {
    assert.equal(await page.evaluate(() => requests.length), 1);
    await complete(page, 0, true);
    await expect.poll(() => page.evaluate(() => requests.length)).toBe(2);
    assert.deepEqual(
      await batchTexts(page, 1),
      Array.from({ length: 18 }, (_, index) => `Paragraph ${index + 18}`),
    );
    await complete(page, 1);
    await expect.poll(() => page.evaluate(() => requests.length)).toBe(3);
    assert.deepEqual(
      await batchTexts(page, 2),
      Array.from({ length: 4 }, (_, index) => `Paragraph ${index + 36}`),
    );
    await complete(page, 2);
    await expect.poll(() => page.evaluate(() => requests.length)).toBe(4);
    assert.deepEqual(await batchTexts(page, 3), ["Paragraph 0"]);
  } finally {
    await page.close();
  }
});
