import { build } from "esbuild";
import sharp from "sharp";
import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = resolve(root, "dist");
await mkdir(out, { recursive: true });
for (const [source, target] of [
  ["manifest.json", "manifest.json"],
  ["src/pages/shared.css", "pages/shared.css"],
  ...["Popup", "Options"].flatMap((page) =>
    ["index.html", "styles.css"].map((name) => [
      `src/pages/${page}/${name}`,
      `pages/${page}/${name}`,
    ]),
  ),
]) {
  const path = resolve(out, target);
  await mkdir(dirname(path), { recursive: true });
  await copyFile(resolve(root, source), path);
}
await build({
  entryPoints: Object.fromEntries(
    ["content", "pages/Popup", "pages/Options"].map((entry) => [
      `${entry}/index`,
      resolve(root, `src/${entry}/index.js`),
    ]),
  ),
  outdir: out,
  bundle: true,
  format: "iife",
  target: "chrome120",
  charset: "utf8",
  legalComments: "none",
});
await build({
  entryPoints: [resolve(root, "src/background/index.js")],
  outfile: resolve(out, "background/index.js"),
  bundle: true,
  format: "esm",
  target: "chrome120",
  charset: "utf8",
  legalComments: "none",
});
const icon = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><defs><linearGradient id="a" x2="1" y2="1"><stop stop-color="#8472ee"/><stop offset="1" stop-color="#4e3bd1"/></linearGradient></defs><rect width="128" height="128" rx="32" fill="url(#a)"/><path d="M31 35c12-3 23-1 33 5 10-6 21-8 33-5v56c-12-3-23-1-33 5-10-6-21-8-33-5z" fill="none" stroke="#fff" stroke-width="5" stroke-linejoin="round"/><path d="M64 42v48M42 51h12M42 61h12M74 53h12M74 63h12M74 73h8" stroke="#fff" stroke-width="4" stroke-linecap="round" opacity=".9"/><path d="M42 73h9" stroke="#d0f2b7" stroke-width="4" stroke-linecap="round"/></svg>`;
await mkdir(resolve(out, "icons"), { recursive: true });
for (const size of [16, 32, 48, 128])
  await sharp(Buffer.from(icon))
    .resize(size, size)
    .png()
    .toFile(resolve(out, `icons/${size}.png`));
await writeFile(resolve(out, "icons/source.svg"), icon);
try {
  await copyFile(resolve(root, "README.md"), resolve(out, "README.md"));
  await copyFile(resolve(root, "CHANGELOG.md"), resolve(out, "CHANGELOG.md"));
} catch {
  /* 开发中的首次构建可能尚未生成说明。 */
}
const manifest = JSON.parse(await readFile(resolve(out, "manifest.json"), "utf8"));
console.log(`已构建 ${manifest.name} v${manifest.version} → dist/`);
