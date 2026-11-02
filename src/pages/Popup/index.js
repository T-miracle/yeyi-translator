import { LANGUAGES, isTranslatableUrl } from "../../shared/settings.js";
import { sendMessage, populateLanguages } from "../../shared/messaging.js";
import {
  translationSourcesText,
  TRANSLATION_SOURCES_HINT,
} from "../../shared/translation-progress.js";

const elements = Object.fromEntries(
  [...document.querySelectorAll("[id]")].map((element) => [element.id, element]),
);
let config;
let tab;
let state;
let hostname = "";
let busy = false;
let pollTimer;
populateLanguages(elements.targetLanguage, LANGUAGES);
elements.progressSources.title = TRANSLATION_SOURCES_HINT;

/** 在 popup 中显示操作或配置提示。@param {string} message 提示。@param {boolean} [error] 是否错误。@returns {void} 无返回值。 */
function notice(message, error = false) {
  elements.notice.textContent = message;
  elements.notice.hidden = !message;
  elements.notice.classList.toggle("error", error);
}

/** 根据状态与配置同步界面。@returns {void} 无返回值。 */
function render() {
  if (!config) return;
  const supported = Boolean(tab && isTranslatableUrl(tab.url));
  const configured = config.configuredProviders[config.provider];
  // 保存期间保持刚选择的值，避免异步保存让开关或下拉框短暂跳回旧值。
  if (!busy) {
    elements.provider.value = config.provider;
    elements.targetLanguage.value = config.targetLanguage;
    elements.autoSite.checked = config.autoTranslateSites.includes(hostname);
  }
  elements.connectionDot.classList.toggle("connected", configured);
  elements.connectionDot.title = configured ? "已配置 API Key" : "尚未配置 API Key";
  elements.autoSite.disabled = !supported || busy;
  elements.provider.disabled = busy || Boolean(state?.active);
  elements.targetLanguage.disabled = busy || Boolean(state?.active);
  elements.translate.disabled = busy || !supported;
  elements.restore.disabled = busy || !state?.total;
  elements.progressCard.hidden = !state?.total && !state?.active;
  const phase = state?.phase || "idle";
  const labels = {
    idle: "准备就绪",
    translating: "正在翻译",
    watching: "已翻译",
    paused: "已暂停",
    error: "需要处理",
  };
  elements.statusChip.textContent = supported ? labels[phase] : "暂不支持";
  elements.translateLabel.textContent = state?.active
    ? "暂停翻译"
    : !configured
      ? "配置 API Key"
      : state?.total
        ? "继续翻译"
        : "翻译此页";
  elements.translateArrow.textContent = state?.active ? "Ⅱ" : "↗";
  const selectedMode = state?.total ? state.mode : config.mode;
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.classList.toggle("selected", button.dataset.mode === selectedMode);
    button.setAttribute("aria-pressed", String(button.dataset.mode === selectedMode));
    button.disabled = busy;
  });
  if (state) {
    elements.progressCount.textContent = `${state.done} / ${state.total} 段`;
    elements.progressLabel.textContent = labels[phase];
    elements.progress.max = Math.max(1, state.total);
    elements.progress.value = state.done;
    elements.progressSources.textContent = translationSourcesText(state);
    elements.progressDetail.textContent = state.retrying
      ? `${state.retrying} 段等待重试（最多 3 次），其他内容优先翻译`
      : state.failed
        ? `${state.failed} 段未完成，已保留原文`
        : phase === "watching"
          ? "持续监测新内容 · 可随时暂停"
          : phase === "paused"
            ? "已完成的译文保留在页面中"
            : "正在翻译页面内容";
    elements.retry.hidden = !state.failed;
    elements.retry.disabled = busy;
  }
  if (state?.error) notice(state.error, true);
}

/** 执行操作并统一管理短暂忙碌状态。@param {Function} work 异步操作。@returns {Promise<void>} 操作完成。 */
async function perform(work) {
  if (busy) return;
  busy = true;
  notice("");
  render();
  try {
    await work();
  } catch (error) {
    notice(error.message, true);
  } finally {
    busy = false;
    render();
  }
}

/** 给当前标签页发送整页操作。@param {string} action 命令。@param {string} [mode] 排版。@returns {Promise<void>} 更新状态。 */
async function pageAction(action, mode) {
  state = await sendMessage({ type: "PAGE_ACTION", tabId: tab.id, action, mode });
}

/** 读取主文档聚合状态；后台停止时不会留下不断增长的监听。@returns {Promise<void>} 更新完成。 */
async function poll() {
  try {
    if (tab && !busy) {
      state = await sendMessage({ type: "GET_TAB_STATE", tabId: tab.id });
      render();
    }
  } catch (error) {
    notice(error.message, true);
  } finally {
    pollTimer = setTimeout(poll, 650);
  }
}

/** 打开配置页。@returns {Promise<void>} 打开完成。 */
async function openSettings() {
  await sendMessage({ type: "OPEN_OPTIONS" });
}

elements.settings.addEventListener("click", () => perform(openSettings));
elements.settingsLink.addEventListener("click", () => perform(openSettings));
elements.translate.addEventListener("click", () =>
  perform(async () => {
    if (!config.configuredProviders[config.provider]) await openSettings();
    else await pageAction(state?.active ? "stop" : "start");
  }),
);
elements.restore.addEventListener("click", () => perform(() => pageAction("restore")));
elements.retry.addEventListener("click", () => perform(() => pageAction("retry")));
document.querySelectorAll("[data-mode]").forEach((button) =>
  button.addEventListener("click", () =>
    perform(async () => {
      config = await sendMessage({
        type: "PATCH_PREFERENCES",
        patch: { mode: button.dataset.mode },
      });
      if (state?.total) await pageAction("set-mode", button.dataset.mode);
    }),
  ),
);
/** 在重新渲染忙碌态之前捕获选项，避免被旧配置覆盖。@param {Event} event 下拉框变更。@returns {void} 无返回值。 */
function preferenceChanged(event) {
  const key = event.target.id;
  const value = event.target.value;
  void perform(async () => {
    config = await sendMessage({ type: "PATCH_PREFERENCES", patch: { [key]: value } });
  });
}
for (const key of ["provider", "targetLanguage"])
  elements[key].addEventListener("change", preferenceChanged);
elements.autoSite.addEventListener("change", (event) => {
  const enabled = event.target.checked;
  void perform(async () => {
    const sites = new Set(config.autoTranslateSites);
    if (enabled) sites.add(hostname);
    else sites.delete(hostname);
    config = await sendMessage({
      type: "PATCH_PREFERENCES",
      patch: { autoTranslateSites: [...sites] },
    });
  });
});
window.addEventListener("pagehide", () => clearTimeout(pollTimer));

/** 初始化配置和当前网页信息。@returns {Promise<void>} 初始化完成。 */
async function initialize() {
  config = await sendMessage({ type: "GET_PUBLIC_CONFIG" });
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    hostname = new URL(tab?.url).hostname;
  } catch {
    /* 内部页面没有可翻译主机名。 */
  }
  elements.siteName.textContent = hostname || "当前页面";
  elements.autoSiteHint.textContent = hostname || "仅对普通网页生效";
  if (!tab || !isTranslatableUrl(tab.url))
    notice("请打开普通网页后使用。浏览器内部页和扩展商店页面无法翻译。");
  else if (!config.configured) notice("首次使用：打开设置，填写你的 DeepSeek 或 OpenAI Key。");
  render();
  await poll();
}
initialize().catch((error) => notice(error.message, true));
