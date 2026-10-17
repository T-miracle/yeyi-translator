import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, dirname, basename } from "node:path";
import { startServer } from "./server.mjs";

const output = resolve("test-results");
await mkdir(output, { recursive: true });
const profile = resolve(output, `browser-profile-${Date.now()}`);
const fixture = await startServer();
const results = [];
let context;
let page;
let options;
let popup;
let worker;
let extensionId;
const runtimeErrors = [];

/** 在用户操作边界执行一个验收场景。@param {string} name 行为。@param {Function} work 验证。@returns {Promise<void>} 完成。 */
async function scenario(name, work) {
  await work();
  results.push(name);
  console.log(`✓ ${name}`);
}

/** 打开常用设置并等待显示模式保存、应用完成。@param {string} name 模式按钮名称。@returns {Promise<void>} 模式已生效。 */
async function chooseMode(name) {
  const settings = page.getByRole("button", { name: "打开翻译设置" });
  if ((await settings.getAttribute("aria-expanded")) === "false") await settings.click();
  const button = page.getByRole("button", { name, exact: true });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
  await expect(button).toBeEnabled();
}

/** 打开真实扩展 popup 为后台标签页，保持待翻译网页为当前标签。@returns {Promise<import('@playwright/test').Page>} 弹窗页面。 */
async function openPopup() {
  await page.bringToFront();
  const created = context.waitForEvent("page");
  await worker.evaluate(
    (url) => chrome.tabs.create({ url, active: false }),
    `chrome-extension://${extensionId}/pages/Popup/index.html`,
  );
  const next = await created;
  await next.waitForLoadState();
  await expect(next.locator("#siteName")).toHaveText("127.0.0.1");
  return next;
}

