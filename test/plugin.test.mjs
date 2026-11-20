// The plugin itself (src/main.ts) against a stand-in for Obsidian (test/obsidian-stub.mjs) and a fake Inbox Hero:
// the pairing link, the confirm step, the move from the Caldera plugin, the outbox, the daily sync and the report.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import InboxHeroPlugin from "./main.build.mjs";
import { makeApp } from "./obsidian-stub.mjs";
import { parsePairLink, dailyDue, nextDaily, whenText, calderaConnection, syncDoneNotice, syncErrorNotice, emailsNotice, movedNotice, DAY_MS, NOT_FROM_IH, BAD_CODE, REVOKED_NOTICE, NOT_NOW_NOTICE } from "./logic.build.mjs";

const TOKEN = "iho_" + "A".repeat(20) + "b1_-" + "x".repeat(19);
const CODE = "ihp_" + "Q".repeat(32);
const API = "https://joininboxhero.com";
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const tick = () => new Promise(r => setImmediate(r));

function fakeIh(opts = {}) {
  const calls = [], store = new Map(), acked = new Set(); let folder = opts.folder ?? null;
  const req = async o => {
    const u = new URL(o.url), body = o.body ? JSON.parse(o.body) : null; calls.push({ path: u.pathname, method: o.method, body, auth: o.headers.authorization });
    if (u.origin !== API) return { status: 599, json: null };
    if (u.pathname === "/api/obsidian/pair") return body.code === CODE ? { status: 200, json: { ok: true, token: TOKEN } } : { status: 401, json: { error: "bad_code" } };
    if (o.headers.authorization !== "Bearer " + TOKEN || opts.revoked) return { status: 401, json: { error: "revoked" } };
    if (u.pathname === "/api/obsidian/limits") return { status: 200, json: { maxNoteBytes: 2e6, maxTotalBytes: 5e7, maxNotes: 10000, maxBatchNotes: 100, maxBatchBytes: 4e6, folder, notes: store.size } };
    if (u.pathname === "/api/obsidian/notes") { folder = body.folder; for (const n of body.notes) store.set(n.path, n); return { status: 200, json: { ok: true, accepted: body.notes.length, unchanged: 0, rejected: [] } }; }
    if (u.pathname === "/api/obsidian/notes/delete") { body.paths.forEach(p => store.delete(p)); return { status: 200, json: { ok: true } }; }
    if (u.pathname === "/api/obsidian/resync") { folder = body.folder; return { status: 200, json: { ok: true, removed: 0 } }; }
    if (u.pathname === "/api/obsidian/report") return { status: 200, json: { ok: true } };
    if (u.pathname === "/api/obsidian/poll") return { status: 200, json: { ok: true, syncRequested: false, outbox: (opts.outbox || []).filter(n => !acked.has(n.id)).length } };
    if (u.pathname === "/api/obsidian/outbox") return { status: 200, json: { ok: true, notes: (opts.outbox || []).filter(n => !acked.has(n.id)).slice(0, 20) } };
    if (u.pathname === "/api/obsidian/outbox/ack") { body.ids.forEach(i => acked.add(i)); return { status: 200, json: { ok: true } }; }
    if (u.pathname === "/api/obsidian/disconnect") { store.clear(); return { status: 200, json: { ok: true } }; }
    return { status: 404, json: null };
  };
  return { req, calls, store, acked, paths: () => calls.map(c => c.path) };
}

async function load(files = {}, o = {}) {
  globalThis.__notices.length = 0;
  const ih = fakeIh(o.ih); globalThis.__ihRequest = ih.req;
  const app = makeApp(files, o.app); app.__pluginData = o.data ?? null;
  const p = new InboxHeroPlugin(app, { id: "inbox-hero" });
  const asked = [], chooser = [];
  p.askConfirm = opts => { asked.push(opts); return o.answer instanceof Promise ? o.answer : Promise.resolve(o.answer ?? false); };
  p.openChooser = first => chooser.push(first);
  await p.onload();
  return { p, app, ih, asked, chooser, notices: globalThis.__notices };
}
const CONNECTED = { token: TOKEN, api: API, scope: { mode: "folders", include: ["wiki"], skipPrivate: true }, folder: "wiki", sent: {} };

