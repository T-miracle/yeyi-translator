import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "./server.mjs";
import { cacheKey, CACHE_PREFIX } from "../../src/background/cache.js";

const output = resolve("test-results");
const profile = resolve(output, `feature-profile-${Date.now()}`);
let fixture;
let context;
let worker;
let options;
let extensionId;
const errors = [];

/** 真实加载扩展，允许复用本测试自己的 profile 验证重启后的缓存。 */
async function launch() {
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
  await expect(options.locator('[name="deepseekModel"]')).toHaveValue("deepseek-flash");
}

const message = (data) => options.evaluate((data) => chrome.runtime.sendMessage(data), data);

/** 只通过可信的设置页发送设置消息。 */
async function settings(patch) {
  const current = await message({ type: "GET_SETTINGS" });
  const result = await message({ type: "SAVE_SETTINGS", settings: { ...current.data, ...patch } });
  assert.equal(result.ok, true);
  await options.reload();
  await expect(options.locator("#cacheUsage")).not.toHaveText("正在读取…");
}

/** 本机测试页面，不使用任何真实 Key 或 Discord 私人聊天内容。 */
async function article(t, body = '<p id="source">Reusable source paragraph.</p>') {
  const page = await context.newPage();
  t.after(async () => {
    if (!page.isClosed()) await page.close();
  });
  await page.route(`${fixture.url}/features/**`, (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html><body>${body}</body></html>`,
    }),
  );
  await page.goto(`${fixture.url}/features/article`);
  await expect(page.getByRole("button", { name: "翻译此页", exact: true })).toBeVisible();
  return page;
}

async function translate(page, selector = "#source") {
  await page.getByRole("button", { name: "翻译此页", exact: true }).click();
  await expect(page.locator(`${selector} [data-yeyi-owned=translation]`)).toHaveCount(1);
}

const upload = (data) =>
  options.locator("#cacheFile").setInputFiles({
    name: "cache.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(data)),
  });

test("推理级别在服务卡片内分别选择，连接测试和保存请求共用当前档位", async () => {
  const deepseek = options.getByRole("combobox", { name: "DeepSeek 推理级别", exact: true });
  const openai = options.getByRole("combobox", { name: "OpenAI 推理级别", exact: true });
  assert.deepEqual(
    await deepseek.locator("option").evaluateAll((items) => items.map((item) => item.value)),
    ["default", "low", "high", "max"],
  );
  await expect(deepseek).toHaveValue("default");
  await expect(openai).toHaveValue("default");
  const before = (await message({ type: "GET_SETTINGS" })).data;
  await options
    .getByRole("combobox", { name: "DeepSeek 思考模式", exact: true })
    .selectOption("enabled");
  await deepseek.selectOption("max");
  await openai.selectOption("medium");
  await options.locator('[data-test="deepseek"]').click();
  await expect(options.locator('[data-result="deepseek"]')).toContainText("连接成功");
  assert.equal(fixture.requests.at(-1).body.reasoning_effort, "max");
  await options.locator("#saveButton").click();
  await expect(options.locator("#saveStatus")).toContainText("已保存");
  const expected = structuredClone(before);
  expected.providers.deepseek.reasoningEffort = "max";
  expected.providers.deepseek.thinkingMode = "enabled";
  expected.providers.openai.reasoningEffort = "medium";
  assert.deepEqual((await message({ type: "GET_SETTINGS" })).data, expected);
  await options.reload();
  await expect(deepseek).toHaveValue("max");
  await expect(
    options.getByRole("combobox", { name: "DeepSeek 思考模式", exact: true }),
  ).toHaveValue("enabled");
  await expect(openai).toHaveValue("medium");
  await options
    .locator('[data-provider="deepseek"]')
    .screenshot({ path: resolve(output, "reasoning-settings.png") });
  await options.setViewportSize({ width: 390, height: 844 });
  await options
    .locator('[data-provider="deepseek"]')
    .screenshot({ path: resolve(output, "reasoning-settings-mobile.png") });
  assert.equal(
    await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
  );
  await options.setViewportSize({ width: 1280, height: 900 });
});

test("推理级别保存后重启正在翻译的页面，缓存分档保留且切回原档位可复用", async (t) => {
  await settings({ cacheEnabled: true });
  const page = await article(t);
  const before = fixture.requests.length;
  await translate(page);
  await expect.poll(async () => (await message({ type: "GET_CACHE_STATS" })).data.count).toBe(1);
  const original = (await message({ type: "EXPORT_CACHE" })).data.entries[0];
  const chooseEffort = async (effort, mode = "enabled") => {
    await options
      .getByRole("combobox", { name: "DeepSeek 思考模式", exact: true })
      .selectOption(mode);
    await options
      .getByRole("combobox", { name: "DeepSeek 推理级别", exact: true })
      .selectOption(effort);
    await options.locator("#saveButton").click();
    await expect(options.locator("#saveStatus")).toContainText("已保存");
  };
  await chooseEffort("low");
  await expect.poll(() => fixture.requests.length).toBe(before + 2);
  assert.equal(fixture.requests.at(-1).body.reasoning_effort, "low");
  await expect.poll(async () => (await message({ type: "GET_CACHE_STATS" })).data.count).toBe(2);
  const stored = (await message({ type: "EXPORT_CACHE" })).data;
  assert(
    stored.entries.some(
      (entry) =>
        entry.key === original.key &&
        JSON.stringify(entry.parts) === JSON.stringify(original.parts),
    ),
  );
  await chooseEffort("default", "default");
  await expect(page.locator("#source [data-yeyi-owned=translation]")).toHaveCount(1);
  await expect
    .poll(async () => {
      const tabs = await worker.evaluate(() => chrome.tabs.query({}));
      const tab = tabs.find((tab) => tab.url === page.url());
      return worker.evaluate(
        (tabId) => chrome.tabs.sendMessage(tabId, { type: "GET_STATE" }, { frameId: 0 }),
        tab.id,
      );
    })
    .toMatchObject({ active: true, done: 1, phase: "watching" });
  assert.equal(fixture.requests.length, before + 2);
  assert.deepEqual((await message({ type: "EXPORT_CACHE" })).data, stored);
});

test("关闭思考时调高推理级别不启动思考、不重译或覆盖缓存，重新开启后才按预选级别请求", async (t) => {
  const mode = options.getByRole("combobox", { name: "DeepSeek 思考模式", exact: true });
  const effort = options.getByRole("combobox", { name: "DeepSeek 推理级别", exact: true });
  await mode.selectOption("disabled");
  await effort.selectOption("low");
  await options.locator('[name="cacheEnabled"]').check();
  await options.locator("#saveButton").click();
  await expect(options.locator("#saveStatus")).toContainText("已保存");
  const page = await article(t);
  const before = fixture.requests.length;
  await translate(page);
  assert.equal(fixture.requests.at(-1).body.reasoning_effort, "none");
  await expect.poll(async () => (await message({ type: "GET_CACHE_STATS" })).data.count).toBe(1);
  const original = (await message({ type: "EXPORT_CACHE" })).data;
  await effort.selectOption("max");
  await expect(mode).toHaveValue("disabled");
  await options.locator("#saveButton").click();
  await expect(options.locator("#saveStatus")).toContainText("已保存");
  await expect(page.locator("#source [data-yeyi-owned=translation]")).toHaveCount(1);
  assert.equal(fixture.requests.length, before + 1);
  assert.deepEqual((await message({ type: "EXPORT_CACHE" })).data, original);
  await options.reload();
  await expect(mode).toHaveValue("disabled");
  await expect(effort).toHaveValue("max");
  await options.locator('[data-test="deepseek"]').click();
  await expect(options.locator('[data-result="deepseek"]')).toContainText("连接成功");
  assert.equal(fixture.requests.at(-1).body.reasoning_effort, "none");
  await mode.selectOption("enabled");
  await options.locator("#saveButton").click();
  await expect(options.locator("#saveStatus")).toContainText("已保存");
  await expect.poll(() => fixture.requests.length).toBe(before + 3);
  assert.equal(fixture.requests.at(-1).body.reasoning_effort, "max");
  await expect.poll(async () => (await message({ type: "GET_CACHE_STATS" })).data.count).toBe(2);
  await mode.selectOption("disabled");
  await options.locator("#saveButton").click();
  await expect(options.locator("#saveStatus")).toContainText("已保存");
  await expect
    .poll(async () => {
      const tabs = await worker.evaluate(() => chrome.tabs.query({}));
      const tab = tabs.find((tab) => tab.url === page.url());
      return worker.evaluate(
        (tabId) => chrome.tabs.sendMessage(tabId, { type: "GET_STATE" }, { frameId: 0 }),
        tab.id,
      );
    })
    .toMatchObject({ active: true, done: 1, phase: "watching" });
  assert.equal(fixture.requests.length, before + 3);
});

test("推理级别非法配置不能覆盖本机设置，OpenAI 选项完整且保存后仍可测试", async () => {
  const before = (await message({ type: "GET_SETTINGS" })).data;
  const invalid = structuredClone(before);
  invalid.providers.deepseek.reasoningEffort = "bad-level";
  const result = await message({ type: "SAVE_SETTINGS", settings: invalid });
  assert.equal(result.ok, false);
  assert.deepEqual((await message({ type: "GET_SETTINGS" })).data, before);
  const openai = options.getByRole("combobox", { name: "OpenAI 推理级别", exact: true });
  assert.deepEqual(
    await openai.locator("option").evaluateAll((items) => items.map((item) => item.value)),
    ["default", "none", "minimal", "low", "medium", "high", "xhigh", "max"],
  );
  await options.locator('[name="openaiUrl"]').fill(`${fixture.url}/v1`);
  await options.locator('[name="openaiModel"]').fill("o3");
  await options.locator('[name="openaiKey"]').fill("fixture-secret-reasoning-openai");
  await openai.selectOption("low");
  await options.locator('[data-test="openai"]').click();
  await expect(options.locator('[data-result="openai"]')).toContainText("连接成功");
  assert.equal(fixture.requests.at(-1).body.reasoning_effort, "low");
  assert.equal(fixture.requests.at(-1).body.thinking, undefined);
});

before(async () => {
  await mkdir(output, { recursive: true });
  fixture = await startServer();
  await launch();
});

beforeEach(async () => {
  await settings({
    visibleOnly: false,
    optimizeChineseFont: false,
    cacheEnabled: false,
    cacheLimitMb: 512,
    autoTranslateSites: [],
    provider: "deepseek",
    targetLanguage: "zh-CN",
    mode: "bilingual",
    providers: {
      deepseek: {
        apiKey: "fixture-secret-features",
        baseUrl: `${fixture.url}/deepseek`,
        model: "deepseek-flash",
      },
      openai: { apiKey: "", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
    },
  });
  await message({ type: "CLEAR_CACHE" });
});

after(async () => {
  await context?.close();
  await fixture?.close();
  if (dirname(profile) !== output || !basename(profile).startsWith("feature-profile-"))
    throw new Error("拒绝清理测试目录以外的路径");
  await rm(profile, { recursive: true, force: true });
  assert.deepEqual(errors, []);
});

test("设置新增开关默认关闭，容量可编辑，保存后保持并显示实际大小", async () => {
  await expect(options.locator('[name="visibleOnly"]')).not.toBeChecked();
  await expect(options.locator('[name="cacheEnabled"]')).not.toBeChecked();
  await expect(options.locator('[name="cacheLimitMb"]')).toHaveValue("512");
  await options.locator('[name="visibleOnly"]').check();
  await options.locator('[name="cacheEnabled"]').check();
  await options.locator('[name="cacheLimitMb"]').fill("128");
  await options.locator("#saveButton").click();
  await expect(options.locator("#saveStatus")).toContainText("已保存");
  await options.reload();
  await expect(options.locator('[name="visibleOnly"]')).toBeChecked();
  await expect(options.locator('[name="cacheEnabled"]')).toBeChecked();
  await expect(options.locator('[name="cacheLimitMb"]')).toHaveValue("128");
  await expect(options.locator("#cacheUsage")).toHaveText("0 B · 0 条");
  await options.screenshot({ path: resolve(output, "options-cache.png"), fullPage: true });
});

test("Discord 内部滚动预翻译，开关只保留在完整设置且保存后即时生效", async (t) => {
  await settings({ visibleOnly: true });
  const page = await article(
    t,
    `<div id="app-mount"><ol data-list-id="chat-messages" style="height:160px;overflow:auto"><li id="chat-messages-1"><h3 id="message-username-1"><span class="username_newHash">Example Author</span></h3><p id="first">Top chat body.</p></li><li style="height:800px"></li>${Array.from({ length: 12 }, (_, index) => `<li><p>Context message ${index}.</p></li>`).join("")}<li><span class="username_otherHash">Another Author</span><p id="last">Bottom chat body.</p></li></ol></div>`,
  );
  const before = fixture.requests.length;
  await translate(page, "#first");
  const texts = () =>
    fixture.requests
      .slice(before)
      .flatMap((request) =>
        JSON.parse(request.body.messages.at(-1).content).segments.flatMap((item) => item.parts),
      );
  assert(texts().includes("Top chat body."));
  assert(!texts().includes("Bottom chat body."));
  await page.evaluate(() => {
    const scroller = document.querySelector("ol");
    scroller.scrollTop = scroller.scrollHeight;
  });
  await expect(page.locator("#last [data-yeyi-owned=translation]")).toHaveCount(1);
  assert(!texts().some((part) => part.includes("Author")));
  await page.getByRole("button", { name: "打开翻译设置" }).click();
  await expect(page.getByRole("checkbox", { name: "只翻译可视页面" })).toHaveCount(0);
  await expect(options.locator('[name="visibleOnly"]')).toBeChecked();
  await settings({ visibleOnly: false });
  await expect(page.locator("#last [data-yeyi-owned=translation]")).toHaveCount(1);
  const config = await message({ type: "GET_SETTINGS" });
  assert.equal(config.data.visibleOnly, false);
});

test("X 式根元素滚动后可视翻译继续请求正文，兼容字体、缓存与恢复原文", async (t) => {
  await settings({
    visibleOnly: true,
    mode: "replace",
    optimizeChineseFont: true,
    cacheEnabled: true,
  });
  const page = await article(
    t,
    `<style>html{height:100%;overflow-y:scroll}body{margin:0}article{height:100px;overflow:hidden}</style><main>${Array.from({ length: 50 }, (_, index) => `<article><div id="post${index}" data-testid="tweetText"><span style="font-weight:700">Search</span><span> result ${index}.</span></div></article>`).join("")}</main>`,
  );
  await page.evaluate(() => {
    globalThis.postNodes = [...document.querySelector("#post22").children].map(
      (element) => element.firstChild,
    );
  });
  const before = fixture.requests.length;
  await page.getByRole("button", { name: "翻译此页", exact: true }).click();
  await expect(page.locator("#post0")).toContainText("译文：result 0.");
  await expect(page.locator("#post22")).toHaveText("Search result 22.");
  await page.evaluate(() => window.scrollTo(0, 2200));
  await expect(page.locator("#post22")).toContainText("译文：result 22.");
  await expect(page.locator("#post30")).toContainText("译文：result 30.");
  await expect(page.locator("#post49")).toHaveText("Search result 49.");
  await expect(page.locator("#post22 span")).toHaveCount(2);
  await expect(page.locator("#post22 span").first()).toHaveCSS("font-weight", "700");
  assert.match(
    await page
      .locator("#post22 span")
      .first()
      .evaluate((element) => getComputedStyle(element).fontFamily),
    /Microsoft YaHei/,
  );
  assert(
    await page.evaluate(() =>
      [...document.querySelector("#post22").children].every(
        (element, index) => element.firstChild === postNodes[index],
      ),
    ),
  );
  assert.equal(
    fixture.requests
      .slice(before)
      .flatMap((request) =>
        JSON.parse(request.body.messages.at(-1).content).segments.flatMap((item) => item.parts),
      )
      .filter((part) => part === " result 0.").length,
    1,
  );
  await page.screenshot({ path: resolve(output, "x-root-scroll.png") });
  await page.getByRole("button", { name: "恢复原文", exact: true }).click();
  await expect(page.locator("#post22")).toHaveText("Search result 22.");
});

test("Discord 缓存立即显示后保持阅读位置，恢复原文也不拉回滚动", async (t) => {
  await settings({ cacheEnabled: true, mode: "replace", optimizeChineseFont: true });
  const body = `<style>body{margin:0;overflow:hidden}#scroll{height:320px;width:400px;overflow:auto;overflow-anchor:none;position:relative}ol{list-style:none;margin:0;padding:0}li{padding:8px}p{margin:0;font:16px/24px monospace}</style><div id="app-mount"><div id="scroll"><ol data-list-id="chat-messages">${Array.from({ length: 45 }, (_, index) => `<li id="chat-messages-${index}"><p id="message-content-${index}">Preview exactly what will be downloaded before starting.</p></li>`).join("")}</ol></div></div>`;
  const seeded = await article(t, body);
  await seeded.getByRole("button", { name: "翻译此页", exact: true }).click();
  await expect(seeded.locator("#message-content-44")).toHaveText("开始前准确预览将要下载的内容。");
  await seeded.close();
  await settings({ visibleOnly: true });
  const page = await article(t, body);
  const before = await page.evaluate(() => {
    const scroller = document.querySelector("#scroll");
    const anchor = document.querySelector("#chat-messages-22");
    scroller.scrollTop = anchor.offsetTop + 8;
    return {
      top: anchor.getBoundingClientRect().top,
      height: anchor.getBoundingClientRect().height,
    };
  });
  const requests = fixture.requests.length;
  await page.getByRole("button", { name: "翻译此页", exact: true }).click();
  await expect(page.locator("#message-content-22")).toHaveText("开始前准确预览将要下载的内容。");
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }),
  );
  const after = await page.locator("#chat-messages-22").evaluate((element) => ({
    top: element.getBoundingClientRect().top,
    height: element.getBoundingClientRect().height,
  }));
  assert(after.height < before.height, "缓存译文应实际改变消息高度");
  assert(Math.abs(after.top - before.top) <= 1, `缓存命中后偏移 ${after.top - before.top}px`);
  assert.equal(fixture.requests.length, requests);
  await page.screenshot({ path: resolve(output, "discord-cache-scroll.png") });
  await page.getByRole("button", { name: "恢复原文", exact: true }).click();
  await expect(page.locator("#message-content-22")).toHaveText(
    "Preview exactly what will be downloaded before starting.",
  );
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }),
  );
  const restoredTop = await page
    .locator("#chat-messages-22")
    .evaluate((element) => element.getBoundingClientRect().top);
  assert(Math.abs(restoredTop - before.top) <= 1, `恢复原文后偏移 ${restoredTop - before.top}px`);
});

