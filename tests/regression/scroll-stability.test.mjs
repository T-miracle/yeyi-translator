import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

let browser;
let source;
before(async () => {
  source = (
    await build({
      entryPoints: ["src/content/engine.js"],
      bundle: true,
      write: false,
      format: "iife",
      globalName: "engineModule",
    })
  ).outputFiles[0].text;
  browser = await chromium.launch({ channel: "chromium", headless: true });
});
after(() => browser?.close());

/** 合成 Discord 式列表：关闭原生锚定，按距底部的距离响应消息高度变化。 */
async function chat(t, mode, { managed = true, bottom = false, fonts = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  t.after(() => page.close());
  await page.route("http://127.0.0.1/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><style>body{margin:0;overflow:hidden}#scroll{height:320px;width:400px;overflow:auto;overflow-anchor:none;position:relative}ol{margin:0;padding:0;list-style:none}li{padding:8px;font:16px/24px Arial}p{margin:0}</style><div id="app-mount"><div id="scroll"><ol data-list-id="chat-messages">${Array.from({ length: 45 }, (_, i) => `<li id="chat-messages-${i}"><p id="message-content-${i}">Cached source ${i}. This message keeps several lines of original text to measure reflow above the reading position.</p></li>`).join("")}</ol></div></div>`,
    }),
  );
  await page.goto("http://127.0.0.1/");
  await page.addScriptTag({ content: source });
  await page.evaluate(
    ({ mode, managed, bottom, fonts }) => {
      const scroller = document.querySelector("#scroll");
      const list = document.querySelector("ol");
      scroller.scrollTop = bottom
        ? scroller.scrollHeight
        : document.querySelector("#chat-messages-22").offsetTop;
      if (managed) {
        let height = list.offsetHeight;
        let distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        scroller.addEventListener("scroll", () => {
          distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        });
        globalThis.siteObserver = new ResizeObserver(() => {
          if (height === list.offsetHeight) return;
          height = list.offsetHeight;
          scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight - distance;
        });
        siteObserver.observe(list);
      }
      globalThis.lookups = [];
      globalThis.requests = [];
      globalThis.releaseCache = false;
      globalThis.chrome = {
        runtime: {
          sendMessage(message) {
            if (message.type === "LOOKUP_CACHE") {
              const data = message.segments.map((segment) => ({
                id: segment.id,
                parts: segment.parts.map((text) => `缓存译文${text.match(/source (\d+)/)[1]}。`),
              }));
              if (releaseCache) return Promise.resolve({ ok: true, data });
              return new Promise((resolve) => lookups.push({ resolve, data }));
            }
            if (message.type === "TRANSLATE_BATCH") requests.push(message);
            return Promise.resolve({ ok: true, data: [] });
          },
        },
      };
      globalThis.engine = new engineModule.TranslationEngine(() => {});
      engine.start({
        signature: "scroll-stability",
        targetLanguage: "zh-CN",
        mode,
        cacheEnabled: true,
        visibleOnly: true,
        optimizeChineseFont: fonts,
      });
    },
    { mode, managed, bottom, fonts },
  );
  await expect.poll(() => page.evaluate(() => lookups.length)).toBeGreaterThan(0);
  return page;
}

/** 缓存返回前模拟用户上滚，译文必须以这个最新阅读位置为准。 */
async function scrollUp(page) {
  return page.evaluate(() => {
    const scroller = document.querySelector("#scroll");
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
    scroller.scrollTop -= 120;
    const rect = scroller.getBoundingClientRect();
    const anchor = [...document.querySelectorAll("ol > li")].find(
      (element) => element.getBoundingClientRect().bottom > rect.top,
    );
    return { id: anchor.id, top: anchor.getBoundingClientRect().top };
  });
}

async function release(page, selector = "#message-content-22") {
  await page.evaluate(() => {
    releaseCache = true;
    for (const lookup of lookups) lookup.resolve({ ok: true, data: lookup.data });
  });
  await expect(page.locator(selector)).toContainText("缓存译文");
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }),
  );
}

