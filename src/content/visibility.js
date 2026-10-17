/**
 * 判断文字是否与视口及所有滚动/裁剪祖先相交，适用于 Discord 的内部滚动列表。
 * 使用文本 Range 而非段落容器的高度，避免空白占位和大容器触发屏幕外请求。
 * 部分露出的文本节点按完整节点翻译，以保留完整语义和原有内联结构。
 * @param {Object[]} records 含 node 的原文记录。
 * @param {Object} [options] 默认检查视口；预翻译时只检查真实隐藏和永久裁剪。
 * @returns {boolean} 是否有实际可见的文字。
 */
export function hasVisibleText(records, { viewportOnly = true, clipRoot } = {}) {
  return records.some(({ node }) => {
    if (!node.isConnected || (node.nodeType === Node.TEXT_NODE && !node.data.trim())) return false;
    const doc = node.ownerDocument;
    const view = doc.defaultView;
    const range = doc.createRange();
    if (node.nodeType === Node.TEXT_NODE) range.selectNodeContents(node);
    else range.selectNode(node);
    const bounds = viewportOnly
      ? { left: 0, top: 0, right: view.innerWidth, bottom: view.innerHeight }
      : { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
    let outsideScrollContent = false;
    for (
      let element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      element;
      element = element.parentElement
    ) {
      const style = view.getComputedStyle(element);
      if (
        element.hidden ||
        element.getAttribute("aria-hidden") === "true" ||
        style.display === "none" ||
        ["hidden", "collapse"].includes(style.visibility) ||
        style.contentVisibility === "hidden" ||
        Number(style.opacity) === 0
      )
        return false;
      const clips = viewportOnly ? /hidden|clip|scroll|auto/ : /hidden|clip/;
      const clipX = !outsideScrollContent && clips.test(style.overflowX);
      const clipY = !outsideScrollContent && clips.test(style.overflowY);
      if (clipX || clipY) {
        let viewportElement = element === doc.documentElement || element === doc.scrollingElement;
        if (!viewportElement && element === doc.body) {
          const rootStyle = view.getComputedStyle(doc.documentElement);
          viewportElement = rootStyle.overflowX === "visible" && rootStyle.overflowY === "visible";
        }
        // 根元素及向视口传播 overflow 的 body 裁剪视口本身，不能使用滚动后的负坐标。
        // 普通列表仍按自身客户区裁剪，避免将内部滚动区域外的文字误判为可见。
        const rect = viewportElement ? null : element.getBoundingClientRect();
        const left = viewportElement ? 0 : rect.left + element.clientLeft;
        const top = viewportElement ? 0 : rect.top + element.clientTop;
        const width = viewportElement ? view.innerWidth : element.clientWidth;
        const height = viewportElement ? view.innerHeight : element.clientHeight;
        if (clipX) {
          bounds.left = Math.max(bounds.left, left);
          bounds.right = Math.min(bounds.right, left + width);
        }
        if (clipY) {
          bounds.top = Math.max(bounds.top, top);
          bounds.bottom = Math.min(bounds.bottom, top + height);
        }
      }
      if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) return false;
      // 滚动内容使用自己的坐标空间；外层页面 overflow:hidden 不代表列表中的离屏文字永久隐藏。
      if (!viewportOnly && element === clipRoot) outsideScrollContent = true;
    }
    // 同源子帧也检查外层页面，防止屏幕外或隐藏的 iframe 提前翻译。
    try {
      if (view.frameElement && !hasVisibleText([{ node: view.frameElement }], { viewportOnly }))
        return false;
    } catch {
      // 跨域 frame 的 DOM 由浏览器隔离，内部仍按自己的视口裁剪。
    }
    return [...range.getClientRects()].some(
      (rect) =>
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right > bounds.left &&
        rect.left < bounds.right &&
        rect.bottom > bounds.top &&
        rect.top < bounds.bottom,
    );
  });
}

/**
 * 以可视文字为中心，在同一个滚动容器内向上、向下各扩展 10 句。
 * 段落是翻译与恢复的最小排版单元，边界段落整体保留；隐藏/永久裁剪的文字不计入窗口。
 * 返回的优先级中 0 为当前可视内容，其余按离视口的句数排序，确保可视内容先请求。
 * @param {Map<Element,Object[]>} groups 已排除隐藏内容的段落与原文节点。
 * @param {number} [sentences] 上下文各侧的句数。
 * @returns {Map<Element,number>} 本轮允许翻译的段落与优先级。
 */
export function visibleTranslationScope(groups, sentences = 10) {
  const scope = new Map();
  const containers = new Map();
  const parents = new Map();
  const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
  /** 单次扫描复用滚动祖先，避免把其他列表的文字当成当前列表的上下文。 */
  function scrollContainer(element) {
    if (parents.has(element)) return parents.get(element);
    const doc = element.ownerDocument;
    const style = doc.defaultView.getComputedStyle(element);
    const scrolls =
      (/auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight) ||
      (/auto|scroll/.test(style.overflowX) && element.scrollWidth > element.clientWidth);
    const result = scrolls
      ? element
      : element.parentElement
        ? scrollContainer(element.parentElement)
        : doc;
    parents.set(element, result);
    return result;
  }
  for (const [element, records] of groups) {
    const container = scrollContainer(element);
    if (!containers.has(container)) containers.set(container, []);
    const visible = hasVisibleText(records);
    containers.get(container).push({ element, records, visible });
    if (visible) scope.set(element, 0);
  }
  for (const [container, entries] of containers) {
    entries.forEach((entry, index) => {
      if (!entry.visible) return;
      for (const direction of [-1, 1]) {
        let remaining = sentences;
        for (
          let next = index + direction;
          next >= 0 && next < entries.length && remaining > 0;
          next += direction
        ) {
          const candidate = entries[next];
          candidate.readable ??=
            candidate.visible ||
            hasVisibleText(candidate.records, { viewportOnly: false, clipRoot: container });
          if (!candidate.readable) continue;
          candidate.sentences ??= Math.max(
            1,
            [
              ...segmenter.segment(candidate.records.map((record) => record.original).join("")),
            ].filter(({ segment }) => /\p{L}/u.test(segment)).length,
          );
          scope.set(
            candidate.element,
            Math.min(scope.get(candidate.element) ?? Infinity, sentences - remaining + 1),
          );
          remaining -= candidate.sentences;
        }
      }
    });
  }
  return scope;
}