try {
  context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${resolve("dist")}`, `--load-extension=${resolve("dist")}`],
  });
  context.on("page", (opened) =>
    opened.on("pageerror", (error) => runtimeErrors.push(error.message)),
  );
  [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  extensionId = new URL(worker.url()).hostname;
  options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/pages/Options/index.html`);
  await expect(options.locator('[name="deepseekModel"]')).toHaveValue("deepseek-flash");

  await scenario("填入 Key 后自动获取模型，并把版本展示名匹配为 API ID", async () => {
    await options.locator('[name="deepseekUrl"]').fill(`${fixture.url}/deepseek`);
    await options.locator('[name="deepseekModel"]').fill("DeepSeek-V41-Flash");
    await options.locator('[name="deepseekKey"]').fill("fixture-secret-deepseek");
    await expect(options.locator('[data-model-picker="deepseek"]')).toBeVisible();
    await expect(options.locator('[data-model-picker="deepseek"]')).toHaveValue("deepseek-flash");
    await expect(options.locator('[name="deepseekModel"]')).toHaveValue("deepseek-flash");
    assert.equal(fixture.modelRequests.length, 1);
    assert.equal(fixture.modelRequests[0].path, "/deepseek/models");
    assert.equal(fixture.modelRequests[0].method, "GET");
    assert.equal(fixture.requests.length, 0);
  });

  await scenario("可在设置页分别配置两个服务，并完成真实扩展到 HTTP 接口的连接测试", async () => {
    await options.locator('[name="deepseekKey"]').fill("fixture-secret-deepseek");
    await options.locator('[name="deepseekUrl"]').fill(`${fixture.url}/deepseek`);
    await options.locator('[name="openaiKey"]').fill("fixture-secret-openai");
    await options.locator('[name="openaiUrl"]').fill(`${fixture.url}/v1`);
    await options.locator('[data-test="deepseek"]').click();
    await expect(options.locator('[data-result="deepseek"]')).toContainText("连接成功");
    await options.locator('[data-test="openai"]').click();
    await expect(options.locator('[data-result="openai"]')).toContainText("连接成功");
    assert.equal(fixture.requests[0].path, "/deepseek/chat/completions");
    assert.equal(fixture.requests[0].authorization, "Bearer fixture-secret-deepseek");
    assert.equal(fixture.requests[1].path, "/v1/chat/completions");
    assert.equal(fixture.requests[1].body.model, "gpt-4.1-mini");
    await options.locator("#saveButton").click();
    await expect(options.locator("#saveStatus")).toContainText("已保存");
    await options.screenshot({ path: resolve(output, "options.png"), fullPage: true });
  });

  await scenario("模型下拉框使用真实 ID，并保留手动填写自定义模型的入口", async () => {
    await options.locator('[data-model-picker="deepseek"]').selectOption("deepseek-v4-pro");
    await expect(options.locator('[name="deepseekModel"]')).toHaveValue("deepseek-v4-pro");
    await options.locator('[data-model-picker="deepseek"]').selectOption("");
    await expect(options.locator('[name="deepseekModel"]')).toBeVisible();
    await options.locator('[name="deepseekModel"]').fill("custom-model-id");
    await options.locator('[data-models="deepseek"]').click();
    await expect(options.locator('[data-model-status="deepseek"]')).toContainText("已获取");
    await expect(options.locator('[name="deepseekModel"]')).toHaveValue("custom-model-id");
    await options.locator('[data-model-picker="deepseek"]').selectOption("deepseek-flash");
  });

  await scenario("模型 ID 无效的 HTTP 400 显示原因，重新选择后连接成功", async () => {
    await options.locator('[data-model-picker="deepseek"]').selectOption("");
    await options.locator('[name="deepseekModel"]').fill("missing-model");
    await options.locator('[data-test="deepseek"]').click();
    await expect(options.locator('[data-result="deepseek"]')).toContainText("missing-model");
    await expect(options.locator('[data-result="deepseek"]')).toContainText("获取模型");
    await options.locator('[data-model-picker="deepseek"]').selectOption("deepseek-flash");
    await options.locator('[data-test="deepseek"]').click();
    await expect(options.locator('[data-result="deepseek"]')).toContainText("连接成功");
  });

  await scenario("修改地址后重新自动获取，旧地址的迟到列表不能覆盖当前选择", async () => {
    const before = fixture.modelRequests.length;
    await options.locator('[name="deepseekUrl"]').fill(`${fixture.url}/old`);
    await expect.poll(() => fixture.modelRequests.length).toBeGreaterThan(before);
    await options.locator('[name="deepseekUrl"]').fill(`${fixture.url}/deepseek`);
    await expect(options.locator('[data-model-picker="deepseek"]')).toHaveValue("deepseek-flash");
    await new Promise((resolve) => setTimeout(resolve, 1600));
    await expect(options.locator('[data-model-picker="deepseek"]')).toHaveValue("deepseek-flash");
    assert.equal(
      await options.locator('[data-model-picker="deepseek"] option[value="old-chat"]').count(),
      0,
    );
  });

  await scenario("接口没有模型列表时保留手动配置，仍可测试 Chat Completions", async () => {
    await options.locator('[name="deepseekUrl"]').fill(`${fixture.url}/no-models`);
    await expect(options.locator('[data-model-status="deepseek"]')).toContainText("不提供模型列表");
    await expect(options.locator('[name="deepseekModel"]')).toHaveValue("deepseek-flash");
    await options.locator('[data-test="deepseek"]').click();
    await expect(options.locator('[data-result="deepseek"]')).toContainText("连接成功");
    await options.locator('[name="deepseekUrl"]').fill(`${fixture.url}/deepseek`);
    await expect(options.locator('[data-model-picker="deepseek"]')).toHaveValue("deepseek-flash");
    await options.locator("#saveButton").click();
    await expect(options.locator("#saveStatus")).toContainText("已保存");
  });

  page = await context.newPage();
  await scenario("两个小圆形按钮可直接翻译与恢复，圆环展示进度，设置不遮挡默认阅读", async () => {
    await page.goto(`${fixture.url}/long`);
    const host = page.locator('[data-yeyi-owned="control"]');
    await expect(host.locator(".dock button")).toHaveCount(2);
    for (const button of await host.locator(".dock button").all()) {
      const box = await button.boundingBox();
      assert.equal(box.width, box.height);
      assert(box.width <= 44);
      assert.equal(await button.evaluate((node) => getComputedStyle(node).borderRadius), "50%");
    }
    await expect(host.locator(".panel")).toBeHidden();
    fixture.state.delayMs = 200;
    await page.getByRole("button", { name: "翻译此页", exact: true }).click();
    await expect(page.getByRole("button", { name: "恢复原文", exact: true })).toBeVisible();
    await expect
      .poll(async () => Number(await host.locator(".progress").getAttribute("aria-valuenow")))
      .toBeGreaterThan(0);
    const percent = Number(await host.locator(".progress").getAttribute("aria-valuenow"));
    assert(percent < 100);
    assert.equal(
      Number(await host.locator(".arc").evaluate((node) => node.style.strokeDashoffset)),
      100 - percent,
    );
    await page.screenshot({
      path: resolve(output, "floating-progress.png"),
      clip: { x: 1150, y: 755, width: 130, height: 145 },
    });
    await expect(host.locator(".panel")).toBeHidden();
    await page.getByRole("button", { name: "恢复原文", exact: true }).click();
    await expect(page.getByRole("button", { name: "翻译此页", exact: true })).toBeVisible();
    await expect(host.locator(".progress")).toHaveAttribute("aria-valuenow", "0");
    await expect(page.locator("[data-yeyi-owned=translation]")).toHaveCount(0);
    fixture.state.delayMs = 0;
  });
  await scenario("圆形设置按钮可保存常用偏好，设置权限不允许写入密钥", async () => {
    await page.getByRole("button", { name: "打开翻译设置" }).click();
    const host = page.locator('[data-yeyi-owned="control"]');
    await page.getByRole("combobox", { name: "目标语言" }).selectOption("ja");
    await expect(page.getByRole("combobox", { name: "目标语言" })).toBeEnabled();
    await page.getByRole("combobox", { name: "翻译服务" }).selectOption("openai");
    await expect(page.getByRole("combobox", { name: "翻译服务" })).toBeEnabled();
    await page.getByRole("checkbox", { name: "本站自动翻译" }).check();
    await expect(page.getByRole("checkbox", { name: "本站自动翻译" })).toBeEnabled();
    await options.reload();
    await expect(options.locator('[name="provider"][value="openai"]')).toBeChecked();
    await expect(options.locator('[name="targetLanguage"]')).toHaveValue("ja");
    const forbidden = await worker.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url: `${url}/*` });
      return chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () =>
          chrome.runtime.sendMessage({
            type: "PAGE_PREFERENCES",
            patch: { providers: { deepseek: { apiKey: "forbidden" } } },
          }),
      });
    }, fixture.url);
    assert.equal(forbidden[0].result.error.code, "BAD_INPUT");
    await page.getByRole("combobox", { name: "目标语言" }).selectOption("zh-CN");
    await expect(page.getByRole("combobox", { name: "目标语言" })).toBeEnabled();
    await page.getByRole("combobox", { name: "翻译服务" }).selectOption("deepseek");
    await expect(page.getByRole("combobox", { name: "翻译服务" })).toBeEnabled();
    await page.getByRole("checkbox", { name: "本站自动翻译" }).uncheck();
    await expect(page.getByRole("checkbox", { name: "本站自动翻译" })).toBeEnabled();
    await page.screenshot({
      path: resolve(output, "floating-settings.png"),
      clip: { x: 950, y: 320, width: 330, height: 580 },
    });
    await page.keyboard.press("Escape");
    await expect(host.locator(".panel")).toBeHidden();
  });
  await scenario("纯中文页面不请求 API，混排只翻译外文并允许中文作为上下文", async () => {
    await page.goto(`${fixture.url}/article`);
    await page.evaluate(() => {
      document.body.innerHTML =
        '<main><h1>中文标题</h1><p id="chinese">这是中文说明，支持 <strong>Windows</strong> 和 Linux 系统。</p></main>';
    });
    const original = await page.locator("main").innerHTML();
    const before = fixture.requests.length;
    await page.getByRole("button", { name: "翻译此页", exact: true }).click();
    await expect(page.locator('[data-yeyi-owned="control"] .progress')).toHaveAttribute(
      "aria-valuenow",
      "100",
    );
    assert.equal(fixture.requests.length, before);
    assert.equal(await page.locator("main").innerHTML(), original);
    await page.getByRole("button", { name: "恢复原文", exact: true }).click();
    await expect(page.getByRole("button", { name: "翻译此页", exact: true })).toBeVisible();
    await page.evaluate(() => {
      document.querySelector("main").innerHTML =
        '<p id="mixed">这是中文参考。<strong>Read the guide and explore.</strong>中文结尾。</p>';
    });
    await chooseMode("替换原文");
    await page.getByRole("button", { name: "翻译此页", exact: true }).click();
    await expect(page.locator("#mixed strong")).toHaveText("阅读指南并探索。");
    await expect(page.locator("#mixed")).toHaveText("这是中文参考。阅读指南并探索。中文结尾。");
    const payload = JSON.parse(fixture.requests.at(-1).body.messages.at(-1).content);
    assert(
      payload.segments.every((segment) =>
        segment.parts.every((part) => !/\p{Script=Han}/u.test(part)),
      ),
    );
    assert(payload.segments.some((segment) => segment.context?.includes("这是中文参考")));
    await page.getByRole("button", { name: "恢复原文", exact: true }).click();
    await expect(page.locator("#mixed strong")).toHaveText("Read the guide and explore.");
    await chooseMode("原文 / 译文");
  });
  await scenario("GitHub README 的整张功能表在模型省略表情与标点时仍完整翻译并可恢复", async () => {
    fixture.state.mode = "emptyNonLanguage";
    await page.goto(`${fixture.url}/readme`);
    const original = await page.locator("article").textContent();
    const codes = await page.locator("code").allTextContents();
    const naturalCodeTranslations = {
      "Standard Videos": "普通视频",
      Bangumi: "番剧",
      Movies: "电影",
      Courses: "课程",
      "Interactive Videos": "互动视频",
      "Audio (au/am)": "音频（au/am）",
      "User Space": "用户空间",
      Favorites: "收藏夹",
      "Weekly Must-Watch": "每周必看",
      Subscriptions: "订阅",
      "Watch Later": "稍后观看",
      History: "历史记录",
    };
    const cells = await page.locator("td, th").count();
    await page.getByRole("button", { name: "打开翻译设置" }).click();
    await page.getByRole("button", { name: "翻译此页", exact: true }).click();
    await expect(
      page.locator("td [data-yeyi-owned=translation], th [data-yeyi-owned=translation]"),
    ).toHaveCount(cells);
    await chooseMode("替换原文");
    for (const cell of await page.locator("td, th").all())
      await expect(cell).toContainText(/\p{Script=Han}/u);
    assert.deepEqual(
      await page.locator("code").allTextContents(),
      codes.map((code) => naturalCodeTranslations[code] || code),
    );
    await page.screenshot({ path: resolve(output, "readme-replace.png"), fullPage: true });
    await page.getByRole("button", { name: "恢复原文", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("点击翻译，开始阅读。");
    assert.equal(await page.locator("article").textContent(), original);
    await chooseMode("原文 / 译文");
    fixture.state.mode = "success";
  });
  await scenario("模型持续合并同格多个文本片段时，逐节点补译媒体行及灰底功能名称", async () => {
    fixture.state.mode = "mergeParts";
    await page.reload();
    const original = await page.locator("article").textContent();
    const lineBreaks = await page.locator("#readmeMedia br").count();
    await page.getByRole("button", { name: "打开翻译设置" }).click();
    await page.getByRole("button", { name: "翻译此页", exact: true }).click();
    await expect(
      page.locator("td [data-yeyi-owned=translation], th [data-yeyi-owned=translation]"),
    ).toHaveCount(36, { timeout: 20_000 });
    await chooseMode("替换原文");
    await expect(page.locator("#readmeMedia")).toContainText("开始前准确预览将要下载的内容。");
    await expect(page.locator("#readmeMedia strong")).toHaveText(["视频", "音频", "编码"]);
    await expect(page.locator("#readmeParsing code")).toHaveText([
      "普通视频",
      "番剧",
      "电影",
      "课程",
      "互动视频",
      "音频（au/am）",
      "用户空间",
      "收藏夹",
      "每周必看",
      "订阅",
      "稍后观看",
      "历史记录",
    ]);
    assert.equal(await page.locator("#readmeMedia br").count(), lineBreaks);
    await expect(page.getByRole("status")).not.toContainText("不完整");
    await page.getByRole("button", { name: "恢复原文", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("点击翻译，开始阅读。");
    assert.equal(await page.locator("article").textContent(), original);
    await chooseMode("原文 / 译文");
    fixture.state.mode = "success";
  });
  await scenario("README 某批译文缺项时自动缩小批次补译，不留下整片英文", async () => {
    await page.reload();
    fixture.state.malformedAt = fixture.requests.length + 1;
    const before = fixture.requests.length;
    const cells = await page.locator("td, th").count();
    await page.getByRole("button", { name: "打开翻译设置" }).click();
    await page.getByRole("button", { name: "翻译此页", exact: true }).click();
    await expect(
      page.locator("td [data-yeyi-owned=translation], th [data-yeyi-owned=translation]"),
    ).toHaveCount(cells);
    assert(fixture.requests.length > before + 2);
    fixture.state.malformedAt = -1;
    await page.getByRole("button", { name: "恢复原文", exact: true }).click();
  });
  await scenario("自动拆批补译期间恢复原文会取消后续补译，迟到响应不覆盖页面", async () => {
    await page.reload();
    const original = await page.locator("article").textContent();
    const before = fixture.requests.length;
    fixture.state.malformedAt = before + 1;
    fixture.state.delayMs = 200;
    await page.getByRole("button", { name: "打开翻译设置" }).click();
    await page.getByRole("button", { name: "翻译此页", exact: true }).click();
    await expect.poll(() => fixture.requests.length).toBeGreaterThan(before + 2);
    await page.getByRole("button", { name: "恢复原文", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("点击翻译，开始阅读。");
    const afterRestore = fixture.requests.length;
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await page.locator("article").textContent(), original);
    assert.equal(await page.locator("[data-yeyi-owned=translation]").count(), 0);
    assert.equal(fixture.requests.length, afterRestore);
    fixture.state.malformedAt = -1;
    fixture.state.delayMs = 0;
  });
  await page.goto(`${fixture.url}/article`);
  await page.getByRole("button", { name: "打开翻译设置" }).click();
  await scenario("换行双语翻译整页，包括首屏之外的文字，并跳过输入、代码及隐藏内容", async () => {
    await page.getByRole("button", { name: "翻译此页", exact: true }).click();
    await expect(page.locator("#intro [data-yeyi-owned=translation]")).toHaveText(
      "阅读 指南 并探索。",
    );
    await expect(page.locator("#below [data-yeyi-owned=translation]")).toHaveText(
      "这段文字位于首屏下方。",
    );
    assert.equal(await page.locator("#guide strong").textContent(), "the guide");
    assert.equal(await page.locator("#textarea").inputValue(), "Private draft text.");
    assert.equal(await page.locator("#input").inputValue(), "Private input value.");
    assert.equal(await page.locator("#editable").textContent(), "Editable source text.");
    assert.equal(await page.locator("#code").textContent(), 'const greeting = "Hello";');
    assert.equal(await page.locator("#excluded").textContent(), "Do not translate this paragraph.");
    const sent = JSON.stringify(fixture.requests.map((request) => request.body));
    assert(!sent.includes("Hidden source text."));
    assert(!sent.includes("Private draft text."));
    await page.screenshot({ path: resolve(output, "bilingual.png"), fullPage: true });
  });

  await scenario("切换为替换模式保留链接与按钮行为，切换与恢复均不重复调用 API", async () => {
    const before = fixture.requests.length;
    await chooseMode("替换原文");
    await expect(page.locator("#intro")).toHaveText("阅读 指南 并探索。");
    assert.equal(await page.locator("#guide").getAttribute("href"), "https://example.org/guide");
    await page.locator("#menu").click();
    await expect(page.locator("#clicks")).toHaveText("1");
    await chooseMode("原文 / 译文");
    await expect(page.locator("#intro [data-yeyi-owned=translation]")).toHaveText(
      "阅读 指南 并探索。",
    );
    assert.equal(fixture.requests.length, before);
    await page.getByRole("button", { name: "恢复原文", exact: true }).click();
    await expect(page.locator("#intro")).toHaveText("Read the guide and explore.");
    assert.equal(await page.locator("[data-yeyi-owned=translation]").count(), 0);
    assert.equal(fixture.requests.length, before);
  });

  await scenario("恢复后再次翻译复用当前页面内存中的译文", async () => {
    const before = fixture.requests.length;
    await page.getByRole("button", { name: "翻译此页", exact: true }).click();
    await expect(page.locator("#intro [data-yeyi-owned=translation]")).toHaveText(
      "阅读 指南 并探索。",
    );
    assert.equal(fixture.requests.length, before);
  });

  await scenario("动态新增和网站改写的文字会翻译，恢复时保留网站最新内容", async () => {
    await page.evaluate(() => {
      const paragraph = document.createElement("p");
      paragraph.id = "newParagraph";
      paragraph.textContent = "Dynamic paragraph.";
      document.querySelector("#dynamic").append(paragraph);
    });
    await expect(page.locator("#newParagraph [data-yeyi-owned=translation]")).toHaveText(
      "动态段落。",
    );
    await chooseMode("替换原文");
    await expect(page.locator("#newParagraph")).toHaveText("动态段落。");
    await page.evaluate(() => {
      document.querySelector("#newParagraph").firstChild.data = "Updated paragraph.";
    });
    await expect(page.locator("#newParagraph")).toHaveText("更新后的段落。");
    await page.getByRole("button", { name: "恢复原文", exact: true }).click();
    await expect(page.locator("#newParagraph")).toHaveText("Updated paragraph.");
    await chooseMode("原文 / 译文");
  });

  popup = await openPopup();
  await scenario("工具栏弹窗可以切换服务和目标语言并保存偏好", async () => {
    await popup.locator("#provider").selectOption("openai");
    await expect(popup.locator("#provider")).toHaveValue("openai");
    await popup.locator("#targetLanguage").selectOption("ja");
    await expect(popup.locator("#targetLanguage")).toHaveValue("ja");
    await options.reload();
    await expect(options.locator('[name="provider"][value="openai"]')).toBeChecked();
    await expect(options.locator('[name="targetLanguage"]')).toHaveValue("ja");
  });

  await scenario("工具栏可启动翻译，当前服务使用自己的模型、Key 与目标语言", async () => {
    await popup.locator("#targetLanguage").selectOption("zh-CN");
    await expect(popup.locator("#targetLanguage")).toHaveValue("zh-CN");
    const before = fixture.requests.length;
    await popup.locator("#translate").click();
    await expect(page.locator("#intro [data-yeyi-owned=translation]")).toHaveText(
      "阅读 指南 并探索。",
    );
    assert(fixture.requests.length > before);
    assert.equal(fixture.requests.at(-1).authorization, "Bearer fixture-secret-openai");
    assert.equal(fixture.requests.at(-1).body.model, "gpt-4.1-mini");
    await expect(popup.locator("#statusChip")).toHaveText("已翻译");
    await popup.setViewportSize({ width: 380, height: 740 });
    await popup.screenshot({ path: resolve(output, "popup.png"), fullPage: true });
    await popup.locator("#restore").click();
    await expect(page.locator("#intro")).toHaveText("Read the guide and explore.");
  });

  await scenario("内联标点与数字出现在双语译文中，格式仍保留在原文中", async () => {
    await page.evaluate(() => {
      document.querySelector("#dynamic").innerHTML =
        '<p id="punctuation">Read <em>the guide</em>!</p><p id="numbers">Year <b>2026</b> ends.</p>';
    });
    await popup.locator("#translate").click();
    await expect(page.locator("#punctuation [data-yeyi-owned=translation]")).toHaveText(
      "阅读 指南!",
    );
    await expect(page.locator("#numbers [data-yeyi-owned=translation]")).toContainText("2026");
    assert.equal(await page.locator("#punctuation em").textContent(), "the guide");
    await popup.locator("#restore").click();
  });

  await scenario("刷新网页清空译文缓存，本机存储中只有设置且内容脚本无法读取密钥", async () => {
    const before = fixture.requests.length;
    await page.reload();
    await page.getByRole("button", { name: "打开翻译设置" }).click();
    await page.getByRole("button", { name: "翻译此页", exact: true }).click();
    await expect(page.locator("#intro [data-yeyi-owned=translation]")).toHaveText(
      "阅读 指南 并探索。",
    );
    assert(fixture.requests.length > before);
    const storage = await worker.evaluate(() => chrome.storage.local.get(null));
    assert.deepEqual(Object.keys(storage), ["settings"]);
    assert(!JSON.stringify(storage).includes("Read the guide"));
    assert(!(await page.content()).includes("fixture-secret"));
    const access = await worker.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url: `${url}/*` });
      return chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async () => {
          try {
            const data = await chrome.storage.local.get("settings");
            return Boolean(data.settings);
          } catch {
            return false;
          }
        },
      });
    }, fixture.url);
    assert.equal(access[0].result, false);
    await page.getByRole("button", { name: "恢复原文", exact: true }).click();
  });

  await scenario("站点自动翻译开关保存后，下次加载自动翻译；关闭后恢复手动", async () => {
    await popup.locator("#autoSite").check();
    await expect(popup.locator("#autoSite")).toBeChecked();
    await page.reload();
    await expect(page.locator("#intro [data-yeyi-owned=translation]")).toHaveText(
      "阅读 指南 并探索。",
    );
    await popup.locator("#autoSite").uncheck();
    await expect(popup.locator("#autoSite")).not.toBeChecked();
    await page.reload();
    await expect(page.getByRole("button", { name: "打开翻译设置" })).toBeVisible();
    assert.equal(await page.locator("[data-yeyi-owned=translation]").count(), 0);
  });

  await scenario("翻译中的页面新加入的 iframe 可以翻译，并随整页一起恢复", async () => {
    await page.getByRole("button", { name: "打开翻译设置" }).click();
    await page.getByRole("button", { name: "翻译此页", exact: true }).click();
    await expect(page.locator("#intro [data-yeyi-owned=translation]")).toBeVisible();
    await page.evaluate((url) => {
      const iframe = document.createElement("iframe");
      iframe.id = "testFrame";
      iframe.src = `${url}/frame`;
      document.querySelector("#dynamic").append(iframe);
    }, fixture.url);
    await expect(
      page.frameLocator("#testFrame").locator("#frameText [data-yeyi-owned=translation]"),
    ).toHaveText("框架中的段落。");
    await page.getByRole("button", { name: "恢复原文", exact: true }).click();
    await expect(page.frameLocator("#testFrame").locator("#frameText")).toHaveText(
      "Frame paragraph.",
    );
    await page.evaluate(() => document.querySelector("#testFrame").remove());
  });

  await scenario("请求尚未返回时恢复原文，迟到响应不能再次覆盖页面", async () => {
    await page.reload();
    fixture.state.delayMs = 1200;
    const before = fixture.requests.length;
    await page.getByRole("button", { name: "打开翻译设置" }).click();
    await page.getByRole("button", { name: "翻译此页", exact: true }).click();
    await expect.poll(() => fixture.requests.length).toBeGreaterThan(before);
    await page.getByRole("button", { name: "恢复原文", exact: true }).click();
    await new Promise((resolve) => setTimeout(resolve, 1400));
    await expect(page.locator("#intro")).toHaveText("Read the guide and explore.");
    assert.equal(await page.locator("[data-yeyi-owned=translation]").count(), 0);
    fixture.state.delayMs = 0;
  });

  for (const [mode, text] of [
    ["auth", "API Key 无效"],
    ["quota", "余额或额度不足"],
  ]) {
    await scenario(
      `${mode === "auth" ? "Key 无效" : "额度不足"}时提示原因并停止，避免无意义的自动重试`,
      async () => {
        await page.reload();
        fixture.state.mode = mode;
        const before = fixture.requests.length;
        await page.getByRole("button", { name: "打开翻译设置" }).click();
        await page.getByRole("button", { name: "翻译此页", exact: true }).click();
        await expect(page.locator("[data-yeyi-owned=control]").locator(".status")).toContainText(
          text,
        );
        await new Promise((resolve) => setTimeout(resolve, 1100));
        assert.equal(fixture.requests.length, before + 1);
        await expect(page.locator("#intro")).toHaveText("Read the guide and explore.");
      },
    );
  }
  fixture.state.mode = "success";

  await scenario("临时服务故障进入失败队列，并在三次重试上限内恢复翻译", async () => {
    await page.reload();
    fixture.state.transientRemaining = 2;
    const before = fixture.requests.length;
    await page.getByRole("button", { name: "打开翻译设置" }).click();
    await page.getByRole("button", { name: "翻译此页", exact: true }).click();
    await expect(page.locator("#intro [data-yeyi-owned=translation]")).toHaveText(
      "阅读 指南 并探索。",
      { timeout: 15_000 },
    );
    await expect(page.locator("[data-yeyi-owned=control]").locator(".status")).toHaveText(
      /段已完成 · 已完成$/,
      { timeout: 15_000 },
    );
    const attempts = new Map();
    for (const request of fixture.requests.slice(before)) {
      for (const segment of JSON.parse(request.body.messages.at(-1).content).segments)
        attempts.set(segment.id, (attempts.get(segment.id) || 0) + 1);
    }
    assert(fixture.requests.length >= before + 3);
    assert([...attempts.values()].every((count) => count <= 4));
    await page.getByRole("button", { name: "恢复原文", exact: true }).click();
  });

  await scenario("长网页部分失败时保留成功译文，点击重试只请求失败部分", async () => {
    await popup.close();
    await page.goto(`${fixture.url}/long`);
    fixture.state.malformedText = "Long paragraph 20:";
    await page.getByRole("button", { name: "打开翻译设置" }).click();
    await page.getByRole("button", { name: "翻译此页", exact: true }).click();
    popup = await openPopup();
    await expect(popup.locator("#retry")).toBeVisible({ timeout: 15_000 });
    await expect(popup.locator("#statusChip")).toHaveText("已翻译");
    assert((await page.locator(".long-paragraph [data-yeyi-owned=translation]").count()) > 0);
    await expect(page.locator(".long-paragraph [data-yeyi-owned=translation]")).toHaveCount(44);
    const failedRequest = fixture.requests.findLast((request) => {
      const segments = JSON.parse(
        request.body.messages.find((message) => message.role === "user").content,
      ).segments;
      return (
        segments.length === 1 &&
        segments[0].parts.some((part) => part.includes(fixture.state.malformedText))
      );
    });
    const failedIds = new Set(
      JSON.parse(
        failedRequest.body.messages.find((message) => message.role === "user").content,
      ).segments.map((segment) => segment.id),
    );
    const before = fixture.requests.length;
    fixture.state.malformedText = "";
    await popup.locator("#retry").click();
    await expect(page.locator(".long-paragraph [data-yeyi-owned=translation]")).toHaveCount(45);
    for (const request of fixture.requests.slice(before)) {
      const segments = JSON.parse(
        request.body.messages.find((message) => message.role === "user").content,
      ).segments;
      assert(segments.every((segment) => failedIds.has(segment.id)));
    }
    await popup.locator("#restore").click();
    await expect(page.locator(".long-paragraph [data-yeyi-owned=translation]")).toHaveCount(0);
  });

  await scenario("单个超长段落可分批翻译，Unicode 字符和原文恢复保持完整", async () => {
    const original = "A long Unicode paragraph with 🌍 and 🚀. ".repeat(300);
    await page.evaluate((text) => {
      const paragraph = document.createElement("p");
      paragraph.id = "unicodeParagraph";
      paragraph.textContent = text;
      document.querySelector("#dynamic").append(paragraph);
    }, original);
    const before = fixture.requests.length;
    await popup.locator("#translate").click();
    await expect(page.locator("#unicodeParagraph [data-yeyi-owned=translation]")).toContainText(
      "🌍",
      { timeout: 15_000 },
    );
    assert(fixture.requests.length > before + 1);
    for (const request of fixture.requests.slice(before)) {
      const segments = JSON.parse(
        request.body.messages.find((message) => message.role === "user").content,
      ).segments;
      const parts = segments.flatMap((segment) => segment.parts);
      assert(parts.reduce((sum, part) => sum + part.length, 0) <= 6500);
      assert(parts.every((part) => part.length <= 1500));
      assert(
        parts.every((part) =>
          [...part].every(
            (character) =>
              character.length > 1 ||
              character.charCodeAt(0) < 0xd800 ||
              character.charCodeAt(0) > 0xdfff,
          ),
        ),
      );
    }
    await popup.locator("#restore").click();
    assert.equal(await page.locator("#unicodeParagraph").textContent(), original);
  });

  await scenario("模型返回 HTML 时按纯文本呈现，不产生页面元素或执行事件", async () => {
    fixture.state.mode = "injection";
    await page.evaluate(() => {
      const paragraph = document.createElement("p");
      paragraph.id = "injectionParagraph";
      paragraph.textContent = "Model output should be text.";
      document.querySelector("#dynamic").append(paragraph);
    });
    await popup.locator("#translate").click();
    await expect(page.locator("#injectionParagraph [data-yeyi-owned=translation]")).toContainText(
      "<img",
    );
    assert.equal(await page.locator("#injectionParagraph img").count(), 0);
    assert.equal(await page.locator("body").getAttribute("data-injected"), null);
    await popup.locator("#restore").click();
    fixture.state.mode = "success";
  });

  await scenario("兼容服务返回完整 JSON 时也可翻译", async () => {
    fixture.state.mode = "json";
    await page.evaluate(() => {
      const paragraph = document.createElement("p");
      paragraph.id = "jsonParagraph";
      paragraph.textContent = "JSON paragraph.";
      document.querySelector("#dynamic").append(paragraph);
    });
    await popup.locator("#translate").click();
    await expect(page.locator("#jsonParagraph [data-yeyi-owned=translation]")).toHaveText(
      "译文：JSON paragraph.",
    );
    await popup.locator("#restore").click();
    fixture.state.mode = "success";
  });

  assert.deepEqual(runtimeErrors, []);
  await writeFile(
    resolve(output, "results.json"),
    JSON.stringify(
      { browser: context.browser().version(), passed: results, runtimeErrors },
      null,
      2,
    ),
  );
  console.log(`浏览器验收通过：${results.length} 个场景。`);
} catch (error) {
  if (page)
    await page.screenshot({ path: resolve(output, "failure.png"), fullPage: true }).catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  await context?.close();
  await fixture.close();
  // 仅清理本测试创建的独立 profile；先校验最终绝对路径位于 test-results。
  if (dirname(profile) !== output || !basename(profile).startsWith("browser-profile-"))
    throw new Error("拒绝清理测试目录以外的路径");
  await rm(profile, { recursive: true, force: true });
}