test("真实扩展的译文响应在 Discord 平滑滚动中返回，不打断动画或改写消息", async (t) => {
  await settings({ mode: "replace", optimizeChineseFont: true });
  fixture.state.delayMs = 180;
  t.after(() => {
    fixture.state.delayMs = 0;
  });
  const page = await article(
    t,
    `<style>body{margin:0;overflow:hidden}#scroll{height:320px;width:400px;overflow:auto;overflow-anchor:none;position:relative}ol{list-style:none;margin:0;padding:0}li{padding:8px}p{margin:0;font:16px/24px monospace}</style><div id="app-mount"><div id="scroll"><ol data-list-id="chat-messages">${Array.from({ length: 45 }, (_, i) => `<li id="chat-messages-${i}"><p id="message-content-${i}">Preview exactly what will be downloaded before starting.</p></li>`).join("")}</ol></div></div>`,
  );
  await page.evaluate(() => {
    document.querySelector("#scroll").scrollTop =
      document.querySelector("#chat-messages-22").offsetTop;
  });
  const before = fixture.requests.length;
  await page.getByRole("button", { name: "翻译此页", exact: true }).click();
  await expect.poll(() => fixture.requests.length).toBeGreaterThan(before);
  const trace = await page.evaluate(async () => {
    const scroller = document.querySelector("#scroll");
    const target = scroller.scrollTop - 500;
    let writes = 0;
    const observer = new MutationObserver((records) => {
      writes += records.length;
    });
    observer.observe(document.querySelector("ol"), {
      characterData: true,
      childList: true,
      attributes: true,
      subtree: true,
    });
    const end = new Promise((resolve) =>
      scroller.addEventListener("scrollend", resolve, { once: true }),
    );
    scroller.scrollTo({ top: target, behavior: "smooth" });
    await end;
    observer.disconnect();
    return { target, actual: scroller.scrollTop, writes };
  });
  assert(
    Math.abs(trace.actual - trace.target) <= 1,
    `实际停在 ${trace.actual}，目标 ${trace.target}`,
  );
  assert.equal(trace.writes, 0, "运动期间扩展应保留所有聊天文本、节点及字体");
  await expect(page.locator("#message-content-44")).toHaveText("开始前准确预览将要下载的内容。");
  await page.screenshot({ path: resolve(output, "discord-smooth-scroll.png") });
});