test("pairing link: only api https://joininboxhero.com (or none) is accepted; nothing is asked or sent otherwise", async () => {
  assert.deepEqual(parsePairLink({ action: "inbox-hero", pair: CODE }), { ok: true, code: CODE, api: API });
  assert.deepEqual(parsePairLink({ action: "inbox-hero", pair: CODE, api: "https://joininboxhero.com/" }), { ok: true, code: CODE, api: API });
  assert.equal(parsePairLink({ action: "inbox-hero" }), null, "not a pairing link: nothing to do");
  for (const bad of ["https://caldera.social", "http://joininboxhero.com", "https://joininboxhero.com.evil.io", "https://evil.joininboxhero.com", "javascript:alert(1)", "https://joininboxhero.com/x"])
    assert.deepEqual(parsePairLink({ pair: CODE, api: bad }), { ok: false, notice: NOT_FROM_IH }, bad);
  assert.deepEqual(parsePairLink({ pair: "ihp_short" }), { ok: false, notice: BAD_CODE });
  assert.equal(NOT_FROM_IH, "That link doesn't come from Inbox Hero.");

  const { p, ih, asked, notices } = await load({}, { answer: true });
  assert.equal(typeof p._handlers["inbox-hero"], "function", "obsidian://inbox-hero is registered");
  assert.equal(p._handlers.caldera, undefined, "the Caldera link form is not handled here");
  p._handlers["inbox-hero"]({ action: "inbox-hero", pair: CODE, api: "https://evil.example.com" }); await tick();
  assert.deepEqual(notices, [NOT_FROM_IH]); assert.equal(asked.length, 0); assert.equal(ih.calls.length, 0);
  await p.onPairLink({ action: "inbox-hero", pair: "nope", api: API });
  assert.equal(notices.at(-1), BAD_CODE); assert.equal(asked.length, 0); assert.equal(ih.calls.length, 0);
  p.onunload();
});

test("pairing: the code is not exchanged until the member presses Connect", async () => {
  let answer; const gate = new Promise(r => { answer = r; });
  const { p, app, ih, asked, chooser } = await load({ "wiki/a.md": "A" }, { answer: gate });
  p._handlers["inbox-hero"]({ action: "inbox-hero", pair: CODE, api: API });
  await tick(); await tick();
  assert.equal(asked.length, 1); assert.equal(ih.calls.length, 0, "nothing sent while the confirm window is open");
  assert.equal(asked[0].title, "Connect this vault to Inbox Hero?");
  assert.deepEqual(asked[0].body, ["Vault: Mike. You choose the folders next. Inbox Hero can't change your notes."]);
  assert.equal(asked[0].ok, "Connect"); assert.equal(asked[0].cancel, "Cancel");
  answer(true); await tick(); await tick(); await tick();
  assert.deepEqual(ih.paths(), ["/api/obsidian/pair"]); assert.equal(ih.calls[0].auth, undefined);
  assert.deepEqual(ih.calls[0].body, { code: CODE, vault: "Mike", device: "Mac · Mike" });
  assert.equal(p.data.token, TOKEN); assert.equal(app.__pluginData.token, TOKEN, "saved in this plugin's data.json");
  assert.deepEqual(chooser, [true], "the folder chooser opens in first-run mode");
  // already paired: the confirm says it replaces the connection; Cancel sends nothing
  const before = ih.calls.length; p.askConfirm = o => { asked.push(o); return Promise.resolve(false); };
  await p.onPairLink({ action: "inbox-hero", pair: CODE });
  assert.deepEqual(asked.at(-1).body.at(-1), "This replaces the current connection. Your shared folders stay the same.");
  assert.equal(ih.calls.length, before, "Cancel: the code is never exchanged");
  p.onunload();
});

test("pairing: an used code keeps the engine's text; Not now with nothing chosen says what happens next", async () => {
  const { p, notices, chooser } = await load({}, { answer: true });
  await p.onPairLink({ pair: "ihp_" + "Z".repeat(32) });
  assert.equal(notices.at(-1), "Inbox Hero: That pairing link was already used or has expired. Make a new one in Inbox Hero Settings.");
  assert.equal(p.data.token, undefined); assert.deepEqual(chooser, []);
  await p.onPairLink({ pair: CODE }); await p.chooserDismissed(true);
  assert.equal(notices.at(-1), NOT_NOW_NOTICE);
  assert.equal(NOT_NOW_NOTICE, "Inbox Hero: connected. Nothing syncs until you choose folders in Settings.");
  p.onunload();
});

