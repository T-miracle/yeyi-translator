import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

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

/** 使用暂停的浏览器时钟精确驱动滚动、缓存预检与合批窗口，不依赖机器执行速度。 */
async function startPage(t, html, { cacheEnabled = false, visibleOnly = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  t.after(() => page.close());
  await page.clock.install({ time: new Date("2026-10-15T00:00:00Z") });
  await page.route("http://127.0.0.1/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body><main>${html}</main></body></html>`,
    }),
  );
  await page.goto("http://127.0.0.1/");
  await page.clock.pauseAt(new Date("2026-10-15T00:01:00Z"));
  await page.addScriptTag({ content: source });
  await page.evaluate(
    ({ cacheEnabled, visibleOnly }) => {
      globalThis.requests = [];
      globalThis.lookups = [];
      globalThis.chrome = {
        runtime: {
          sendMessage(message) {
            if (message.type === "LOOKUP_CACHE") {
              lookups.push(message);
              return Promise.resolve({
                ok: true,
                data: message.segments
                  .filter((segment) => segment.parts.every((part) => part.startsWith("Cached")))
                  .map((segment) => ({
                    id: segment.id,
                    parts: segment.parts.map((part) => `缓存：${part}`),
                  })),
              });
            }
            if (message.type === "TRANSLATE_BATCH")
              return new Promise((resolve) => requests.push({ message, resolve }));
            return Promise.resolve({ ok: true, data: null });
          },
        },
      };
      globalThis.config = {
        signature: "batching-test",
        targetLanguage: "zh-CN",
        mode: "bilingual",
        cacheEnabled,
        visibleOnly,
      };
      globalThis.engine = new engineModule.TranslationEngine(() => {});
      engine.start(config);
    },
    { cacheEnabled, visibleOnly },
  );
  return page;
}

const batches = (page) =>
  page.evaluate(() =>
    requests.map(({ message }) => message.segments.flatMap((segment) => segment.parts)),
  );

/** 模拟网站增量更新；可选直接扫描，覆盖多次扫描仍合并为一个请求的情况。 */
async function append(page, texts, scan = true) {
  await page.evaluate(
    ({ texts, scan }) => {
      for (const text of texts) {
        const paragraph = document.createElement("p");
        paragraph.textContent = text;
        document.querySelector("main").append(paragraph);
      }
      if (scan) {
        engine.scan();
        engine.pump();
      }
    },
    { texts, scan },
  );
}

test("连续多次入队先聚合，200 毫秒到期只发一个请求且不因新增内容延后", async (t) => {
  const page = await startPage(t, "<p>First source.</p>");
  assert.deepEqual(await batches(page), []);
  for (const text of ["Second source.", "Third source.", "Fourth source."]) {
    await page.clock.runFor(50);
    await append(page, [text]);
    assert.deepEqual(await batches(page), []);
  }
  await page.clock.runFor(49);
  assert.deepEqual(await batches(page), []);
  await page.clock.runFor(1);
  assert.deepEqual(await batches(page), [
    ["First source.", "Second source.", "Third source.", "Fourth source."],
  ]);
});

test("达到 18 个片段直接发出，尾批合并且始终只有一个网络批次", async (t) => {
  const page = await startPage(t, "<p>Source 0.</p>");
  await append(
    page,
    Array.from({ length: 17 }, (_, index) => `Source ${index + 1}.`),
  );
  assert.equal((await batches(page))[0].length, 18);
  await append(page, ["Tail first."]);
  await page.clock.runFor(300);
  assert.equal((await batches(page)).length, 1);
  await page.evaluate(() => {
    const request = requests[0];
    request.resolve({
      ok: true,
      data: request.message.segments.map((segment) => ({
        id: segment.id,
        parts: segment.parts.map((part) => `译文：${part}`),
      })),
    });
  });
  await page.clock.runFor(100);
  await append(page, ["Tail second."]);
  await page.clock.runFor(100);
  assert.deepEqual((await batches(page))[1], ["Tail first.", "Tail second."]);
});

