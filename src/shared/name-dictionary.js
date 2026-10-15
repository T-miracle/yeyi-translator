export const NAME_DICTIONARY_KEY = "nameDictionary";
export const MAX_DICTIONARY_BYTES = 8 * 1024 * 1024;

/**
 * 完整校验 AiNiee 的 src/dst/info 列表，再返回独立副本；任一行错误都拒绝整份文件。
 * 空译文可作为待补充条目保存，但不参与翻译。正则采用不同引擎，明确拒绝以免静默改变人名。
 */
export function normalizeNameEntries(data) {
  if (!Array.isArray(data) || data.length > 10000)
    throw new Error("人名字典格式无效：需要 AiNiee JSON 列表，最多 10000 条。");
  const entries = data.map((row, index) => {
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      typeof row.src !== "string" ||
      !row.src.trim() ||
      row.src.length > 500 ||
      typeof row.dst !== "string" ||
      row.dst.length > 500 ||
      (row.info !== undefined && (typeof row.info !== "string" || row.info.length > 2000)) ||
      (row.regex !== undefined && typeof row.regex !== "boolean")
    )
      throw new Error(
        `人名字典第 ${index + 1} 行格式无效，请检查原文、译文和描述；已有数据未修改。`,
      );
    if (row.regex === true)
      throw new Error(
        `人名字典第 ${index + 1} 行启用了正则；请先在 AiNiee 改为普通人名。已有数据未修改。`,
      );
    return { src: row.src.trim(), dst: row.dst.trim(), info: row.info || "" };
  });
  if (new TextEncoder().encode(JSON.stringify(entries)).length > MAX_DICTIONARY_BYTES)
    throw new Error("人名字典超过 8 MB，已有数据未修改，请拆分文件。");
  return entries;
}

/** 人名按字面、不区分大小写匹配，不将用户输入解释为正则。 */
export function nameKey(source) {
  return source.trim().toLowerCase();
}

/** 只提取本次原文及上下文中出现的条目，较长人名优先，减少提示词开销。 */
export function matchingNames(entries, segments, contextParts = []) {
  const text = [
    ...segments.flatMap((item) => [item.parts.join(""), item.context || ""]),
    contextParts.join(""),
  ]
    .join("\n")
    .toLowerCase();
  return entries
    .filter((entry) => entry.dst && text.includes(nameKey(entry.src)))
    .sort((a, b) => b.src.length - a.src.length);
}

/** 整个文本节点为人名时直接使用约定译名，保留原来的首尾空白。 */
export function translateNamePart(part, entries) {
  const entry = entries.find((item) => item.dst && nameKey(item.src) === nameKey(part));
  if (!entry) return null;
  return (
    part.slice(0, part.length - part.trimStart().length) +
    entry.dst +
    part.slice(part.trimEnd().length)
  );
}

/**
 * 对本机保留片段按最长字面人名替换；跨节点匹配的译名写入起始节点，其余节点保留未命中的文字。
 * @param {string[]} parts 连续原文节点。
 * @param {Object[]} entries 本次命中的有效人名。
 * @returns {string[]} 与原节点数量相同的本机译文。
 */
export function replaceNameParts(parts, entries) {
  if (!entries.length) return [...parts];
  const sorted = [...entries]
    .filter((entry) => entry.dst)
    .sort((a, b) => b.src.length - a.src.length);
  if (!sorted.length) return [...parts];
  const pattern = new RegExp(
    sorted.map((entry) => entry.src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "giu",
  );
  const names = new Map(sorted.map((entry) => [nameKey(entry.src), entry.dst]));
  const matches = [...parts.join("").matchAll(pattern)];
  let offset = 0;
  return parts.map((part) => {
    const start = offset;
    const end = (offset += part.length);
    let cursor = 0;
    let translated = "";
    for (const match of matches) {
      if (match.index >= end) break;
      const matchEnd = match.index + match[0].length;
      if (matchEnd <= start) continue;
      translated += part.slice(cursor, Math.max(start, match.index) - start);
      if (match.index >= start) translated += names.get(nameKey(match[0]));
      cursor = Math.min(end, matchEnd) - start;
    }
    return translated + part.slice(cursor);
  });
}

/** 全部节点均为人名、纯标点或本机保留片段时在本地完成；其余正文交给翻译接口。@param {Object[]} segments 原文片段。@param {Object[]} entries 命中人名。@returns {Object[]} 可完全在本机完成的译文。 */
export function localNameTranslations(segments, entries) {
  return segments.flatMap((segment) => {
    if (segment.dictionaryOnly)
      return [{ id: segment.id, parts: replaceNameParts(segment.parts, entries) }];
    let matched = false;
    const parts = segment.parts.map((part) => {
      const translated = translateNamePart(part, entries);
      if (translated !== null) matched = true;
      return translated ?? (/\p{L}/u.test(part) ? null : part);
    });
    return matched && parts.every((part) => part !== null) ? [{ id: segment.id, parts }] : [];
  });
}

/** 对有效条目生成稳定摘要；排序变化、禁用和空译文不使既有无字典缓存失效。 */
export async function nameDictionarySignature(dictionary) {
  const entries = dictionary.enabled
    ? dictionary.entries
        .filter((entry) => entry.dst)
        .sort((a, b) =>
          nameKey(a.src) < nameKey(b.src) ? -1 : nameKey(a.src) > nameKey(b.src) ? 1 : 0,
        )
    : [];
  if (!entries.length) return "";
  const bytes = new TextEncoder().encode(JSON.stringify(entries));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
