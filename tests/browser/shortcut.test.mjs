import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "./server.mjs";

const output = resolve("test-results");
const profile = resolve(output, `shortcut-profile-${Date.now()}`);
let fixture;
let context;
let worker;
let options;
let extensionId;
const errors = [];
const message = (data) => options.evaluate((data) => chrome.runtime.sendMessage(data), data);
const control = (page) => page.locator('[data-yeyi-owned="control"]');
const translation = (page) => page.locator("#source [data-yeyi-owned=translation]");

/** 每例只修改独立测试 profile，不读取或写入用户浏览器的数据。 */
async function settings(patch) {
  const current = await message({ type: "GET_SETTINGS" });
  const result = await message({ type: "SAVE_SETTINGS", settings: { ...current.data, ...patch } });
  assert.equal(result.ok, true);
  await options.reload();
  await expect(options.locator("#cacheUsage")).not.toHaveText("正在读取…");
}

/** 新建真实内容脚本页面，等待快捷键配置送达主文档。 */
async function article(t, body = '<p id="source">Shortcut source paragraph.</p>') {
  const page = await context.newPage();
  t.after(() => page.close());
  await page.route(`${fixture.url}/shortcuts/**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body>${body}</body></html>`,
    }),
  );
  await page.goto(`${fixture.url}/shortcuts/article`);
  await expect(page.locator(".translate-toggle")).toHaveAttribute("aria-keyshortcuts", "Control+X");
  return page;
}

/** 监听未被扩展消费的按键，明确验证输入框和停用场景没有被拦截。 */
async function recordKeys(page) {
  await page.evaluate(() => {
    window.shortcutKeys = [];
    document.addEventListener("keydown", (event) => {
      if (event.ctrlKey && event.code === "KeyX") window.shortcutKeys.push(event.defaultPrevented);
    });
  });
}

before(async () => {
  await mkdir(output, { recursive: true });
  fixture = await startServer();
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${resolve("dist")}`, `--load-extension=${resolve("dist")}`],
  });
  context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
  [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  extensionId = new URL(worker.url()).hostname;
  options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/pages/Options/index.html`);
  await expect(options.locator('[name="translationShortcut"]')).toHaveValue("Ctrl+X");
});

