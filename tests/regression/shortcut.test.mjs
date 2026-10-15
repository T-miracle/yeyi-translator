import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSettings, publicSettings } from "../../src/shared/settings.js";
import {
  normalizeShortcut,
  shortcutFromEvent,
  matchesShortcut,
} from "../../src/shared/shortcut.js";

const keyEvent = (patch = {}) => ({
  key: "x",
  code: "KeyX",
  ctrlKey: true,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  composedPath: () => [],
  ...patch,
});

test("快捷键默认兼容旧设置，隐藏偏好、Key、模型、网站及缓存签名保持不变", () => {
  const previous = {
    providers: { deepseek: { apiKey: "saved-shortcut-key", model: "custom-model" } },
    showFloatingButton: false,
    autoTranslateSites: ["example.com"],
    cacheEnabled: true,
    cacheLimitMb: 128,
  };
  const before = structuredClone(previous);
  const settings = normalizeSettings(previous);
  assert.deepEqual(previous, before);
  assert.equal(settings.translationShortcut, "Ctrl+X");
  assert.equal(settings.showFloatingButton, false);
  assert.equal(settings.providers.deepseek.apiKey, previous.providers.deepseek.apiKey);
  assert.equal(settings.providers.deepseek.model, previous.providers.deepseek.model);
  assert.deepEqual(settings.autoTranslateSites, previous.autoTranslateSites);
  assert.equal(settings.cacheEnabled, true);
  assert.equal(settings.cacheLimitMb, 128);
  const changed = normalizeSettings({ ...settings, translationShortcut: "Alt+Shift+T" });
  assert.equal(publicSettings(changed).signature, publicSettings(settings).signature);
  assert.equal(publicSettings(changed).translationShortcut, "Alt+Shift+T");
  assert(!JSON.stringify(publicSettings(changed)).includes(previous.providers.deepseek.apiKey));
  assert.equal(normalizeSettings().showFloatingButton, true);
  assert.equal(normalizeSettings({ translationShortcut: "" }).translationShortcut, "");
});

test("快捷键规范化组合顺序，并拒绝无修饰键、重复修饰键和不支持的按键", () => {
  assert.equal(normalizeShortcut(" shift + ctrl + y "), "Ctrl+Shift+Y");
  assert.equal(normalizeShortcut("meta+alt+F12"), "Alt+Meta+F12");
  assert.equal(normalizeShortcut("Ctrl+1"), "Ctrl+1");
  assert.equal(normalizeShortcut(""), "");
  for (const value of [null, 1, "X", "Shift+X", "Ctrl+Ctrl+X", "Ctrl+", "Ctrl+F13", "Ctrl+Tab"])
    assert.throws(() => normalizeShortcut(value));
});

test("键盘匹配精确区分修饰键，兼容 Shift 键码并忽略长按、输入法及 AltGraph", () => {
  assert.equal(shortcutFromEvent(keyEvent()), "Ctrl+X");
  assert.equal(
    shortcutFromEvent(keyEvent({ key: "!", code: "Digit1", shiftKey: true })),
    "Ctrl+Shift+1",
  );
  assert.equal(matchesShortcut(keyEvent(), "Ctrl+X"), true);
  assert.equal(matchesShortcut(keyEvent({ shiftKey: true }), "Ctrl+X"), false);
  assert.equal(matchesShortcut(keyEvent({ repeat: true }), "Ctrl+X"), false);
  assert.equal(matchesShortcut(keyEvent({ isComposing: true }), "Ctrl+X"), false);
  assert.equal(matchesShortcut(keyEvent({ getModifierState: () => true }), "Ctrl+X"), false);
  assert.equal(matchesShortcut(keyEvent(), ""), false);
});

test("输入框、富文本及 Shadow DOM 内层编辑节点保留原有快捷操作", () => {
  for (const node of [{ isContentEditable: true }, { matches: () => true }]) {
    assert.equal(
      matchesShortcut(keyEvent({ composedPath: () => [{}, node, {}] }), "Ctrl+X"),
      false,
    );
  }
});