test("缓存显示后继续上滚时，以新的阅读位置为准，不被延迟补偿拉回", async (t) => {
  const page = await chat(t, "replace", { managed: false });
  await scrollUp(page);
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      if (!document.querySelector("#message-content-22").textContent.includes("缓存译文")) return;
      observer.disconnect();
      const scroller = document.querySelector("#scroll");
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
      scroller.scrollTop -= 120;
      const anchor = [...document.querySelectorAll("ol > li")].find(
        (element) => element.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top,
      );
      globalThis.userAnchor = { id: anchor.id, top: anchor.getBoundingClientRect().top };
    });
    observer.observe(document.querySelector("ol"), { subtree: true, characterData: true });
  });
  await release(page);
  const shift = await page.evaluate(
    () => document.getElementById(userAnchor.id).getBoundingClientRect().top - userAnchor.top,
  );
  assert(Math.abs(shift) <= 1, `用户继续上滚后被拉回 ${shift}px`);
});

test("停止会话后不再执行旧批次的滚动补偿", async (t) => {
  const page = await chat(t, "replace", { managed: false });
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      if (!document.querySelector("#message-content-22").textContent.includes("缓存译文")) return;
      observer.disconnect();
      engine.stop();
      const scroller = document.querySelector("#scroll");
      scroller.scrollTop -= 120;
      globalThis.stoppedTop = scroller.scrollTop;
    });
    observer.observe(document.querySelector("ol"), { subtree: true, characterData: true });
  });
  await release(page);
  assert.equal(
    await page.locator("#scroll").evaluate((element) => element.scrollTop),
    await page.evaluate(() => stoppedTop),
  );
});

test("停在聊天底部时保留站点自动跟随，不锁定旧消息位置", async (t) => {
  const page = await chat(t, "bilingual", { bottom: true });
  await release(page, "#message-content-44");
  const remaining = await page
    .locator("#scroll")
    .evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);
  assert(remaining <= 1, `离开底部 ${remaining}px`);
  assert.equal(await page.locator("#scroll").getAttribute("style"), null);
});

test("浏览器原生滚动锚定开启时不会重复补偿", async (t) => {
  const page = await chat(t, "bilingual", { managed: false });
  await page.locator("#scroll").evaluate((element) => {
    element.style.overflowAnchor = "auto";
  });
  const anchor = await scrollUp(page);
  await release(page);
  const top = await page
    .locator(`#${anchor.id}`)
    .evaluate((element) => element.getBoundingClientRect().top);
  assert(Math.abs(top - anchor.top) <= 1, `原生锚定叠加偏移 ${top - anchor.top}px`);
  await expect(page.locator("#scroll")).toHaveCSS("overflow-anchor", "auto");
});

test("消息总高度稳定后的连续滚动帧不被旧补偿抵消", async (t) => {
  const page = await chat(t, "replace", { managed: false });
  await page.evaluate(() => {
    globalThis.inertia = new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (!document.querySelector("#message-content-22").textContent.includes("缓存译文")) return;
        observer.disconnect();
        const scroller = document.querySelector("#scroll");
        const anchor = document.querySelector("#chat-messages-22");
        requestAnimationFrame(() => {
          const start = anchor.getBoundingClientRect().top;
          const heights = [scroller.scrollHeight];
          scroller.scrollTop -= 18;
          requestAnimationFrame(() => {
            heights.push(scroller.scrollHeight);
            scroller.scrollTop -= 12;
            requestAnimationFrame(() => {
              heights.push(scroller.scrollHeight);
              resolve({ movement: anchor.getBoundingClientRect().top - start, heights });
            });
          });
        });
      });
      observer.observe(document.querySelector("ol"), { subtree: true, characterData: true });
    });
  });
  await release(page);
  const trace = await page.evaluate(() => inertia);
  assert.equal(new Set(trace.heights).size, 1, "连续滚动期间消息总高度必须保持不变");
  assert(Math.abs(trace.movement - 30) <= 1, `连续上滚 30px 后实际移动 ${trace.movement}px`);
});