test("真实失败请求不挡正常正文，每段最多三次重试，手动重试和缓存保持兼容", async (t) => {
  await settings({ cacheEnabled: true, mode: "replace" });
  fixture.state.malformedText = "Broken source.";
  t.after(() => {
    fixture.state.malformedText = "";
  });
  const page = await article(
    t,
    `<p id="broken">Broken source.</p>${Array.from({ length: 19 }, (_, i) => `<p id="healthy-${i}">Healthy source ${i}.</p>`).join("")}`,
  );
  const before = fixture.requests.length;
  await page.getByRole("button", { name: "翻译此页", exact: true }).click();
  await page.getByRole("button", { name: "打开翻译设置" }).click();
  await expect(page.locator("#healthy-18")).toHaveText("译文：Healthy source 18.");
  const parts = () =>
    fixture.requests
      .slice(before)
      .map((request) =>
        JSON.parse(request.body.messages.at(-1).content).segments.flatMap(
          (segment) => segment.parts,
        ),
      );
  assert.deepEqual(parts()[1], ["Healthy source 17.", "Healthy source 18."]);
  await expect(page.locator('[data-yeyi-owned="control"]').locator(".status")).toContainText(
    "等待重试",
  );
  await expect(page.getByRole("button", { name: "重试失败部分", exact: true })).toBeVisible({
    timeout: 15_000,
  });
  assert.equal(parts().filter((batch) => batch.includes("Broken source.")).length, 4);
  await expect(page.locator("#healthy-0")).toHaveText("译文：Healthy source 0.");
  assert.equal((await message({ type: "GET_CACHE_STATS" })).data.count, 19);
  const count = fixture.requests.length;
  fixture.state.malformedText = "";
  await page.getByRole("button", { name: "重试失败部分", exact: true }).click();
  await expect(page.locator("#broken")).toHaveText("译文：Broken source.");
  assert.equal(fixture.requests.length, count + 1);
  assert.deepEqual(parts().at(-1), ["Broken source."]);
  assert.equal((await message({ type: "GET_CACHE_STATS" })).data.count, 20);
  await page.reload();
  await page.getByRole("button", { name: "翻译此页", exact: true }).click();
  await expect(page.locator("#broken")).toHaveText("译文：Broken source.");
  assert.equal(fixture.requests.length, count + 1);
});

