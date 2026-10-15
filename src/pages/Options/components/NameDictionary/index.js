import { sendMessage } from "../../../../shared/messaging.js";
import {
  MAX_DICTIONARY_BYTES,
  NAME_DICTIONARY_KEY,
  normalizeNameEntries,
} from "../../../../shared/name-dictionary.js";

/** 独立的人名字典编辑器，操作即时保存，不与 API 设置表单互相覆盖。 */
export class NameDictionaryEditor {
  constructor(root) {
    this.root = root;
    this.dictionary = { enabled: true, entries: [] };
    this.previous = null;
    this.busy = false;
    this.ready = false;
    this.result = root.querySelector("#nameResult");
    this.enabled = root.querySelector("#nameDictionaryEnabled");
    this.source = root.querySelector("#nameSource");
    this.translation = root.querySelector("#nameTranslation");
    this.info = root.querySelector("#nameInfo");
    this.search = root.querySelector("#nameSearch");
    this.file = root.querySelector("#nameFile");
    root.querySelector("#saveName").addEventListener("click", () => this.save());
    root.querySelector("#cancelName").addEventListener("click", () => this.resetEditor());
    root.querySelector("#reloadNames").addEventListener("click", () => this.refresh());
    root.querySelector("#importNames").addEventListener("click", () => this.file.click());
    root.querySelector("#exportNames").addEventListener("click", () => this.export());
    this.search.addEventListener("input", () => this.render());
    this.enabled.addEventListener("change", () => {
      const enabled = this.enabled.checked;
      void this.action(async () => {
        const result = await sendMessage({ type: "SET_NAME_DICTIONARY_ENABLED", enabled });
        this.dictionary = result.dictionary;
        return enabled
          ? "已启用人名字典，翻译中的页面会自动更新。"
          : "已停用人名字典，已有条目保留。";
      });
    });
    this.file.addEventListener("change", () => {
      const file = this.file.files[0];
      this.file.value = "";
      if (file) void this.import(file);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[NAME_DICTIONARY_KEY] && !this.busy) void this.refresh();
    });
    void this.refresh();
  }

  /** 刷新列表时保留未提交的编辑；保存时仍使用原条目检测并发冲突。 */
  async refresh() {
    try {
      this.dictionary = await sendMessage({ type: "GET_NAME_DICTIONARY" });
      this.ready = true;
      this.render();
      this.setDisabled(false);
    } catch (error) {
      this.ready = false;
      this.result.textContent = error.message;
      this.result.className = "hint error";
      this.setDisabled(true);
      this.root.querySelector("#reloadNames").disabled = false;
    }
  }

  /** 锁定写操作期间的控件，避免重复提交。 */
  setDisabled(disabled) {
    for (const control of this.root.querySelectorAll("button,input,textarea"))
      if (control !== this.search) control.disabled = disabled;
  }

  /** 统一展示写入结果；失败保留草稿和原有条目。 */
  async action(work) {
    if (this.busy || !this.ready) return;
    this.busy = true;
    this.setDisabled(true);
    this.result.textContent = "处理中…";
    this.result.className = "hint";
    try {
      this.result.textContent = await work();
    } catch (error) {
      this.result.textContent = error.message;
      this.result.className = "hint error";
    } finally {
      this.busy = false;
      this.render();
      this.setDisabled(false);
    }
  }

  /** 以文本节点绘制用户数据，避免导入的 HTML 被当作页面内容执行。 */
  render() {
    this.enabled.checked = this.dictionary.enabled;
    const query = this.search.value.trim().toLowerCase();
    const entries = this.dictionary.entries.filter((entry) =>
      [entry.src, entry.dst, entry.info].some((value) => value.toLowerCase().includes(query)),
    );
    const shown = entries.slice(0, 100);
    this.root.querySelector("#nameCount").textContent =
      `共 ${this.dictionary.entries.length} 条${query ? ` · 匹配 ${entries.length} 条` : ""}${entries.length > shown.length ? " · 显示前 100 条，请搜索定位" : ""}`;
    const body = this.root.querySelector("#nameRows");
    body.replaceChildren();
    for (const entry of shown) {
      const row = document.createElement("tr");
      for (const value of [entry.src, entry.dst || "待补充", entry.info]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }
      const actions = document.createElement("td");
      for (const [label, work] of [
        ["编辑", () => this.edit(entry)],
        [
          "删除",
          () =>
            this.action(async () => {
              const result = await sendMessage({
                type: "SAVE_NAME_ENTRY",
                entry: null,
                previous: entry,
              });
              this.dictionary = result.dictionary;
              if (this.previous?.src === entry.src) this.resetEditor();
              return "已删除该人名。";
            }),
        ],
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "name-row-action";
        button.textContent = label;
        button.setAttribute("aria-label", `${label} ${entry.src}`);
        button.disabled = this.busy;
        button.addEventListener("click", work);
        actions.append(button);
      }
      row.append(actions);
      body.append(row);
    }
    this.root.querySelector("#nameEmpty").hidden = entries.length > 0;
  }

  /** 将选中人名复制到编辑栏。 */
  edit(entry) {
    this.previous = { ...entry };
    this.source.value = entry.src;
    this.translation.value = entry.dst;
    this.info.value = entry.info;
    this.root.querySelector("#saveName").textContent = "保存人名";
    this.source.focus();
  }

  /** 清除编辑草稿，不修改已保存数据。 */
  resetEditor() {
    this.previous = null;
    this.source.value = "";
    this.translation.value = "";
    this.info.value = "";
    this.root.querySelector("#saveName").textContent = "添加人名";
  }

  /** 添加或更新单条，后台负责重复和并发校验。 */
  save() {
    return this.action(async () => {
      const [entry] = normalizeNameEntries([
        {
          src: this.source.value,
          dst: this.translation.value,
          info: this.info.value,
        },
      ]);
      const result = await sendMessage({ type: "SAVE_NAME_ENTRY", entry, previous: this.previous });
      this.dictionary = result.dictionary;
      this.resetEditor();
      return "人名已保存，翻译中的页面会自动更新。";
    });
  }

  /** 先解析完整文件再提交；导入不清空、不覆盖本机已有条目。 */
  import(file) {
    return this.action(async () => {
      if (file.size > MAX_DICTIONARY_BYTES) throw new Error("人名字典超过 8 MB，已有数据未修改。");
      let data;
      try {
        data = JSON.parse((await file.text()).replace(/^\uFEFF/, ""));
      } catch {
        throw new Error("无法读取人名字典 JSON，已有数据未修改。");
      }
      const entries = normalizeNameEntries(data);
      const result = await sendMessage({ type: "IMPORT_NAME_DICTIONARY", entries });
      this.dictionary = result.dictionary;
      return `已导入 ${result.added} 条，跳过 ${result.skipped} 条重复记录；本机已有数据优先保留。`;
    });
  }

  /** 导出纯 AiNiee 列表，不混入开关、接口设置或密钥。 */
  export() {
    return this.action(async () => {
      const data = await sendMessage({ type: "GET_NAME_DICTIONARY" });
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data.entries, null, 2)], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `yeyi-names-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return `已导出 ${data.entries.length} 条人名，可直接导入 AiNiee 的 AI 术语表。`;
    });
  }
}
