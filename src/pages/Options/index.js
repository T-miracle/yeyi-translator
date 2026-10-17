import { DEFAULT_SETTINGS, LANGUAGES, normalizeSettings } from "../../shared/settings.js";
import { shortcutFromEvent } from "../../shared/shortcut.js";
import { REASONING_LEVELS, THINKING_MODES } from "../../shared/reasoning.js";
import { sendMessage, populateLanguages } from "../../shared/messaging.js";
import { ModelPicker } from "./components/ModelPicker/index.js";
import { NameDictionaryEditor } from "./components/NameDictionary/index.js";
import { TranslationCache } from "../../background/cache.js";
import { validateCacheFile, cacheFileBatches } from "../../shared/cache-file.js";

const form = document.querySelector("#settingsForm");
const status = document.querySelector("#saveStatus");
const saveButton = document.querySelector("#saveButton");
const reloadButton = document.querySelector("#reloadExtension");
const modelPickers = new Map();
let cacheBusy = false;
let cacheStats;
let cacheRefreshTimer;
populateLanguages(form.elements.targetLanguage, LANGUAGES);
for (const id of ["deepseek", "openai"]) {
  const levels = REASONING_LEVELS.filter(
    ([level]) => id !== "deepseek" || ["default", "low", "high", "max"].includes(level),
  );
  for (const [value, label] of levels)
    form.elements[`${id}ReasoningEffort`].add(new Option(label, value));
}
for (const [value, label] of THINKING_MODES)
  form.elements.deepseekThinkingMode.add(new Option(label, value));
new NameDictionaryEditor(document.querySelector("#names"));

/** 从表单读取并校验可保存配置。@returns {Object} 配置对象。 */
function readForm() {
  return normalizeSettings({
    provider: form.elements.provider.value,
    providers: Object.fromEntries(
      ["deepseek", "openai"].map((id) => [
        id,
        {
          apiKey: form.elements[`${id}Key`].value,
          model: form.elements[`${id}Model`].value,
          baseUrl: form.elements[`${id}Url`].value,
          reasoningEffort: form.elements[`${id}ReasoningEffort`].value,
          thinkingMode: form.elements[`${id}ThinkingMode`]?.value,
        },
      ]),
    ),
    targetLanguage: form.elements.targetLanguage.value,
    mode: form.elements.mode.value,
    showFloatingButton: !form.elements.hideFloatingButton.checked,
    translationShortcut: form.elements.translationShortcut.value,
    visibleOnly: form.elements.visibleOnly.checked,
    optimizeChineseFont: form.elements.optimizeChineseFont.checked,
    cacheEnabled: form.elements.cacheEnabled.checked,
    cacheLimitMb: form.elements.cacheLimitMb.value,
    autoTranslateSites: form.elements.autoTranslateSites.value,
  });
}

/** 标记选中的服务配置卡片。@returns {void} 无返回值。 */
function markProvider() {
  document
    .querySelectorAll("[data-provider]")
    .forEach((card) =>
      card.classList.toggle("active", card.dataset.provider === form.elements.provider.value),
    );
}

/** 保存表单，只有明确保存才写入本机配置。@param {SubmitEvent} event 表单提交。@returns {Promise<void>} 保存完成。 */
async function save(event) {
  event.preventDefault();
  // 初始化和版本检查完成前禁止提交，避免旧后台丢弃新字段后仍提示保存成功。
  if (saveButton.disabled) return;
  saveButton.disabled = true;
  try {
    const settings = readForm();
    await sendMessage({ type: "SAVE_SETTINGS", settings });
    await refreshCache();
    status.textContent = "已保存，可以返回网页开始翻译";
    status.className = "success";
  } catch (error) {
    status.textContent = error.message;
    status.className = "error";
  } finally {
    saveButton.disabled = false;
  }
}

/** 验证指定服务的当前表单配置，无需先保存。@param {string} provider 服务标识。@returns {Promise<void>} 测试结束。 */
async function testConnection(provider) {
  const button = document.querySelector(`[data-test="${provider}"]`);
  if (button.disabled) return;
  const result = document.querySelector(`[data-result="${provider}"]`);
  button.disabled = true;
  button.textContent = "正在测试…";
  result.textContent = "正在发送短文本验证连接…";
  result.className = "hint test-result";
  try {
    const picker = modelPickers.get(provider);
    await picker.refresh({ automatic: true });
    const current = picker.readProvider();
    const settings = normalizeSettings({ provider, providers: { [provider]: current } });
    const { elapsedMs } = await sendMessage({ type: "TEST_PROVIDER", settings });
    result.textContent = `连接成功 · ${(elapsedMs / 1000).toFixed(1)} 秒 · 记得保存设置`;
    result.classList.add("success");
  } catch (error) {
    result.textContent = error.message;
    result.classList.add("error");
  } finally {
    button.disabled = false;
    button.textContent = "测试连接 ↗";
  }
}

