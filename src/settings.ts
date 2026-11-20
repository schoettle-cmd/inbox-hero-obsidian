import { App, PluginSettingTab, Setting } from "obsidian";
import { scopeOf, scopeEmpty, scopeLabel, skippedMessage } from "./ihsync";
import { nextDaily, whenText, syncErrorDesc } from "./logic";
import type InboxHeroPlugin from "./main";

export const IH_APP_KNOWLEDGE = "https://joininboxhero.com/app#knowledge";
const count = (n: number, one: string, many = one + "s") => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export class InboxHeroSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: InboxHeroPlugin) { super(app, plugin); }

  /** Redraw when the tab is on screen (after a sync, a pairing or a move). */
  refresh() { if (this.containerEl.isConnected && this.containerEl.childElementCount) this.display(); }

  display(): void {
    const el = this.containerEl, p = this.plugin, st = p.data, now = Date.now();
    el.empty();
    // the Caldera plugin's connection can appear or go away while Obsidian runs: look again, redraw only on a change
    void p.checkMigration().then(changed => { if (changed && el.isConnected) this.display(); });

    if (!p.connected()) {
      if (p.migration) {
        new Setting(el).setName("Use the existing connection")
          .setDesc("This vault is already connected to Inbox Hero through the Caldera plugin. Move the connection here. Your shared folders stay the same and nothing is sent again.")
          .addButton(b => b.setButtonText("Use the existing connection").setCta().onClick(async () => { b.setDisabled(true); await p.useExisting(); this.display(); }));
      }
      new Setting(el).setName("Connect to Inbox Hero")
        .setDesc("Lets drafts and Ask in Inbox Hero use the notes you choose. Open Inbox Hero, go to Knowledge, Connect your notes, and press Connect.")
        .addButton(b => b.setButtonText("Open Inbox Hero").setCta().onClick(() => window.open(IH_APP_KNOWLEDGE)));
      new Setting(el).setName("What is shared")
        .setDesc("Only the folders you choose, and only one way. Notes are never changed. Notes that look like they hold passwords, keys, card numbers or seed phrases are left out.");
      return;
    }

    new Setting(el).setName("Connected")
      .setDesc(`Vault: ${this.app.vault.getName()}. Last sync: ${st.lastSync ? whenText(st.lastSync, now) : "Not yet"}.`);

    const scope = scopeOf(st), empty = scopeEmpty(scope);
    new Setting(el).setName("Shared folders")
      .setDesc(empty ? "Nothing chosen yet: nothing syncs." : `${scopeLabel(scope)}. ${count(Object.keys(st.sent || {}).length, "note")} sent.`)
      .addButton(b => { b.setButtonText("Choose folders").onClick(() => p.openChooser(false)); if (empty) b.setCta(); });

    const next = nextDaily(st.lastFull, now);
    new Setting(el).setName("Sync")
      .setDesc(`Changes sync a few seconds after you save. A full sync runs once a day. Next daily sync: ${next ? whenText(next, now) : "when Obsidian is open"}.`)
      .addButton(b => b.setButtonText(p.busy ? "Syncing" : "Sync now").setDisabled(p.busy).onClick(() => void p.syncNow(false)));

    const emails = st.emails || 0, then = "Send to Obsidian in Inbox Hero puts an email there while Obsidian is open.";
    const em = new Setting(el).setName("Emails from Inbox Hero")
      .setDesc(emails ? `${count(emails, "email")} saved to the folder Inbox Hero. ${then}` : `No emails yet. ${then}`);
    if (emails) em.addButton(b => b.setButtonText("Open folder").onClick(() => p.openEmailsFolder()));

    if (st.skipped?.length) new Setting(el).setName("Left out").setDesc(skippedMessage(st.skipped) + ".");

    if (st.error) new Setting(el).setName("Sync stopped").setDesc(syncErrorDesc(st.error))
      .addButton(b => b.setButtonText("Try again").onClick(() => void p.syncNow(false)));

    new Setting(el).setName("Disconnect").setHeading();
    new Setting(el).setName("Disconnect and delete synced notes")
      .setDesc("Inbox Hero deletes every note it has from this vault. Your notes here are not touched.")
      .addButton(b => b.setButtonText("Disconnect").setWarning().onClick(async () => {
        const ok = await p.askConfirm({ title: "Disconnect this vault from Inbox Hero?", body: [], ok: "Disconnect", cancel: "Cancel", warning: true });
        if (ok) { await p.disconnect(); this.display(); }
      }));
  }
}