beforeEach(async () => {
  fixture.state.delayMs = 0;
  await settings({
    provider: "deepseek",
    providers: {
      deepseek: {
        apiKey: "fixture-secret-shortcuts",
        baseUrl: `${fixture.url}/deepseek`,
        model: "deepseek-flash",
      },
      openai: { apiKey: "", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
    },
    targetLanguage: "zh-CN",
    mode: "bilingual",
    showFloatingButton: true,
    translationShortcut: "Ctrl+X",
    visibleOnly: false,
    cacheEnabled: false,
    cacheLimitMb: 512,
    autoTranslateSites: [],
  });
});

after(async () => {
  await context?.close();
  await fixture?.close();
  if (dirname(profile) !== output || !basename(profile).startsWith("shortcut-profile-"))
    throw new Error("拒绝清理测试目录以外的路径");
  await rm(profile, { recursive: true, force: true });
  assert.deepEqual(errors, []);
});

test("默认 Ctrl+X 与悬浮球共用翻译、恢复和再次开启的状态", async (t) => {
  // 缓存可能先渲染，再收到后台确认；第二次开启时主动延迟确认，锁定此时序。
  await worker.evaluate(() => {
    const send = chrome.tabs.sendMessage.bind(chrome.tabs);
    let starts = 0;
    globalThis.restoreShortcutSend = () => {
      chrome.tabs.sendMessage = send;
    };
    chrome.tabs.sendMessage = async (...args) => {
      const result = await send(...args);
      if (args[1]?.type === "PAGE_COMMAND" && args[1]?.action === "start" && ++starts === 2)
        return new Promise((resolve) => {
          globalThis.confirmShortcutStart = () => resolve(result);
        });
      return result;
    };
  });
  t.after(() =>
    worker.evaluate(() => {
      globalThis.restoreShortcutSend();
      delete globalThis.restoreShortcutSend;
      delete globalThis.confirmShortcutStart;
    }),
  );
  await expect(options.getByRole("checkbox", { name: "隐藏悬浮球" })).not.toBeChecked();
  const page = await article(t);
  await expect(control(page)).toBeVisible();
  await page.keyboard.press("Control+x");
  await expect(translation(page)).toHaveCount(1);
  await expect(page.getByRole("button", { name: "恢复原文", exact: true })).toBeEnabled();
  await page.keyboard.press("Control+x");
  await expect(translation(page)).toHaveCount(0);
  await expect(control(page)).toBeVisible();
  await page.getByRole("button", { name: "翻译此页", exact: true }).click();
  await expect(translation(page)).toHaveCount(1);
  await expect
    .poll(() => worker.evaluate(() => typeof globalThis.confirmShortcutStart))
    .toBe("function");
  await expect(page.getByRole("button", { name: "恢复原文", exact: true })).toBeDisabled();
  await worker.evaluate(() => globalThis.confirmShortcutStart());
  await expect(page.getByRole("button", { name: "恢复原文", exact: true })).toBeEnabled();
  await page.keyboard.press("Control+x");
  await expect(page.locator("#source")).toHaveText("Shortcut source paragraph.");
});

test("自定义快捷键与隐藏设置保存后即时生效，刷新保留配置及原有数据", async (t) => {
  await settings({ cacheEnabled: true, autoTranslateSites: ["example.com"] });
  const page = await article(t);
  await page.keyboard.press("Control+x");
  await expect(translation(page)).toHaveCount(1);
  await expect.poll(async () => (await message({ type: "GET_CACHE_STATS" })).data.count).toBe(1);
  const cached = (await message({ type: "EXPORT_CACHE" })).data;
  const before = (await message({ type: "GET_SETTINGS" })).data;
  await options.locator('[name="translationShortcut"]').press("Control+Shift+y");
  await options.getByRole("checkbox", { name: "隐藏悬浮球" }).check();
  await options.locator("#saveButton").click();
  await expect(options.locator("#saveStatus")).toContainText("已保存");
  await expect(page.locator(".translate-toggle")).toHaveAttribute(
    "aria-keyshortcuts",
    "Control+Shift+Y",
  );
  await expect(control(page)).toBeVisible();
  const after = (await message({ type: "GET_SETTINGS" })).data;
  assert.deepEqual(after, {
    ...before,
    showFloatingButton: false,
    translationShortcut: "Ctrl+Shift+Y",
  });
  assert.deepEqual((await message({ type: "EXPORT_CACHE" })).data, cached);
  await recordKeys(page);
  await page.keyboard.press("Control+x");
  assert.deepEqual(await page.evaluate(() => window.shortcutKeys), [false]);
  await expect(translation(page)).toHaveCount(1);
  await page.keyboard.press("Control+Shift+y");
  await expect(translation(page)).toHaveCount(0);
  await expect(control(page)).toBeHidden();
  await page.keyboard.press("Control+Shift+y");
  await expect(translation(page)).toHaveCount(1);
  await expect(control(page)).toBeVisible();
  await page.getByRole("button", { name: "恢复原文", exact: true }).click();
  await expect(control(page)).toBeHidden();
  await page.reload();
  await expect(control(page)).toBeHidden();
  await options.reload();
  await expect(options.locator('[name="translationShortcut"]')).toHaveValue("Ctrl+Shift+Y");
  await expect(options.getByRole("checkbox", { name: "隐藏悬浮球" })).toBeChecked();
  await options
    .locator("#preferences")
    .screenshot({ path: resolve(output, "shortcut-settings.png") });
  await options.setViewportSize({ width: 390, height: 844 });
  await options
    .locator("#preferences")
    .screenshot({ path: resolve(output, "shortcut-settings-mobile.png") });
  assert.equal(
    await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  await options.setViewportSize({ width: 1280, height: 900 });
});

test("隐藏时快捷键可停止未完成的替换翻译，迟到响应不会覆盖原文", async (t) => {
  await settings({ showFloatingButton: false, mode: "replace" });
  const page = await article(t);
  await expect(control(page)).toBeHidden();
  fixture.state.delayMs = 1200;
  const before = fixture.requests.length;
  await page.keyboard.press("Control+x");
  await expect(control(page)).toBeVisible();
  await expect.poll(() => fixture.requests.length).toBe(before + 1);
  await expect(page.getByRole("button", { name: "恢复原文", exact: true })).toBeEnabled();
  await page.keyboard.press("Control+x");
  await expect(control(page)).toBeHidden();
  await expect(page.locator("#source")).toHaveText("Shortcut source paragraph.");
  fixture.state.delayMs = 0;
  await page.keyboard.press("Control+x");
  await expect(page.locator("#source")).toHaveText("译文：Shortcut source paragraph.");
  await page.keyboard.press("Control+x");
  await expect(page.locator("#source")).toHaveText("Shortcut source paragraph.");
  await expect(control(page)).toBeHidden();
});

test("输入框和富文本中的 Ctrl+X 保留剪切，长按及网页合成事件不启动翻译", async (t) => {
  const page = await article(
    t,
    '<p id="source">Shortcut source paragraph.</p><input id="input" value="Editable value"><textarea id="textarea">Editable value</textarea><div id="editor" contenteditable="true">Editable value</div><div id="shadow"></div>',
  );
  await page.evaluate(() => {
    document.querySelector("#shadow").attachShadow({ mode: "open" }).innerHTML =
      '<input id="shadowInput" value="Editable value">';
  });
  await recordKeys(page);
  for (const selector of ["#input", "#textarea", "#editor", "#shadowInput"]) {
    await page.locator(selector).click();
    await page.keyboard.press("Control+x");
  }
  assert.deepEqual(await page.evaluate(() => window.shortcutKeys), [false, false, false, false]);
  await expect(translation(page)).toHaveCount(0);
  await page.locator("#input").evaluate((input) => input.blur());
  await page.evaluate(() => {
    document.activeElement?.blur();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "x", code: "KeyX", ctrlKey: true, bubbles: true }),
    );
  });
  await expect(translation(page)).toHaveCount(0);
  await page.keyboard.down("Control");
  await page.keyboard.down("x");
  await expect(translation(page)).toHaveCount(1);
  await expect(page.getByRole("button", { name: "恢复原文", exact: true })).toBeEnabled();
  await page.keyboard.down("x");
  await page.keyboard.up("x");
  await page.keyboard.up("Control");
  await expect(translation(page)).toHaveCount(1);
});

