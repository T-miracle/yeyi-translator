import { zipSync, strToU8 } from "fflate";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";

/** 收集已构建文件，ZIP 根目录直接包含 manifest.json。@param {string} directory 构建目录。@param {string} base 根路径。@returns {Promise<Object>} ZIP 文件表。 */
async function collect(directory, base = directory) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = resolve(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await collect(full, base));
    else result[relative(base, full).replaceAll("\\", "/")] = new Uint8Array(await readFile(full));
  }
  return result;
}
const manifest = JSON.parse(await readFile("dist/manifest.json", "utf8"));
const files = await collect(resolve("dist"));
files["安装说明.txt"] = strToU8(
  "页译 · Chrome / Edge 整页翻译\r\n\r\n1. 将 ZIP 解压到一个固定目录。\r\n2. Chrome 打开 chrome://extensions；Edge 打开 edge://extensions。\r\n3. 打开开发者模式，选择“加载已解压的扩展程序”，选择包含 manifest.json 的目录。\r\n4. 打开插件设置，填写 DeepSeek 或 OpenAI 的 Key，保存后回到普通网页。\r\n5. 刷新已打开的网页，从工具栏或网页右下角启动翻译。\r\n\r\n更新已有扩展：将新版文件覆盖到原来加载的插件目录，在扩展管理页找到原扩展并点击“重新加载”，然后刷新网页。这样可保留 Key、设置、翻译缓存和人名字典；不要先移除旧扩展，也不要换个目录加载成第二个扩展。\r\n\r\n支持换行双语、替换原文、恢复原文及指定网站自动翻译。只翻译可视页面默认关闭，开启后优先翻译可视内容，并向上下各预翻译 10 句，滚动后自动更新；此开关仅在完整设置中提供。Discord 自动排除用户名。\r\n待翻译内容合批请求，每批最多 18 个片段、约 4800 字符；满批立即发送，未满批次聚合 200 毫秒内新增内容。\r\n持久缓存默认关闭，命中后立即显示，仅未命中内容进入翻译队列；可在设置中启用、清理、导入和导出。容量提醒阈值默认 512 MB，超出后仍继续保存并显示感叹号。导入保留本机已有译文，导出不含 Key 和设置，但译文可能包含私人内容。\r\nKey 仅保存在本机。API 费用由你配置的服务收取。\r\n",
);
await mkdir("release", { recursive: true });
const target = `release/yeyi-translator-${manifest.version}.zip`;
await writeFile(target, zipSync(files, { level: 9 }));
console.log(`已打包 → ${target}`);
