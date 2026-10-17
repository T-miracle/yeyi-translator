import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium, expect } from "@playwright/test";

let browser;
let source;
before(async () => {
  source = (
    await build({
      entryPoints: ["src/content/engine.js"],
      bundle: true,
      write: false,
      format: "iife",
      globalName: "engineModule",
    })
  ).outputFiles[0].text;
  browser = await chromium.launch({ channel: "chromium", headless: true });
});
after(() => browser?.close());

/** 用合成搜索列表复现站点重新渲染，不保存用户账号、帖子正文或页面快照。 */
async function article(t) {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.route("http://127.0.0.1/", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<main><article><div id="post" data-testid="tweetText"><span>First source post.</span></div></article><span id="metadata" hidden></span></main>',
    }),
  );
  await page.goto("http://127.0.0.1/");
  await page.addScriptTag({ content: source });
  await page.evaluate(() => {
    globalThis.requests = [];
    globalThis.originalNode = document.querySelector("#post span").firstChild;
    globalThis.chrome = {
      runtime: {
        sendMessage: async (message) => {
          if (message.type !== "TRANSLATE_BATCH") return { ok: true, data: null };
          requests.push(message);
          return {
            ok: true,
            data: message.segments.map((segment) => ({
              id: segment.id,
              parts: segment.parts.map((text) =>
                text.includes("First") ? "第一条译文。" : "第二条译文。",
              ),
            })),
          };
        },
      },
    };
    globalThis.engine = new engineModule.TranslationEngine(() => {});
    engine.start({
      signature: "dynamic-render",
      targetLanguage: "zh-CN",
      mode: "replace",
      cacheEnabled: false,
    });
  });
  await expect(page.locator("#post")).toHaveText("第一条译文。");
  return page;
}

test("站点在同一文本节点写回原文后重新显示已有译文，不重复请求", async (t) => {
  const page = await article(t);
  await page.evaluate(() => {
    originalNode.data = "First source post.";
  });
  await expect(page.locator("#post")).toHaveText("第一条译文。", { timeout: 1800 });
  assert.equal(await page.evaluate(() => requests.length), 1);
  assert(
    await page.evaluate(() => document.querySelector("#post span").firstChild === originalNode),
  );
});

test("站点替换文本节点可复用译文，列表容器换成另一条帖子时正常重新翻译", async (t) => {
  const page = await article(t);
  await page.evaluate(() => {
    document.querySelector("#post span").textContent = "First source post.";
  });
  await expect(page.locator("#post")).toHaveText("第一条译文。");
  assert.equal(await page.evaluate(() => requests.length), 1);
  await page.evaluate(() => {
    document.querySelector("#post span").textContent = "Second source post.";
  });
  await expect(page.locator("#post")).toHaveText("第二条译文。");
  assert.equal(await page.evaluate(() => requests.length), 2);
  await page.evaluate(() => engine.restore());
  await expect(page.locator("#post")).toHaveText("Second source post.");
});

test("持续更新其他节点不会无限推迟新帖采集，暂停后停止自动重绘", async (t) => {
  const page = await article(t);
  await page.evaluate(() => {
    const post = document.createElement("p");
    post.id = "newPost";
    post.textContent = "Second source post.";
    document.querySelector("main").append(post);
    let count = 0;
    globalThis.updating = setInterval(() => {
      document.querySelector("#metadata").textContent = String(++count);
    }, 40);
  });
  await expect(page.locator("#newPost")).toHaveText("第二条译文。", { timeout: 1800 });
  await page.evaluate(() => {
    clearInterval(updating);
    engine.stop();
    originalNode.data = "First source post.";
  });
  await page.waitForTimeout(500);
  await expect(page.locator("#post")).toHaveText("First source post.");
});

test("单行译文重复显示不重写文字和字体，字号行距及最终尺寸保持不变", async (t) => {
  const page = await article(t);
  const result = await page.evaluate(() => {
    const post = document.querySelector("#post");
    post.style.cssText = "font:16px/22px Arial";
    engine.setFontOptimization(true);
    const measure = () => {
      const style = getComputedStyle(post.querySelector("span"));
      const rect = post.getBoundingClientRect();
      return {
        size: style.fontSize,
        line: style.lineHeight,
        width: rect.width,
        height: rect.height,
      };
    };
    const before = measure();
    const observer = new MutationObserver(() => {});
    observer.observe(post, {
      subtree: true,
      characterData: true,
      childList: true,
      attributes: true,
    });
    engine.setMode("replace");
    engine.start({ ...engine.config }, false);
    engine.scan();
    const mutations = observer.takeRecords().map((record) => record.type);
    observer.disconnect();
    return { before, after: measure(), mutations };
  });
  assert.deepEqual(result.after, result.before);
  assert.equal(result.after.size, "16px");
  assert.equal(result.after.line, "22px");
  assert.deepEqual(result.mutations, []);
  assert.equal(await page.evaluate(() => requests.length), 1);
});

test("站点重写一个片段时，只更新该片段，其他译文和字体不闪回原文", async (t) => {
  const page = await article(t);
  await page.evaluate(() => {
    const other = document.createElement("span");
    other.id = "other";
    other.textContent = "Second source post.";
    document.querySelector("#post").append(other);
    engine.scan();
  });
  await expect(page.locator("#other")).toHaveText("第二条译文。");
  const result = await page.evaluate(() => {
    engine.setFontOptimization(true);
    const observer = new MutationObserver(() => {});
    observer.observe(document.querySelector("#other"), {
      subtree: true,
      characterData: true,
      attributes: true,
    });
    originalNode.data = "First source post.";
    engine.scan();
    const mutations = observer.takeRecords().map((record) => record.type);
    observer.disconnect();
    return {
      mutations,
      first: originalNode.data,
      other: document.querySelector("#other").textContent,
    };
  });
  assert.equal(result.first, "第一条译文。");
  assert.equal(result.other, "第二条译文。");
  assert.deepEqual(result.mutations, []);
});

test("双语模式重复显示复用现有译文节点，不删除重建或重复写入样式", async (t) => {
  const page = await article(t);
  const result = await page.evaluate(() => {
    engine.setMode("bilingual");
    engine.setFontOptimization(true);
    const post = document.querySelector("#post");
    const anchor = post.querySelector('[data-yeyi-owned="translation"]');
    const observer = new MutationObserver(() => {});
    observer.observe(post, {
      subtree: true,
      characterData: true,
      childList: true,
      attributes: true,
    });
    engine.setMode("bilingual");
    engine.start({ ...engine.config }, false);
    const mutations = observer.takeRecords().map((record) => record.type);
    observer.disconnect();
    return { same: anchor === post.querySelector('[data-yeyi-owned="translation"]'), mutations };
  });
  assert.equal(result.same, true);
  assert.deepEqual(result.mutations, []);
});
