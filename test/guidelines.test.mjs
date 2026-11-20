// Obsidian community plugin guidelines and house rules, checked on the source.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = p => fs.readFileSync(new URL("../" + p, import.meta.url), "utf8");
const SRC = ["src/main.ts", "src/ihsync.ts", "src/logic.ts", "src/settings.ts", "src/modals.ts"];
const ALL = [...SRC, "headless/ih-sync.ts", "headless/install.sh", "styles.css", "README.md", "manifest.json", "package.json", "esbuild.config.mjs", "LICENSE",
  "test/obsidian-stub.mjs", "test/ihsync.test.mjs", "test/ihheadless.test.mjs", "test/plugin.test.mjs", "test/guidelines.test.mjs"];

test("no em or en dashes anywhere in copy or comments", () => {
  for (const f of ALL) assert.ok(!/[\u2013\u2014]/.test(read(f)), f);
});

test("plugin code: no innerHTML, no console noise, requestUrl only, no remote code, no default hotkeys", () => {
  for (const f of SRC) {
    const s = read(f);
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(s), f + ": no HTML strings");
    assert.ok(!/console\.(log|info|debug|warn|error)/.test(s), f + ": no console output");
    assert.ok(!/\bfetch\(|XMLHttpRequest|new WebSocket|import\(\s*["'`]http|\beval\(|new Function\(/.test(s), f + ": no fetch, no remote code");
    assert.ok(!/hotkeys\s*:/.test(s), f + ": no default hotkeys");
    assert.ok(!/\.style\.[a-zA-Z]+\s*=/.test(s), f + ": no inline styles");
  }
  assert.ok(/requestUrl\(/.test(read("src/main.ts")));
  assert.ok(!/setInterval\((?![^;]*registerInterval)/.test(read("src/main.ts").replace(/this\.registerInterval\(window\.setInterval\(/g, "")), "every interval is registered");
});

test("styles: ih- prefix, Obsidian variables only (no colours of our own)", () => {
  const css = read("styles.css");
  for (const m of css.matchAll(/\.([a-z][\w-]*)/g)) if (!/^(is-|clickable-icon)/.test(m[1])) assert.ok(m[1].startsWith("ih-"), m[1]);
  assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(css), "no literal colours");
});

test("manifest, versions and README", () => {
  const m = JSON.parse(read("manifest.json"));
  assert.deepEqual(m, { id: "inbox-hero", name: "Inbox Hero", version: "1.0.0", minAppVersion: "1.8.0",
    description: "Share the folders you choose with your Inbox Hero account, so email drafts and answers can use your notes.",
    author: "mjonesone, LLC", authorUrl: "https://joininboxhero.com", isDesktopOnly: false });
  assert.deepEqual(JSON.parse(read("versions.json")), { "1.0.0": "1.8.0" });
  assert.ok(read("README.md").startsWith("# Inbox Hero\n\nShare the folders you choose with your Inbox Hero account, so email drafts and answers can use your notes.\n"));
  assert.match(read("README.md"), /Network use: the plugin talks only to https:\/\/joininboxhero\.com/);
  assert.match(read("LICENSE"), /^MIT License\n\nCopyright \(c\) 2026 mjonesone, LLC/);
});
