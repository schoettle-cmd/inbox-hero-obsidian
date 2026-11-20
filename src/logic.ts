/**
 * The plugin's pure rules (no Obsidian import, so tests run them in Node): what this plugin keeps in data.json, the
 * pairing link check, the daily sync clock, the move from the Caldera plugin, and the notice texts.
 */
import { IH_API_DEFAULT, IH_OUTBOX_DIR, ihApiOk, ihCodeOk, ihTokenOk, skippedMessage, type IhSyncState, type SyncResult } from "./ihsync";

/** data.json: the engine's state at the top level, plus this plugin's own fields. */
export interface PluginData extends IhSyncState {
  lastFull?: number;          // the last full sync that finished (the daily sync runs 24 hours after it)
  emails?: number;            // emails saved to "Inbox Hero/" (raised by deliverOutbox().written)
  migrationOffered?: boolean; // the "Use the existing connection" window was shown once
  droppedToken?: string;      // last 8 characters of a token this vault disconnected (so it is not offered again)
}

/** The fields copied from the Caldera plugin's ihSync. Nothing else is taken, and Caldera's file is never written. */
export const MIGRATE_KEYS = ["token", "api", "scope", "folder", "sent", "lastSync", "maxNotes"] as const;

// ---- pairing link: obsidian://inbox-hero?pair=<ihp_ code>&api=https://joininboxhero.com ----------------------------------
export const NOT_FROM_IH = "That link doesn't come from Inbox Hero.";
export const BAD_CODE = "That pairing link isn't valid. Make a new one in Inbox Hero Settings.";
export type PairLink = { ok: true; code: string; api: string } | { ok: false; notice: string } | null;
/** null = not a pairing link (nothing to do). `api` is optional; any value but https://joininboxhero.com is refused. */
export function parsePairLink(params: Record<string, unknown>): PairLink {
  if (params.pair === undefined) return null;
  const rawApi = params.api;
  const api = rawApi === undefined || rawApi === "" ? IH_API_DEFAULT : ihApiOk(rawApi);
  if (!api) return { ok: false, notice: NOT_FROM_IH };
  const code = String(params.pair || "").trim();
  if (!ihCodeOk(code)) return { ok: false, notice: BAD_CODE };
  return { ok: true, code, api };
}

// ---- the daily full sync ---------------------------------------------------------------------------------------------
export const DAY_MS = 24 * 3600_000;
/** Due when the last full sync is 24 hours old (or there was none yet). */
export const dailyDue = (lastFull: number | undefined, now: number) => !lastFull || now - lastFull >= DAY_MS;
/** When the next daily sync runs, or null when it is already due (it passed while Obsidian was closed). */
export function nextDaily(lastFull: number | undefined, now: number): number | null {
  if (!lastFull) return null; const t = lastFull + DAY_MS; return t > now ? t : null;
}

/** "today 10:40am", "tomorrow 9:05pm", "yesterday 8:00am", "Nov 18 10:40am" (local time). */
export function whenText(t: number, now: number): string {
  const d = new Date(t), h = d.getHours(), m = d.getMinutes();
  const clock = `${h % 12 || 12}:${String(m).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(new Date(now))) / DAY_MS);
  if (diff === 0) return "today " + clock;
  if (diff === 1) return "tomorrow " + clock;
  if (diff === -1) return "yesterday " + clock;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " + clock;
}
/** The schedule sent with /report, so Inbox Hero shows the next daily sync: the clock time of the last full sync. */
export function scheduleFor(lastFull: number | undefined): { daily: string; tz: string; runner: string } | undefined {
  if (!lastFull) return undefined;
  let tz = "UTC"; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { /* keep UTC */ }
  const d = new Date(lastFull);
  return { daily: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`, tz, runner: "inbox-hero-plugin" };
}

// ---- moving the connection from the Caldera plugin -------------------------------------------------------------------
/** The Caldera plugin's connection, from the text of its data.json, if it holds a valid token. Read only. */
export function calderaConnection(text: string | null | undefined): IhSyncState | null {
  if (!text) return null;
  let j: any; try { j = JSON.parse(text); } catch { return null; }
  const ih = j && typeof j === "object" ? j.ihSync : null;
  if (!ih || !ihTokenOk(ih.token)) return null;
  const out: Record<string, unknown> = {};
  for (const k of MIGRATE_KEYS) if (ih[k] !== undefined) out[k] = typeof ih[k] === "object" && ih[k] !== null ? JSON.parse(JSON.stringify(ih[k])) : ih[k];
  if (!ihApiOk(out.api ?? IH_API_DEFAULT)) return null;
  return out as IhSyncState;
}

// ---- texts -----------------------------------------------------------------------------------------------------------
const plural = (n: number, one: string, many = one + "s") => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const noDot = (s: string) => String(s || "").trim().replace(/[.\s]+$/, "");

export function syncDoneNotice(r: SyncResult, maxNotes?: number): string {
  const over = r.skipped.filter(s => s.why === "over the limit").length;
  return `Inbox Hero: ${plural(r.sent, "note")} sent${r.removed ? `, ${r.removed.toLocaleString()} removed` : ""}.`
    + (r.skipped.length ? " " + skippedMessage(r.skipped) + "." : "")
    + (over ? ` Inbox Hero takes up to ${(maxNotes || 10000).toLocaleString()} notes: leave out a few folders (Settings, Inbox Hero, Choose folders).` : "");
}
export const syncErrorNotice = (msg: string) => `Inbox Hero: sync stopped. ${noDot(msg)}. What was sent so far is kept; it carries on next time.`;
export const syncErrorDesc = (msg: string) => `${noDot(msg)}. What was sent so far is kept.`;
export const emailsNotice = (n: number) => n === 1 ? `Inbox Hero: 1 email saved to ${IH_OUTBOX_DIR}/` : `Inbox Hero: ${n.toLocaleString()} emails saved to ${IH_OUTBOX_DIR}/`;
export const FIRST_SYNC_NOTICE = "Inbox Hero: sending your notes. This can take a few minutes for a big folder.";
export const NOT_NOW_NOTICE = "Inbox Hero: connected. Nothing syncs until you choose folders in Settings.";
export const DISCONNECTED_NOTICE = "Inbox Hero: disconnected. Inbox Hero is deleting the notes it had from this vault.";
export const REVOKED_NOTICE = "Inbox Hero: this vault was disconnected. Press Connect in Inbox Hero to connect again.";
export const movedNotice = (n: number) => `Inbox Hero: connection moved. ${plural(n, "note")} ${n === 1 ? "is" : "are"} already synced.`;