test("真实临时网络错误最多首次加三次请求，不叠加后台内部重试", async (t) => {
  fixture.state.transientRemaining = 10;
  t.after(() => {
    fixture.state.transientRemaining = 0;
  });
  const page = await article(t);
  const before = fixture.requests.length;
  await page.getByRole("button", { name: "翻译此页", exact: true }).click();
  await page.getByRole("button", { name: "打开翻译设置" }).click();
  await expect(page.getByRole("button", { name: "重试失败部分", exact: true })).toBeVisible({
    timeout: 15_000,
  });
  assert.equal(fixture.requests.length, before + 4);
  await page.waitForTimeout(300);
  assert.equal(fixture.requests.length, before + 4);
  await expect(page.locator("#source")).toHaveText("Reusable source paragraph.");
});

test("跨页面和刷新复用缓存，停用后不读取但保留原缓存", async (t) => {
  await settings({ cacheEnabled: true });
  const page = await article(t);
  const before = fixture.requests.length;
  await translate(page);
  assert.equal(fixture.requests.length, before + 1);
  const stats = await message({ type: "GET_CACHE_STATS" });
  assert.equal(stats.data.count, 1);
  assert(stats.data.bytes > 0);
  await page.reload();
  await translate(page);
  assert.equal(fixture.requests.length, before + 1);
  const another = await article(t);
  await translate(another);
  assert.equal(fixture.requests.length, before + 1);
  await settings({ cacheEnabled: false });
  await page.reload();
  await translate(page);
  assert.equal(fixture.requests.length, before + 2);
  assert.equal((await message({ type: "GET_CACHE_STATS" })).data.count, 1);
});

