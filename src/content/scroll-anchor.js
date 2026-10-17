const CHAT_LIST = '[data-list-id="chat-messages"]';
const SCROLL_QUIET_MS = 180;

/** 查找消息列表实际使用的滚动容器，兼容列表自身滚动及 Discord 的外层包装。 */
function scrollerOf(list) {
  for (let element = list; element; element = element.parentElement)
    if (
      /auto|scroll/.test(getComputedStyle(element).overflowY) &&
      element.scrollHeight > element.clientHeight
    )
      return element;
  return null;
}

/**
 * Discord 在滚动时自行测量和定位消息。译文重排及任何 scrollTop 写入都可能打断
 * 浏览器的平滑/惯性滚动，因此运动期间只准备结果，停稳后才允许合并写入页面。
 * 静止时只同步补偿本批实际位移，不跨帧追踪旧位置，也不固定或裁剪消息高度。
 */
export class TranslationScrollAnchor {
  constructor(onSettled) {
    /** @type {Map<Element,ReturnType<typeof setTimeout>>} 各消息滚动区独立的静止检测。 */
    this.moving = new Map();
    /** @type {boolean} 是否有扫描、译文或字体更新等候滚动结束。 */
    this.pending = false;
    this.onSettled = onSettled;
    this.onMotion = (event) => {
      if (event.type === "wheel" && !event.deltaY) return;
      if (
        event.type === "keydown" &&
        (!/^(ArrowUp|ArrowDown|PageUp|PageDown|Home|End| )$/.test(event.key) ||
          event.target?.closest?.(
            'input,textarea,select,[contenteditable]:not([contenteditable="false"])',
          ))
      )
        return;
      for (const list of document.querySelectorAll(CHAT_LIST)) {
        const scroller = scrollerOf(list);
        if (!scroller) continue;
        const target = event.target;
        if (event.type === "scroll" ? target !== scroller : !scroller.contains(target)) continue;
        clearTimeout(this.moving.get(scroller));
        this.moving.set(
          scroller,
          setTimeout(() => {
            this.moving.delete(scroller);
            if (this.moving.size || !this.pending) return;
            this.pending = false;
            this.onSettled();
          }, SCROLL_QUIET_MS),
        );
      }
    };
  }

  /** 被动监听输入及实际滚动；惯性阶段没有 wheel 事件，仍会由 scroll 持续延后写入。 */
  start() {
    for (const type of ["wheel", "touchmove", "keydown", "scroll"])
      document.addEventListener(type, this.onMotion, { capture: true, passive: true });
  }

  /** 暂停和恢复原文时清除旧会话的待显示通知，避免迟到回调重新写回译文。 */
  stop() {
    for (const type of ["wheel", "touchmove", "keydown", "scroll"])
      document.removeEventListener(type, this.onMotion, true);
    for (const timer of this.moving.values()) clearTimeout(timer);
    this.moving.clear();
    this.pending = false;
  }

  /** 网络及缓存结果仍可完成，扫描和排版统一等到实际滚动停稳。 */
  wait() {
    if (!this.moving.size) return false;
    this.pending = true;
    return true;
  }

  /** 记录当前可见消息的位置，同步写入结束后立即丢弃。 */
  capture() {
    const positions = [];
    for (const list of document.querySelectorAll(CHAT_LIST)) {
      const scroller = scrollerOf(list);
      if (!scroller || positions.some((position) => position.scroller === scroller)) continue;
      if (scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 2) continue;
      const rect = scroller.getBoundingClientRect();
      const top = Math.max(0, rect.top + scroller.clientTop);
      const bottom = Math.min(innerHeight, rect.top + scroller.clientTop + scroller.clientHeight);
      if (bottom <= top) continue;
      const anchor = [...list.querySelectorAll('[id^="chat-messages-"]')].find((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.height > 0 && bounds.bottom > top && bounds.top < bottom;
      });
      if (anchor)
        positions.push({
          scroller,
          list,
          anchor,
          id: anchor.id,
          top: anchor.getBoundingClientRect().top - rect.top,
        });
    }
    return positions;
  }

  /**
   * 滚动停稳后，只补偿此次同步写入造成的真实几何变化。
   * 浏览器已经完成原生锚定、或文字/字体更新后位置未变时，不写入 scrollTop。
   */
  preserve(mutation) {
    if (this.moving.size) return mutation();
    const positions = this.capture();
    try {
      return mutation();
    } finally {
      for (const position of positions) {
        const { scroller, list } = position;
        const anchor = position.anchor.isConnected
          ? position.anchor
          : document.getElementById(position.id);
        if (
          !scroller.isConnected ||
          !scroller.contains(list) ||
          !anchor ||
          !list.contains(anchor) ||
          anchor.id !== position.id
        )
          continue;
        const delta =
          anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top - position.top;
        if (Math.abs(delta) >= 0.5)
          scroller.scrollTo({ top: scroller.scrollTop + delta, behavior: "instant" });
      }
    }
  }
}
