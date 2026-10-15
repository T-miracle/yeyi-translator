const MODIFIERS = ["Ctrl", "Alt", "Shift", "Meta"];

/** 校验并统一快捷键格式；空字符串表示停用，至少需要 Ctrl、Alt 或 Meta。 */
export function normalizeShortcut(value) {
  if (value === "") return "";
  if (typeof value !== "string") throw new Error("快捷键格式无效。");
  const parts = value.split("+").map((part) => part.trim().toLowerCase());
  const key = parts.pop().toUpperCase();
  const modifiers = MODIFIERS.filter((modifier) => parts.includes(modifier.toLowerCase()));
  if (
    modifiers.length !== parts.length ||
    !modifiers.some((modifier) => modifier !== "Shift") ||
    !/^(?:[A-Z0-9]|F(?:[1-9]|1[0-2]))$/.test(key)
  )
    throw new Error("快捷键请使用 Ctrl、Alt 或 Meta 搭配字母、数字或 F1～F12，可附加 Shift。");
  return [...modifiers, key].join("+");
}

/** 从按键事件生成组合；优先使用实体键码，避免 Shift 和输入法改变字母。 */
export function shortcutFromEvent(event) {
  if (event.isComposing || event.getModifierState?.("AltGraph")) return "";
  const key = /^(?:Key[A-Z]|Digit[0-9])$/.test(event.code)
    ? event.code.replace(/^(?:Key|Digit)/, "")
    : event.key;
  const modifiers = MODIFIERS.filter((modifier) => event[`${modifier.toLowerCase()}Key`]);
  try {
    return normalizeShortcut([...modifiers, key].join("+"));
  } catch {
    return "";
  }
}

/** 精确匹配组合，忽略长按，并保留输入框、富文本及 Shadow DOM 编辑器中的剪切等操作。 */
export function matchesShortcut(event, shortcut) {
  if (!shortcut || event.repeat || shortcutFromEvent(event) !== shortcut) return false;
  return !event
    .composedPath()
    .some(
      (node) =>
        node.isContentEditable || node.matches?.("input, textarea, select, [role='textbox']"),
    );
}
