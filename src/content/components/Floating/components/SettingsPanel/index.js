import { LANGUAGES } from "../../../../../shared/settings.js";
import { populateLanguages } from "../../../../../shared/messaging.js";
import {
  translationSourcesText,
  TRANSLATION_SOURCES_HINT,
} from "../../../../../shared/translation-progress.js";

/** 常用设置面板，拥有表单保存及错误展示的生命周期。 */
export class SettingsPanel {
  /** @param {Object} callbacks 面板操作边界。@param {Function} callbacks.onAction 执行整页操作。@param {Function} callbacks.onPreference 保存公开偏好。@param {Function} callbacks.onSettings 打开完整设置。@param {Function} callbacks.onClose 关闭面板。 */
  constructor({ onAction, onPreference, onSettings, onClose }) {
    /** @type {Function} 保存受限的公开偏好。 */
    this.onPreference = onPreference;
    /** @type {boolean} 保存期间避免旧配置覆盖用户选择。 */
    this.saving = false;
    /** @type {Object} 最近一次公开配置。 */
    this.config = {
      provider: "deepseek",
      targetLanguage: "zh-CN",
      mode: "bilingual",
      autoTranslateSites: [],
    };
    /** @type {Object} 最近一次翻译状态，用于暂停与重试操作。 */
    this.state = { total: 0, active: false, mode: "bilingual", phase: "idle" };
    /** @type {HTMLElement} 位于父级 Shadow DOM 内的面板根节点。 */
    this.element = document.createElement("section");
    this.element.id = "yeyi-settings";
    this.element.className = "panel";
    this.element.hidden = true;
    this.element.setAttribute("aria-label", "翻译设置");
    this.element.innerHTML = `<style>
      .panel{width:268px;max-width:calc(100vw - 40px);margin-bottom:12px;padding:16px;background:#fff;border:1px solid #e9e5f2;border-radius:16px;box-shadow:0 8px 32px #29213b1a;max-height:calc(100dvh - 140px);overflow:auto}.panel[hidden]{display:none}
      .panel-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:15px}.panel-title{font-size:14px;font-weight:650}.panel-close{border:0;background:transparent;color:#92899e;padding:0 3px;font-size:21px;line-height:1}
      .field{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:11px 0;color:#6e667c}.field select{font:inherit;width:144px;border:1px solid #e8e3f0;border-radius:8px;padding:6px 8px;background:#fff;color:#39324c}.field select:focus-visible{outline:2px solid #bcb5ff;outline-offset:2px}
      .modes{display:grid;grid-template-columns:1fr 1fr;gap:4px;margin:14px 0;padding:3px;background:#f3f1f8;border-radius:9px}.modes button{border:0;border-radius:6px;padding:7px 0;background:transparent;color:#797088}.modes button[aria-pressed=true]{background:#fff;color:#5e48ce;box-shadow:0 1px 4px #36244e10}
      .auto-row{display:flex;justify-content:space-between;align-items:center;padding:3px 0;color:#6e667c;cursor:pointer}.auto-row input{accent-color:#6350df;width:15px;height:15px;cursor:pointer}
      .status{margin:14px 0 0;padding-top:12px;border-top:1px solid #f0edf5;color:#948b9e;font-size:11px;line-height:1.65;overflow-wrap:anywhere}.status.error{color:#a56928}
      .source-status{margin-top:5px;color:#716583;font-size:11px;line-height:1.65;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.source-status[hidden]{display:none}
      .auxiliary{display:flex;gap:8px;margin-top:10px}.auxiliary button{flex:1;padding:6px 8px;border:1px solid #e8e3f0;border-radius:7px;background:#fff;color:#716583}.auxiliary button[hidden]{display:none}
      .all-settings{display:block;width:100%;margin-top:10px;padding:4px 0;border:0;background:transparent;color:#8a7f9b;font-size:11px;text-align:center}
    </style><div class="panel-head"><span class="panel-title">翻译设置</span><button type="button" class="panel-close" aria-label="关闭翻译设置">×</button></div>
      <label class="field">目标语言<select name="targetLanguage" aria-label="目标语言"></select></label>
      <label class="field">翻译服务<select name="provider" aria-label="翻译服务"><option value="deepseek">DeepSeek</option><option value="openai">OpenAI</option></select></label>
      <div class="modes"><button type="button" data-mode="bilingual" aria-pressed="true">原文 / 译文</button><button type="button" data-mode="replace" aria-pressed="false">替换原文</button></div>
      <label class="auto-row">本站自动翻译<input type="checkbox" name="autoSite" aria-label="本站自动翻译" /></label>
      <div class="status" role="status">点击翻译，开始阅读。</div>
      <div class="source-status" aria-label="译文来源统计" hidden></div>
      <div class="auxiliary"><button type="button" data-action="toggle-pause" hidden>暂停翻译</button><button type="button" data-action="retry" hidden>重试失败部分</button></div>
      <button type="button" class="all-settings">完整设置 ↗</button>`;
    populateLanguages(this.element.querySelector('[name="targetLanguage"]'), LANGUAGES);
    this.element.querySelector(".source-status").title = TRANSLATION_SOURCES_HINT;
    this.element.querySelector(".panel-close").addEventListener("click", onClose);
    this.element
      .querySelector(".all-settings")
      .addEventListener("click", () => this.openSettings(onSettings));
    for (const name of ["targetLanguage", "provider"])
      this.element
        .querySelector(`[name="${name}"]`)
        .addEventListener("change", (event) => this.save({ [name]: event.target.value }));
    this.element
      .querySelector('[name="autoSite"]')
      .addEventListener("change", (event) => this.save({ autoSite: event.target.checked }));
    for (const button of this.element.querySelectorAll("[data-mode]"))
      button.addEventListener("click", () => this.save({ mode: button.dataset.mode }));
    for (const button of this.element.querySelectorAll("[data-action]"))
      button.addEventListener("click", () => onAction(button.dataset.action));
  }

