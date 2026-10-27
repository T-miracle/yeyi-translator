import { isJapaneseText } from "../shared/translation-profile.js";

const SKIP =
  'script,style,noscript,pre,kbd,samp,textarea,input,select,option,svg,math,canvas,video,audio,[contenteditable]:not([contenteditable="false"]),[translate="no"],.notranslate,[data-yeyi-owned]';
const PROSE = "article,main,[role=main],[role=article],.markdown-body";
const PROSE_BLOCK = "p,li,td,th,dt,dd,figcaption,caption,summary,h1,h2,h3,h4,h5,h6";
const CODE_SYNTAX = "pre,.hljs,.highlight,[class*=language-],[class*=highlight-source-]";
// Discord 的哈希后缀随版本变化；使用语义 ID 和类名前缀排除作者、回复作者及成员名。
const DISCORD_NAMES =
  '[id^="message-username-"],[class*="username_"],[class*="displayName_"],[class*="nickname_"],[data-user-id]';
const BLOCK_DISPLAYS = new Set([
  "block",
  "flow-root",
  "flex",
  "grid",
  "list-item",
  "table-cell",
  "table-caption",
  "inline-block",
]);
const LEAF_BLOCKS = new Set([
  "P",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "BUTTON",
  "LABEL",
  "TD",
  "TH",
  "DT",
  "DD",
  "FIGCAPTION",
  "CAPTION",
  "SUMMARY",
]);

/** 把长文本按句子边界分片，避免切断 Unicode 码点。@param {string} text 原文。@param {number} [limit] 每片 UTF-16 字符上限。@returns {string[]} 无损分片。 */
export function splitText(text, limit = 1200) {
  if (text.length <= limit) return [text];
  const sentences =
    typeof Intl.Segmenter === "function"
      ? [...new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(text)].map(
          (entry) => entry.segment,
        )
      : [text];
  const parts = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > limit) {
      parts.push(current);
      current = "";
    }
    if (sentence.length <= limit) {
      current += sentence;
      continue;
    }
    for (const character of sentence) {
      if (current.length + character.length > limit) {
        parts.push(current);
        current = "";
      }
      current += character;
    }
  }
  if (current) parts.push(current);
  return parts;
}

