import { normalizeShortcut } from "./shortcut.js";
import {
  normalizeReasoningEffort,
  normalizeThinkingMode,
  reasoningSignature,
} from "./reasoning.js";

/** @typedef {'deepseek'|'openai'} ProviderId 支持的 API 服务。 */
/**
 * @typedef {Object} ProviderSettings 一个服务的本机配置。
 * @property {string} apiKey 用户自己的密钥，仅允许扩展可信上下文读取。
 * @property {string} baseUrl API 根地址或完整的 Chat Completions 地址。
 * @property {string} model 用户可修改的模型名称。
 * @property {string} reasoningEffort 推理档位；default 表示不指定，none 表示关闭思考。
 * @property {'disabled'|'enabled'|'default'} [thinkingMode] DeepSeek 独立思考开关，推理档位仅开启时生效。
 */
/**
 * @typedef {Object} Settings 持久设置；不包含网页或译文缓存。
 * @property {ProviderId} provider 当前服务。
 * @property {Record<ProviderId, ProviderSettings>} providers 两家服务各自的配置。
 * @property {string} targetLanguage 目标语言代码。
 * @property {'bilingual'|'replace'} mode 默认排版。
 * @property {boolean} showFloatingButton 是否显示网页入口。
 * @property {string} translationShortcut 切换翻译与恢复原文的快捷键；空字符串表示停用。
 * @property {boolean} visibleOnly 是否只翻译当前视口可见的段落。
 * @property {boolean} optimizeChineseFont 是否为中文译文优先使用本机中文字体。
 * @property {boolean} cacheEnabled 是否跨页面、刷新和重启保存译文缓存。
 * @property {number} cacheLimitMb 缓存容量提醒阈值（MiB），超出后继续保存。
 * @property {string[]} autoTranslateSites 精确匹配的主机名，不隐式包含子域。
 */

export const LANGUAGES = [
  ["zh-CN", "简体中文"],
  ["zh-TW", "繁體中文"],
  ["en", "English"],
  ["ja", "日本語"],
  ["ko", "한국어"],
  ["fr", "Français"],
  ["de", "Deutsch"],
  ["es", "Español"],
  ["pt", "Português"],
  ["ru", "Русский"],
  ["ar", "العربية"],
  ["it", "Italiano"],
  ["vi", "Tiếng Việt"],
  ["th", "ไทย"],
];

export const DEFAULT_SETTINGS = {
  provider: "deepseek",
  providers: {
    deepseek: {
      apiKey: "",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-flash",
      thinkingMode: "disabled",
      reasoningEffort: "default",
    },
    openai: {
      apiKey: "",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      reasoningEffort: "default",
    },
  },
  targetLanguage: "zh-CN",
  mode: "bilingual",
  showFloatingButton: true,
  translationShortcut: "Ctrl+X",
  visibleOnly: false,
  optimizeChineseFont: false,
  cacheEnabled: false,
  cacheLimitMb: 512,
  autoTranslateSites: [],
};

/** 校验 API 地址，并统一去掉尾部斜杠。@param {string} value 输入地址。@returns {string} 规范地址。 */
export function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("请输入完整的 API 地址，例如 https://api.openai.com/v1");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("API 地址需要 HTTPS；本机 localhost / 127.0.0.1 可使用 HTTP。");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("API 地址不能包含账号、密码、查询参数或 # 片段。");
  }
  return url.href.replace(/\/+$/, "");
}

/** 兼容根地址、/v1 和完整端点，避免重复拼接。@param {string} baseUrl 配置地址。@returns {string} 请求端点。 */
export function completionUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl);
  return normalized.endsWith("/chat/completions") ? normalized : `${normalized}/chat/completions`;
}

/** 从同一 API 根路径派生模型列表端点。@param {string} baseUrl 根地址或 Chat Completions 端点。@returns {string} GET 模型地址。 */
export function modelsUrl(baseUrl) {
  return completionUrl(baseUrl).replace(/\/chat\/completions$/, "/models");
}

/** 规范化精确匹配的站点名单。@param {string[]|string} value 主机名或 URL 列表。@returns {string[]} 去重主机名。 */
export function normalizeSites(value) {
  const entries = Array.isArray(value) ? value : String(value || "").split(/[\s,，;；]+/);
  return [
    ...new Set(
      entries.filter(Boolean).map((entry) => {
        const input = String(entry).trim();
        let url;
        try {
          url = new URL(input.includes("://") ? input : `https://${input}`);
        } catch {
          throw new Error(`无效的网站地址：${input.slice(0, 60)}`);
        }
        if (
          !["http:", "https:"].includes(url.protocol) ||
          !url.hostname ||
          /[\s*]/.test(url.hostname)
        ) {
          throw new Error("自动翻译网站请填写具体主机名，例如 docs.example.com，不支持通配符。");
        }
        return url.hostname.toLowerCase();
      }),
    ),
  ].sort();
}

