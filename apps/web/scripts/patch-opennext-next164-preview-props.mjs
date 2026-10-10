/**
 * Temporary build-time workaround for Next.js 16.4 / OpenNext 1.20.9.
 * Upstream: https://github.com/opennextjs/opennextjs-cloudflare/pull/1356
 * Keep the genuine preview props; do not silently return an empty manifest.
 */
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("node_modules/@opennextjs/cloudflare");
const before = "**/{*-manifest,required-server-files,prefetch-hints}.json";
const after = "**/{*-manifest,required-server-files,prefetch-hints,preview-props}.json";
let patched = 0;
let fixed = 0;
let inspected = 0;

async function walk(dir, depth = 0) {
  if (depth > 15) throw new Error("OpenNext package layout depth exceeded");
  for (const file of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, file.name);
    if (file.isDirectory()) {
      if (["node_modules", ".git"].includes(file.name)) continue;
      await walk(full, depth + 1);
    } else if (file.isFile() && /\.(?:js|mjs|cjs)$/.test(file.name)) {
      const info = await stat(full);
      if (info.size > 15000000) continue;
      inspected++;
      const content = await readFile(full, "utf8");
      if (content.includes(before)) {
        await writeFile(full, content.split(before).join(after));
        patched++;
        console.log("Patched manifest glob:", path.relative(root, full));
      } else if (content.includes(after)) {
        fixed++;
      }
    }
  }
}
await walk(root);
if (!patched && !fixed) {
  throw new Error("OpenNext loadManifest pattern missing after examining " + inspected + " JS files");
}
console.log("OpenNext preview props manifest: patched=" + patched + ", already-fixed=" + fixed);