test("子帧快捷键切换整页翻译，隐藏悬浮球随整页状态变化", async (t) => {
  await settings({ showFloatingButton: false });
  const page = await article(
    t,
    `<p id="source">Shortcut source paragraph.</p><iframe id="frame" src="${fixture.url}/frame"></iframe>`,
  );
  await expect(control(page)).toBeHidden();
  const frame = page.frameLocator("#frame");
  await frame.locator("#frameText").click();
  await page.keyboard.press("Control+x");
  await expect(translation(page)).toHaveCount(1);
  await expect(frame.locator("#frameText [data-yeyi-owned=translation]")).toHaveCount(1);
  await expect(control(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "恢复原文", exact: true })).toBeEnabled();
  await page.keyboard.press("Control+x");
  await expect(translation(page)).toHaveCount(0);
  await expect(frame.locator("#frameText [data-yeyi-owned=translation]")).toHaveCount(0);
  await expect(control(page)).toBeHidden();
});

test("快捷键可停用及恢复默认，隐藏状态下无 Key 时显示可操作的设置错误", async (t) => {
  const page = await article(t);
  await options.locator('[data-shortcut="clear"]').click();
  await options.locator("#saveButton").click();
  await expect(options.locator("#saveStatus")).toContainText("已保存");
  await expect(page.locator(".translate-toggle")).toHaveAttribute("aria-keyshortcuts", "");
  await recordKeys(page);
  await page.keyboard.press("Control+x");
  assert.deepEqual(await page.evaluate(() => window.shortcutKeys), [false]);
  await expect(translation(page)).toHaveCount(0);
  await options.locator('[data-shortcut="reset"]').click();
  await expect(options.locator('[name="translationShortcut"]')).toHaveValue("Ctrl+X");
  await options.getByRole("checkbox", { name: "隐藏悬浮球" }).check();
  await options.locator('[name="deepseekKey"]').fill("");
  await options.locator("#saveButton").click();
  await expect(options.locator("#saveStatus")).toContainText("已保存");
  await expect(control(page)).toBeHidden();
  await page.keyboard.press("Control+x");
  await expect(control(page)).toBeVisible();
  await expect(
    page.getByText("请先打开设置，填写当前服务的 API Key。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "完整设置 ↗", exact: true })).toBeVisible();
});
