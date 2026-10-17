const SIMPLIFIED_FONT =
  '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", "Noto Sans SC", "Source Han Sans SC", "WenQuanYi Micro Hei", sans-serif';
const TRADITIONAL_FONT =
  '"Microsoft JhengHei", "PingFang TC", "Noto Sans CJK TC", "Noto Sans TC", "Source Han Sans TC", sans-serif';

/** 只为包含汉字的中文目标译文选择本机字体，不请求远程字体，也不改变字号或字重。 */
export function translationFont(config, text) {
  if (!config.optimizeChineseFont || !/\p{Script=Han}/u.test(text)) return "";
  if (config.targetLanguage === "zh-CN") return SIMPLIFIED_FONT;
  if (config.targetLanguage === "zh-TW") return TRADITIONAL_FONT;
  return "";
}

/**
 * 复用译文现有的最小文字容器，只暂时修改 font-family，避免包裹/移动文本节点破坏站点重绘。
 * 同一容器的多个文本记录共用一份原样式；停用、切换模式和恢复原文时按引用数还原。
 * 网站在翻译期间重设字体时更新备份，恢复时不以旧快照覆盖网站的新样式。
 */
export class TranslationFontStyles {
  constructor() {
    this.elements = new Map();
    this.records = new Map();
  }

  /** 应用译文容器字体；保留网站的字号、字重、行距、颜色及 DOM 层级。 */
  apply(record, config) {
    const element = record.node.parentElement;
    const family = translationFont(config, record.lastWritten);
    const translated =
      record.lastWritten !== record.original && record.node.data === record.lastWritten;
    if (!element || !family || !translated) {
      this.restore(record);
      return;
    }
    // 私用区通常是图标字体，同容器存在此类字形时保持原样，避免图标被中文字体替代。
    const iconText = /\p{Co}/u.test(element.textContent);
    if (iconText) {
      this.restore(record);
      return;
    }
    if (this.records.get(record) !== element) this.restore(record);
    let saved = this.elements.get(element);
    if (!saved) {
      saved = {
        owners: new Set(),
        family: "",
        applied: "",
        value: "",
        priority: "",
        hadStyle: false,
      };
      this.elements.set(element, saved);
    }
    saved.owners.add(record);
    this.records.set(record, element);
    const changed =
      element.style.getPropertyValue("font-family") !== saved.applied ||
      element.style.getPropertyPriority("font-family") !== "important";
    if (!changed && saved.family === family) return;
    if (changed) {
      saved.value = element.style.getPropertyValue("font-family");
      saved.priority = element.style.getPropertyPriority("font-family");
      saved.hadStyle = element.hasAttribute("style");
    }
    saved.family = family;
    element.style.setProperty("font-family", family, "important");
    saved.applied = element.style.getPropertyValue("font-family");
  }

  /** 仅在当前字体仍由扩展设置时恢复；保留网页随后修改的其他样式和文字。 */
  restore(record) {
    const element = this.records.get(record);
    if (!element) return;
    this.records.delete(record);
    const saved = this.elements.get(element);
    saved.owners.delete(record);
    if (saved.owners.size) return;
    if (
      element.style.getPropertyValue("font-family") === saved.applied &&
      element.style.getPropertyPriority("font-family") === "important"
    ) {
      if (saved.value) element.style.setProperty("font-family", saved.value, saved.priority);
      else element.style.removeProperty("font-family");
      if (!saved.hadStyle && !element.style.cssText) element.removeAttribute("style");
    }
    this.elements.delete(element);
  }
}