test("导出下载与导入复用成功，重复和坏文件不覆盖缓存，清理保留 Key 与设置", async (t) => {
  await settings({ cacheEnabled: true });
  const page = await article(t);
  await translate(page);
  const before = fixture.requests.length;
  const saved = (await message({ type: "GET_SETTINGS" })).data;
  const downloadPromise = options.waitForEvent("download");
  await options.locator("#exportCache").click();
  const download = await downloadPromise;
  const exported = JSON.parse(await readFile(await download.path(), "utf8"));
  assert.equal(exported.entries.length, 1);
  assert(!JSON.stringify(exported).includes("fixture-secret"));
  assert(!JSON.stringify(exported).includes(fixture.url));
  await options.locator("#clearCache").click();
  await expect(options.locator("#cacheUsage")).toHaveText("0 B · 0 条");
  assert.deepEqual((await message({ type: "GET_SETTINGS" })).data, saved);
  await expect(page.locator("#source [data-yeyi-owned=translation]")).toHaveCount(1);
  await upload(exported);
  await expect(options.locator("#cacheResult")).toContainText("已导入 1 条");
  await page.reload();
  await translate(page);
  assert.equal(fixture.requests.length, before);
  await upload({
    ...exported,
    entries: exported.entries.map((entry) => ({ ...entry, parts: ["不应覆盖"] })),
  });
  await expect(options.locator("#cacheResult")).toContainText("跳过 1 条");
  await upload({
    ...exported,
    entries: [...exported.entries, { key: "invalid", parts: ["错误"] }],
  });
  await expect(options.locator("#cacheResult")).toContainText("格式无效");
  const actual = await message({ type: "EXPORT_CACHE" });
  assert.deepEqual(actual.data, exported);
  await upload({ ...exported, version: 999 });
  await expect(options.locator("#cacheResult")).toContainText("格式无效");
});

test("超过自定义阈值显示感叹号并继续存储，调整阈值后提示消失", async () => {
  await settings({ cacheLimitMb: 1 });
  const data = {
    format: "yeyi-translation-cache",
    version: 1,
    entries: [{ key: "f".repeat(64), parts: ["缓存".repeat(200000)] }],
  };
  await upload(data);
  await expect(options.locator("#cacheWarning")).toBeVisible();
  await expect(options.locator("#cacheNotice")).toContainText("仍会继续保存");
  const before = (await message({ type: "GET_CACHE_STATS" })).data;
  assert.equal(before.overLimit, true);
  await upload({ ...data, entries: [{ key: "e".repeat(64), parts: ["超过阈值仍新增"] }] });
  await expect(options.locator("#cacheUsage")).toContainText("2 条");
  const after = (await message({ type: "GET_CACHE_STATS" })).data;
  assert(after.bytes > before.bytes);
  const exported = await message({ type: "EXPORT_CACHE" });
  assert.equal(exported.data.entries[0].parts[0], data.entries[0].parts[0]);
  await options.locator('[name="cacheLimitMb"]').fill("2");
  await expect(options.locator("#cacheWarning")).toBeHidden();
  await options.locator("#saveButton").click();
  await expect(options.locator("#saveStatus")).toContainText("已保存");
  await options.locator("#cache").scrollIntoViewIfNeeded();
  await options.screenshot({ path: resolve(output, "cache-settings.png") });
});

test("网页内容脚本不能读取、清除、导出或导入持久缓存", async (t) => {
  const page = await article(t);
  const results = await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url: `${url}/features/*` });
    return chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        const results = [];
        for (const type of ["GET_CACHE_STATS", "CLEAR_CACHE", "EXPORT_CACHE", "IMPORT_CACHE"])
          results.push(await chrome.runtime.sendMessage({ type }));
        return results;
      },
    });
  }, fixture.url);
  assert(results[0].result.every((result) => result.error.code === "FORBIDDEN"));
  assert.equal(await page.locator("#source").textContent(), "Reusable source paragraph.");
});