form.addEventListener("submit", save);
/** 将用户输入及自动匹配的模型变更标记为未保存。@returns {void} 无返回值。 */
function markDirty(event) {
  if (!reloadButton.hidden || event?.target?.type === "file" || event?.target?.closest("#names"))
    return;
  status.textContent = "有未保存的修改";
  status.className = "";
  markProvider();
}
form.addEventListener("input", markDirty);
reloadButton.addEventListener("click", () => chrome.runtime.reload());

/** 直接录入按键组合；Tab 保留焦点导航，Escape 退出录入，不触发表单提交或浏览器剪切。 */
form.elements.translationShortcut.addEventListener("keydown", (event) => {
  if (event.key === "Tab") return;
  event.preventDefault();
  if (event.key === "Escape") {
    event.target.blur();
    return;
  }
  const shortcut = shortcutFromEvent(event);
  if (!shortcut) return;
  event.target.value = shortcut;
  markDirty();
});
document.querySelectorAll("[data-shortcut]").forEach((button) =>
  button.addEventListener("click", () => {
    form.elements.translationShortcut.value =
      button.dataset.shortcut === "reset" ? DEFAULT_SETTINGS.translationShortcut : "";
    markDirty();
  }),
);

/** 格式化浏览器实际统计的字节数。 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** 只提示超过用户阈值，不删除或阻止写入缓存。 */
function renderCache() {
  if (!cacheStats) return;
  document.querySelector("#cacheUsage").textContent =
    `${formatBytes(cacheStats.bytes)} · ${cacheStats.count} 条`;
  const overLimit = cacheStats.bytes > Number(form.elements.cacheLimitMb.value) * 1024 * 1024;
  const warning = document.querySelector("#cacheWarning");
  warning.hidden = !overLimit && !cacheStats.warning;
  const notice = document.querySelector("#cacheNotice");
  notice.textContent =
    cacheStats.warning ||
    (overLimit ? "已超过容量提醒阈值，缓存仍会继续保存，可按需导出或清理。" : "");
  notice.hidden = !notice.textContent;
  warning.title = notice.textContent;
}

/** 刷新缓存大小；保持表单中未保存的偏好。 */
async function refreshCache() {
  try {
    cacheStats = await sendMessage({ type: "GET_CACHE_STATS" });
    renderCache();
  } catch {
    document.querySelector("#cacheUsage").textContent = "暂时无法读取";
    const notice = document.querySelector("#cacheNotice");
    notice.textContent = "缓存状态读取失败，设置和已有缓存均已保留，请稍后重试。";
    notice.hidden = false;
    document.querySelector("#cacheWarning").hidden = false;
  }
}

/** 串行处理用户的缓存操作，错误仅显示到缓存区域。 */
async function cacheAction(work) {
  if (cacheBusy) return;
  cacheBusy = true;
  for (const button of document.querySelectorAll("[data-cache-action]")) button.disabled = true;
  const result = document.querySelector("#cacheResult");
  result.textContent = "处理中…";
  result.className = "hint";
  try {
    result.textContent = await work();
    await refreshCache();
  } catch (error) {
    result.textContent = error.message;
    result.className = "hint error";
  } finally {
    cacheBusy = false;
    for (const button of document.querySelectorAll("[data-cache-action]")) button.disabled = false;
  }
}