/** 收集当前可渲染的文本，按最近段落边界分组；不要求位于视口内。@param {Document} doc 网页文档。@param {WeakMap} ownership 节点原文记录。@returns {Map<Element,Object[]>} 段落与原文节点。 */
export function collectGroups(doc, ownership) {
  const groups = new Map();
  if (!doc.body) return groups;
  const styles = new Map();
  const visibility = new Map();
  const codeLabels = new Map();
  const codeEligibility = new Map();
  const discord =
    /(^|\.)(discord\.com|discordapp\.com)$/i.test(doc.location?.hostname || "") ||
    Boolean(doc.querySelector('#app-mount [id^="chat-messages-"],[data-list-id="chat-messages"]'));
  /** 以原文判断节点类型，避免替换模式写入译文后改变扫描结果。@param {Text} text 文本节点。@returns {string} 当前仍受扩展管理的原文或网站新文本。 */
  function originalOf(text) {
    const previous = ownership.get(text);
    return previous && text.data === previous.lastWritten ? previous.original : text.data;
  }
  /** 在一次扫描内复用样式查询。@param {Element} element 页面元素。@returns {CSSStyleDeclaration} 计算样式。 */
  function styleOf(element) {
    if (!styles.has(element)) styles.set(element, doc.defaultView.getComputedStyle(element));
    return styles.get(element);
  }
  /** 识别正文中的可读标签；路径、标识符、缩写、命令及高亮代码不开放。@param {Element} code code 元素。@returns {{natural: boolean, phrase: boolean}} 是否像自然语言标签、是否包含多个词。 */
  function codeLabel(code) {
    if (codeLabels.has(code)) return codeLabels.get(code);
    if (code.closest(CODE_SYNTAX) || !["inline", "inline-block"].includes(styleOf(code).display)) {
      const result = { natural: false, phrase: false };
      codeLabels.set(code, result);
      return result;
    }
    const walker = doc.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    let text = "";
    let node;
    while ((node = walker.nextNode())) text += originalOf(node);
    // 有些文档把内容类型放进 code；括号中的短类别编号仍属于该可读标签。
    const label = text.trim().replace(/ \([a-z]{2,4}(?:\/[a-z]{2,4})+\)$/, "");
    const natural =
      label.length <= 120 &&
      /^\p{Lu}[\p{L}\p{M}]*(?:[ -][\p{L}\p{M}]+)*$/u.test(label) &&
      /\p{Ll}/u.test(label) &&
      !/\p{Ll}\p{Lu}/u.test(label);
    const result = { natural, phrase: natural && /\s/.test(label) };
    codeLabels.set(code, result);
    return result;
  }
  /** 查找逗号连续连接的同段标签词组，避免旁边说明中的 API 单词被误判为分类名。@param {Element} code 待判断的单词标签。@param {Element} block 正文段落。@returns {boolean} 是否属于含自然语言词组的枚举列表。 */
  function hasLabelContext(code, block) {
    const codes = [...block.querySelectorAll("code")];
    const current = codes.indexOf(code);
    for (const direction of [-1, 1]) {
      for (
        let index = current + direction;
        index >= 0 && index < codes.length;
        index += direction
      ) {
        const candidate = codes[index];
        const neighbor = codes[index - direction];
        const between = doc.createRange();
        between.setStartAfter(direction < 0 ? candidate : neighbor);
        between.setEndBefore(direction < 0 ? neighbor : candidate);
        if (!/^\s*[,，、]\s*$/.test(between.toString()) || !codeLabel(candidate).natural) break;
        if (codeLabel(candidate).phrase) return true;
      }
    }
    return false;
  }
  /** 只放行正文中的自然语言词组；孤立单词还需同段标签词组提供列表语境。@param {Element} code code 元素。@returns {boolean} 是否可随正文翻译。 */
  function translatableCode(code) {
    if (codeEligibility.has(code)) return codeEligibility.get(code);
    const block = code.closest(PROSE_BLOCK);
    const label = block?.closest(PROSE) ? codeLabel(code) : { natural: false, phrase: false };
    const result = Boolean(label.natural && (label.phrase || hasLabelContext(code, block)));
    codeEligibility.set(code, result);
    return result;
  }
  /** 检查祖先的隐藏与排除规则。@param {Element} element 文本父元素。@returns {boolean} 是否适合翻译。 */
  function visible(element) {
    if (visibility.has(element)) return visibility.get(element);
    const style = styleOf(element);
    const ownVisible =
      !element.matches(SKIP) &&
      !(discord && element.matches(DISCORD_NAMES)) &&
      (element.tagName !== "CODE" || translatableCode(element)) &&
      !element.hidden &&
      element.getAttribute("aria-hidden") !== "true" &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.visibility !== "collapse" &&
      Number(style.opacity) !== 0 &&
      !/^rect\(0px[, ]+0px[, ]+0px[, ]+0px\)$/.test(style.clip) &&
      style.clipPath !== "inset(50%)" &&
      style.contentVisibility !== "hidden";
    const result =
      ownVisible &&
      (element === doc.body || !element.parentElement || visible(element.parentElement));
    visibility.set(element, result);
    return result;
  }
  /** 寻找段落容器，内联链接和加粗不会被拆为独立段落。@param {Element} element 文本父元素。@returns {Element} 段落容器。 */
  function ownerOf(element) {
    let current = element;
    while (current.parentElement && current !== doc.body) {
      if (
        current.tagName !== "CODE" &&
        (LEAF_BLOCKS.has(current.tagName) || BLOCK_DISPLAYS.has(styleOf(current).display))
      )
        return current;
      current = current.parentElement;
    }
    return current;
  }
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || !visible(parent)) continue;
    const original = originalOf(node);
    if (!original) continue;
    const owner = ownerOf(parent);
    if (!owner.getClientRects().length) continue;
    if (!groups.has(owner)) groups.set(owner, []);
    groups.get(owner).push({ node, original });
  }
  // 标点、空白、数字必须跟随同段正文；只有整段没有语言文字时才跳过。
  for (const [owner, records] of groups) {
    const text = records.map((record) => record.original).join("");
    if (!/\p{L}/u.test(text) || /^(?:https?:\/\/|www\.)\S+$/i.test(text.trim()))
      groups.delete(owner);
  }
  return groups;
}