test("字符预算先满时立即发送，不为凑够片段数突破 4800 字符", async (t) => {
  const long = "A readable foreign sentence. ".repeat(24).trim();
  const page = await startPage(
    t,
    Array.from({ length: 10 }, (_, index) => `<p>${index}: ${long}</p>`).join(""),
  );
  const sent = await batches(page);
  assert.equal(sent.length, 1);
  assert(sent[0].length < 18);
  assert(sent[0].reduce((sum, part) => sum + part.length, 0) <= 4800);
  assert(sent[0].reduce((sum, part) => sum + part.length, 0) + long.length > 4800);
});

test("发出前吸收尚未扫描的 DOM 更新，同时排除刚隐藏和移除的内容", async (t) => {
  const page = await startPage(
    t,
    '<p id="hidden">Hide this source.</p><p id="removed">Remove this source.</p><p>Keep source.</p>',
  );
  await page.clock.runFor(150);
  await page.evaluate(() => {
    document.querySelector("#hidden").hidden = true;
    document.querySelector("#removed").remove();
  });
  await append(page, ["New source before dispatch."], false);
  await page.clock.runFor(50);
  assert.deepEqual(await batches(page), [["Keep source.", "New source before dispatch."]]);
});

test("合批期间缓存仍立即显示，最终请求只含所有新增缺项", async (t) => {
  const page = await startPage(t, "<p>Missing first.</p><p>Cached first.</p>", {
    cacheEnabled: true,
  });
  assert.equal(await page.locator("[data-yeyi-owned=translation]").count(), 1);
  assert.deepEqual(await batches(page), []);
  await page.clock.runFor(150);
  await append(page, ["Cached second.", "Missing second."], false);
  await page.clock.runFor(50);
  assert.equal(await page.locator("[data-yeyi-owned=translation]").count(), 2);
  assert.deepEqual(await batches(page), [["Missing first.", "Missing second."]]);
});

test("暂停和恢复取消等待中的批次，新会话不受旧计时器影响", async (t) => {
  const page = await startPage(t, "<p>Source before restart.</p>");
  await page.clock.runFor(100);
  await page.evaluate(() => engine.restore());
  await page.clock.runFor(500);
  assert.deepEqual(await batches(page), []);
  assert.equal(await page.locator("[data-yeyi-owned=translation]").count(), 0);
  await page.evaluate(() => engine.start(config));
  await page.clock.runFor(199);
  assert.deepEqual(await batches(page), []);
  await page.clock.runFor(1);
  assert.deepEqual(await batches(page), [["Source before restart."]]);
});

test("可视合批等待期间滚动，以最新视口和上下十句重新选择待译内容", async (t) => {
  const page = await startPage(
    t,
    `<style>body,p{margin:0}p{height:100px}</style>${Array.from({ length: 45 }, (_, index) => `<p>Viewport source ${index}.</p>`).join("")}`,
    { visibleOnly: true },
  );
  assert.deepEqual(await batches(page), []);
  await page.clock.runFor(150);
  await page.evaluate(() => window.scrollTo(0, 2500));
  await page.clock.runFor(50);
  const sent = (await batches(page))[0];
  assert.equal(sent[0], "Viewport source 25.");
  assert(!sent.includes("Viewport source 0."));
});

test("窗口到期的缓存预检尚未完成时重启，旧回调不覆盖新批次计时器", async (t) => {
  const page = await startPage(t, "<p>Missing first.</p>", { cacheEnabled: true });
  await page.clock.runFor(100);
  await page.evaluate(() => {
    const send = chrome.runtime.sendMessage;
    globalThis.deferred = [];
    chrome.runtime.sendMessage = (message) =>
      message.type === "LOOKUP_CACHE"
        ? new Promise((resolve) => deferred.push(resolve))
        : send(message);
  });
  await append(page, ["Missing second."], false);
  await page.clock.runFor(100);
  assert.deepEqual(await batches(page), []);
  assert.equal(await page.evaluate(() => deferred.length), 1);
  await page.evaluate(() => {
    engine.restore();
    engine.start(config);
    deferred[0]({ ok: true, data: [] });
  });
  assert.deepEqual(await batches(page), []);
  await page.evaluate(() => deferred[1]({ ok: true, data: [] }));
  await page.clock.runFor(199);
  assert.deepEqual(await batches(page), []);
  await page.clock.runFor(1);
  assert.deepEqual(await batches(page), [["Missing first.", "Missing second."]]);
});

