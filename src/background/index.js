import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  publicSettings,
  isTranslatableUrl,
  LANGUAGES,
} from "../shared/settings.js";
import { translateBatch, listModels, TranslationError } from "./api.js";
import { TranslationCache, translateWithCache, lookupCachedTranslations } from "./cache.js";
import { NameDictionary } from "./name-dictionary.js";
import { nameDictionarySignature } from "../shared/name-dictionary.js";

const inflight = new Map();
const cache = new TranslationCache();
const nameDictionary = new NameDictionary();
let settingsQueue = Promise.resolve();
const ready = initialize();

/** 限制本机密钥存储的访问上下文并建立默认值。@returns {Promise<void>} 初始化完成。 */
async function initialize() {
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  const stored = await chrome.storage.local.get("settings");
  if (!stored.settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
}

/** 读取最新设置，避免 worker 休眠后依赖旧内存。@returns {Promise<Object>} 校验过的本机配置。 */
async function getSettings() {
  await ready;
  const { settings } = await chrome.storage.local.get("settings");
  const dictionary = await nameDictionary.read();
  return {
    ...normalizeSettings(settings),
    nameDictionary: dictionary.enabled ? dictionary.entries : [],
    nameDictionarySignature: await nameDictionarySignature(dictionary),
  };
}

/** 限制密钥读写只能来自扩展自己的设置或弹窗页面。@param {Object} sender 消息来源。@returns {void} 无返回值。 */
function requireTrusted(sender) {
  if (!sender.url?.startsWith(chrome.runtime.getURL("pages/"))) {
    throw new TranslationError("FORBIDDEN", "此操作仅允许在插件设置页或工具栏弹窗中使用。", {
      fatal: true,
    });
  }
}

/** 串行合并设置，防止弹窗和设置页同时保存时丢失更新。@param {Function} update 基于当前设置的更新。@returns {Promise<Object>} 更新后的脱敏配置。 */
async function updateSettings(update) {
  const task = settingsQueue
    .catch(() => {})
    .then(async () => {
      const current = await getSettings();
      const next = normalizeSettings(update(current));
      if (current.cacheEnabled !== next.cacheEnabled) cache.invalidate();
      await chrome.storage.local.set({ settings: next });
      const config = publicSettings(await getSettings());
      await broadcastSettings(config);
      return config;
    });
  settingsQueue = task;
  return task;
}

/** 字典提交成功后再通知网页重译；旧请求不会写入当前轮缓存，不删除原有缓存数据。 */
async function updateNameDictionary(work) {
  const result = await work();
  cache.invalidate();
  await broadcastSettings(publicSettings(await getSettings()));
  return result;
}

/** 通知所有已打开的网页刷新公开偏好。@param {Object} config 脱敏配置。@returns {Promise<void>} 发送结束。 */
async function broadcastSettings(config) {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(
    tabs
      .filter((tab) => isTranslatableUrl(tab.url))
      .map((tab) => chrome.tabs.sendMessage(tab.id, { type: "CONFIG_CHANGED", config })),
  );
}

/** 取消指定标签页或其某一帧的一轮请求。@param {number} tabId 标签页。@param {number} [frameId] 可选帧。@param {string} [runId] 可选运行代号。@returns {void} 无返回值。 */
function cancelRequests(tabId, frameId, runId) {
  for (const request of inflight.values()) {
    if (
      request.tabId === tabId &&
      (frameId === undefined || request.frameId === frameId) &&
      (!runId || request.runId === runId)
    )
      request.controller.abort();
  }
}

/** 确保安装前已打开的网页也能接收命令。@param {number} tabId 标签页。@returns {Promise<void>} 脚本可用。 */
async function ensureContent(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "GET_STATE" }, { frameId: 0 });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content/index.js"],
    });
  }
}

/** 处理 popup 或网页悬浮栏发起的整页命令。@param {Object} message 命令。@param {Object} sender 消息来源。@returns {Promise<Object>} 主文档状态。 */
async function pageAction(message, sender) {
  const trusted = sender.url?.startsWith(chrome.runtime.getURL("pages/"));
  if (!trusted && (!sender.tab || sender.frameId !== 0))
    throw new TranslationError("FORBIDDEN", "无效的网页命令。");
  const tabId = trusted ? message.tabId : sender.tab.id;
  const tab = await chrome.tabs.get(tabId);
  if (!isTranslatableUrl(tab.url))
    throw new TranslationError("UNSUPPORTED", "此页面受浏览器保护，请打开普通网页后使用。");
  const config = publicSettings(await getSettings());
  if (["start", "retry"].includes(message.action) && !config.configured) {
    throw new TranslationError("NO_KEY", "请先打开设置，填写当前服务的 API Key。", { fatal: true });
  }
  if (!["start", "stop", "restore", "set-mode", "retry"].includes(message.action))
    throw new TranslationError("BAD_INPUT", "无效的翻译操作。");
  if (["stop", "restore"].includes(message.action)) cancelRequests(tabId);
  await ensureContent(tabId);
  await chrome.tabs.sendMessage(tabId, {
    type: "PAGE_COMMAND",
    action: message.action,
    mode: message.mode === "replace" ? "replace" : "bilingual",
    config,
  });
  return chrome.tabs.sendMessage(tabId, { type: "GET_STATE" }, { frameId: 0 });
}

