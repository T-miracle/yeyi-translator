import { SettingsPanel } from "./components/SettingsPanel/index.js";

/** 网页右下角的翻译与设置入口；按钮和进度使用 Shadow DOM 隔离页面样式。 */
export class FloatingControl {
  /** @param {Function} onAction 执行整页命令。@param {Function} onSettings 打开完整设置。@param {Function} onPreference 保存常用设置。 */
  constructor(onAction, onSettings, onPreference) {
    /** @type {Function} 用户明确发起的整页操作。 */
    this.onAction = onAction;
    /** @type {boolean} 是否正在等待用户命令确认，避免重复点击。 */
    this.busy = false;
    /** @type {boolean} 未翻译时是否也显示入口；沿用已有配置字段，兼容旧设置。 */
    this.showFloatingButton = true;
    /** @type {Object} 最近一次全页进度，不包含原文或密钥。 */
    this.state = { active: false, total: 0, done: 0, failed: 0, phase: "idle", mode: "bilingual" };
    /** @type {HTMLDivElement} 文本收集器排除的控件宿主。 */
    this.host = document.createElement("div");
    this.host.dataset.yeyiOwned = "control";
    this.host.style.cssText =
      "all:initial!important;position:fixed!important;right:20px!important;bottom:24px!important;z-index:2147483647!important;display:block!important;";
    /** @type {ShadowRoot} 隔离网页样式的渲染入口。 */
    this.root = this.host.attachShadow({ mode: "open" });
    this.root.innerHTML = `<style>
      :host{color-scheme:light}*{box-sizing:border-box}button{font:inherit;cursor:pointer}button:focus-visible{outline:3px solid #bcb5ff;outline-offset:4px}button:disabled{cursor:wait;opacity:.6}
      .wrap{font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#27283c;text-align:left}.dock{display:flex;flex-direction:column;align-items:center;width:42px;margin-left:auto;gap:9px}
      .round{display:grid;place-items:center;position:relative;padding:0;border-radius:50%;flex:none;transition:background .18s,box-shadow .18s,transform .18s}.round:hover{transform:translateY(-1px)}.round:active{transform:translateY(0)}
      .settings-toggle{width:34px;height:34px;border:1px solid #e5e2f0;background:#fff;color:#706984;box-shadow:0 2px 10px #30264a12}.settings-toggle[aria-expanded=true]{background:#f0edff;color:#5c49d7;border-color:#d9d2ff}.settings-toggle svg{width:17px;height:17px}
      .notice{position:absolute;right:0;top:0;width:7px;height:7px;border-radius:50%;background:#d58b35;border:1.5px solid #fff}.notice[hidden]{display:none}
      .translate-toggle{width:42px;height:42px;border:0;background:#6350df;color:#fff;box-shadow:0 4px 16px #4733b82b}.translate-toggle:hover{background:#5843d2;box-shadow:0 5px 18px #4733b838}.translate-toggle[aria-pressed=true]{background:#5140c7}.translate-toggle.error{background:#a86a25}.glyph{font-size:17px;font-weight:650;line-height:1}
      .progress{position:absolute;inset:0;width:42px;height:42px;transform:rotate(-90deg);pointer-events:none}.track,.arc{fill:none;stroke-width:2.5}.track{stroke:#ffffff30}.arc{stroke:#fff;stroke-linecap:round;stroke-dasharray:100;stroke-dashoffset:100;transition:stroke-dashoffset .25s ease}.translate-toggle.idle .progress{opacity:0}.progress.indeterminate{animation:yeyi-spin 1.2s linear infinite}.progress.indeterminate .arc{stroke-dasharray:24 76;stroke-dashoffset:0}
      @keyframes yeyi-spin{to{transform:rotate(270deg)}}@media(prefers-reduced-motion:reduce){.round,.arc{transition:none}.progress.indeterminate{animation:none}}
    </style><div class="wrap"><div class="dock">
      <button type="button" class="round settings-toggle" aria-label="打开翻译设置" aria-expanded="false" aria-controls="yeyi-settings" title="翻译设置"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9.7 3-.6 2.4-2 .9-2.2-.7-2 3.4 1.7 1.7-.2 2.2-1.5 1.6 2 3.4 2.3-.6 1.8 1.3.6 2.4h4l.6-2.4 1.8-1.3 2.3.6 2-3.4-1.5-1.6-.2-2.2 1.7-1.7-2-3.4-2.2.7-2-.9-.6-2.4Z"/><circle cx="12" cy="12" r="3.2"/></svg><span class="notice" hidden></span></button>
      <button type="button" class="round translate-toggle idle" aria-label="翻译此页" aria-pressed="false" title="翻译此页"><svg class="progress" viewBox="0 0 42 42" role="progressbar" aria-label="翻译进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><circle class="track" cx="21" cy="21" r="18"/><circle class="arc" cx="21" cy="21" r="18" pathLength="100"/></svg><span class="glyph" aria-hidden="true">译</span></button>
    </div></div>`;
    /** @type {SettingsPanel} 常用设置及辅助操作，拥有表单保存状态。 */
    this.panel = new SettingsPanel({
      onAction: (action, mode) => this.perform(action, mode),
      onPreference: (patch) => this.savePreferences(patch, onPreference),
      onSettings,
      onClose: () => this.toggle(false),
    });
    this.root.querySelector(".wrap").prepend(this.panel.element);
    this.root.querySelector(".settings-toggle").addEventListener("click", () => this.toggle());
    this.root
      .querySelector(".translate-toggle")
      .addEventListener("click", () => this.perform("toggle-translation"));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !this.panel.element.hidden) {
        this.toggle(false);
        this.root.querySelector(".settings-toggle").focus();
      }
    });
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (!event.composedPath().includes(this.host)) this.toggle(false);
      },
      { passive: true },
    );
    document.documentElement.append(this.host);
    this.update(this.state);
  }

  /** 展开或收起常用设置，不改变翻译状态。@param {boolean} [open] 指定开合，省略则切换。@returns {void} 无返回值。 */
  toggle(open = this.panel.element.hidden) {
    this.panel.element.hidden = !open;
    this.root.querySelector(".settings-toggle").setAttribute("aria-expanded", String(open));
  }

  /** 执行用户命令；主按钮切换翻译与恢复，暂停位于设置面板。@param {string} action 命令或按钮意图。@param {string} [mode] 排版模式。@returns {Promise<void>} 命令确认完成。 */
  async perform(action, mode) {
    if (this.busy) return;
    if (action === "toggle-translation")
      action = this.state.active || this.state.total ? "restore" : "start";
    if (action === "toggle-pause") action = this.state.active ? "stop" : "start";
    this.busy = true;
    this.update(this.state);
    try {
      await this.onAction(action, mode);
    } catch (error) {
      this.panel.showError(error.message);
      this.setVisible(true);
      this.toggle(true);
    } finally {
      this.busy = false;
      this.root.querySelector(".translate-toggle").disabled = false;
    }
  }

  /** 设置保存与翻译按钮共用命令锁，避免保存语言期间又恢复原文而被迟到的重启覆盖。@param {Object} patch 本次修改。@param {Function} save 保存公开偏好的回调。@returns {Promise<Object>} 保存后的公开配置。 */
  async savePreferences(patch, save) {
    if (this.busy) throw new Error("操作处理中，请稍后重试。");
    this.busy = true;
    this.root.querySelector(".translate-toggle").disabled = true;
    try {
      return await save(patch);
    } finally {
      this.busy = false;
      this.root.querySelector(".translate-toggle").disabled = false;
    }
  }

  /** 更新圆环、主按钮语义与设置面板中的辅助操作。@param {Object} state 全页汇总进度。@returns {void} 无返回值。 */
  update(state) {
    this.state = state;
    const translated = Boolean(state.active || state.total);
    const percent = state.total
      ? Math.max(0, Math.min(100, Math.floor((state.done / state.total) * 100)))
      : 0;
    const button = this.root.querySelector(".translate-toggle");
    const progress = this.root.querySelector(".progress");
    button.setAttribute("aria-label", translated ? "恢复原文" : "翻译此页");
    button.setAttribute("aria-pressed", String(translated));
    button.title = state.error || (translated ? `恢复原文 · 已完成 ${percent}%` : "翻译此页");
    button.disabled = this.busy;
    button.classList.toggle("idle", !translated);
    button.classList.toggle("error", Boolean(state.failed || state.error));
    progress.setAttribute("aria-valuenow", String(percent));
    progress.setAttribute("aria-valuetext", `${state.done} / ${state.total} 段已完成`);
    progress.classList.toggle("indeterminate", state.active && !state.total);
    this.root.querySelector(".arc").style.strokeDashoffset = String(100 - percent);
    this.root.querySelector(".notice").hidden = !state.failed && !state.error;
    this.panel.updateState(state);
    this.setVisible(this.showFloatingButton || translated);
  }

  /** 应用后台公开的阅读偏好，绝不接触密钥。@param {Object} config 公开配置。@returns {void} 无返回值。 */
  setConfig(config) {
    this.showFloatingButton = config.showFloatingButton !== false;
    this.root
      .querySelector(".translate-toggle")
      .setAttribute(
        "aria-keyshortcuts",
        (config.translationShortcut || "").replace("Ctrl", "Control"),
      );
    this.panel.updateConfig(config);
    this.setVisible(this.showFloatingButton || Boolean(this.state.active || this.state.total));
  }

  /** 应用悬浮按钮可见性。@param {boolean} visible 是否显示。@returns {void} 无返回值。 */
  setVisible(visible) {
    if (!visible) this.toggle(false);
    this.host.style.setProperty("display", visible ? "block" : "none", "important");
  }
}