test("migration: reads {configDir}/plugins/caldera/data.json ihSync.token, copies the connection, never writes Caldera's file", async () => {
  const notes = { "wiki/a.md": "Alpha", "wiki/b.md": "Beta" };
  const cal = JSON.stringify({ handle: "mike", identity: { id: "x" }, ihSync: { token: TOKEN, api: API, scope: CONNECTED.scope, folder: "wiki", sent: { "wiki/a.md": sha("Alpha"), "wiki/b.md": sha("Beta") }, lastSync: 1793900000000, maxNotes: 10000, error: "old", skippedNoticed: ["x"] } });
  const path = ".config/plugins/caldera/data.json";
  const { p, app, ih, asked, notices } = await load(notes, { app: { configDir: ".config", adapterFiles: { [path]: cal } }, answer: true });
  app.__layout();   // first load: the offer shows once as a window
  await tick(); await tick(); await tick(); await tick(); await tick(); await tick();
  assert.equal(asked.length, 1); assert.equal(asked[0].ok, "Use the existing connection"); assert.equal(asked[0].cancel, "Not now");
  assert.match(asked[0].body[0], /^This vault is already connected to Inbox Hero through the Caldera plugin\./);
  for (let i = 0; i < 10 && !ih.paths().includes("/api/obsidian/report"); i++) await tick();
  assert.equal(p.data.token, TOKEN); assert.deepEqual(p.data.scope, CONNECTED.scope); assert.equal(p.data.maxNotes, 10000); assert.equal(p.data.lastSync >= 1793900000000, true);
  assert.deepEqual(Object.keys(calderaConnection(cal)).sort(), ["api", "folder", "lastSync", "maxNotes", "scope", "sent", "token"], "only these are copied");
  assert.notEqual(p.data.error, "old");
  assert.equal(notices[0], "Inbox Hero: connection moved. 2 notes are already synced.");
  assert.ok(!ih.paths().includes("/api/obsidian/notes"), "nothing is sent again");
  assert.ok(!ih.paths().includes("/api/obsidian/resync"), "no full resync right after the move");
  assert.equal(ih.calls.find(c => c.path === "/api/obsidian/report").body.source, "inbox-hero");
  assert.deepEqual(app.adapterWrites, [], "Caldera's data.json is never written");
  assert.equal(app.adapterFiles[path], cal, "byte for byte unchanged");
  assert.deepEqual(app.writes, [], "no vault writes");
  assert.equal(await p.checkMigration(), false); assert.equal(p.migration, null, "connected: no offer");
  // a second start does not show the window again
  const again = await load(notes, { app: { configDir: ".config", adapterFiles: { [path]: cal } }, data: { migrationOffered: true }, answer: true });
  again.app.__layout(); await tick(); await tick(); await tick();
  assert.equal(again.asked.length, 0); assert.ok(again.p.migration, "the settings row is still offered");
  // after a disconnect, the same (now revoked) Caldera token is not offered again
  await p.disconnect(); assert.equal(await p.readCaldera(), null);
  // an invalid token is never offered
  assert.equal(calderaConnection(JSON.stringify({ ihSync: { token: "ihn_" + "a".repeat(43) } })), null);
  assert.equal(calderaConnection("not json"), null); assert.equal(calderaConnection(JSON.stringify({ ihSync: { token: TOKEN, api: "https://evil.io" } })), null);
  p.onunload(); again.p.onunload();
});