for (const mode of ["replace", "bilingual"]) {
  test(`缓存返回不能中断浏览器仍在进行的平滑上滚（${mode}，开启字体优化）`, async (t) => {
    const page = await chat(t, mode, { managed: false, fonts: true });
    const trace = await page.evaluate(async () => {
      const scroller = document.querySelector("#scroll");
      // 先等初始定位事件结束，再让浏览器自己产生连续滚动帧，不用脚本逐帧赋 scrollTop。
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const target = scroller.scrollTop - 500;
      const start = scroller.scrollTop;
      let released = false;
      let moving = true;
      let writesDuringScroll = 0;
      const observer = new MutationObserver((records) => {
        if (moving)
          writesDuringScroll += records.filter((record) => record.type === "characterData").length;
      });
      observer.observe(document.querySelector("ol"), { subtree: true, characterData: true });
      const end = new Promise((resolve) =>
        scroller.addEventListener(
          "scrollend",
          () => {
            moving = false;
            resolve(scroller.scrollTop);
          },
          { once: true },
        ),
      );
      scroller.addEventListener("scroll", () => {
        if (released || start - scroller.scrollTop < 30) return;
        released = true;
        releaseCache = true;
        for (const lookup of lookups) lookup.resolve({ ok: true, data: lookup.data });
      });
      scroller.scrollTo({ top: target, behavior: "smooth" });
      const endTop = await end;
      observer.disconnect();
      return { target, endTop, released, writesDuringScroll };
    });
    assert.equal(trace.released, true, "缓存必须在平滑滚动途中返回");
    assert(
      Math.abs(trace.endTop - trace.target) <= 1,
      `预期滚到 ${trace.target}px，实际被打断在 ${trace.endTop}px`,
    );
    assert.equal(trace.writesDuringScroll, 0, "滚动未结束时不应改动聊天排版");
    await expect(page.locator("#message-content-22")).toContainText("缓存译文");
  });
}

test("滚动中站点回收或改写消息，停稳后只显示当前节点对应的缓存", async (t) => {
  const page = await chat(t, "replace");
  await scrollUp(page);
  await page.evaluate(async () => {
    releaseCache = true;
    for (const lookup of lookups) lookup.resolve({ ok: true, data: lookup.data });
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.beforeSettled = document.querySelector("#message-content-22").textContent;
    document.querySelector("#chat-messages-21").remove();
    document.querySelector("#message-content-22").firstChild.data = "Cached source 122.";
    engine.scan();
  });
  assert((await page.evaluate(() => beforeSettled)).startsWith("Cached source 22."));
  await expect(page.locator("#message-content-22")).toHaveText("缓存译文122。");
  assert.equal(await page.locator("#chat-messages-21").count(), 0);
  assert.equal(await page.evaluate(() => requests.length), 0);
});

test("滚动中恢复原文会丢弃等候显示的译文，停稳后不会重新写回", async (t) => {
  const page = await chat(t, "replace");
  await scrollUp(page);
  await page.evaluate(async () => {
    releaseCache = true;
    for (const lookup of lookups) lookup.resolve({ ok: true, data: lookup.data });
    await new Promise((resolve) => setTimeout(resolve, 20));
    engine.restore();
  });
  await page.waitForTimeout(250);
  assert((await page.locator("#message-content-22").textContent()).startsWith("Cached source 22."));
  assert.equal(await page.evaluate(() => engine.getState().total), 0);
});

for (const mode of ["replace", "bilingual"]) {
  test(`缓存命中改变消息高度后保持上滚后的阅读位置（${mode}）`, async (t) => {
    const page = await chat(t, mode);
    const anchor = await scrollUp(page);
    await release(page);
    const top = await page
      .locator(`#${anchor.id}`)
      .evaluate((element) => element.getBoundingClientRect().top);
    assert(Math.abs(top - anchor.top) <= 1, `阅读位置偏移 ${top - anchor.top}px`);
    assert.equal(await page.evaluate(() => requests.length), 0);
  });
}
