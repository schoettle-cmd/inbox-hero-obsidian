/**
 * Inbox Hero for Obsidian: share the folders you choose with your Inbox Hero account, one way.
 * Network use (disclosed): only https://joininboxhero.com, to upload the notes you share and to fetch the emails you
 * sent to this vault from Inbox Hero. No telemetry, no remote code.
 */
import { Notice, Platform, Plugin, TFile, TFolder, normalizePath, requestUrl, type ObsidianProtocolData } from "obsidian";
import { IhSyncEngine, IH_OUTBOX_DIR, inScope, scopeOf, scopeEmpty, type IhSyncState, type VaultWriter } from "./ihsync";
import {
  type PluginData, MIGRATE_KEYS, parsePairLink, dailyDue, scheduleFor, calderaConnection, syncDoneNotice, syncErrorNotice, emailsNotice,
  FIRST_SYNC_NOTICE, NOT_NOW_NOTICE, DISCONNECTED_NOTICE, REVOKED_NOTICE, movedNotice,
} from "./logic";
import { InboxHeroSettingTab } from "./settings";
import { ChooseFoldersModal, ConfirmModal, type ConfirmOpts } from "./modals";

export const REPORT_SOURCE = "inbox-hero";
const HOUR = 3600_000;

export default class InboxHeroPlugin extends Plugin {
  data: PluginData = {};
  busy = false;
  /** The Caldera plugin's connection in this vault, when there is one to move here (read only). */
  migration: IhSyncState | null = null;
  tab: InboxHeroSettingTab | null = null;
  private queue = new Set<string>();
  private debounce = 0;
  private timeouts = new Set<number>();
  private outboxBusy = false;
  private unloaded = false;

  async onload() {
    this.data = Object.assign({}, await this.loadData());
    this.tab = new InboxHeroSettingTab(this.app, this);
    this.addSettingTab(this.tab);
    // obsidian://inbox-hero?pair=ihp_...&api=https://joininboxhero.com (the Connect button in Inbox Hero)
    this.registerObsidianProtocolHandler("inbox-hero", params => { void this.onPairLink(params); });
    this.addCommand({ id: "sync-now", name: "Sync now", checkCallback: check => {
      if (!this.connected()) return false; if (!check) void this.syncNow(false); return true; } });
    this.addCommand({ id: "choose-folders", name: "Choose folders to share", checkCallback: check => {
      if (!this.connected()) return false; if (!check) this.openChooser(false); return true; } });
    this.app.workspace.onLayoutReady(() => this.start());
  }

  onunload() {
    this.unloaded = true;
    window.clearTimeout(this.debounce);
    for (const t of this.timeouts) window.clearTimeout(t);
    this.timeouts.clear();
  }

