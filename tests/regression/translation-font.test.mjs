import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";
import { normalizeSettings, publicSettings } from "../../src/shared/settings.js";

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

/** 固定样式与合成译文，独立验证字体及站点 DOM 完整性，不使用真实 API 或账号。 */
async function article(
  t,
  config = {},
  html = '<p id="source" lang="ja" style="font-family: Georgia !important; font-size: 17px; font-weight: 500; line-height: 29px; color: rgb(44, 55, 66); letter-spacing: 1px">Source sentence.</p>',
) {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.route("http://127.0.0.1/", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html><body>${html}</body></html>`,
    }),
  );
  await page.goto("http://127.0.0.1/");
  await page.addScriptTag({ content: source });
  await page.evaluate((config) => {
    globalThis.requestCount = 0;
    globalThis.originalNode = document.querySelector("#source").firstChild;
    globalThis.originalParent = originalNode.parentNode;
    globalThis.chrome = {
      runtime: {
        sendMessage: async (message) => {
          if (message.type !== "TRANSLATE_BATCH") return { ok: true, data: null };
          requestCount++;
          return {
            ok: true,
            data: message.segments.map((segment) => ({
              id: segment.id,
              parts: segment.parts.map((text) =>
                text.includes("Second") ? "另一段中文译文。" : "中文译文，角色名字不会突然变黑。",
              ),
            })),
          };
        },
      },
    };
    globalThis.engine = new engineModule.TranslationEngine(() => {});
    engine.start({
      signature: "font-test",
      targetLanguage: "zh-CN",
      mode: "replace",
      cacheEnabled: false,
      ...config,
    });
  }, config);
  await expect.poll(() => page.evaluate(() => engine.getState().done)).toBeGreaterThan(0);
  return page;
}

const family = (page, selector = "#source") =>
  page.locator(selector).evaluate((element) => getComputedStyle(element).fontFamily);

test("旧设置默认关闭字体优化，启用不改变缓存签名、Key、字典摘要或其他偏好", () => {
  const old = normalizeSettings({
    visibleOnly: true,
    translationShortcut: "Ctrl+Y",
    providers: { deepseek: { apiKey: "test-only-font-secret" } },
  });
  assert.equal(old.optimizeChineseFont, false);
  const enabled = normalizeSettings({ ...old, optimizeChineseFont: true });
  assert.deepEqual(enabled, { ...old, optimizeChineseFont: true });
  assert.equal(publicSettings(enabled).optimizeChineseFont, true);
  assert.equal(publicSettings(enabled).signature, publicSettings(old).signature);
  assert.equal(normalizeSettings({ optimizeChineseFont: "true" }).optimizeChineseFont, false);
});

test("默认保持网页字体，开启仅改变字体族，字号字重行距颜色及文本节点保持不变", async (t) => {
  const page = await article(t);
  assert.equal(await family(page), "Georgia");
  const before = await page.locator("#source").evaluate((element) => {
    const style = getComputedStyle(element);
    return [
      style.fontSize,
      style.fontWeight,
      style.lineHeight,
      style.letterSpacing,
      style.color,
      style.display,
      element.childNodes.length,
    ];
  });
  await page.evaluate(() => engine.setFontOptimization(true));
  assert.match(await family(page), /Microsoft YaHei/);
  assert.deepEqual(
    await page.locator("#source").evaluate((element) => {
      const style = getComputedStyle(element);
      return [
        style.fontSize,
        style.fontWeight,
        style.lineHeight,
        style.letterSpacing,
        style.color,
        style.display,
        element.childNodes.length,
      ];
    }),
    before,
  );
  assert(
    await page.evaluate(
      () =>
        originalNode === document.querySelector("#source").firstChild &&
        originalNode.parentNode === originalParent,
    ),
  );
  await page.evaluate(() => engine.setFontOptimization(false));
  assert.equal(await family(page), "Georgia");
  assert.equal(
    await page
      .locator("#source")
      .evaluate((element) => element.style.getPropertyPriority("font-family")),
    "important",
  );
  assert.equal(await page.evaluate(() => requestCount), 1);
});

test("内联加粗与链接保持原节点和字重，恢复原文移除自有字体但保留网站原样式", async (t) => {
  const page = await article(
    t,
    { optimizeChineseFont: true },
    '<p id="source" style="font-size:18px"><span id="regular">Source sentence.</span><strong id="bold" style="font-weight:700">Second sentence.</strong><a id="link" href="#target" style="color:rgb(0,120,200)">Source link.</a><img id="emoji" alt="✨" width="16" height="16"><code id="code">const value = 1;</code></p>',
  );
  assert.equal(
    await page.locator("#bold").evaluate((element) => getComputedStyle(element).fontWeight),
    "700",
  );
  assert.equal(
    await page.locator("#regular").evaluate((element) => getComputedStyle(element).fontWeight),
    "400",
  );
  assert.equal(await page.locator("#link").getAttribute("href"), "#target");
  assert.equal(await page.locator("#emoji").count(), 1);
  assert.match(await family(page, "#code"), /monospace/);
  await page.evaluate(() => engine.restore());
  assert.equal(await page.locator("#regular").getAttribute("style"), null);
  assert.equal(await page.locator("#bold").evaluate((element) => element.style.fontFamily), "");
  assert.equal(await page.locator("#bold").evaluate((element) => element.style.fontWeight), "700");
  assert.equal(
    await page.locator("#link").evaluate((element) => element.style.color),
    "rgb(0, 120, 200)",
  );
  assert.equal(await page.locator("#regular").textContent(), "Source sentence.");
  assert.equal(
    await page.evaluate(() => engine.fontStyles.records.size + engine.fontStyles.elements.size),
    0,
  );
});

test("网站重绘译文并修改字体后，停用优化恢复网站的新字体，不以旧快照覆盖", async (t) => {
  const page = await article(t, { optimizeChineseFont: true });
  await page.evaluate(() => {
    document.querySelector("#source").style.fontFamily = "Courier New";
    originalNode.data = "Source sentence.";
  });
  await expect(page.locator("#source")).toHaveText("中文译文，角色名字不会突然变黑。");
  assert.match(await family(page), /Microsoft YaHei/);
  await page.evaluate(() => engine.setFontOptimization(false));
  assert.match(await family(page), /Courier New/);
  assert.equal(await page.evaluate(() => requestCount), 1);
  await page.evaluate(() => engine.restore());
  await expect(page.locator("#source")).toHaveText("Source sentence.");
});

test("同一容器内多个文本记录共享备份，图片节点不变且关闭后完整恢复字体", async (t) => {
  const page = await article(
    t,
    { optimizeChineseFont: true },
    '<p id="source" style="font-family:Georgia">Source sentence.<img id="picture" width="16" height="16">Second sentence.</p>',
  );
  assert.match(await family(page), /Microsoft YaHei/);
  assert.equal(await page.evaluate(() => engine.fontStyles.records.size), 2);
  await page.evaluate(() => engine.setFontOptimization(false));
  assert.equal(await family(page), "Georgia");
  assert.equal(await page.evaluate(() => engine.fontStyles.elements.size), 0);
  assert.equal(await page.locator("#picture").count(), 1);
  await page.evaluate(() => engine.restore());
  await expect(page.locator("#source")).toHaveText("Source sentence.Second sentence.");
});

test("暂停时可切换优化，双语与替换模式互切复用译文，原文容器字体可恢复", async (t) => {
  const page = await article(t);
  await page.evaluate(() => {
    engine.stop();
    engine.setFontOptimization(true);
  });
  assert.equal(await page.evaluate(() => engine.getState().phase), "paused");
  assert.match(await family(page), /Microsoft YaHei/);
  await page.evaluate(() => engine.setMode("bilingual"));
  assert.equal(await family(page), "Georgia");
  assert.match(await family(page, "[data-yeyi-owned=translation]"), /Microsoft YaHei/);
  await page.evaluate(() => engine.setFontOptimization(false));
  assert.equal(await family(page, "[data-yeyi-owned=translation]"), "Georgia");
  await page.evaluate(() => engine.setMode("replace"));
  assert.equal(await family(page), "Georgia");
  assert.equal(await page.evaluate(() => requestCount), 1);
});

test("繁体中文使用对应字体，非中文目标及原有中文不优化，图标私用字形保持原字体", async (t) => {
  const traditional = await article(t, { optimizeChineseFont: true, targetLanguage: "zh-TW" });
  assert.match(await family(traditional), /Microsoft JhengHei/);
  const english = await article(t, { optimizeChineseFont: true, targetLanguage: "en" });
  assert.equal(await family(english), "Georgia");
  const original = await article(
    t,
    { optimizeChineseFont: true },
    '<p id="source">原有中文不修改。</p>',
  );
  assert.equal(await original.locator("#source").getAttribute("style"), null);
  assert.equal(await original.evaluate(() => requestCount), 0);
  const icons = await article(
    t,
    { optimizeChineseFont: true },
    '<p id="source" style="font-family:Georgia">Source sentence.<span hidden>icon</span>\ue001</p>',
  );
  assert.equal(await family(icons), "Georgia");
});

test("嵌套私用图标不因祖先文字容器的字体优化而丢失原字体", async (t) => {
  const page = await article(
    t,
    { optimizeChineseFont: true },
    '<p id="source" style="font-family:Georgia">Source sentence.<span id="icon">\ue001</span></p>',
  );
  assert.equal(await family(page), "Georgia");
  assert.equal(await family(page, "#icon"), "Georgia");
  await page.evaluate(() => engine.restore());
  assert.equal(await page.locator("#icon").textContent(), "\ue001");
});

test("常用中文实际渲染为同一字体，开启优化后无新增字体下载", async (t) => {
  const page = await article(t, { optimizeChineseFont: true });
  const session = await page.context().newCDPSession(page);
  await session.send("DOM.enable");
  await session.send("CSS.enable");
  const { root } = await session.send("DOM.getDocument");
  const { nodeId } = await session.send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: "#source",
  });
  const { fonts } = await session.send("CSS.getPlatformFontsForNode", { nodeId });
  assert.equal(
    new Set(fonts.filter((font) => font.glyphCount > 0).map((font) => font.familyName)).size,
    1,
  );
  assert(fonts.every((font) => !font.isCustomFont));
  console.log(`中文实际渲染字体：${fonts.map((font) => font.familyName).join("、")}`);
  await session.detach();
});