test("outbox: writes only \"Inbox Hero/<YYYY-MM-DD> <name>.md\", never overwrites, counts emails", async () => {
  const B = "---\nfrom: a@b.c\ntags: [inbox-hero]\n---\nHello";
  const outbox = [
    { id: "1", path: "Inbox Hero/2026-11-20 Hi.md", body: B },
    { id: "2", path: "Inbox Hero/2026-11-20 Re: plans.md", body: "two" },
    { id: "3", path: "Inbox Hero/../evil.md", body: "no" },
    { id: "4", path: "wiki/2026-11-20 x.md", body: "no" },
    { id: "5", path: "Inbox Hero/sub/2026-11-20 x.md", body: "no" },
    { id: "6", path: "Inbox Hero/notdated.md", body: "no" },
    { id: "7", path: "inbox hero/2026-11-20 x.md", body: "no" },
  ];
  const { p, app, ih, notices } = await load({ "Inbox Hero/2026-11-20 Hi.md": "my own note", "wiki/a.md": "x" }, { data: { ...CONNECTED }, ih: { outbox } });
  await p.checkOutbox();
  assert.equal(app.files.get("Inbox Hero/2026-11-20 Hi.md").body, "my own note", "an existing note is never overwritten");
  assert.equal(app.files.get("Inbox Hero/2026-11-20 Hi 2.md").body, B);
  assert.equal(app.files.get("Inbox Hero/2026-11-20 Re: plans.md").body, "two");
  const created = app.writes.filter(w => w[0] === "create").map(w => w[1]);
  assert.deepEqual(created, ["Inbox Hero/2026-11-20 Hi 2.md", "Inbox Hero/2026-11-20 Re: plans.md"]);
  assert.ok(created.every(x => /^Inbox Hero\/\d{4}-\d{2}-\d{2} [^/]+\.md$/.test(x)));
  assert.ok(app.writes.every(w => w[0] === "create" || w[0] === "createFolder"), "no modify, rename, delete: " + JSON.stringify(app.writes));
  assert.deepEqual([...ih.acked].sort(), ["1", "2", "3", "4", "5", "6", "7"]);
  assert.equal(p.data.emails, 2); assert.equal(notices.at(-1), "Inbox Hero: 2 emails saved to Inbox Hero/");
  assert.equal(emailsNotice(1), "Inbox Hero: 1 email saved to Inbox Hero/");
  // the same email again (written by the headless runner too): found, acked, not written twice
  ih.acked.delete("1"); const n = app.writes.length; await p.checkOutbox();
  assert.equal(app.writes.filter(w => w[0] === "create").length, created.length, "not written again"); assert.ok(app.writes.length >= n);
  assert.equal(p.data.emails, 2);
  // fresh vault: the folder is made first
  const fresh = await load({}, { data: { ...CONNECTED }, ih: { outbox: [outbox[0]] } });
  await fresh.p.checkOutbox(); assert.deepEqual(fresh.app.writes, [["createFolder", "Inbox Hero"], ["create", "Inbox Hero/2026-11-20 Hi.md"]]);
  assert.equal(fresh.notices.at(-1), "Inbox Hero: 1 email saved to Inbox Hero/");
  p.onunload(); fresh.p.onunload();
});

test("daily sync: due 24 hours after the last full sync; next time shown, or none when it passed", async () => {
  const now = Date.UTC(2026, 10, 20, 18, 40);
  assert.equal(dailyDue(undefined, now), true, "never had a full sync");
  assert.equal(dailyDue(now - DAY_MS + 1000, now), false);
  assert.equal(dailyDue(now - DAY_MS, now), true);
  assert.equal(nextDaily(now - 3600_000, now), now - 3600_000 + DAY_MS);
  assert.equal(nextDaily(now - DAY_MS - 1, now), null, "passed while Obsidian was closed");
  assert.equal(nextDaily(undefined, now), null);
  const at = (d, h, m) => new Date(2026, 10, d, h, m).getTime();
  assert.equal(whenText(at(20, 10, 40), at(20, 12, 0)), "today 10:40am");
  assert.equal(whenText(at(21, 10, 40), at(20, 12, 0)), "tomorrow 10:40am");
  assert.equal(whenText(at(19, 22, 5), at(20, 12, 0)), "yesterday 10:05pm");
  assert.equal(whenText(at(18, 0, 0), at(20, 12, 0)), "Nov 18 12:00am");

  const notes = { "wiki/a.md": "Alpha" };
  const old = await load(notes, { data: { ...CONNECTED, lastFull: Date.now() - DAY_MS - 60_000 } });
  await old.p.dailyCheck(false);
  assert.ok(old.ih.paths().includes("/api/obsidian/resync"), "a full sync ran (it tells Inbox Hero the complete list)");
  assert.ok(Date.now() - old.p.data.lastFull < 5000, "the clock restarts");
  const fresh = await load(notes, { data: { ...CONNECTED, lastFull: Date.now() - 3600_000 } });
  await fresh.p.dailyCheck(false);
  assert.equal(fresh.ih.calls.length, 0, "not due: the hourly check does nothing");
  await fresh.p.dailyCheck(true);
  assert.ok(fresh.ih.paths().includes("/api/obsidian/notes") && !fresh.ih.paths().includes("/api/obsidian/resync"), "at load: a quiet catch-up, not a full sync");
  assert.equal(fresh.notices.filter(n => /notes? sent/.test(n)).length, 1, "the first run says it sent notes once");
  old.p.onunload(); fresh.p.onunload();
});

