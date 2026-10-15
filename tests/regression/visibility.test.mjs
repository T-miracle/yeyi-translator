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
    globalName: "engineModule",
  });
  source = result.outputFiles[0].text;
  browser = await chromium.launch({ headless: true, channel: "chromium" });
});
after(async () => browser?.close());

/** 在真实布局中运行引擎，记录发往后台的原文，不调用外部 API。 */
async function startPage(t, html, visibleOnly = true, initialScroll = 0) {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  t.after(() => page.close());
  await page.route("http://127.0.0.1/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body>${html}</body></html>`,
    }),
  );
  await page.goto("http://127.0.0.1/");
  await page.addScriptTag({ content: source });
  await page.evaluate(
    ({ visibleOnly, initialScroll }) => {
      globalThis.requests = [];
      globalThis.chrome = {
        runtime: {
          sendMessage(message) {
            if (message.type !== "TRANSLATE_BATCH")
              return Promise.resolve({ ok: true, data: null });
            requests.push(message);
            return Promise.resolve({
              ok: true,
              data: message.segments.map((item) => ({
                id: item.id,
                parts: item.parts.map((part) => `译文：${part}`),
              })),
            });
          },
        },
      };
      globalThis.engine = new engineModule.TranslationEngine(() => {});
      window.scrollTo(0, initialScroll);
      engine.start({
        signature: "visibility-test",
        targetLanguage: "zh-CN",
        mode: "bilingual",
        visibleOnly,
      });
    },
    { visibleOnly, initialScroll },
  );
  return page;
}

const sentTexts = (page) =>
  page.evaluate(() =>
    requests.flatMap((request) => request.segments.flatMap((segment) => segment.parts)),
  );
const contextParagraphs = Array.from(
  { length: 12 },
  (_, index) => `<p>Context paragraph ${index}.</p>`,
).join("");

test("可视区域默认关闭时仍翻译屏幕外已加载的段落", async (t) => {
  const page = await startPage(
    t,
    '<p>First visible paragraph.</p><div style="height:1500px"></div><p id="below">Below the viewport.</p>',
    false,
  );
  await expect(page.locator("#below [data-yeyi-owned=translation]")).toHaveCount(1);
  assert((await sentTexts(page)).includes("Below the viewport."));
});

test("可视区域模式推迟十句窗口外的内容，滚动后翻译并保留前面的译文", async (t) => {
  const page = await startPage(
    t,
    `<p id="first">First visible paragraph.</p><div style="height:1500px"></div>${contextParagraphs}<p id="below">Below the viewport.</p>`,
  );
  await expect(page.locator("#first [data-yeyi-owned=translation]")).toHaveCount(1);
  assert(!(await sentTexts(page)).includes("Below the viewport."));
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(page.locator("#below [data-yeyi-owned=translation]")).toHaveCount(1);
  await expect(page.locator("#first [data-yeyi-owned=translation]")).toHaveCount(1);
});

test("Discord 内部滚动容器裁剪的内容先不翻译，内部滚动事件触发新内容", async (t) => {
  const page = await startPage(
    t,
    `<div id="scroll" style="height:160px;overflow:auto"><p id="first">Top chat message.</p><div style="height:700px"></div>${contextParagraphs}<p id="last">New chat message.</p></div>`,
  );
  await expect(page.locator("#first [data-yeyi-owned=translation]")).toHaveCount(1);
  assert(!(await sentTexts(page)).includes("New chat message."));
  await page.evaluate(() => {
    const scroller = document.querySelector("#scroll");
    scroller.scrollTop = scroller.scrollHeight;
  });
  await expect(page.locator("#last [data-yeyi-owned=translation]")).toHaveCount(1);
  assert.equal(await page.evaluate(() => window.scrollY), 0);
});

test("隐藏、透明、裁剪、可编辑区域不发送，展开和新插入的内容会翻译", async (t) => {
  const page = await startPage(
    t,
    `<main><p id="visible">Visible source.</p><p hidden id="hidden">Hidden source.</p><p style="display:none">Display hidden.</p><p style="visibility:hidden">Visibility hidden.</p><p style="opacity:0">Transparent source.</p><p style="position:absolute;clip:rect(0,0,0,0)">Screen reader source.</p><div style="height:0;overflow:hidden"><p>Clipped source.</p></div><div contenteditable="true">Private input.</div></main>`,
  );
  await expect(page.locator("#visible [data-yeyi-owned=translation]")).toHaveCount(1);
  assert.deepEqual(await sentTexts(page), ["Visible source."]);
  await page.evaluate(() => {
    document.querySelector("#hidden").hidden = false;
    const paragraph = document.createElement("p");
    paragraph.id = "new";
    paragraph.textContent = "Newly inserted source.";
    document.querySelector("main").append(paragraph);
  });
  await expect(page.locator("#hidden [data-yeyi-owned=translation]")).toHaveCount(1);
  await expect(page.locator("#new [data-yeyi-owned=translation]")).toHaveCount(1);
});

