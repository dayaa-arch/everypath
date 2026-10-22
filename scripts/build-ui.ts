import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/** Builds `dist/ui.html`: `src/ui/main.ts` bundled into one inline script of `src/ui/index.html`. */
const root = fileURLToPath(new URL("..", import.meta.url));
const PLACEHOLDER = "<!-- everypath:script -->";

const { outputFiles } = await build({
  entryPoints: [`${root}src/ui/main.ts`],
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  charset: "utf8",
  legalComments: "none",
  write: false,
});
const [bundle] = outputFiles;
if (bundle === undefined) throw new Error("esbuild produced no output for src/ui/main.ts");

const template = await readFile(`${root}src/ui/index.html`, "utf8");
const parts = template.split(PLACEHOLDER);
if (parts.length !== 2) {
  throw new Error(`src/ui/index.html needs ${PLACEHOLDER} exactly once, found ${parts.length - 1}`);
}
// A `</script` inside the bundle would end the inline script early.
const script = bundle.text.replace(/<\/(script)/gi, "<\\/$1");
const html = parts.join(`<script>${script}</script>`);
await mkdir(`${root}dist`, { recursive: true });
await writeFile(`${root}dist/ui.html`, html);
console.log(`dist/ui.html ${Buffer.byteLength(html)} bytes`);