test("8344 条缓存跨天重启后复用日英译文，不等待新内容的慢请求", async (t) => {
  await settings({ cacheEnabled: true });
  // 使用与问题现场相同的条数，在独立浏览器 profile 内构造约 2 MiB 的缓存。
  const seeded = await message({
    type: "IMPORT_CACHE",
    data: {
      format: "yeyi-translation-cache",
      version: 1,
      entries: Array.from({ length: 8304 }, (_, index) => ({
        key: index.toString(16).padStart(64, "0"),
        parts: ["仅用于缓存容量回归的模拟译文，不属于用户数据。"],
      })),
    },
  });
  assert.equal(seeded.ok, true);
  const body = Array.from(
    { length: 40 },
    (_, index) =>
      `<p class="cached" id="cached${index}">${index % 2 ? `Read this forum post ${index}.` : `これ<strong>最高</strong>じゃん、その${index}。`}</p>`,
  ).join("");
  const page = await article(t, body);
  await page.getByRole("button", { name: "翻译此页", exact: true }).click();
  await expect(page.locator(".cached [data-yeyi-owned=translation]")).toHaveCount(40);
  const before = fixture.requests.length;
  const saved = (await message({ type: "EXPORT_CACHE" })).data;
  const savedSettings = (await message({ type: "GET_SETTINGS" })).data;
  assert.equal(saved.entries.length, 8344);
  const bytes = (await message({ type: "GET_CACHE_STATS" })).data.bytes;
  await context.close();
  await launch();
  // 只推进测试 worker 的日期，证明身份与保存时间无关；不修改用户电脑时钟。
  await worker.evaluate(() => {
    const now = Date.now;
    Date.now = () => now() + 2 * 24 * 60 * 60 * 1000;
  });
  fixture.state.delayMs = 8000;
  t.after(() => {
    fixture.state.delayMs = 0;
  });
  const restarted = await article(t, `<p id="slow">New uncached forum post.</p>${body}`);
  const started = performance.now();
  await restarted.getByRole("button", { name: "翻译此页", exact: true }).click();
  await expect(restarted.locator(".cached [data-yeyi-owned=translation]")).toHaveCount(40);
  const elapsedMs = Math.round(performance.now() - started);
  await expect.poll(() => fixture.requests.length).toBe(before + 1);
  assert.deepEqual(
    fixture.requests
      .slice(before)
      .flatMap((request) =>
        JSON.parse(request.body.messages.at(-1).content).segments.flatMap(
          (segment) => segment.parts,
        ),
      ),
    ["New uncached forum post."],
  );
  await expect(restarted.locator("#slow [data-yeyi-owned=translation]")).toHaveCount(0);
  assert.deepEqual((await message({ type: "EXPORT_CACHE" })).data, saved);
  assert.deepEqual((await message({ type: "GET_SETTINGS" })).data, savedSettings);
  t.diagnostic(`8344 条 / ${bytes} 字节；重启后 40 段缓存显示耗时 ${elapsedMs} ms，缓存零重译。`);
});

test("异常缓存只重译一次，实际磁盘修复后刷新和重启仍可复用", async (t) => {
  await settings({ cacheEnabled: true });
  const config = (await message({ type: "GET_PUBLIC_CONFIG" })).data;
  const sources = ["Missing cached forum post.", "Invalid cached forum post.", "これ最高だね。"];
  const keys = await Promise.all(
    sources.map(
      async (text) => CACHE_PREFIX + (await cacheKey(config.signature, { parts: [text] })),
    ),
  );
  await worker.evaluate(
    (keys) =>
      chrome.storage.local.set({
        translationCacheIndexV1: keys,
        [keys[1]]: "损坏的正文",
        [keys[2]]: ["分片数量", "不符合原文"],
      }),
    keys,
  );
  const savedSettings = (await message({ type: "GET_SETTINGS" })).data;
  const body = sources.map((text) => `<p class="repair">${text}</p>`).join("");
  const before = fixture.requests.length;
  const page = await article(t, body);
  await page.getByRole("button", { name: "翻译此页", exact: true }).click();
  await expect(page.locator(".repair [data-yeyi-owned=translation]")).toHaveCount(3);
  assert.equal(fixture.requests.length, before + 1);
  const repaired = (await message({ type: "EXPORT_CACHE" })).data;
  assert.equal(repaired.entries.length, 3);
  assert(repaired.entries.every((entry) => entry.parts.length === 1));
  await page.reload();
  await page.getByRole("button", { name: "翻译此页", exact: true }).click();
  await expect(page.locator(".repair [data-yeyi-owned=translation]")).toHaveCount(3);
  assert.equal(fixture.requests.length, before + 1);
  await context.close();
  await launch();
  const restarted = await article(t, body);
  await restarted.getByRole("button", { name: "翻译此页", exact: true }).click();
  await expect(restarted.locator(".repair [data-yeyi-owned=translation]")).toHaveCount(3);
  assert.equal(fixture.requests.length, before + 1);
  assert.deepEqual((await message({ type: "EXPORT_CACHE" })).data, repaired);
  assert.deepEqual((await message({ type: "GET_SETTINGS" })).data, savedSettings);
});

test("可视区域模式推迟屏幕外同源和跨域 iframe，滚动出现后开始翻译", async (t) => {
  await settings({ visibleOnly: true });
  // 使用真实 HTTP 响应确定本机地址空间；route.fulfill 的合成响应会触发 Chromium 的跨域本机网络拦截。
  const foreignFixture = await startServer();
  t.after(() => foreignFixture.close());
  const foreign = foreignFixture.url;
  fixture.state.frameDocument = `<!doctype html><html><body><p id="source">Visible top source.</p><div style="height:1500px"></div><iframe id="sameFrame" src="${fixture.url}/frame"></iframe><div style="height:1500px"></div><iframe id="foreignFrame" src="${foreign}/frame"></iframe></body></html>`;
  const page = await context.newPage();
  t.after(() => page.close());
  await page.goto(`${fixture.url}/viewport-frames`);
  const before = fixture.requests.length;
  await translate(page);
  const framesSent = () =>
    fixture.requests
      .slice(before)
      .flatMap((request) =>
        JSON.parse(request.body.messages.at(-1).content).segments.flatMap((item) => item.parts),
      )
      .filter((part) => part === "Frame paragraph.");
  assert.equal(framesSent().length, 0);
  await page.locator("#sameFrame").scrollIntoViewIfNeeded();
  await expect(
    page.frameLocator("#sameFrame").locator("#frameText [data-yeyi-owned=translation]"),
  ).toHaveCount(1);
  assert.equal(framesSent().length, 1);
  await page.locator("#foreignFrame").scrollIntoViewIfNeeded();
  await expect(page.frameLocator("#foreignFrame").locator("#frameText")).toBeVisible();
  await expect(
    page.frameLocator("#foreignFrame").locator("#frameText [data-yeyi-owned=translation]"),
  ).toHaveCount(1);
  assert.equal(framesSent().length, 2);
});