test("调整窗口使新内容可见后自动翻译，暂停后不发送新请求", async (t) => {
  const page = await startPage(
    t,
    `<p>Top source.</p><div style="height:600px"></div>${contextParagraphs}<p id="resized">Source after resize.</p>`,
  );
  assert(!(await sentTexts(page)).includes("Source after resize."));
  await page.setViewportSize({ width: 900, height: 1600 });
  await expect(page.locator("#resized [data-yeyi-owned=translation]")).toHaveCount(1);
  const count = (await sentTexts(page)).length;
  await page.evaluate(() => {
    engine.stop();
    const paragraph = document.createElement("p");
    paragraph.textContent = "Paused new source.";
    document.body.prepend(paragraph);
    window.dispatchEvent(new Event("resize"));
  });
  await page.waitForTimeout(450);
  assert.equal((await sentTexts(page)).length, count);
});

test("Discord 作者、回复作者、成员名与昵称不进入请求，正文和普通网站同类名仍翻译", async (t) => {
  const page = await startPage(
    t,
    `<div id="app-mount"><ol data-list-id="chat-messages"><li id="chat-messages-1"><h3><span id="message-username-1"><span class="username_c19a55">Example Author</span></span></h3><div class="repliedMessage_c19a55"><span class="username_otherHash">Reply Author</span></div><div id="message-content-1"><span>Read the message body.</span></div></li></ol><aside><span class="displayName_newHash">Member Display Name</span><span class="nickname_newHash">Member Nickname</span></aside></div>`,
  );
  await expect(page.locator("#message-content-1 [data-yeyi-owned=translation]")).toHaveCount(1);
  assert.deepEqual(await sentTexts(page), ["Read the message body."]);
  await page.evaluate(() => {
    engine.restore();
    document.body.innerHTML = '<p class="username_c19a55">Ordinary article label.</p>';
    engine.start({
      signature: "visibility-test",
      targetLanguage: "zh-CN",
      mode: "replace",
      visibleOnly: true,
    });
  });
  await expect(page.locator("p")).toHaveText("译文：Ordinary article label.");
});

test("可视内容优先，上下各预翻译十句；向上滚动只新增更上面的十句", async (t) => {
  const html = `<style>body{margin:0}p{height:100px;margin:0}</style>${Array.from({ length: 50 }, (_, index) => `<p id="p${index}">Paragraph ${index}.</p>`).join("")}`;
  const page = await startPage(t, html, true, 2000);
  const indices = async () =>
    (await sentTexts(page))
      .map((text) => Number(text.match(/Paragraph (\d+)/)?.[1]))
      .sort((a, b) => a - b);
  await expect.poll(() => indices()).toEqual(Array.from({ length: 26 }, (_, index) => index + 10));
  const first = await page.evaluate(() =>
    requests[0].segments.map((segment) => segment.parts.join("")),
  );
  assert.deepEqual(
    first.slice(0, 6),
    Array.from({ length: 6 }, (_, index) => `Paragraph ${index + 20}.`),
  );
  const before = (await sentTexts(page)).length;
  await page.evaluate(() => window.scrollTo(0, 1000));
  await expect.poll(() => indices()).toEqual(Array.from({ length: 36 }, (_, index) => index));
  const added = (await sentTexts(page))
    .slice(before)
    .map((text) => Number(text.match(/Paragraph (\d+)/)[1]))
    .sort((a, b) => a - b);
  assert.deepEqual(
    added,
    Array.from({ length: 10 }, (_, index) => index),
  );
});

test("预翻译按句数扩展，多句段落不被当成一句重复扩大窗口", async (t) => {
  const html = `<style>body{margin:0}p{height:100px;margin:0}</style>${Array.from({ length: 40 }, (_, index) => `<p>First sentence ${index}. Second sentence ${index}.</p>`).join("")}`;
  const page = await startPage(t, html, true, 1500);
  await expect
    .poll(async () =>
      (await sentTexts(page))
        .map((text) => Number(text.match(/First sentence (\d+)/)?.[1]))
        .sort((a, b) => a - b),
    )
    .toEqual(Array.from({ length: 16 }, (_, index) => index + 10));
});

test("预翻译不跨入屏幕外的独立滚动列表，也不翻译永久裁剪的文字", async (t) => {
  const page = await startPage(
    t,
    `<p>Visible main source.</p><div style="height:0;overflow:hidden"><p>Permanently clipped source.</p></div><div style="height:1400px"></div><aside style="height:120px;overflow:auto">${contextParagraphs}</aside>`,
  );
  await expect(page.locator("p [data-yeyi-owned=translation]")).toHaveCount(1);
  assert.deepEqual(await sentTexts(page), ["Visible main source."]);
});

test("Discord 式外层禁止滚动的页面仍预翻译内部列表上下十句", async (t) => {
  const page = await startPage(
    t,
    `<style>body{margin:0;height:600px;overflow:hidden}p{height:100px;margin:0}</style><main style="height:200px;overflow:auto">${Array.from({ length: 30 }, (_, index) => `<p>Chat sentence ${index}.</p>`).join("")}</main>`,
  );
  await expect
    .poll(async () =>
      (await sentTexts(page))
        .map((text) => Number(text.match(/Chat sentence (\d+)/)?.[1]))
        .sort((a, b) => a - b),
    )
    .toEqual(Array.from({ length: 12 }, (_, index) => index));
});
