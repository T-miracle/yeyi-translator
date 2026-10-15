import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "./server.mjs";

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
      contentType: "text/html",
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

before(async () => {
  await mkdir(output, { recursive: true });
  fixture = await startServer();
  await launch();
});

beforeEach(async () => {
  await settings({
    visibleOnly: false,
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

test("关闭并重启浏览器后仍复用已保存译文", async (t) => {
  await settings({ cacheEnabled: true });
  const page = await article(t);
  await translate(page);
  const before = fixture.requests.length;
  await context.close();
  await launch();
  const restarted = await article(t);
  await translate(restarted);
  assert.equal(fixture.requests.length, before);
  assert.equal((await message({ type: "GET_CACHE_STATS" })).data.count, 1);
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