/** 仅允许主文档悬浮控件修改公开偏好；自动翻译网站取自浏览器验证的当前标签页。@param {Object} message 含普通设置 patch 的消息。@param {Object} sender Chrome 验证的来源。@returns {Promise<Object>} 保存后的脱敏配置。 */
async function pagePreferences(message, sender) {
  if (!sender.tab || sender.frameId !== 0)
    throw new TranslationError("FORBIDDEN", "无效的网页设置操作。");
  const patch = message.patch;
  if (
    !patch ||
    typeof patch !== "object" ||
    Array.isArray(patch) ||
    Object.keys(patch).some(
      (key) => !["provider", "targetLanguage", "mode", "autoSite"].includes(key),
    ) ||
    ("provider" in patch && !["deepseek", "openai"].includes(patch.provider)) ||
    ("targetLanguage" in patch && !LANGUAGES.some(([id]) => id === patch.targetLanguage)) ||
    ("mode" in patch && !["bilingual", "replace"].includes(patch.mode)) ||
    ("autoSite" in patch && typeof patch.autoSite !== "boolean")
  )
    throw new TranslationError("BAD_INPUT", "无效的翻译设置。");
  const tab = await chrome.tabs.get(sender.tab.id);
  if (!isTranslatableUrl(tab.url))
    throw new TranslationError("UNSUPPORTED", "此页面无法保存翻译设置。");
  const hostname = new URL(tab.url).hostname.toLowerCase();
  return updateSettings((current) => {
    const next = { ...current };
    for (const key of ["provider", "targetLanguage", "mode"])
      if (key in patch) next[key] = patch[key];
    if ("autoSite" in patch) {
      const sites = new Set(current.autoTranslateSites);
      if (patch.autoSite) sites.add(hostname);
      else sites.delete(hostname);
      next.autoTranslateSites = [...sites];
    }
    return next;
  });
}

