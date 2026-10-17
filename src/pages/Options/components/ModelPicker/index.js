import { normalizeBaseUrl } from "../../../../shared/settings.js";
import { sendMessage } from "../../../../shared/messaging.js";

/** 单个服务的模型选择器，拥有自动获取、手动输入与过期响应隔离状态。 */
export class ModelPicker {
  /** @param {string} provider 服务标识。@param {HTMLElement} root 服务表单。@param {Function} onChange 模型值变化后的未保存提示。 */
  constructor(provider, root, onChange) {
    /** @type {string} 当前服务 ID。 */
    this.provider = provider;
    /** @type {Function} 仅当模型 ID 改变时通知表单。 */
    this.onChange = onChange;
    /** @type {HTMLInputElement} 可信扩展页面内的 Key 输入框。 */
    this.keyInput = root.querySelector(`[name="${provider}Key"]`);
    /** @type {HTMLInputElement} 当前 API 地址。 */
    this.urlInput = root.querySelector(`[name="${provider}Url"]`);
    /** @type {HTMLInputElement} 表单提交的真实模型 ID，也允许手动输入。 */
    this.input = root.querySelector(`[name="${provider}Model"]`);
    /** @type {HTMLSelectElement} 测试连接与保存设置共用的推理档位。 */
    this.reasoningSelect = root.querySelector(`[name="${provider}ReasoningEffort"]`);
    /** @type {HTMLSelectElement|null} DeepSeek 的独立思考开关，OpenAI 不提供此字段。 */
    this.thinkingSelect = root.querySelector(`[name="${provider}ThinkingMode"]`);
    /** @type {HTMLSelectElement} 接口返回的模型及手动输入入口。 */
    this.select = root.querySelector("[data-model-picker]");
    /** @type {HTMLButtonElement} 重新获取列表的入口。 */
    this.button = root.querySelector("[data-models]");
    /** @type {HTMLElement} 不包含密钥的状态提示。 */
    this.status = root.querySelector("[data-model-status]");
    /** @type {Array<{id:string,name:string}>} 仅保存在当前设置页内存中的模型列表。 */
    this.models = [];
    /** @type {string|null} 最近成功获取的 Key / 地址组合，仅存在可信页面内存中。 */
    this.loadedIdentity = null;
    /** @type {number} 凭据变化时递增，旧响应不允许写回表单。 */
    this.revision = 0;
    /** @type {{identity:string,promise:Promise<Object[]>}|null} 可复用的同配置请求。 */
    this.pending = null;
    /** @type {ReturnType<typeof setTimeout>|null} 输入停止后的防抖计时器。 */
    this.timer = null;
    for (const input of [this.keyInput, this.urlInput])
      input.addEventListener("input", () => this.credentialsChanged());
    this.select.addEventListener("change", () => this.chooseModel());
    this.button.addEventListener("click", () => void this.refresh());
    window.addEventListener("pagehide", () => {
      clearTimeout(this.timer);
      this.revision++;
    });
  }

  /** 读取单个服务配置，不受另一服务未完成表单影响。@returns {Object} 当前服务配置。 */
  readProvider() {
    return {
      apiKey: this.keyInput.value.trim(),
      baseUrl: normalizeBaseUrl(this.urlInput.value),
      model: this.input.value.trim(),
      reasoningEffort: this.reasoningSelect.value,
      ...(this.thinkingSelect ? { thinkingMode: this.thinkingSelect.value } : {}),
    };
  }

  /** 标记需要重新获取，并在用户停止输入后自动请求。@returns {void} 无返回值。 */
  credentialsChanged() {
    clearTimeout(this.timer);
    this.revision++;
    this.loadedIdentity = null;
    this.pending = null;
    this.models = [];
    this.select.replaceChildren();
    this.select.hidden = true;
    this.input.hidden = false;
    this.input.parentElement.classList.remove("manual-model");
    this.button.disabled = false;
    this.button.textContent = "获取模型";
    this.status.className = "hint model-status";
    this.status.textContent = this.keyInput.value.trim()
      ? "即将自动获取模型…"
      : "填入 Key 后自动获取，也可手动填写模型 ID。";
    if (this.keyInput.value.trim())
      this.timer = setTimeout(() => void this.refresh({ automatic: true }), 750);
  }