test("超过 64 MiB 的缓存文件可完整导入和导出，不受单条扩展消息限制", async (t) => {
  const data = {
    format: "yeyi-translation-cache",
    version: 1,
    entries: Array.from({ length: 36 }, (_, index) => ({
      key: index.toString(16).padStart(64, "0"),
      parts: ["x".repeat(1_900_000)],
    })),
  };
  assert(Buffer.byteLength(JSON.stringify(data)) > 64 * 1024 * 1024);
  const file = resolve(output, `large-cache-${Date.now()}.json`);
  t.after(() => rm(file, { force: true }));
  await writeFile(file, JSON.stringify(data));
  await options.locator("#cacheFile").setInputFiles(file);
  await expect(options.locator("#cacheResult")).toContainText("已导入 36 条", { timeout: 30_000 });
  assert.equal((await message({ type: "GET_CACHE_STATS" })).data.count, 36);
  const downloadPromise = options.waitForEvent("download", { timeout: 30_000 });
  await options.locator("#exportCache").click();
  const download = await downloadPromise;
  const exported = JSON.parse(await readFile(await download.path(), "utf8"));
  assert.deepEqual(exported, data);
});

test("命中缓存立即显示，同页慢请求只包含未缓存文字", async (t) => {
  await settings({ cacheEnabled: true });
  const seed = await article(t, '<p id="source">Cached browser source.</p>');
  await translate(seed);
  const page = await article(
    t,
    '<p id="missing">Uncached slow browser source.</p><p id="cached">Cached browser source.</p>',
  );
  const before = fixture.requests.length;
  fixture.state.delayMs = 3000;
  t.after(() => {
    fixture.state.delayMs = 0;
  });
  await page.getByRole("button", { name: "翻译此页", exact: true }).click();
  await expect(page.locator("#cached [data-yeyi-owned=translation]")).toHaveText(
    "译文：Cached browser source.",
  );
  await expect.poll(() => fixture.requests.length).toBe(before + 1);
  const sources = fixture.requests
    .slice(before)
    .flatMap((request) =>
      JSON.parse(request.body.messages.at(-1).content).segments.flatMap((segment) => segment.parts),
    );
  assert.deepEqual(sources, ["Uncached slow browser source."]);
  await expect(page.locator("#missing [data-yeyi-owned=translation]")).toHaveCount(0);
});

test("中文字体开关默认关闭，保存和重启设置页保持，Key、缓存及人名字典均保留", async () => {
  await expect(options.locator('[name="optimizeChineseFont"]')).not.toBeChecked();
  const saved = (await message({ type: "GET_SETTINGS" })).data;
  const signature = (await message({ type: "GET_PUBLIC_CONFIG" })).data.signature;
  const dictionary = (await message({ type: "GET_NAME_DICTIONARY" })).data;
  await upload({
    format: "yeyi-translation-cache",
    version: 1,
    entries: [{ key: "a".repeat(64), parts: ["字体测试缓存"] }],
  });
  await expect(options.locator("#cacheResult")).toContainText("已导入 1 条");
  const cache = (await message({ type: "EXPORT_CACHE" })).data;
  await options.locator('[name="optimizeChineseFont"]').check();
  await options.locator("#saveButton").click();
  await expect(options.locator("#saveStatus")).toContainText("已保存");
  assert.deepEqual((await message({ type: "GET_SETTINGS" })).data, {
    ...saved,
    optimizeChineseFont: true,
  });
  assert.equal((await message({ type: "GET_PUBLIC_CONFIG" })).data.signature, signature);
  assert.deepEqual((await message({ type: "EXPORT_CACHE" })).data, cache);
  assert.deepEqual((await message({ type: "GET_NAME_DICTIONARY" })).data, dictionary);
  await options.reload();
  await expect(options.locator('[name="optimizeChineseFont"]')).toBeChecked();
  await options
    .locator("#preferences")
    .screenshot({ path: resolve(output, "font-preference.png") });
});

test("保存字体开关即时更新中文译文，关闭或恢复原文还原字体，字号字重及缓存请求不变", async (t) => {
  await settings({ mode: "replace", cacheEnabled: true });
  const page = await article(
    t,
    '<p id="source" lang="ja" style="font-family:Georgia; font-size:17px; font-weight:600; line-height:28px">Welcome to the open web</p>',
  );
  await page.getByRole("button", { name: "翻译此页", exact: true }).click();
  await expect(page.locator("#source")).toHaveText("欢迎来到开放网络");
  const readFont = () =>
    page.locator("#source").evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        family: style.fontFamily,
        size: style.fontSize,
        weight: style.fontWeight,
        lineHeight: style.lineHeight,
      };
    });
  const original = await readFont();
  const requests = fixture.requests.length;
  await options.locator('[name="optimizeChineseFont"]').check();
  await options.locator("#saveButton").click();
  await expect(options.locator("#saveStatus")).toContainText("已保存");
  await expect.poll(async () => (await readFont()).family).toContain("Microsoft YaHei");
  assert.deepEqual({ ...(await readFont()), family: original.family }, original);
  assert.equal(fixture.requests.length, requests);
  // 在同一文本节点重绘原文，验证真实扩展仍复用译文，且字体优化不会妨碍站点重绘。
  await page.locator("#source").evaluate((element) => {
    element.firstChild.data = "Welcome to the open web";
  });
  await expect(page.locator("#source")).toHaveText("欢迎来到开放网络");
  assert.equal(fixture.requests.length, requests);
  await options.locator('[name="optimizeChineseFont"]').uncheck();
  await options.locator("#saveButton").click();
  await expect(options.locator("#saveStatus")).toContainText("已保存");
  await expect.poll(readFont).toEqual(original);
  await page.getByRole("button", { name: "恢复原文", exact: true }).click();
  await expect(page.locator("#source")).toHaveText("Welcome to the open web");
  assert.deepEqual(await readFont(), original);
});