/** 识别以中文为主的原文，允许品牌、缩写和少量外文词；日文假名与韩文不按中文跳过。@param {string} text 完整原文。@returns {boolean} 是否可直接保留为中文。 */
export function isChineseText(text) {
  const han = text.match(/\p{Script=Han}/gu) || [];
  if (!han.length || /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text))
    return false;
  const prose = text.replace(/(?:https?:\/\/|www\.)\S+/gi, "");
  const words = prose.match(/[A-Za-z]+(?:[-'][A-Za-z]+)*/g) || [];
  const lowercase = words.filter((word) => /^[a-z]/.test(word)).length;
  const latinLength = words.join("").length;
  const sentence = [...prose.matchAll(/[A-Za-z]+(?:\s+[A-Za-z]+){3,}/g)].some(
    (match) => (match[0].match(/\b[a-z][a-z]+/g) || []).length >= 2,
  );
  return !sentence && !(words.length >= 3 && lowercase >= 2 && latinLength > han.length);
}

/** 将中文与外文分开；日语段落保留完整语义，节点顺序用于无损拼接。@param {string} text 节点原文。@param {boolean} preserveAll 是否整段已经为中文。@param {boolean} japanese 是否属于日语段落。@returns {Array<{text:string,preserve:boolean}>} 文本片段。 */
export function textFragments(text, preserveAll = false, japanese = false) {
  if (preserveAll) return [{ text, preserve: true }];
  if (japanese || /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text))
    return [{ text, preserve: !/\p{L}/u.test(text) }];
  return text
    .split(/(\p{Script=Han}[\p{Script=Han}\p{M}\s，。！？；：、“”‘’（）《》【】…—]*)/u)
    .filter(Boolean)
    .map((part) => ({
      text: part,
      preserve: /\p{Script=Han}/u.test(part) || !/\p{L}/u.test(part),
    }));
}

/** 为外文与本机字典构造有界任务；纯中文在本机处理，日语保留完整节点与来源。@param {Object} unit 段落。@param {boolean} [checkNames] 是否存在有效人名字典。@returns {Object[]} 含节点位置与来源的片段。 */
export function createChunks(unit, checkNames = false) {
  const text = unit.nodes.map((record) => record.original).join("");
  const japanese = isJapaneseText(text);
  const chinese = !japanese && isChineseText(text);
  // 先判断完整段落，避免日文中单独加粗的汉字被当成中文跳过。
  for (const record of unit.nodes)
    record.fragments = textFragments(record.original, chinese, japanese);
  const context =
    splitText(
      unit.nodes
        .flatMap((record) => record.fragments)
        .filter((fragment) => fragment.preserve && /\p{Script=Han}/u.test(fragment.text))
        .map((fragment) => fragment.text)
        .join(""),
      1000,
    )[0] || "";
  const chunks = [];
  let parts = [];
  let locations = [];
  let length = 0;
  let dictionaryOnly = false;
  /** 结束当前 API 片段。@returns {void} 无返回值。 */
  function flush() {
    if (!parts.length) return;
    chunks.push({
      id: `${unit.id}:${chunks.length}`,
      parts,
      locations,
      ...(japanese ? { sourceLanguage: "ja" } : {}),
      ...(dictionaryOnly ? { dictionaryOnly: true } : {}),
      ...(context ? { context } : {}),
      state: "pending",
      translated: null,
    });
    parts = [];
    locations = [];
    length = 0;
  }
  unit.nodes.forEach((record, nodeIndex) => {
    record.fragments.forEach((fragment, fragmentIndex) => {
      const local = fragment.preserve && checkNames && /\p{L}/u.test(fragment.text);
      if (fragment.preserve && !local) return;
      // 字典检查与远程翻译分开合片，保留中文字句不受模型改写。
      if (local !== dictionaryOnly) flush();
      dictionaryOnly = local;
      fragment.preserve = false;
      splitText(fragment.text).forEach((part) => {
        if (parts.length >= 40 || length + part.length > 2800) flush();
        parts.push(part);
        locations.push({ nodeIndex, fragmentIndex });
        length += part.length;
      });
    });
  });
  flush();
  return chunks;
}

/** 比较同一文档中段落的阅读顺序，滚动与译文换行不会改变优先级。@param {Element} first 前一候选段落。@param {Element} second 后一候选段落。@returns {number} 排序比较值，前方段落优先。 */
export function compareDocumentOrder(first, second) {
  const position = first.compareDocumentPosition(second);
  if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
  if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
  return 0;
}
