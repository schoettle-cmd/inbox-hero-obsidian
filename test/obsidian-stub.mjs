// A small stand-in for the obsidian module, enough to run src/main.ts in Node. Notices and requests are recorded on
// globalThis (__notices, __ihRequest), and the fake app is built by makeApp() below.
if (typeof globalThis.window === "undefined") globalThis.window = globalThis;
globalThis.__notices = globalThis.__notices || [];

export class Notice { constructor(msg) { globalThis.__notices.push(String(msg)); } }
export class TAbstractFile { constructor(path) { this.path = path; this.name = path.split("/").pop(); } }
export class TFile extends TAbstractFile { constructor(path, body = "") { super(path); this.body = body; this.stat = { mtime: 1793900000000, size: body.length }; this.extension = "md"; } }
export class TFolder extends TAbstractFile { constructor(path) { super(path); this.children = []; } }
export const Platform = { isMobile: false, isMacOS: true, isWin: false, isDesktopApp: true };
export const normalizePath = p => String(p).replace(/ | /g, " ").replace(/[\\/]+/g, "/").replace(/^\/+|\/+$/g, "").normalize("NFC");
export const requestUrl = async o => {
  if (!globalThis.__ihRequest) throw new Error("no network in tests");
  const r = await globalThis.__ihRequest(o);
  return { status: r.status, json: r.json };
};
export const setIcon = () => {};

export class Plugin {
  constructor(app, manifest) { this.app = app; this.manifest = manifest; this._events = []; this._intervals = []; this._handlers = {}; this._commands = []; this._tabs = []; this._data = null; }
  async loadData() { return this.app.__pluginData ?? null; }
  async saveData(d) { this.app.__pluginData = JSON.parse(JSON.stringify(d)); this.app.__saves = (this.app.__saves || 0) + 1; }
  // the 15 s and 20 s start-up timers are cleared by onunload(), which every test calls
  addSettingTab(t) { this._tabs.push(t); }
  addCommand(c) { this._commands.push(c); return c; }
  registerObsidianProtocolHandler(action, fn) { this._handlers[action] = fn; }
  registerEvent(e) { this._events.push(e); }
  registerInterval(id) { this._intervals.push(id); globalThis.clearInterval(id); return id; }   // Obsidian clears these on unload; tests never let them run
}
export class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = { isConnected: false, childElementCount: 0, empty() {} }; } }
export class Modal { constructor(app) { this.app = app; } open() { globalThis.__modals = (globalThis.__modals || 0) + 1; } close() {} }
export class Setting { constructor() {} setName() { return this; } setDesc() { return this; } setHeading() { return this; } addButton() { return this; } }

/** A fake app: an in-memory vault (files: path -> text) that records every write. */
export function makeApp(files = {}, opts = {}) {
  const writes = [], adapterWrites = [], adapterFiles = { ...(opts.adapterFiles || {}) };
  const map = new Map(Object.entries(files).map(([p, t]) => [p, new TFile(p, t)]));
  const folders = new Map();
  const folderOf = p => { if (!folders.has(p)) folders.set(p, new TFolder(p)); return folders.get(p); };
  for (const p of map.keys()) { const s = p.split("/"); for (let i = 1; i < s.length; i++) folderOf(s.slice(0, i).join("/")); }
  const vault = {
    configDir: opts.configDir || ".obsidian",
    getName: () => opts.vaultName || "Mike",
    getMarkdownFiles: () => [...map.values()].filter(f => f.path.endsWith(".md")),
    getAllLoadedFiles: () => [...folders.values(), ...map.values()],
    cachedRead: async f => map.get(f.path).body,
    read: async f => map.get(f.path).body,
    getAbstractFileByPath: p => map.get(p) || folders.get(p) || null,
    create: async (p, body) => { writes.push(["create", p]); if (map.has(p) || folders.has(p)) throw new Error("File already exists."); map.set(p, new TFile(p, body)); return map.get(p); },
    createFolder: async p => { writes.push(["createFolder", p]); if (folders.has(p)) throw new Error("Folder already exists."); folderOf(p); },
    modify: async p => { writes.push(["modify", p?.path]); }, delete: async p => { writes.push(["delete", p?.path]); },
    trash: async p => { writes.push(["trash", p?.path]); }, rename: async p => { writes.push(["rename", p?.path]); },
    process: async p => { writes.push(["process", p?.path]); }, append: async p => { writes.push(["append", p?.path]); },
    on: (name, fn) => ({ name, fn }),
    adapter: {
      exists: async p => p in adapterFiles,
      read: async p => { if (!(p in adapterFiles)) throw new Error("ENOENT"); return adapterFiles[p]; },
      write: async (p, t) => { adapterWrites.push(p); adapterFiles[p] = t; },
      remove: async p => { adapterWrites.push(p); delete adapterFiles[p]; },
    },
  };
  const app = {
    vault, writes, adapterWrites, adapterFiles, files: map,
    metadataCache: { getCache: () => null, getFileCache: () => null },
    workspace: { onLayoutReady: fn => { app.__layout = fn; }, getLeavesOfType: () => [], getLeaf: () => ({ openFile: async () => {} }), revealLeaf: async () => {} },
  };
  return app;
}
