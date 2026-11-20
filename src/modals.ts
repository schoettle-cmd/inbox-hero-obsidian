import { App, Modal, Setting, TFolder, setIcon } from "obsidian";
import { scopeEmpty, scopeRoot, suggestedScope, defaultExclusions, topmost, countScope, isPrivateNote, type IhScope } from "./ihsync";
import type InboxHeroPlugin from "./main";

export interface ConfirmOpts { title: string; body: string[]; ok: string; cancel: string; warning?: boolean }

/** A plain confirm window: a title, short paragraphs, and two buttons. Resolves true only on the first button. */
export class ConfirmModal extends Modal {
  private answered = false;
  constructor(app: App, private o: ConfirmOpts, private done: (ok: boolean) => void) { super(app); }
  onOpen() {
    this.titleEl.setText(this.o.title);
    for (const p of this.o.body) this.contentEl.createEl("p", { text: p });
    new Setting(this.contentEl)
      .addButton(b => { b.setButtonText(this.o.ok); if (this.o.warning) b.setWarning(); else b.setCta(); b.onClick(() => this.answer(true)); })
      .addButton(b => b.setButtonText(this.o.cancel).onClick(() => this.answer(false)));
  }
  private answer(ok: boolean) { if (this.answered) return; this.answered = true; this.done(ok); this.close(); }
  onClose() { this.contentEl.empty(); if (!this.answered) { this.answered = true; this.done(false); } }
}

/** The folder chooser: right after pairing ("first"), and Settings > Shared folders > Choose folders.
 *  A searchable tree with checkboxes (a folder includes its subfolders), or "Whole vault, except" with folders that
 *  sound private pre-ticked, private notes left out, and a live count. */
