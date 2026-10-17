/** 推理档位仅保存稳定的接口值；不同服务的可选范围分别展示。 */
export const REASONING_LEVELS = [
  ["default", "接口默认"],
  ["none", "关闭思考"],
  ["minimal", "极低"],
  ["low", "低"],
  ["medium", "中"],
  ["high", "高"],
  ["xhigh", "极高"],
  ["max", "最高"],
];

/** DeepSeek 的思考开关独立于强度；接口默认时不替用户指定开关。 */
export const THINKING_MODES = [
  ["disabled", "关闭"],
  ["enabled", "开启"],
  ["default", "接口默认"],
];

/** 根据实际端点识别 DeepSeek 官方协议，代理接口只使用通用的推理参数。 */
function isOfficialDeepSeek(baseUrl) {
  try {
    return new URL(baseUrl).hostname === "api.deepseek.com";
  } catch {
    return false;
  }
}

/** 旧配置缺少字段时保留原行为：DeepSeek 官方关闭思考，其他接口不传参数。 */
export function normalizeReasoningEffort(value, baseUrl) {
  const effort = value ?? (isOfficialDeepSeek(baseUrl) ? "none" : "default");
  if (!REASONING_LEVELS.some(([id]) => id === effort))
    throw new Error("推理级别无效，请从下拉框重新选择。");
  return effort;
}

/** 旧版用 none 表示关闭、具体档位表示开启；缺少独立开关时按原行为补齐。 */
export function normalizeThinkingMode(value, effort) {
  const mode =
    value ?? (effort === "none" ? "disabled" : effort === "default" ? "default" : "enabled");
  if (!THINKING_MODES.some(([id]) => id === mode))
    throw new Error("思考模式无效，请从下拉框重新选择。");
  return mode;
}

/**
 * 思考开关优先：关闭时绝不发送预选的强度，避免 reasoning_effort 隐式开启思考。
 * 接口默认时两个参数都省略；明确开启后才发送预选强度，单独调整强度不会改变开关。
 * 没有独立开关的旧调用及 OpenAI 保持原参数行为；代理使用通用的 none 关闭思考。
 */
export function reasoningParameters(provider) {
  const effort = normalizeReasoningEffort(provider.reasoningEffort, provider.baseUrl);
  if (provider.thinkingMode !== undefined) {
    const mode = normalizeThinkingMode(provider.thinkingMode, effort);
    if (mode === "default") return {};
    const official = isOfficialDeepSeek(provider.baseUrl);
    if (mode === "disabled")
      return official ? { thinking: { type: "disabled" } } : { reasoning_effort: "none" };
    const level = effort === "none" ? "default" : effort;
    if (official)
      return {
        thinking: { type: "enabled" },
        ...(level === "default" ? {} : { reasoning_effort: level }),
      };
    return { reasoning_effort: level === "default" ? "high" : level };
  }
  if (effort === "default") return {};
  if (isOfficialDeepSeek(provider.baseUrl)) {
    if (effort === "none") return { thinking: { type: "disabled" } };
    return { thinking: { type: "enabled" }, reasoning_effort: effort };
  }
  return { reasoning_effort: effort };
}

/**
 * 按实际生效参数生成签名，关闭思考时更改预选强度不会使原缓存失效或触发重译。
 * 已有档位及关闭模式保持原签名，开启但不指定强度时单独隔离，避免与接口默认混用。
 * 只改变缓存身份，不迁移、清空或覆盖旧缓存，切回原档位仍能命中原条目。
 */
export function reasoningSignature(provider) {
  const parameters = reasoningParameters(provider);
  const effort =
    parameters.reasoning_effort ??
    (parameters.thinking?.type === "disabled"
      ? "none"
      : parameters.thinking?.type === "enabled"
        ? "enabled-default"
        : "default");
  const legacy = isOfficialDeepSeek(provider.baseUrl) ? "none" : "default";
  return effort === legacy ? "" : effort;
}
