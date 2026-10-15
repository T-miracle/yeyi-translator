export const CACHE_FORMAT = "yeyi-translation-cache";

/** 单条缓存不超过翻译接口既有的 2 MB 响应上限；整个缓存文件没有容量硬上限。 */
export function validCacheEntry(entry) {
  return Boolean(
    entry &&
    typeof entry.key === "string" &&
    /^[a-f0-9]{64}$/.test(entry.key) &&
    Array.isArray(entry.parts) &&
    entry.parts.length > 0 &&
    entry.parts.length <= 100 &&
    entry.parts.every((part) => typeof part === "string") &&
    entry.parts.reduce((sum, part) => sum + part.length, 0) <= 2_000_000,
  );
}

/** 在任何写入之前完整校验文件，错误文件不会产生部分导入。 */
export function validateCacheFile(data) {
  if (
    !data ||
    data.format !== CACHE_FORMAT ||
    data.version !== 1 ||
    !Array.isArray(data.entries) ||
    !data.entries.every(validCacheEntry)
  ) {
    const error = new Error("缓存文件格式无效或版本不受支持，请选择页译导出的 JSON 文件。");
    error.code = "BAD_INPUT";
    throw error;
  }
}

/** 分批发送已校验条目，即使 JSON 转义膨胀也保持低于 Chrome 单条消息的 64 MiB 限制。 */
export function* cacheFileBatches(entries, maxChars = 4_000_000) {
  let batch = [];
  let chars = 0;
  for (const entry of entries) {
    const size = entry.parts.reduce((sum, part) => sum + part.length, 0) + 1000;
    if (batch.length && chars + size > maxChars) {
      yield batch;
      batch = [];
      chars = 0;
    }
    batch.push(entry);
    chars += size;
  }
  if (batch.length) yield batch;
}