  // ---- state ----------------------------------------------------------------------------------------------------------
  connected(): boolean { return !!this.data.token; }
  async save() { await this.saveData(this.data); }
  /** A one-off timer, cleared on unload. Repeating ones go through registerInterval. */
  later(fn: () => void, ms: number) {
    const id = window.setTimeout(() => { this.timeouts.delete(id); if (!this.unloaded) fn(); }, ms);
    this.timeouts.add(id);
  }
  deviceName(): string {
    return (Platform.isMobile ? "Phone" : Platform.isMacOS ? "Mac" : Platform.isWin ? "Windows PC" : "Computer") + " · " + this.app.vault.getName();
  }
  engine(): IhSyncEngine {
    const v = this.app.vault;
    return new IhSyncEngine(this.data,
      { getMarkdownFiles: () => v.getMarkdownFiles(), cachedRead: f => v.cachedRead(f as TFile) },   // reads only
      path => (this.app.metadataCache.getCache(path) as any) || null,
      async o => {
        const r = await requestUrl({ url: o.url, method: o.method, headers: o.headers, body: o.body, throw: false });
        let json: any = null; try { json = r.json; } catch { /* not JSON */ }
        return { status: r.status, json };
      },
      v.getName());
  }
  /** Run a call to Inbox Hero. If it answered 401 (the engine then forgets the token), say so once. */
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    const before = this.data.token;
    try { return await fn(); }
    finally {
      if (before && !this.data.token) {
        this.data.droppedToken = before.slice(-8);
        this.data.error = undefined; this.data.lastFull = undefined;
        new Notice(REVOKED_NOTICE, 12_000);
        await this.save(); this.tab?.refresh();
      }
    }
  }

  // ---- background work -------------------------------------------------------------------------------------------------
  private start() {
    // changes inside the shared folders sync a few seconds after the member saves (debounced)
    const hit = (path: string) => {
      if (!this.connected() || !inScope(path, scopeOf(this.data))) return;
      this.queue.add(path); this.kick();
    };
    for (const ev of ["create", "modify", "delete"] as const) this.registerEvent(this.app.vault.on(ev as "modify", f => { if (f instanceof TFile) hit(f.path); }));
    this.registerEvent(this.app.vault.on("rename", (f, old) => { if (f instanceof TFile) { hit(old); hit(f.path); } }));
    // catch up on changes made while Obsidian was closed, then the daily full sync (checked hourly)
    this.later(() => void this.dailyCheck(true), 15_000);
    this.registerInterval(window.setInterval(() => void this.dailyCheck(false), HOUR));
    // Send to Obsidian: emails the member sent wait in the outbox; check every minute while Obsidian is open
    this.later(() => void this.checkOutbox(), 20_000);
    this.registerInterval(window.setInterval(() => void this.checkOutbox(), 60_000));
    void this.offerMigration();
  }
  private kick() {
    window.clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => {
      if (this.unloaded) return;
      const q = new Set(this.queue); this.queue.clear(); if (q.size) void this.syncNow(false, q, true);
    }, 4_000);
  }
  /** Full sync when the last one is 24 hours old; at load, otherwise a quiet catch-up of what changed. */
  async dailyCheck(atLoad: boolean, now = Date.now()) {
    if (!this.connected()) return;
    if (dailyDue(this.data.lastFull, now)) await this.syncNow(true, undefined, true);
    else if (atLoad) await this.syncNow(false, undefined, true);
  }

  // ---- sync ------------------------------------------------------------------------------------------------------------
  async syncNow(full: boolean, only?: Set<string>, quiet = false) {
    if (!this.connected() || scopeEmpty(scopeOf(this.data))) return;
    if (this.busy) {
      if (only) only.forEach(p => this.queue.add(p)); else this.later(() => void this.syncNow(full, undefined, quiet), 5_000);
      return;
    }
    this.busy = true; this.tab?.refresh();
    const st = this.data, firstRun = !Object.keys(st.sent || {}).length;
    if (firstRun && !only) new Notice(FIRST_SYNC_NOTICE, 6_000);
    try {
      await this.guarded(async () => {
        const eng = this.engine();
        try {
          const r = await eng.sync(full, only);
          if (full && !only) st.lastFull = Date.now();
          const over = r.skipped.filter(s => s.why === "over the limit").length, key = JSON.stringify(scopeOf(st)) + ":" + over;
          const loud = !quiet || firstRun || (over > 0 && st.overNoticed !== key);
          if (over) st.overNoticed = key;
          const newSecret = r.skipped.some(s => /^sensitive/.test(s.why) && !st.skippedNoticed?.includes(s.path));
          if (loud || newSecret) new Notice(syncDoneNotice(r, st.maxNotes), r.skipped.length ? 15_000 : 6_000);
          st.skippedNoticed = r.skipped.filter(s => /^sensitive/.test(s.why)).map(s => s.path).slice(0, 500);
          st.errorAt = undefined;
          try { await eng.report(r, REPORT_SOURCE, scheduleFor(st.lastFull)); } catch { /* the report is a courtesy; the sync itself worked */ }
        } catch (e: any) {
          if (!st.token) return;   // 401: guarded() tells the member once
          const msg = String(e?.message || e);
          st.error = msg;
          const again = msg === st.lastNoticedError && Date.now() - (st.errorAt || 0) < HOUR;
          if (!quiet || !again) { new Notice(syncErrorNotice(msg), 12_000); st.lastNoticedError = msg; st.errorAt = Date.now(); }
          this.later(() => void this.syncNow(false, undefined, true), /slow down/.test(msg) ? 120_000 : 10 * 60_000);
        }
      });
    } finally {
      this.busy = false; await this.save(); this.tab?.refresh();
      if (this.queue.size) this.kick();
    }
  }

  // ---- Send to Obsidian (outbox) ----------------------------------------------------------------------------------------
  /** New files only, and only through deliverOutbox (which checks every path is "Inbox Hero/<YYYY-MM-DD> <name>.md"). */
  vaultWriter(): VaultWriter {
    const v = this.app.vault;
    return {
      read: async path => { const f = v.getAbstractFileByPath(normalizePath(path)); return f instanceof TFile ? await v.read(f) : f ? "\u0000folder" : null; },
      create: async (path, body) => { await v.create(normalizePath(path), body); },
      ensureFolder: async dir => { if (!v.getAbstractFileByPath(normalizePath(dir))) await v.createFolder(normalizePath(dir)); },
    };
  }
  async checkOutbox() {
    if (!this.connected() || this.outboxBusy) return;
    this.outboxBusy = true;
    try {
      await this.guarded(async () => {
        const eng = this.engine(), p = await eng.poll();
        if (!(Number(p?.outbox) > 0)) return;
        const r = await eng.deliverOutbox(this.vaultWriter());
        if (r.written.length) {
          this.data.emails = (this.data.emails || 0) + r.written.length;
          new Notice(emailsNotice(r.written.length), 6_000);
          await this.save(); this.tab?.refresh();
        }
      });
    } catch { /* offline or Inbox Hero busy: next minute */ }
    finally { this.outboxBusy = false; }
  }
  /** Settings > Emails from Inbox Hero > Open folder: show the folder in the file explorer (or open its newest email). */
  openEmailsFolder() {
    const ws = this.app.workspace, f = this.app.vault.getAbstractFileByPath(IH_OUTBOX_DIR);
    if (!(f instanceof TFolder)) return;
    (this.app as any).setting?.close?.();
    const leaf = ws.getLeavesOfType("file-explorer")[0], view: any = leaf?.view;
    if (leaf && typeof view?.revealInFolder === "function") { void ws.revealLeaf(leaf); view.revealInFolder(f); return; }
    const newest = f.children.filter((c): c is TFile => c instanceof TFile).sort((a, b) => b.stat.mtime - a.stat.mtime)[0];
    if (newest) void ws.getLeaf(false).openFile(newest);
  }

  // ---- pairing ---------------------------------------------------------------------------------------------------------
  /** Opens a confirm window; resolves true on the first button. Tests replace it. */
  askConfirm(o: ConfirmOpts): Promise<boolean> { return new Promise(res => new ConfirmModal(this.app, o, res).open()); }
  /** The folder chooser (first = right after pairing). Tests replace it. */
  openChooser(first: boolean) { new ChooseFoldersModal(this.app, this, first).open(); }

  /** The link is checked first; the one-time code is only exchanged after the member presses Connect. */
  async onPairLink(params: ObsidianProtocolData | Record<string, unknown>) {
    const link = parsePairLink(params as Record<string, unknown>);
    if (!link) return;
    if (!link.ok) { new Notice(link.notice, 10_000); return; }
    const body = [`Vault: ${this.app.vault.getName()}. You choose the folders next. Inbox Hero can't change your notes.`];
    if (this.connected()) body.push("This replaces the current connection. Your shared folders stay the same.");
    const ok = await this.askConfirm({ title: "Connect this vault to Inbox Hero?", body, ok: "Connect", cancel: "Cancel" });
    if (!ok) return;
    await this.pair(link.code, link.api);
  }
  async pair(code: string, api: string): Promise<boolean> {
    const st = this.data, prevApi = st.api;
    st.api = api;
    try { await this.engine().pair(code, this.deviceName()); }
    catch (e: any) { st.api = prevApi; await this.save(); new Notice("Inbox Hero: " + String(e?.message || e), 10_000); return false; }
    st.lastFull = undefined; this.migration = null;
    await this.save(); this.tab?.refresh();
    this.openChooser(true);
    return true;
  }
  /** The chooser closed without saving. Right after pairing: say what happens next, or keep the folders already chosen. */
  async chooserDismissed(first: boolean) {
    if (!first) return;
    if (scopeEmpty(scopeOf(this.data))) new Notice(NOT_NOW_NOTICE, 8_000);
    else await this.syncNow(true, undefined, true);
  }

  // ---- moving the connection from the Caldera plugin ---------------------------------------------------------------------
  calderaDataPath() { return normalizePath(`${this.app.vault.configDir}/plugins/caldera/data.json`); }
  /** Reads the Caldera plugin's data.json (never writes it). */
  async readCaldera(): Promise<IhSyncState | null> {
    const a = this.app.vault.adapter, p = this.calderaDataPath();
    try {
      if (!(await a.exists(p))) return null;
      const c = calderaConnection(await a.read(p));
      return c && c.token && c.token.slice(-8) !== this.data.droppedToken ? c : null;   // not a connection this vault already ended
    } catch { return null; }
  }
  /** Refresh `migration`; true when it changed. */
  async checkMigration(): Promise<boolean> {
    const before = !!this.migration;
    this.migration = this.connected() ? null : await this.readCaldera();
    return before !== !!this.migration;
  }
  static readonly MOVE_DESC = "This vault is already connected to Inbox Hero through the Caldera plugin. Move the connection here. Your shared folders stay the same and nothing is sent again.";
  /** At first load: offer the move once as a window (the settings row stays until it is used). */
  async offerMigration() {
    await this.checkMigration();
    if (!this.migration || this.data.migrationOffered) return;
    this.data.migrationOffered = true; await this.save();
    const ok = await this.askConfirm({ title: "Use the existing connection", body: [InboxHeroPlugin.MOVE_DESC], ok: "Use the existing connection", cancel: "Not now" });
    if (ok) await this.useExisting();
  }
  async useExisting() {
    const m = this.migration ?? await this.readCaldera();
    if (!m || this.connected()) return;
    const d = this.data as Record<string, unknown>;
    for (const k of MIGRATE_KEYS) if ((m as Record<string, unknown>)[k] !== undefined) d[k] = (m as Record<string, unknown>)[k];
    this.data.error = undefined;
    this.data.lastFull = Date.now();   // nothing is sent again: the daily full sync starts its clock now
    this.migration = null;
    await this.save();
    new Notice(movedNotice(Object.keys(this.data.sent || {}).length), 8_000);
    this.tab?.refresh();
    await this.syncNow(false, undefined, true);
  }

  // ---- disconnect ------------------------------------------------------------------------------------------------------
  async disconnect() {
    if (this.data.token) this.data.droppedToken = this.data.token.slice(-8);
    try { await this.engine().disconnect(); new Notice(DISCONNECTED_NOTICE, 8_000); }
    catch (e: any) { new Notice("Inbox Hero: disconnected here. Inbox Hero answered: " + String(e?.message || e).replace(/[.\s]+$/, "") + ". You can also delete the synced notes in Inbox Hero Settings.", 12_000); }
    this.data.lastFull = undefined; this.data.error = undefined;
    await this.save(); this.tab?.refresh();
  }
}