  /** 保存表单值，失败时恢复后台配置并展示错误。@param {Object} patch 本次修改的公开偏好。@returns {Promise<void>} 保存处理结束。 */
  async save(patch) {
    if (this.saving) return;
    this.saving = true;
    for (const field of this.element.querySelectorAll("select,input,[data-mode]"))
      field.disabled = true;
    try {
      this.config = await this.onPreference(patch);
    } catch (error) {
      this.showError(error.message);
    } finally {
      this.saving = false;
      for (const field of this.element.querySelectorAll("select,input,[data-mode]"))
        field.disabled = false;
      this.renderConfig();
    }
  }

  /** 打开完整设置并在失败时保留反馈。@param {Function} open 打开扩展设置的回调。@returns {Promise<void>} 操作完成。 */
  async openSettings(open) {
    try {
      await open();
    } catch (error) {
      this.showError(error.message);
    }
  }

  /** 将错误作为纯文本显示。@param {string} message 脱敏提示。@returns {void} 无返回值。 */
  showError(message) {
    this.element.querySelector(".status").textContent = message;
    this.element.querySelector(".status").classList.add("error");
  }

  /** 接收公开配置，保存期间不覆盖表单选择。@param {Object} config 最新公开配置。@returns {void} 无返回值。 */
  updateConfig(config) {
    this.config = config;
    if (!this.saving) this.renderConfig();
  }

  /** 将公开偏好同步到普通设置控件。@returns {void} 无返回值。 */
  renderConfig() {
    for (const name of ["targetLanguage", "provider"])
      this.element.querySelector(`[name="${name}"]`).value = this.config[name];
    this.element.querySelector('[name="autoSite"]').checked =
      this.config.autoTranslateSites?.includes(location.hostname.toLowerCase()) || false;
    const mode = this.state.total ? this.state.mode : this.config.mode;
    for (const button of this.element.querySelectorAll("[data-mode]"))
      button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
  }

  /** 刷新进度说明及暂停、继续、重试按钮。@param {Object} state 汇总翻译状态。@returns {void} 无返回值。 */
  updateState(state) {
    this.state = state;
    const status = this.element.querySelector(".status");
    status.textContent =
      state.error ||
      (state.phase === "idle"
        ? "点击翻译，开始阅读。"
        : `${state.done} / ${state.total} 段已完成${state.retrying ? ` · ${state.retrying} 段等待重试（最多 3 次）` : state.failed ? ` · ${state.failed} 段失败，可重试` : state.phase === "watching" ? " · 已完成" : state.phase === "paused" ? " · 已暂停" : " · 正在翻译"}`);
    status.classList.toggle("error", Boolean(state.error || state.failed));
    const sources = this.element.querySelector(".source-status");
    sources.textContent = translationSourcesText(state);
    sources.hidden = !state.total && !state.active;
    const pause = this.element.querySelector('[data-action="toggle-pause"]');
    pause.hidden = !state.total || state.phase === "error";
    pause.textContent = state.active ? "暂停翻译" : "继续翻译";
    this.element.querySelector('[data-action="retry"]').hidden = !state.failed;
    if (!this.saving) this.renderConfig();
  }
}