test("等待期间所有内容被隐藏时取消发送，重新显示后仍可正常合批", async (t) => {
  const page = await startPage(t, '<p id="source">Hide and show source.</p>');
  await page.clock.runFor(100);
  await page.evaluate(() => {
    document.querySelector("#source").hidden = true;
  });
  await page.clock.runFor(100);
  assert.deepEqual(await batches(page), []);
  assert.equal(await page.evaluate(() => engine.getState().phase), "watching");
  await page.evaluate(() => {
    document.querySelector("#source").hidden = false;
  });
  await page.clock.runFor(600);
  assert.deepEqual(await batches(page), [["Hide and show source."]]);
});

test("前一批结束后立即重查满批，隐藏和移除的段落不再发送", async (t) => {
  const page = await startPage(
    t,
    Array.from({ length: 54 }, (_, i) => `<p>Source ${i}.</p>`).join(""),
  );
  await page.evaluate(() => {
    [...document.querySelectorAll("main p")].forEach((paragraph, i) => {
      if (i >= 18 && i < 36) paragraph.hidden = true;
      if (i >= 36) paragraph.remove();
    });
    const { message, resolve } = requests[0];
    resolve({
      ok: true,
      data: message.segments.map(({ id, parts }) => ({
        id,
        parts: parts.map((part) => `译文：${part}`),
      })),
    });
  });
  await page.clock.runFor(1);
  assert.equal((await batches(page)).length, 1);
  await page.clock.runFor(1000);
  assert.equal((await batches(page)).length, 1);
});

test("前一批等待时滚动，下一满批使用最新视口而不发送旧窗口", async (t) => {
  const page = await startPage(
    t,
    `<style>body,p{margin:0}p{height:20px}</style>${Array.from({ length: 80 }, (_, i) => `<p>Viewport source ${i}.</p>`).join("")}`,
    { visibleOnly: true },
  );
  await page.evaluate(() => {
    engine.setMode("replace");
    window.scrollTo(0, document.body.scrollHeight);
    const { message, resolve } = requests[0];
    resolve({
      ok: true,
      data: message.segments.map(({ id, parts }) => ({
        id,
        parts: parts.map((part) => `译文：${part}`),
      })),
    });
  });
  await page.clock.runFor(1);
  const sent = await batches(page);
  assert.equal(sent.length, 2);
  assert.equal(sent[1][0], "Viewport source 50.");
  assert(sent[1].every((part) => Number(part.match(/\d+/)[0]) >= 40));
});

test("下一满批等待新增缓存预检，命中即时显示且不抢占请求", async (t) => {
  const page = await startPage(
    t,
    Array.from({ length: 36 }, (_, i) => `<p>Source ${i}.</p>`).join(""),
    { cacheEnabled: true },
  );
  await page.evaluate(() => {
    const send = chrome.runtime.sendMessage;
    globalThis.pendingLookup = null;
    chrome.runtime.sendMessage = (message) =>
      message.type === "LOOKUP_CACHE"
        ? new Promise((resolve) => {
            globalThis.pendingLookup = { message, resolve };
          })
        : send(message);
    const p = document.createElement("p");
    p.id = "cached-new";
    p.textContent = "Cached new source.";
    document.querySelector("main").prepend(p);
    const { message, resolve } = requests[0];
    resolve({
      ok: true,
      data: message.segments.map(({ id, parts }) => ({
        id,
        parts: parts.map((part) => `译文：${part}`),
      })),
    });
  });
  await page.clock.runFor(1);
  assert.equal((await batches(page)).length, 1);
  await page.evaluate(() => {
    const { message, resolve } = pendingLookup;
    resolve({
      ok: true,
      data: message.segments.map(({ id, parts }) => ({
        id,
        parts: parts.map((part) => `缓存：${part}`),
      })),
    });
  });
  await page.clock.runFor(1);
  assert.equal(await page.locator("#cached-new [data-yeyi-owned=translation]").count(), 1);
  const sent = await batches(page);
  assert.equal(sent.length, 2);
  assert(!sent[1].includes("Cached new source."));
});