export class ChooseFoldersModal extends Modal {
  private saved = false;
  constructor(app: App, private plugin: InboxHeroPlugin, private first = true) { super(app); }
  onOpen() {
    const { contentEl } = this; contentEl.empty(); this.modalEl.addClass("ih-modal");
    const st = this.plugin.data;
    const tree = folderTree(this.app), all = [...tree.keys()].filter(Boolean);
    const files = this.app.vault.getMarkdownFiles().map(f => ({ path: f.path, priv: isPrivateNote(this.app.metadataCache.getFileCache(f) as any) }));
    const start = suggestedScope(st, all);
    let mode: IhScope["mode"] = start.mode, skipPrivate = start.skipPrivate;
    const inc = new Set(start.include.filter(f => tree.has(f))), exc = new Set(start.exclude ?? defaultExclusions(all));
    const open = new Set<string>(), sel = () => mode === "folders" ? inc : exc;
    this.titleEl.setText("Choose what to share");
    contentEl.createEl("p", { cls: "setting-item-description", text: (this.first ? "Connected. " : "") + "Choose what syncs to your Inbox Hero account. It's one way: your notes are never changed, and notes that look like they hold passwords, keys, card numbers or seed phrases are left out." });
    const modes = contentEl.createDiv({ cls: "ih-modes", attr: { role: "radiogroup", "aria-label": "What syncs" } });
    const radio = (m: IhScope["mode"], label: string, hint: string) => {
      const l = modes.createEl("label", { cls: "ih-mode" });
      const r = l.createEl("input", { type: "radio", attr: { name: "ih-mode" } }); r.checked = mode === m;
      const t = l.createDiv(); t.createEl("b", { text: label }); t.createEl("small", { text: hint });
      r.onchange = () => { mode = m; paint(); };
    };
    radio("folders", "Only the folders I choose", "Tick folders below. A folder includes its subfolders.");
    radio("vault", "Whole vault, except", "Everything, minus the folders ticked below. Folders that sound private, financial, legal or medical start ticked.");
    const priv = contentEl.createEl("label", { cls: "ih-check" });
    const pc = priv.createEl("input", { type: "checkbox" }); pc.checked = skipPrivate;
    priv.appendText(" Leave out notes marked private (private: true or #private)");
    pc.onchange = () => { skipPrivate = pc.checked; count(); };
    const out = contentEl.createEl("p", { cls: "ih-count", attr: { "aria-live": "polite" } });
    const head = contentEl.createDiv({ cls: "ih-head" });
    const q = head.createEl("input", { type: "search", placeholder: `Search ${all.length.toLocaleString()} folders`, attr: { "aria-label": "Search folders" } });
    const what = head.createEl("span", { cls: "ih-what" });
    const box = contentEl.createDiv({ cls: "ih-tree", attr: { role: "tree" } });
    const picked = contentEl.createEl("p", { cls: "ih-picked" });
    let go: { setDisabled(d: boolean): unknown } | null = null;
    const scope = (): IhScope => ({ mode, include: topmost([...inc]), exclude: topmost([...exc]), skipPrivate });
    const count = () => {
      const s = scope(), n = countScope(files, s), cap = st.maxNotes || 10000;
      out.setText(scopeEmpty(s) ? "Nothing chosen yet: nothing syncs." : `${n.toLocaleString()} note${n === 1 ? "" : "s"} will sync` + (n > cap ? `. Inbox Hero takes up to ${cap.toLocaleString()}, so ${(n - cap).toLocaleString()} will be left out: leave out a few more folders.` : "."));
      out.toggleClass("is-over", n > cap); go?.setDisabled(scopeEmpty(s));
    };
    const implied = (f: string) => { const s = sel(); return [...s].some(x => x !== f && f.startsWith(x + "/")); };
    const toggle = (f: string, on: boolean) => { const s = sel(); if (on) { for (const x of [...s]) if (x.startsWith(f + "/")) s.delete(x); s.add(f); } else s.delete(f); paint(); };
    const row = (parent: HTMLElement, f: string, depth: number, flat: boolean) => {
      const n = tree.get(f)!, r = parent.createDiv({ cls: "ih-row", attr: { role: "treeitem" } });
      r.setCssProps({ "--ih-depth": String(flat ? 0 : depth) });
      const kids = n.kids.length > 0 && !flat;
      const car = r.createEl("button", { cls: "ih-caret clickable-icon", attr: { "aria-label": (open.has(f) ? "Collapse " : "Expand ") + n.name, tabindex: kids ? "0" : "-1" } });
      if (kids) setIcon(car, open.has(f) ? "chevron-down" : "chevron-right"); else car.addClass("is-leaf");
      car.onclick = () => { if (!kids) return; if (open.has(f)) open.delete(f); else open.add(f); paint(); };
      const l = r.createEl("label"); const c = l.createEl("input", { type: "checkbox" }); const imp = implied(f);
      c.checked = sel().has(f) || imp; c.disabled = imp;
      if (imp) l.title = mode === "folders" ? "Included with its parent folder" : "Left out with its parent folder";
      c.onchange = () => toggle(f, c.checked);
      l.appendText(" " + (flat ? f : n.name)); l.createEl("small", { text: " " + n.notes.toLocaleString() });
      if (kids && open.has(f)) for (const k of n.kids) row(parent, k, depth + 1, false);
    };
    const paint = () => {
      box.empty(); const term = q.value.trim().toLowerCase();
      what.setText(mode === "folders" ? `${inc.size} chosen` : `${exc.size} left out`);
      const list = topmost([...sel()]);
      picked.setText(list.length ? (mode === "folders" ? "Syncing: " : "Leaving out: ") + list.slice(0, 12).join(", ") + (list.length > 12 ? ` and ${list.length - 12} more` : "") : "");
      box.toggleClass("is-exclude", mode === "vault");
      if (term.length >= 2) {
        const hits = all.filter(f => f.toLowerCase().includes(term));
        for (const f of hits.slice(0, 200)) row(box, f, 0, true);
        if (!hits.length) box.createDiv({ cls: "ih-empty", text: "No folder matches." });
        else if (hits.length > 200) box.createDiv({ cls: "ih-empty", text: `${hits.length - 200} more: type more of the name.` });
      } else for (const k of tree.get("")!.kids) row(box, k, 0, false);
      count();
    };
    q.oninput = () => paint();
    // open the way down to what's ticked, so the member sees it
    for (const f of sel()) { const s = f.split("/"); for (let i = 1; i < s.length; i++) open.add(s.slice(0, i).join("/")); }
    new Setting(contentEl)
      .addButton(b => { go = b; b.setButtonText(this.first ? "Start syncing" : "Save and sync").setCta().onClick(async () => {
        const s = scope(); st.scope = s; st.folder = scopeRoot(s); this.saved = true;
        await this.plugin.save(); this.close(); this.plugin.tab?.refresh(); void this.plugin.syncNow(true); }); })
      .addButton(b => b.setButtonText(this.first ? "Not now" : "Cancel").onClick(() => this.close()));
    paint();
  }
  onClose() { this.contentEl.empty(); if (!this.saved) void this.plugin.chooserDismissed(this.first); }
}

/** Every folder of the vault (hidden ones aside) with its children and how many notes it holds, subfolders included.
 *  "" is the vault root. */
export function folderTree(app: App): Map<string, { name: string; kids: string[]; notes: number }> {
  const m = new Map<string, { name: string; kids: string[]; notes: number }>(); m.set("", { name: "", kids: [], notes: 0 });
  for (const f of app.vault.getAllLoadedFiles()) if (f instanceof TFolder && f.path && f.path !== "/" && !f.path.split("/").some(x => x.startsWith("."))) m.set(f.path, { name: f.name, kids: [], notes: 0 });
  for (const p of m.keys()) if (p) { const up = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ""; (m.get(up) || m.get(""))!.kids.push(p); }
  for (const n of m.values()) n.kids.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  for (const f of app.vault.getMarkdownFiles()) { const s = f.path.split("/"); for (let i = 0; i < s.length; i++) { const k = s.slice(0, i).join("/"); const n = m.get(k); if (n) n.notes++; } }
  return m;
}