test("report: every finished sync tells Inbox Hero with source \"inbox-hero\"", async () => {
  const { p, ih, notices } = await load({ "wiki/a.md": "Alpha", "wiki/b.md": "Beta", "other/c.md": "out" }, { data: { ...CONNECTED } });
  await p.syncNow(true);
  const rep = ih.calls.filter(c => c.path === "/api/obsidian/report");
  assert.equal(rep.length, 1); assert.equal(rep[0].body.source, "inbox-hero"); assert.equal(rep[0].body.sent, 2);
  assert.equal(rep[0].body.schedule.runner, "inbox-hero-plugin"); assert.match(rep[0].body.schedule.daily, /^\d\d:\d\d$/);
  assert.deepEqual(notices, ["Inbox Hero: sending your notes. This can take a few minutes for a big folder.", "Inbox Hero: 2 notes sent."]);
  await p.syncNow(false, new Set(["wiki/a.md"]), true);
  assert.equal(ih.calls.filter(c => c.path === "/api/obsidian/report").length, 2, "debounced syncs report too");
  assert.equal(notices.length, 2, "background syncs stay quiet");
  assert.ok(ih.calls.every(c => c.path.startsWith("/api/obsidian/")));
  p.onunload();
});

test("errors: one notice an hour for the same error; a revoked token says so and forgets it", async () => {
  const { p, notices } = await load({ "wiki/a.md": "A" }, { data: { ...CONNECTED, sent: { "wiki/a.md": "x" } } });
  globalThis.__ihRequest = async () => ({ status: 500, json: null });
  await p.syncNow(false, undefined, true); await p.syncNow(false, undefined, true);
  assert.deepEqual(notices, ["Inbox Hero: sync stopped. Inbox Hero answered 500. What was sent so far is kept; it carries on next time."]);
  assert.equal(p.data.error, "Inbox Hero answered 500");
  p.onunload();
  const r = await load({ "wiki/a.md": "A" }, { data: { ...CONNECTED }, ih: { revoked: true } });
  await r.p.syncNow(false, undefined, true);
  assert.deepEqual(r.notices.filter(n => !/sending your notes/.test(n)), [REVOKED_NOTICE]);
  assert.equal(r.p.data.token, undefined); assert.equal(r.app.__pluginData.token, undefined);
  r.p.onunload();
  assert.equal(syncDoneNotice({ sent: 1, removed: 2, skipped: [{ path: "w/k.md", why: "sensitive data: AWS access key" }], unchanged: 0 }), "Inbox Hero: 1 note sent, 2 removed. Skipped 1 note with sensitive data: k.");
  assert.match(syncDoneNotice({ sent: 0, removed: 0, skipped: [{ path: "w/a.md", why: "over the limit" }], unchanged: 0 }, 5000), /Inbox Hero takes up to 5,000 notes: leave out a few folders \(Settings, Inbox Hero, Choose folders\)\.$/);
  assert.equal(syncErrorNotice("Over Inbox Hero's size limit."), "Inbox Hero: sync stopped. Over Inbox Hero's size limit. What was sent so far is kept; it carries on next time.");
  assert.equal(movedNotice(1), "Inbox Hero: connection moved. 1 note is already synced.");
});

test("commands: Sync now and Choose folders to share, no default hotkeys", async () => {
  const { p } = await load();
  assert.deepEqual(p._commands.map(c => [c.id, c.name]), [["sync-now", "Sync now"], ["choose-folders", "Choose folders to share"]]);
  assert.ok(p._commands.every(c => !c.hotkeys));
  assert.equal(p._commands[0].checkCallback(true), false, "not connected: hidden");
  p.data.token = TOKEN; assert.equal(p._commands[0].checkCallback(true), true);
  p.onunload();
});
