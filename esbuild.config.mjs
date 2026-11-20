import esbuild from "esbuild";
import fs from "node:fs";

// Every release's main.js carries its version, so no two releases ship byte-identical files.
const version = JSON.parse(fs.readFileSync(new URL("./manifest.json", import.meta.url), "utf8")).version;
const prod = process.argv.includes("production");

await esbuild.build({
  banner: { js: `/* Inbox Hero ${version} */` },
  entryPoints: ["src/main.ts"], bundle: true, format: "cjs", target: "es2020", platform: "browser",
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"], outfile: "main.js", sourcemap: false, minify: false,
  logLevel: prod ? "info" : "warning",
});
// the headless runner (Node, started by launchd; headless/install.sh). Same engine as the plugin.
await esbuild.build({ entryPoints: ["headless/ih-sync.ts"], bundle: true, format: "esm", platform: "node", target: "node20", outfile: "headless/ih-sync.mjs", logLevel: "warning" });

if (!prod) {
  // test builds: the engine and the pure rules run as is; main.ts runs against a small stand-in for the obsidian module
  const t = { bundle: true, format: "esm", platform: "node", target: "node20", logLevel: "warning" };
  await esbuild.build({ ...t, entryPoints: ["src/ihsync.ts"], packages: "external", outfile: "test/ihsync.build.mjs" });
  await esbuild.build({ ...t, entryPoints: ["src/logic.ts"], packages: "external", outfile: "test/logic.build.mjs" });
  await esbuild.build({ ...t, entryPoints: ["src/main.ts"], alias: { obsidian: "./test/obsidian-stub.mjs" }, outfile: "test/main.build.mjs" });
  await esbuild.build({ ...t, entryPoints: ["headless/ih-sync.ts"], outfile: "test/ihheadless.build.mjs" });
}