  /** 根据选择切换真实模型 ID 或手动输入。@returns {void} 无返回值。 */
  chooseModel() {
    const manual = !this.select.value;
    this.input.hidden = !manual;
    this.input.parentElement.classList.toggle("manual-model", manual);
    if (!manual) this.input.value = this.select.value;
    else this.input.focus();
    this.onChange();
  }

  /** 展示列表；仅在展示名唯一匹配时改用真实 API ID，不替换未知的自定义模型。@returns {void} 无返回值。 */
  populate() {
    const current = this.input.value.trim();
    const exact = this.models.find((model) => model.id === current);
    const normalized = current.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    const matches = normalized
      ? this.models.filter((model) =>
          [model.id, model.name].some(
            (value) => value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "") === normalized,
          ),
        )
      : [];
    const chosen = exact || (matches.length === 1 ? matches[0] : null);
    this.select.replaceChildren(new Option("手动输入模型 ID…", ""));
    for (const model of this.models)
      this.select.add(
        new Option(model.name === model.id ? model.id : `${model.name} · ${model.id}`, model.id),
      );
    this.select.hidden = !this.models.length;
    this.select.value = chosen?.id || "";
    this.input.hidden = Boolean(chosen);
    this.input.parentElement.classList.toggle(
      "manual-model",
      !chosen && Boolean(this.models.length),
    );
    this.status.className = "hint model-status";
    this.status.textContent = this.models.length
      ? `已获取 ${this.models.length} 个模型，请选择支持文本对话的模型。`
      : "接口未列出可用模型，可手动填写模型 ID。";
    if (chosen && chosen.id !== current) {
      this.input.value = chosen.id;
      this.status.textContent = `已匹配 API 模型 ID：${chosen.id}，请保存设置。`;
      this.onChange();
    }
  }

  /** 获取列表；同一配置的自动请求复用进行中或已成功的结果。@param {Object} [options] 获取选项。@param {boolean} [options.automatic] 是否可复用结果。@returns {Promise<Object[]>} 模型列表，失败时保持手动配置并返回空列表。 */
  async refresh({ automatic = false } = {}) {
    clearTimeout(this.timer);
    let provider;
    try {
      provider = this.readProvider();
    } catch (error) {
      this.status.textContent = error.message;
      this.status.classList.add("error");
      return [];
    }
    if (!provider.apiKey) {
      this.status.textContent = "请先填写 API Key，随后会自动获取模型。";
      return [];
    }
    const identity = JSON.stringify([provider.apiKey, provider.baseUrl]);
    if (automatic && this.pending?.identity === identity) return this.pending.promise;
    if (automatic && this.loadedIdentity === identity) {
      this.populate();
      return this.models;
    }
    const revision = ++this.revision;
    this.button.disabled = true;
    this.button.textContent = "获取中…";
    this.status.className = "hint model-status";
    this.status.textContent = "正在自动获取可用模型…";
    const promise = this.load(provider, identity, revision);
    this.pending = { identity, promise };
    return promise;
  }

  /** 仅允许与当前凭据版本一致的响应更新界面。@param {Object} provider API 配置。@param {string} identity 本次凭据标识。@param {number} revision 本次版本。@returns {Promise<Object[]>} 模型列表。 */
  async load(provider, identity, revision) {
    try {
      const models = await sendMessage({ type: "LIST_MODELS", provider });
      if (revision !== this.revision) return [];
      this.models = models;
      this.loadedIdentity = identity;
      this.populate();
      return models;
    } catch (error) {
      if (revision === this.revision) {
        this.status.textContent = error.message;
        this.status.classList.add("error");
      }
      return [];
    } finally {
      if (revision === this.revision) {
        this.pending = null;
        this.button.disabled = false;
        this.button.textContent = "重新获取";
      }
    }
  }
}
