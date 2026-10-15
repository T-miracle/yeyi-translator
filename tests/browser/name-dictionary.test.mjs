import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "./server.mjs";

const output = resolve("test-results");
const profile = resolve(output, `names-profile-${Date.now()}`);
const entry = { src: "Example Hero", dst: "示例角色", info: "测试角色" };
let fixture;
let context;
let worker;
let options;
let extensionId;
const errors = [];

/** 只使用隔离测试配置，不接触用户日常浏览器或真实 API。 */
async function launch() {
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 960 },
    args: [`--disable-extensions-except=${resolve("dist")}`, `--load-extension=${resolve("dist")}`],
  });
  context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
  [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  extensionId = new URL(worker.url()).hostname;
  options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/pages/Options/index.html#names`);
  await expect(options.locator("#nameCount")).toContainText("共");
}

const message = (data) => options.evaluate((data) => chrome.runtime.sendMessage(data), data);
const upload = (data) =>
  options.locator("#nameFile").setInputFiles({
    name: "names.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(data)),
  });

/** 创建无敏感内容的名字标签测试页。 */
async function article(t) {
  const page = await context.newPage();
  t.after(() => page.close());
  await page.route(`${fixture.url}/names-article`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body><p id="source">${entry.src}</p></body></html>`,
    }),
  );
  await page.goto(`${fixture.url}/names-article`);
  await page.getByRole("button", { name: "翻译此页", exact: true }).click();
  await expect(page.locator("#source [data-yeyi-owned=translation]")).toHaveCount(1);
  return page;
}

before(async () => {
  await mkdir(output, { recursive: true });
  fixture = await startServer();
  await launch();
});

beforeEach(async () => {
  await worker.evaluate(() => chrome.storage.local.remove("nameDictionary"));
  const current = (await message({ type: "GET_SETTINGS" })).data;
  const result = await message({
    type: "SAVE_SETTINGS",
    settings: {
      ...current,
      provider: "deepseek",
      mode: "bilingual",
      targetLanguage: "zh-CN",
      cacheEnabled: true,
      visibleOnly: false,
      autoTranslateSites: [],
      providers: {
        ...current.providers,
        deepseek: {
          apiKey: "fixture-secret-names",
          baseUrl: `${fixture.url}/deepseek`,
          model: "deepseek-flash",
        },
      },
    },
  });
  assert.equal(result.ok, true);
  await message({ type: "CLEAR_CACHE" });
  await options.reload();
  await expect(options.locator("#nameCount")).toHaveText("共 0 条");
});

after(async () => {
  await context?.close();
  await fixture?.close();
  if (dirname(profile) !== output || !basename(profile).startsWith("names-profile-"))
    throw new Error("拒绝清理测试目录之外的路径");
  await rm(profile, { recursive: true, force: true });
  assert.deepEqual(errors, []);
});

test("AiNiee JSON 从设置页导入导出，重复、坏行和坏 JSON 保留本机条目", async () => {
  const saved = (await message({ type: "GET_SETTINGS" })).data;
  await upload([entry]);
  await expect(options.locator("#nameResult")).toContainText("已导入 1 条");
  await expect(options.locator("#nameRows")).toContainText(entry.dst);
  await upload([
    { ...entry, dst: "不覆盖" },
    { src: "Second Hero", dst: "第二角色" },
  ]);
  await expect(options.locator("#nameResult")).toContainText("跳过 1 条");
  await upload([
    { src: "Third Hero", dst: "第三角色" },
    { src: "Bad Hero", dst: 1 },
  ]);
  await expect(options.locator("#nameResult")).toContainText("格式无效");
  await expect(options.locator("#nameCount")).toHaveText("共 2 条");
  await options.locator("#nameFile").setInputFiles({
    name: "bad.json",
    mimeType: "application/json",
    buffer: Buffer.from("broken JSON"),
  });
  await expect(options.locator("#nameResult")).toContainText("已有数据未修改");
  const downloadPromise = options.waitForEvent("download");
  await options.locator("#exportNames").click();
  const download = await downloadPromise;
  const exported = JSON.parse(await readFile(await download.path(), "utf8"));
  assert.deepEqual(exported, [entry, { src: "Second Hero", dst: "第二角色", info: "" }]);
  assert(!JSON.stringify(exported).includes("fixture-secret"));
  assert.deepEqual((await message({ type: "GET_SETTINGS" })).data, saved);
  await options.screenshot({ path: resolve(output, "name-dictionary.png"), fullPage: true });
});

test("添加、搜索、编辑和删除即时保存，普通设置保存及清理缓存保留字典", async () => {
  await options.locator("#nameSource").fill(entry.src);
  await options.locator("#nameTranslation").fill(entry.dst);
  await options.locator("#nameInfo").fill(entry.info);
  await options.locator("#saveName").click();
  await expect(options.locator("#nameResult")).toContainText("人名已保存");
  await expect(options.locator("#saveStatus")).not.toContainText("未保存");
  await options.locator("#nameSearch").fill("no matches");
  await expect(options.locator("#nameRows tr")).toHaveCount(0);
  await options.locator("#nameSearch").fill("示例");
  await expect(options.locator("#nameRows tr")).toHaveCount(1);
  await options.getByRole("button", { name: `编辑 ${entry.src}`, exact: true }).click();
  await options.locator("#nameTranslation").fill("更新角色");
  await options.locator("#saveName").click();
  await expect(options.locator("#nameResult")).toContainText("人名已保存");
  await options.locator("#nameSearch").fill("");
  await expect(options.locator("#nameRows")).toContainText("更新角色");
  const before = (await message({ type: "GET_NAME_DICTIONARY" })).data;
  await options.locator("#saveButton").click();
  await expect(options.locator("#saveStatus")).toContainText("已保存");
  await message({ type: "CLEAR_CACHE" });
  assert.deepEqual((await message({ type: "GET_NAME_DICTIONARY" })).data, before);
  await options.getByRole("button", { name: `删除 ${entry.src}`, exact: true }).click();
  await expect(options.locator("#nameCount")).toHaveText("共 0 条");
});

test("并发编辑拒绝过期覆盖，导入文本安全显示，不执行 HTML", async () => {
  const unsafe = { ...entry, info: '<img src=x onerror="globalThis.injected=true">' };
  await upload([unsafe]);
  await expect(options.locator("#nameRows")).toContainText(unsafe.info);
  assert.equal(await options.locator("#nameRows img").count(), 0);
  await options.getByRole("button", { name: `编辑 ${entry.src}`, exact: true }).click();
  const external = { ...unsafe, dst: "另一页修改" };
  assert.equal(
    (await message({ type: "SAVE_NAME_ENTRY", entry: external, previous: unsafe })).ok,
    true,
  );
  await options.locator("#nameTranslation").fill("旧草稿修改");
  await options.locator("#saveName").click();
  await expect(options.locator("#nameResult")).toContainText("其他设置页修改");
  assert.deepEqual((await message({ type: "GET_NAME_DICTIONARY" })).data.entries, [external]);
  await expect(options.locator("#nameTranslation")).toHaveValue("旧草稿修改");
});

test("导入后正在翻译的页面立即换用人名，停用保留数据并复用原缓存", async (t) => {
  const page = await article(t);
  const oldTranslation = await page.locator("#source [data-yeyi-owned=translation]").textContent();
  const requests = fixture.requests.length;
  await upload([entry]);
  await expect(options.locator("#nameResult")).toContainText("已导入 1 条");
  await expect(page.locator("#source [data-yeyi-owned=translation]")).toHaveText(entry.dst);
  assert.equal(fixture.requests.length, requests);
  await options.locator("#nameDictionaryEnabled").uncheck();
  await expect(options.locator("#nameResult")).toContainText("已停用");
  await expect(page.locator("#source [data-yeyi-owned=translation]")).toHaveText(oldTranslation);
  assert.equal(fixture.requests.length, requests);
  assert.deepEqual((await message({ type: "GET_NAME_DICTIONARY" })).data.entries, [entry]);
  await options.locator("#nameDictionaryEnabled").check();
  await expect(options.locator("#nameResult")).toContainText("已启用");
  await expect(page.locator("#source [data-yeyi-owned=translation]")).toHaveText(entry.dst);
});

test("汉字人名字典优先于中文跳过，双语和替换模式支持停用、恢复与跨页面缓存", async (t) => {
  await upload([
    { src: "桐生一馬", dst: "桐生一马" },
    { src: "王小明", dst: "Wang Xiaoming" },
  ]);
  await expect(options.locator("#nameCount")).toHaveText("共 2 条");
  const requests = fixture.requests.length;
  for (const mode of ["bilingual", "replace"]) {
    for (const targetLanguage of ["zh-CN", "en"]) {
      const current = (await message({ type: "GET_SETTINGS" })).data;
      await message({ type: "SAVE_SETTINGS", settings: { ...current, mode, targetLanguage } });
      const page = await context.newPage();
      t.after(() => page.close());
      await page.route(`${fixture.url}/han-names`, (route) =>
        route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: '<!doctype html><meta charset="utf-8"><p id="han"> 桐生<b>一馬</b>与王小明见面，其他中文保留。 </p><p id="plain">这些中文保持原样。</p>',
        }),
      );
      await page.goto(`${fixture.url}/han-names`);
      await page.getByRole("button", { name: "翻译此页", exact: true }).click();
      const translated = " 桐生一马与Wang Xiaoming见面，其他中文保留。 ";
      const original = " 桐生一馬与王小明见面，其他中文保留。 ";
      if (mode === "bilingual")
        await expect(page.locator("#han [data-yeyi-owned=translation]")).toHaveText(translated);
      else await expect(page.locator("#han")).toHaveText(translated);
      assert.equal(await page.locator("#plain").textContent(), "这些中文保持原样。");
      assert.equal(fixture.requests.length, requests);
      await message({ type: "SET_NAME_DICTIONARY_ENABLED", enabled: false });
      await expect(page.locator("#han")).toHaveText(original);
      await message({ type: "SET_NAME_DICTIONARY_ENABLED", enabled: true });
      if (mode === "bilingual")
        await expect(page.locator("#han [data-yeyi-owned=translation]")).toHaveText(translated);
      else await expect(page.locator("#han")).toHaveText(translated);
      await page.getByRole("button", { name: "恢复原文", exact: true }).click();
      await expect(page.locator("#han")).toHaveText(original);
      await page.close();
    }
  }
  assert.equal(fixture.requests.length, requests);
});

test("网页内容脚本无法读写字典，公开配置只含摘要", async (t) => {
  await upload([entry]);
  await expect(options.locator("#nameCount")).toHaveText("共 1 条");
  const config = (await message({ type: "GET_PUBLIC_CONFIG" })).data;
  assert.equal(config.nameDictionarySignature.length, 64);
  assert(!JSON.stringify(config).includes(entry.src));
  assert(!JSON.stringify(config).includes(entry.dst));
  await article(t);
  const results = await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url: `${url}/names-article` });
    return chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        const results = [];
        for (const type of [
          "GET_NAME_DICTIONARY",
          "IMPORT_NAME_DICTIONARY",
          "SAVE_NAME_ENTRY",
          "SET_NAME_DICTIONARY_ENABLED",
        ])
          results.push(
            await chrome.runtime.sendMessage({ type, entries: [], entry: null, enabled: false }),
          );
        return results;
      },
    });
  }, fixture.url);
  assert(results[0].result.every((result) => result.error.code === "FORBIDDEN"));
  assert.deepEqual((await message({ type: "GET_NAME_DICTIONARY" })).data.entries, [entry]);
});

test("重启隔离浏览器后保留字典及开关，启用后人名不调用 API", async () => {
  await upload([entry]);
  await expect(options.locator("#nameCount")).toHaveText("共 1 条");
  await options.locator("#nameDictionaryEnabled").uncheck();
  await expect(options.locator("#nameResult")).toContainText("已停用");
  await context.close();
  await launch();
  await expect(options.locator("#nameCount")).toHaveText("共 1 条");
  await expect(options.locator("#nameDictionaryEnabled")).not.toBeChecked();
  await options.locator("#nameDictionaryEnabled").check();
  await expect(options.locator("#nameResult")).toContainText("已启用");
  const requests = fixture.requests.length;
  const page = await context.newPage();
  await page.route(`${fixture.url}/names-article`, (route) =>
    route.fulfill({ contentType: "text/html", body: `<p id="source">${entry.src}</p>` }),
  );
  await page.goto(`${fixture.url}/names-article`);
  await page.getByRole("button", { name: "翻译此页", exact: true }).click();
  await expect(page.locator("#source [data-yeyi-owned=translation]")).toHaveText(entry.dst);
  assert.equal(fixture.requests.length, requests);
  await page.close();
});

test(
  "本机用户字典通过真实设置页完整导入并可原样导出",
  { skip: !process.env.YEYI_NAME_DICTIONARY_FILE },
  async () => {
    const data = JSON.parse(await readFile(process.env.YEYI_NAME_DICTIONARY_FILE, "utf8"));
    await options.locator("#nameFile").setInputFiles(process.env.YEYI_NAME_DICTIONARY_FILE);
    await expect(options.locator("#nameResult")).toContainText(`已导入 ${data.length} 条`);
    assert.deepEqual((await message({ type: "GET_NAME_DICTIONARY" })).data.entries, data);
    const downloadPromise = options.waitForEvent("download");
    await options.locator("#exportNames").click();
    const download = await downloadPromise;
    assert.deepEqual(JSON.parse(await readFile(await download.path(), "utf8")), data);
  },
);
