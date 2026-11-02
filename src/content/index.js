import { TranslationEngine } from "./engine.js";
import { FloatingControl } from "./components/Floating/index.js";
import { sendMessage } from "../shared/messaging.js";
import { matchesShortcut } from "../shared/shortcut.js";

if (!globalThis.__yeyiInstalled) {
  globalThis.__yeyiInstalled = true;
  initialize().catch(() => {});
}

/** 安装一份 frame 会话；重复注入不会重复监听或重复翻译。@returns {Promise<void>} 安装完成。 */
async function initialize() {
  const isTop = window === window.top;
  const frames = new Map();
  let control;
  let latestConfig = { showFloatingButton: true, mode: "bilingual" };
  const engine = new TranslationEngine(onChange);
  let reportTimer;

  /** 合并主文档和子帧的公开进度。@returns {Object} 整页状态。 */
  function combinedState() {
    const own = engine.getState();
    const others = [...frames.values()];
    const states = [own, ...others];
    return {
      ...own,
      total: states.reduce((sum, state) => sum + state.total, 0),
      done: states.reduce((sum, state) => sum + state.done, 0),
      cached: states.reduce((sum, state) => sum + (state.cached || 0), 0),
      translated: states.reduce((sum, state) => sum + (state.translated || 0), 0),
      skipped: states.reduce((sum, state) => sum + (state.skipped || 0), 0),
      failed: states.reduce((sum, state) => sum + state.failed, 0),
      retrying: states.reduce((sum, state) => sum + (state.retrying || 0), 0),
      error: own.error || others.find((state) => state.error)?.error || "",
      phase:
        own.active && states.some((state) => state.phase === "translating")
          ? "translating"
          : own.phase,
    };
  }

  /** 更新网页面板，并合并频繁的后台状态消息。@returns {void} 无返回值。 */
  function onChange() {
    const state = isTop ? combinedState() : engine.getState();
    control?.update(state);
    clearTimeout(reportTimer);
    reportTimer = setTimeout(
      () =>
        sendMessage({
          type: "FRAME_STATUS",
          status: isTop ? combinedState() : engine.getState(),
        }).catch(() => {}),
      100,
    );
  }

  /** 执行一个在全页所有 frame 广播的用户命令。@param {string} action 命令。@param {string} [mode] 排版。@returns {Promise<void>} 命令完成。 */
  async function act(action, mode) {
    if (action === "set-mode") {
      await sendMessage({ type: "PAGE_ACTION", action, mode });
      return;
    }
    await sendMessage({ type: "PAGE_ACTION", action });
  }

  /** 保存悬浮面板的公开偏好；切换语言或服务时取消旧请求后用新配置继续。@param {Object} patch 普通阅读设置。@returns {Promise<Object>} 保存后的公开配置。 */
  async function changePreferences(patch) {
    const restart = engine.active && ("provider" in patch || "targetLanguage" in patch);
    if (restart) await act("stop");
    latestConfig = await sendMessage({ type: "PAGE_PREFERENCES", patch });
    control?.setConfig(latestConfig);
    if ("mode" in patch && engine.config) await act("set-mode", patch.mode);
    if (restart) await act("start");
    return latestConfig;
  }

  if (isTop) {
    control = new FloatingControl(
      act,
      () => sendMessage({ type: "OPEN_OPTIONS" }),
      changePreferences,
    );
  }

  // 每个 frame 监听自己的键盘输入，子帧只转发到主文档，统一复用悬浮按钮的切换和防重入逻辑。
  document.addEventListener(
    "keydown",
    (event) => {
      if (
        !event.isTrusted ||
        event.defaultPrevented ||
        document.designMode.toLowerCase() === "on" ||
        !matchesShortcut(event, latestConfig.translationShortcut)
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (isTop) void control.perform("toggle-translation");
      else sendMessage({ type: "PAGE_SHORTCUT" }).catch(() => {});
    },
    true,
  );

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message.type === "TOGGLE_TRANSLATION" && isTop) {
      control.perform("toggle-translation").then(() => respond(true));
      return true;
    }
    if (message.type === "GET_STATE") {
      respond(isTop ? combinedState() : engine.getState());
      return false;
    }
    if (message.type === "GET_ACTIVE_CONFIG") {
      respond(engine.active ? engine.config : null);
      return false;
    }
    if (message.type === "CONFIG_CHANGED") {
      latestConfig = message.config;
      control?.setConfig(latestConfig);
      if (
        engine.active &&
        (engine.config.visibleOnly !== latestConfig.visibleOnly ||
          engine.config.cacheEnabled !== latestConfig.cacheEnabled ||
          engine.config.reasoningSignature !== latestConfig.reasoningSignature ||
          engine.config.nameDictionarySignature !== latestConfig.nameDictionarySignature)
      )
        engine.start(latestConfig, false);
      if (engine.config) engine.setFontOptimization(latestConfig.optimizeChineseFont === true);
      if (!engine.config) control?.update({ ...engine.getState(), mode: latestConfig.mode });
      respond(true);
      return false;
    }
    if (message.type === "CACHE_CLEARED") {
      engine.clearCache();
      respond(true);
      return false;
    }
    if (message.type === "FRAME_UPDATE" && isTop) {
      if (message.status)
        frames.set(message.frameId, { ...message.status, documentId: message.documentId });
      else if (frames.get(message.frameId)?.documentId === message.documentId)
        frames.delete(message.frameId);
      onChange();
      respond(true);
      return false;
    }
    if (message.type === "PAGE_COMMAND") {
      latestConfig = message.config;
      control?.setConfig(latestConfig);
      if (message.action === "start" || message.action === "retry")
        engine.start(latestConfig, message.action === "retry");
      if (message.action === "stop") engine.stop();
      if (message.action === "restore") {
        frames.clear();
        engine.restore();
      }
      if (message.action === "set-mode") engine.setMode(message.mode);
      respond(engine.getState());
    }
    return false;
  });

  window.addEventListener("pagehide", () => {
    engine.stop(false);
    sendMessage({ type: "FRAME_GONE" }).catch(() => {});
  });
  latestConfig = await sendMessage({ type: "GET_PUBLIC_CONFIG" });
  control?.setConfig(latestConfig);
  if (
    isTop &&
    latestConfig.configured &&
    latestConfig.autoTranslateSites.includes(location.hostname.toLowerCase())
  ) {
    await act("start");
  } else if (!isTop) {
    const activeConfig = await sendMessage({ type: "FRAME_READY" });
    if (activeConfig) engine.start(activeConfig);
  }
  onChange();
}