/** 合并并校验本机设置；只保留已知字段。@param {Partial<Settings>} input 已存储或表单配置。@returns {Settings} 完整配置。 */
export function normalizeSettings(input = {}) {
  const cacheLimitMb = Number(input.cacheLimitMb ?? DEFAULT_SETTINGS.cacheLimitMb);
  if (!Number.isFinite(cacheLimitMb) || cacheLimitMb < 1 || cacheLimitMb > 10240)
    throw new Error("缓存容量提醒阈值需要在 1～10240 MB 之间。");
  const providers = {};
  for (const id of ["deepseek", "openai"]) {
    const candidate = input.providers?.[id] || {};
    const defaults = DEFAULT_SETTINGS.providers[id];
    providers[id] = {
      apiKey: String(candidate.apiKey ?? defaults.apiKey).trim(),
      baseUrl: normalizeBaseUrl(String(candidate.baseUrl ?? defaults.baseUrl)),
      model: String(candidate.model ?? defaults.model).trim(),
    };
    providers[id].reasoningEffort = normalizeReasoningEffort(
      candidate.reasoningEffort,
      providers[id].baseUrl,
    );
    if (id === "deepseek") {
      // 仅补齐读取结果，不主动重写存档；旧 none/具体档位分别还原为关闭/开启。
      providers[id].thinkingMode = normalizeThinkingMode(
        candidate.thinkingMode,
        providers[id].reasoningEffort,
      );
      if (providers[id].reasoningEffort === "none") providers[id].reasoningEffort = "default";
    }
    if (!providers[id].model || providers[id].model.length > 200) {
      throw new Error("模型名称不能为空，且不能超过 200 个字符。");
    }
  }
  return {
    provider: input.provider === "openai" ? "openai" : "deepseek",
    providers,
    targetLanguage: LANGUAGES.some(([id]) => id === input.targetLanguage)
      ? input.targetLanguage
      : "zh-CN",
    mode: input.mode === "replace" ? "replace" : "bilingual",
    showFloatingButton: input.showFloatingButton !== false,
    translationShortcut: normalizeShortcut(
      input.translationShortcut ?? DEFAULT_SETTINGS.translationShortcut,
    ),
    visibleOnly: input.visibleOnly === true,
    optimizeChineseFont: input.optimizeChineseFont === true,
    cacheEnabled: input.cacheEnabled === true,
    cacheLimitMb,
    autoTranslateSites: normalizeSites(input.autoTranslateSites || []),
  };
}

/** 生成可发送到 content script 的配置，绝不包含 Key。@param {Settings} settings 本机配置。@returns {Object} 脱敏配置。 */
export function publicSettings(settings) {
  const current = settings.providers[settings.provider];
  const signature = [settings.provider, current.baseUrl, current.model, settings.targetLanguage];
  // 无有效字典时保持旧缓存键兼容；摘要不向网页暴露人名及描述。
  if (settings.nameDictionarySignature) signature.push(settings.nameDictionarySignature);
  const reasoning = reasoningSignature(current);
  if (reasoning) signature.push(["reasoning", reasoning]);
  return {
    provider: settings.provider,
    model: current.model,
    reasoningEffort: current.reasoningEffort,
    thinkingMode: current.thinkingMode,
    reasoningSignature: reasoning,
    targetLanguage: settings.targetLanguage,
    mode: settings.mode,
    showFloatingButton: settings.showFloatingButton,
    translationShortcut: settings.translationShortcut,
    visibleOnly: settings.visibleOnly,
    optimizeChineseFont: settings.optimizeChineseFont,
    cacheEnabled: settings.cacheEnabled,
    nameDictionarySignature: settings.nameDictionarySignature || "",
    autoTranslateSites: settings.autoTranslateSites,
    configured: Boolean(current.apiKey),
    signature: JSON.stringify(signature),
    configuredProviders: Object.fromEntries(
      Object.entries(settings.providers).map(([id, config]) => [id, Boolean(config.apiKey)]),
    ),
  };
}

/** 判断是否为允许翻译的普通网页。@param {string} url 标签页地址。@returns {boolean} 是否允许。 */
export function isTranslatableUrl(url = "") {
  try {
    const parsed = new URL(url);
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      !["chromewebstore.google.com", "chrome.google.com", "microsoftedge.microsoft.com"].includes(
        parsed.hostname,
      )
    );
  } catch {
    return false;
  }
}
