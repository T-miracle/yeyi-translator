/** 修改日语译文要求时递增版本，只隔离对应译文，不迁移或清除旧缓存。 */
export const JAPANESE_FORUM_PROFILE = "japanese-forum-v1";

/**
 * 在本机用假名识别日语，覆盖平假名、片假名和半角片假名，不额外调用模型。
 * 网址中的日文路径不作为正文依据；纯汉字无法可靠区分中日文，交给既有规则处理。
 * @param {string} text 待检查的原文。
 * @returns {boolean} 是否含有日语假名。
 */
export function isJapaneseText(text) {
  return /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(
    text.replace(/(?:https?:\/\/|www\.)\S+/gi, ""),
  );
}

/**
 * 按原段落选择提示词与缓存版本，保持两处判定一致。
 * 拆分后的纯汉字节点沿用段落的日语标记；旧内容脚本及补译仍可从原文、上下文判定。
 * 本机字典片段不调用模型，继续复用原缓存身份。
 * @param {Object} segment 含 parts、可选 sourceLanguage 和 context 的片段。
 * @param {string[]} [contextParts] 补译时的完整原段落。
 * @returns {string} 专用提示词版本；空字符串表示通用翻译。
 */
export function translationProfile(segment, contextParts = []) {
  if (segment.dictionaryOnly) return "";
  return segment.sourceLanguage === "ja" ||
    isJapaneseText([...segment.parts, segment.context || "", ...contextParts].join(""))
    ? JAPANESE_FORUM_PROFILE
    : "";
}