/** 路由扩展内部消息；没有网页 window 消息或外部消息入口。@param {Object} message 消息。@param {Object} sender Chrome 验证的来源。@returns {Promise<any>} 对应数据。 */
async function handleMessage(message, sender) {
  await ready;
  switch (message?.type) {
    case "PING":
      return null;
    case "GET_PUBLIC_CONFIG":
      return publicSettings(await getSettings());
    case "GET_SETTINGS":
      requireTrusted(sender);
      return normalizeSettings(await getSettings());
    case "GET_NAME_DICTIONARY":
      requireTrusted(sender);
      return nameDictionary.read();
    case "IMPORT_NAME_DICTIONARY":
      requireTrusted(sender);
      return updateNameDictionary(() => nameDictionary.importData(message.entries));
    case "SAVE_NAME_ENTRY":
      requireTrusted(sender);
      return updateNameDictionary(() => nameDictionary.saveEntry(message.entry, message.previous));
    case "SET_NAME_DICTIONARY_ENABLED":
      requireTrusted(sender);
      return updateNameDictionary(() => nameDictionary.setEnabled(message.enabled));
    case "SAVE_SETTINGS":
      requireTrusted(sender);
      return updateSettings(() => message.settings);
    case "PATCH_PREFERENCES":
      requireTrusted(sender);
      return updateSettings((current) => ({
        ...current,
        ...Object.fromEntries(
          Object.entries(message.patch || {}).filter(([key]) =>
            [
              "provider",
              "targetLanguage",
              "mode",
              "showFloatingButton",
              "translationShortcut",
              "autoTranslateSites",
              "visibleOnly",
              "cacheEnabled",
              "cacheLimitMb",
            ].includes(key),
          ),
        ),
      }));
    case "OPEN_OPTIONS":
      await chrome.runtime.openOptionsPage();
      return null;
    case "GET_CACHE_STATS": {
      requireTrusted(sender);
      const settings = await getSettings();
      const stats = await cache.stats();
      return {
        ...stats,
        limitBytes: settings.cacheLimitMb * 1024 * 1024,
        overLimit: stats.bytes > settings.cacheLimitMb * 1024 * 1024,
      };
    }
    case "CLEAR_CACHE": {
      requireTrusted(sender);
      const stats = await cache.clear();
      const tabs = await chrome.tabs.query({});
      await Promise.allSettled(
        tabs
          .filter((tab) => isTranslatableUrl(tab.url))
          .map((tab) => chrome.tabs.sendMessage(tab.id, { type: "CACHE_CLEARED" })),
      );
      return stats;
    }
    case "EXPORT_CACHE":
      requireTrusted(sender);
      return cache.exportData();
    case "IMPORT_CACHE":
      requireTrusted(sender);
      return cache.importData(message.data, message.revision);
    case "GET_TAB_STATE":
      requireTrusted(sender);
      try {
        return await chrome.tabs.sendMessage(message.tabId, { type: "GET_STATE" }, { frameId: 0 });
      } catch {
        return null;
      }
    case "PAGE_ACTION":
      return pageAction(message, sender);
    case "PAGE_SHORTCUT":
      if (!sender.tab || sender.frameId === 0 || !isTranslatableUrl(sender.tab.url))
        throw new TranslationError("FORBIDDEN", "无效的网页快捷键操作。");
      return chrome.tabs.sendMessage(sender.tab.id, { type: "TOGGLE_TRANSLATION" }, { frameId: 0 });
    case "PAGE_PREFERENCES":
      return pagePreferences(message, sender);
    case "FRAME_READY":
      if (!sender.tab || sender.frameId === 0) return null;
      return chrome.tabs
        .sendMessage(sender.tab.id, { type: "GET_ACTIVE_CONFIG" }, { frameId: 0 })
        .catch(() => null);
    case "FRAME_GONE":
      if (sender.tab && sender.frameId !== 0)
        await chrome.tabs
          .sendMessage(
            sender.tab.id,
            {
              type: "FRAME_UPDATE",
              frameId: sender.frameId,
              documentId: sender.documentId,
              status: null,
            },
            { frameId: 0 },
          )
          .catch(() => {});
      return null;
    case "CANCEL_RUN":
      if (sender.tab) cancelRequests(sender.tab.id, sender.frameId, message.runId);
      return null;
    case "FRAME_STATUS":
      if (!sender.tab) return null;
      if (sender.frameId !== 0) {
        await chrome.tabs
          .sendMessage(
            sender.tab.id,
            {
              type: "FRAME_UPDATE",
              frameId: sender.frameId,
              documentId: sender.documentId,
              status: message.status,
            },
            { frameId: 0 },
          )
          .catch(() => {});
      } else {
        const status = message.status;
        await chrome.action.setBadgeText({
          tabId: sender.tab.id,
          text:
            status.phase === "translating" ? "···" : status.failed ? "!" : status.done ? "✓" : "",
        });
        await chrome.action.setBadgeBackgroundColor({
          tabId: sender.tab.id,
          color: status.failed ? "#b45309" : "#5346d5",
        });
      }
      return null;
    case "LOOKUP_CACHE":
    case "TRANSLATE_BATCH": {
      if (!sender.tab || typeof message.runId !== "string" || message.runId.length > 100)
        throw new TranslationError("FORBIDDEN", "无效的翻译请求。");
      const settings = await getSettings();
      if (message.signature !== publicSettings(settings).signature) {
        throw new TranslationError(
          "CONFIG_CHANGED",
          "服务、目标语言或人名字典已更改，请重新点击翻译。",
          {
            fatal: true,
          },
        );
      }
      if (message.type === "LOOKUP_CACHE")
        return lookupCachedTranslations({ cache, settings, segments: message.segments });
      const requestId = `${sender.tab.id}:${sender.frameId}:${crypto.randomUUID()}`;
      const controller = new AbortController();
      inflight.set(requestId, {
        tabId: sender.tab.id,
        frameId: sender.frameId,
        runId: message.runId,
        controller,
      });
      try {
        return await translateWithCache({
          cache,
          settings,
          segments: message.segments,
          signal: controller.signal,
        });
      } finally {
        inflight.delete(requestId);
      }
    }
    case "LIST_MODELS": {
      requireTrusted(sender);
      return listModels({ provider: message.provider });
    }
    case "TEST_PROVIDER": {
      requireTrusted(sender);
      const settings = normalizeSettings(message.settings);
      const controller = new AbortController();
      const start = Date.now();
      await translateBatch({
        provider: settings.providers[settings.provider],
        targetLanguage: "zh-CN",
        segments: [{ id: "connection-test", parts: ["Hello, world!"] }],
        signal: controller.signal,
      });
      return { elapsedMs: Date.now() - start };
    }
    default:
      throw new TranslationError("BAD_INPUT", "无法识别的插件操作。");
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  handleMessage(message, sender).then(
    (data) => respond({ ok: true, data }),
    (error) =>
      respond({
        ok: false,
        error: {
          code: error.code || "SETTINGS",
          message:
            error instanceof TranslationError
              ? error.message
              : error.message || "操作失败，请重试。",
          fatal: Boolean(error.fatal),
        },
      }),
  );
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => cancelRequests(tabId));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading") cancelRequests(tabId);
});
