import { test } from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { cp, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { normalizeSettings } from "../../src/shared/settings.js";
import { startServer } from "./server.mjs";

const output = resolve("test-results");
const built = resolve("dist");

/** 每个测试使用独立浏览器数据目录；重启仍复用同一目录，覆盖真实持久化链路。 */
async function launch(extension, profile) {
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  return { context, worker, id: new URL(worker.url()).hostname };
}

/** 只删除本测试创建并核对过的工作区内目录。 */
async function clean(paths) {
  for (const path of paths) {
    if (dirname(path) !== output || !basename(path).startsWith("settings-upgrade-"))
      throw new Error("拒绝清理测试目录以外的路径");
    await rm(path, { recursive: true, force: true });
  }
}

async function options(session) {
  const page = await session.context.newPage();
  await page.goto(`chrome-extension://${session.id}/pages/Options/index.html`);
  await expect(page.locator("#cacheUsage")).not.toHaveText("正在读取…");
  return page;
}

const message = (page, data) => page.evaluate((data) => chrome.runtime.sendMessage(data), data);
const thinking = (page) => page.getByRole("combobox", { name: "DeepSeek 思考模式", exact: true });

test("思考模式保存后关闭重开设置及重启浏览器仍保持，其他设置、缓存和字典保留", async (t) => {
  await mkdir(output, { recursive: true });
  const profile = resolve(output, `settings-upgrade-normal-${Date.now()}`);
  const fixture = await startServer();
  let session;
  t.after(async () => {
    await session?.context.close();
    await fixture.close();
    await clean([profile]);
  });
  session = await launch(built, profile);
  let page = await options(session);
  const previous = (await message(page, { type: "GET_SETTINGS" })).data;
  previous.providers.deepseek = {
    ...previous.providers.deepseek,
    apiKey: "fixture-secret-settings-deepseek",
    baseUrl: `${fixture.url}/deepseek`,
    thinkingMode: "disabled",
    reasoningEffort: "high",
  };
  previous.providers.openai = {
    ...previous.providers.openai,
    apiKey: "fixture-secret-settings-openai",
    baseUrl: `${fixture.url}/v1`,
  };
  previous.autoTranslateSites = ["example.com"];
  previous.translationShortcut = "Alt+T";
  assert.equal((await message(page, { type: "SAVE_SETTINGS", settings: previous })).ok, true);
  assert.equal(
    (
      await message(page, {
        type: "IMPORT_CACHE",
        data: {
          format: "yeyi-translation-cache",
          version: 1,
          entries: [{ key: "a".repeat(64), parts: ["保留已有译文"] }],
        },
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await message(page, {
        type: "IMPORT_NAME_DICTIONARY",
        entries: [{ src: "Example", dst: "测试名", info: "保留已有描述" }],
      })
    ).ok,
    true,
  );
  const cache = (await message(page, { type: "EXPORT_CACHE" })).data;
  const dictionary = (await message(page, { type: "GET_NAME_DICTIONARY" })).data;
  await page.reload();
  await expect(page.locator("#saveButton")).toBeEnabled();
  for (const mode of ["default", "disabled", "enabled"]) {
    await thinking(page).selectOption(mode);
    await page.locator("#saveButton").click();
    await expect(page.locator("#saveStatus")).toContainText("已保存");
    const expected = structuredClone(previous);
    expected.providers.deepseek.thinkingMode = mode;
    assert.deepEqual((await message(page, { type: "GET_SETTINGS" })).data, expected);
    await page.close();
    page = await options(session);
    await expect(thinking(page)).toHaveValue(mode);
    await expect(page.locator('[name="deepseekReasoningEffort"]')).toHaveValue("high");
  }
  await session.context.close();
  session = await launch(built, profile);
  page = await options(session);
  await expect(thinking(page)).toHaveValue("enabled");
  await expect(page.locator('[name="deepseekReasoningEffort"]')).toHaveValue("high");
  assert.deepEqual((await message(page, { type: "EXPORT_CACHE" })).data, cache);
  assert.deepEqual((await message(page, { type: "GET_NAME_DICTIONARY" })).data, dictionary);
});

/** 模拟旧后台的字段契约：读取不含 thinkingMode，保存时丢弃它，其余用户数据保留。 */
function legacyWorker() {
  globalThis.legacySaveCalls = 0;
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    const handle = async () => {
      const { settings } = await chrome.storage.local.get("settings");
      if (message.type === "GET_SETTINGS") {
        const legacy = structuredClone(settings);
        delete legacy.providers.deepseek.thinkingMode;
        return legacy;
      }
      if (message.type === "SAVE_SETTINGS") {
        globalThis.legacySaveCalls++;
        const legacy = structuredClone(message.settings);
        delete legacy.providers.deepseek.thinkingMode;
        await chrome.storage.local.set({ settings: legacy });
        return {};
      }
      if (message.type === "GET_CACHE_STATS") return { count: 0, bytes: 0 };
      if (message.type === "GET_NAME_DICTIONARY") return { enabled: true, entries: [] };
      throw new Error("旧后台不支持此请求");
    };
    handle().then(
      (data) => respond({ ok: true, data }),
      (error) => respond({ ok: false, error: { message: error.message } }),
    );
    return true;
  });
}

test("旧后台不会让思考模式显示空白或假保存成功，完成后台更新后可正常保存", async (t) => {
  await mkdir(output, { recursive: true });
  const stamp = Date.now();
  const profile = resolve(output, `settings-upgrade-legacy-profile-${stamp}`);
  const extension = resolve(output, `settings-upgrade-legacy-extension-${stamp}`);
  const fixture = await startServer();
  await cp(built, extension, { recursive: true });
  await writeFile(resolve(extension, "background/index.js"), `(${legacyWorker.toString()})()`);
  let session;
  t.after(async () => {
    await session?.context.close();
    await fixture.close();
    await clean([profile, extension]);
  });
  session = await launch(extension, profile);
  const previous = normalizeSettings({
    providers: { deepseek: { baseUrl: `${fixture.url}/deepseek`, reasoningEffort: "high" } },
  });
  delete previous.providers.deepseek.thinkingMode;
  previous.providers.deepseek.apiKey = "fixture-secret-legacy-settings";
  const userData = {
    settings: previous,
    unrelatedSavedData: { cache: ["已有译文"], names: ["已有字典"] },
  };
  await session.worker.evaluate((data) => chrome.storage.local.set(data), userData);
  let page = await options(session);
  await expect(thinking(page)).toHaveValue("enabled");
  await expect(page.locator('[name="deepseekReasoningEffort"]')).toHaveValue("high");
  await expect(page.locator("#saveButton")).toBeDisabled();
  await expect(page.locator('[data-test="deepseek"]')).toBeDisabled();
  await expect(page.locator("#saveStatus")).toContainText("重新加载扩展");
  await expect(page.getByRole("button", { name: "重新加载扩展", exact: true })).toBeVisible();
  await thinking(page).selectOption("disabled");
  await expect(page.locator("#saveStatus")).toContainText("重新加载扩展");
  await page.locator("#settingsForm").evaluate((form) => form.requestSubmit());
  assert.equal(await session.worker.evaluate(() => globalThis.legacySaveCalls), 0);
  assert.deepEqual(await session.worker.evaluate(() => chrome.storage.local.get(null)), userData);
  await page
    .locator('[data-provider="deepseek"]')
    .screenshot({ path: resolve(output, "thinking-upgrade-fixed.png") });
  // 文件替换后真正重启后台，验证旧档位迁移和保存入口恢复，而不绕过后台直接写入新字段。
  await copyFile(resolve(built, "background/index.js"), resolve(extension, "background/index.js"));
  // runtime.reload 会关闭当前扩展页面；只接受这一预期关闭，随后必须等到新后台并验证字段。
  await page
    .locator("#reloadExtension")
    .click()
    .catch((error) => {
      if (!page.isClosed()) throw error;
    });
  await session.context.close();
  session = await launch(extension, profile);
  page = await options(session);
  await expect(thinking(page)).toHaveValue("enabled");
  await expect(page.locator("#saveButton")).toBeEnabled();
  await expect(page.locator("#reloadExtension")).toBeHidden();
  assert.deepEqual(await session.worker.evaluate(() => chrome.storage.local.get(null)), userData);
  await thinking(page).selectOption("disabled");
  await page.locator("#saveButton").click();
  await expect(page.locator("#saveStatus")).toContainText("已保存");
  await page.reload();
  await expect(thinking(page)).toHaveValue("disabled");
  await expect(page.locator('[name="deepseekReasoningEffort"]')).toHaveValue("high");
  assert.deepEqual(
    await session.worker.evaluate(() => chrome.storage.local.get("unrelatedSavedData")),
    { unrelatedSavedData: userData.unrelatedSavedData },
  );
});