test("中文字体优化兼容汉字人名字典，本机命中与站点重绘均不调用 API", async (t) => {
  await settings({ mode: "replace", optimizeChineseFont: true, cacheEnabled: true });
  const dictionary = await worker.evaluate(() => chrome.storage.local.get("nameDictionary"));
  t.after(() =>
    worker.evaluate(async (stored) => {
      if (stored.nameDictionary) await chrome.storage.local.set(stored);
      else await chrome.storage.local.remove("nameDictionary");
    }, dictionary),
  );
  const imported = await message({
    type: "IMPORT_NAME_DICTIONARY",
    entries: [{ src: "試験名", dst: "测试名", info: "合成字体测试" }],
  });
  assert.equal(imported.ok, true);
  const requests = fixture.requests.length;
  const page = await article(
    t,
    '<p id="source" lang="ja" style="font-family:Georgia">&#x8A66;&#x9A13;&#x540D;</p>',
  );
  await page.getByRole("button", { name: "翻译此页", exact: true }).click();
  await expect(page.locator("#source")).toHaveText("测试名");
  assert.match(
    await page.locator("#source").evaluate((element) => getComputedStyle(element).fontFamily),
    /Microsoft YaHei/,
  );
  await page.locator("#source").evaluate((element) => {
    element.firstChild.data = "試験名";
  });
  await expect(page.locator("#source")).toHaveText("测试名");
  assert.equal(fixture.requests.length, requests);
});

test("日语专用提示词按原文启用，混排、内联汉字、还原及重载缓存保持完整", async (t) => {
  await settings({ mode: "replace", cacheEnabled: true });
  const original =
    '<main lang="ja"><p id="source">これ<strong id="kanji">最高</strong><a id="link" href="/keep">じゃん。</a></p><p id="halfwidth">ﾜﾛﾀｗ</p><p id="english">Welcome to the open web</p><p id="chinese">这是中文帖子。</p></main>';
  const page = await article(t, original);
  const before = fixture.requests.length;
  await page.getByRole("button", { name: "翻译此页", exact: true }).click();
  await expect(page.locator("#kanji")).toHaveText("译文：最高");
  await expect(page.locator("#halfwidth")).toHaveText("译文：ﾜﾛﾀｗ");
  await expect(page.locator("#english")).toHaveText("欢迎来到开放网络");
  await expect(page.locator("#chinese")).toHaveText("这是中文帖子。");
  await expect(page.locator("#link")).toHaveAttribute("href", "/keep");
  const sent = fixture.requests.slice(before);
  assert.equal(sent.length, 1);
  const input = JSON.parse(sent[0].body.messages.at(-1).content);
  assert.deepEqual(
    input.segments
      .filter((segment) => input.japaneseSegmentIds.includes(segment.id))
      .map((segment) => segment.parts.join("")),
    ["これ最高じゃん。", "ﾜﾛﾀｗ"],
  );
  assert.equal(
    input.segments.find((segment) => segment.parts.includes("最高")).sourceLanguage,
    "ja",
  );
  assert.equal(
    input.segments.find((segment) => segment.parts[0] === "Welcome to the open web").sourceLanguage,
    undefined,
  );
  assert.match(sent[0].body.messages[0].content, /Japanese forum translation/);
  await expect.poll(async () => (await message({ type: "GET_CACHE_STATS" })).data.count).toBe(3);
  await page.getByRole("button", { name: "恢复原文", exact: true }).click();
  await expect(page.locator("#source")).toHaveText("これ最高じゃん。");
  await expect(page.locator("#kanji")).toHaveText("最高");
  await page.getByRole("button", { name: "翻译此页", exact: true }).click();
  await expect(page.locator("#kanji")).toHaveText("译文：最高");
  assert.equal(fixture.requests.length, before + 1);
  await page.reload();
  await page.getByRole("button", { name: "翻译此页", exact: true }).click();
  await expect(page.locator("#kanji")).toHaveText("译文：最高");
  await expect(page.locator("#english")).toHaveText("欢迎来到开放网络");
  assert.equal(fixture.requests.length, before + 1);
  // 即使页面标为 ja，新出现的英文仍使用通用提示词。
  await page.locator("main").evaluate((element) => {
    const paragraph = document.createElement("p");
    paragraph.id = "dynamicEnglish";
    paragraph.textContent = "Read the guide and explore.";
    element.append(paragraph);
  });
  await expect(page.locator("#dynamicEnglish")).toHaveText("阅读指南并探索。");
  assert.equal(fixture.requests.length, before + 2);
  assert.doesNotMatch(
    fixture.requests.at(-1).body.messages[0].content,
    /Japanese forum translation/,
  );
});

for (const cacheEnabled of [false, true]) {
  test(`连续动态内容合并为一次 HTTP 请求（缓存${cacheEnabled ? "开启" : "关闭"}）`, async (t) => {
    await settings({ cacheEnabled });
    const page = await article(t, '<main><p class="burst">Burst source 0.</p></main>');
    const before = fixture.requests.length;
    await page.getByRole("button", { name: "翻译此页", exact: true }).evaluate((button) => {
      // 从引擎开始发布活动状态时计时，让新增内容确实发生在首次扫描之后。
      const observer = new MutationObserver(() => {
        if (button.getAttribute("aria-pressed") !== "true") return;
        observer.disconnect();
        for (let index = 1; index <= 3; index++)
          setTimeout(() => {
            const paragraph = document.createElement("p");
            paragraph.className = "burst";
            paragraph.textContent = `Burst source ${index}.`;
            document.querySelector("main").append(paragraph);
          }, index * 40);
      });
      observer.observe(button, { attributes: true, attributeFilter: ["aria-pressed"] });
      button.click();
    });
    await expect(page.locator(".burst [data-yeyi-owned=translation]")).toHaveCount(4);
    const sent = fixture.requests.slice(before);
    assert.equal(sent.length, 1);
    assert.deepEqual(
      JSON.parse(sent[0].body.messages.at(-1).content).segments.flatMap((item) => item.parts),
      Array.from({ length: 4 }, (_, index) => `Burst source ${index}.`),
    );
  });
}
