import { NAME_DICTIONARY_KEY, normalizeNameEntries, nameKey } from "../shared/name-dictionary.js";

/** 人名字典独立存储，由后台串行修改；保存普通设置和清理译文缓存均不触碰此数据。 */
export class NameDictionary {
  constructor(storage = chrome.storage.local) {
    this.storage = storage;
    this.queue = Promise.resolve();
  }

  /** 读取用户数据；格式异常直接报错，绝不以空字典覆盖已有数据。 */
  async read() {
    const stored = (await this.storage.get(NAME_DICTIONARY_KEY))[NAME_DICTIONARY_KEY];
    if (stored === undefined) return { version: 1, enabled: true, entries: [] };
    if (stored?.version !== 1 || typeof stored.enabled !== "boolean")
      throw new Error("本机人名字典格式异常，请先备份扩展数据，未修改已有数据。");
    const entries = normalizeNameEntries(stored.entries);
    if (new Set(entries.map((entry) => nameKey(entry.src))).size !== entries.length)
      throw new Error("本机人名字典存在重复原文，请先备份扩展数据，未修改已有数据。");
    return { version: 1, enabled: stored.enabled, entries };
  }

  /**
   * 所有修改均读取最新字典后排队合并，最后以单次 set 提交整份记录。
   * 验证失败、编辑冲突或存储失败时不清空、不回写旧副本，也不覆盖其他存储键。
   */
  update(change) {
    const task = this.queue
      .catch(() => {})
      .then(async () => {
        const current = await this.read();
        const result = change(current);
        normalizeNameEntries(current.entries);
        await this.storage.set({ [NAME_DICTIONARY_KEY]: current });
        return { ...result, dictionary: current };
      });
    this.queue = task;
    return task;
  }

  /** 全文件验证后合并；同文件及本机重复均保留先前条目，不覆盖用户修改。 */
  importData(data) {
    const incoming = normalizeNameEntries(data);
    return this.update((current) => {
      const keys = new Set(current.entries.map((entry) => nameKey(entry.src)));
      let added = 0;
      for (const entry of incoming) {
        const key = nameKey(entry.src);
        if (keys.has(key)) continue;
        current.entries.push(entry);
        keys.add(key);
        added++;
      }
      return { added, skipped: incoming.length - added };
    });
  }

  /** 编辑和删除使用原条目核对，拒绝另一设置页已经改过的数据。 */
  saveEntry(entry, previous) {
    const next = entry === null ? null : normalizeNameEntries([entry])[0];
    const expected = previous ? normalizeNameEntries([previous])[0] : null;
    if (!next && !expected) throw new Error("请选择需要删除的人名。");
    return this.update((current) => {
      const index = expected
        ? current.entries.findIndex((row) => nameKey(row.src) === nameKey(expected.src))
        : -1;
      if (
        expected &&
        (index < 0 || JSON.stringify(current.entries[index]) !== JSON.stringify(expected))
      )
        throw new Error("此人名已在其他设置页修改，请重新载入后再编辑；已有数据未覆盖。");
      if (
        next &&
        current.entries.some((row, i) => i !== index && nameKey(row.src) === nameKey(next.src))
      )
        throw new Error("此原文已存在，请编辑已有条目；已有数据未覆盖。");
      if (!next) current.entries.splice(index, 1);
      else if (index < 0) current.entries.push(next);
      else current.entries[index] = next;
      return {};
    });
  }

  /** 切换启用状态，保留全部条目。 */
  setEnabled(enabled) {
    if (typeof enabled !== "boolean") throw new Error("无效的人名字典开关。");
    return this.update((current) => {
      current.enabled = enabled;
      return {};
    });
  }
}
