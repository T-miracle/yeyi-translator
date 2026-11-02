/** 悬浮面板与工具栏共用来源说明；统计已完成段落，不代表接口请求次数。 */
export function translationSourcesText(state) {
  return `缓存命中 ${state.cached || 0} 段 · 新翻译 ${state.translated || 0} 段${state.skipped ? ` · 无需翻译 ${state.skipped} 段` : ""}`;
}

export const TRANSLATION_SOURCES_HINT =
  "统计当前页面已完成的段落。缓存包含本页复用和持久缓存；部分命中的段落计入新翻译，新翻译也包含本地字典处理，不代表接口请求次数。";