document.querySelector("#clearCache").addEventListener("click", () =>
  cacheAction(async () => {
    await sendMessage({ type: "CLEAR_CACHE" });
    return "已清空翻译缓存，API Key、设置和当前页面译文均已保留。";
  }),
);
document.querySelector("#exportCache").addEventListener("click", () =>
  cacheAction(async () => {
    // 设置页属于可信上下文，直接只读导出可避免大缓存超过扩展消息的 64 MiB 上限。
    const data = await new TranslationCache().exportData();
    const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `yeyi-cache-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return `已导出 ${data.entries.length} 条缓存。文件不含 API Key 或设置，请妥善保管其中的译文。`;
  }),
);
const cacheFile = document.querySelector("#cacheFile");
document.querySelector("#importCache").addEventListener("click", () => cacheFile.click());
cacheFile.addEventListener("change", () => {
  const file = cacheFile.files[0];
  cacheFile.value = "";
  if (!file) return;
  void cacheAction(async () => {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      throw new Error("无法读取缓存 JSON 文件，已有缓存未修改。");
    }
    validateCacheFile(data);
    const { revision } = await sendMessage({ type: "GET_CACHE_STATS" });
    let added = 0;
    let skipped = 0;
    try {
      for (const entries of cacheFileBatches(data.entries)) {
        const result = await sendMessage({
          type: "IMPORT_CACHE",
          revision,
          data: { ...data, entries },
        });
        added += result.added;
        skipped += result.skipped;
      }
    } catch (error) {
      throw new Error(`导入中止，已新增 ${added} 条，本机原有缓存保留。${error.message}`);
    }
    return `已导入 ${added} 条，跳过 ${skipped} 条重复记录；本机已有译文优先保留。`;
  });
});
form.elements.cacheLimitMb.addEventListener("input", renderCache);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !Object.keys(changes).some((key) => key.startsWith("translationCache")))
    return;
  clearTimeout(cacheRefreshTimer);
  cacheRefreshTimer = setTimeout(() => refreshCache().catch(() => {}), 150);
});
document
  .querySelectorAll("[data-test]")
  .forEach((button) => button.addEventListener("click", () => testConnection(button.dataset.test)));
document.querySelectorAll("[data-key]").forEach((button) =>
  button.addEventListener("click", () => {
    const input = form.elements[button.dataset.key];
    input.type = input.type === "password" ? "text" : "password";
    button.textContent = input.type === "password" ? "显示" : "隐藏";
  }),
);

/** 载入本机配置，不在任何控制台输出密钥。@returns {Promise<void>} 初始化完成。 */
async function initialize() {
  const stored = await sendMessage({ type: "GET_SETTINGS" });
  // 更新文件不会自动替换仍驻留的 service worker；先兼容回填旧值，再检查后台是否支持保存新字段。
  const settings = normalizeSettings(stored);
  const supportsThinkingMode = Object.hasOwn(stored.providers.deepseek, "thinkingMode");
  form.elements.deepseekThinkingMode.value = settings.providers.deepseek.thinkingMode;
  for (const id of ["deepseek", "openai"]) {
    form.elements[`${id}Key`].value = settings.providers[id].apiKey;
    form.elements[`${id}Model`].value = settings.providers[id].model;
    form.elements[`${id}Url`].value = settings.providers[id].baseUrl;
    const effort = settings.providers[id].reasoningEffort;
    const select = form.elements[`${id}ReasoningEffort`];
    // 保留通过兼容接口保存的有效档位，不因服务卡片的常用选项范围而丢失配置。
    if (![...select.options].some((option) => option.value === effort))
      select.add(new Option(REASONING_LEVELS.find(([value]) => value === effort)[1], effort));
    select.value = effort;
  }
  form.elements.provider.value = settings.provider;
  form.elements.targetLanguage.value = settings.targetLanguage;
  form.elements.mode.value = settings.mode;
  form.elements.hideFloatingButton.checked = !settings.showFloatingButton;
  form.elements.translationShortcut.value = settings.translationShortcut;
  form.elements.visibleOnly.checked = settings.visibleOnly;
  form.elements.optimizeChineseFont.checked = settings.optimizeChineseFont;
  form.elements.cacheEnabled.checked = settings.cacheEnabled;
  form.elements.cacheLimitMb.value = settings.cacheLimitMb;
  form.elements.autoTranslateSites.value = settings.autoTranslateSites.join("\n");
  markProvider();
  await refreshCache();
  if (!supportsThinkingMode) {
    status.textContent = "设置页已更新，请重新加载扩展完成更新。原配置已保留。";
    status.className = "error";
    reloadButton.hidden = false;
    return;
  }
  for (const provider of ["deepseek", "openai"]) {
    const picker = new ModelPicker(
      provider,
      document.querySelector(`[data-provider="${provider}"]`),
      markDirty,
    );
    modelPickers.set(provider, picker);
    if (settings.providers[provider].apiKey) void picker.refresh({ automatic: true });
  }
  saveButton.disabled = false;
  for (const button of document.querySelectorAll("[data-test]")) button.disabled = false;
  status.textContent = "设置保存后生效";
}
initialize().catch((error) => {
  status.textContent = error.message;
  status.className = "error";
});
