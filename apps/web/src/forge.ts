/**
 * Forge client (dev only): live game-authoring reload.
 *
 * Loaded from main.ts inside an `if (import.meta.hot)` guard, so this whole
 * module is tree-shaken out of production builds. It listens for the
 * `forge:update` HMR event pushed by forge-plugin.ts and:
 *
 *   game.json valid    -> rebuild the running game in place, preserving the
 *                         player's position/party/battle via snapshot when
 *                         the edited game is still compatible, else a fresh
 *                         start; brief toast either way.
 *   game.json invalid  -> keep the last good game running; show a dismissible
 *                         overlay listing every validation error verbatim.
 *                         The next valid save clears it automatically.
 *   sprites.json       -> hot-swap the sprite mapping only.
 *   other games        -> ignored (title-screen game list is refreshed).
 *
 * A small status chip (game dir, valid/invalid dot, time since last reload)
 * sits in the corner; F9 toggles it.
 */
import {
  Sim,
  itemById,
  moveById,
  speciesById,
  validateGame,
  type BattleState,
  type Combatant,
  type Game,
} from "@llm-rpg/engine";
import type { GameListing } from "./games";
import type { LoadedManifest } from "./render/manifest";
import { loadSpriteMap, type SpriteMap } from "./render/spriteMap";

export interface ForgeHost {
  /** Directory name of the loaded game (the ?game= id). */
  gameId: string;
  loaded: LoadedManifest;
  getSim(): Sim;
  getMode(): "title" | "overworld" | "battle";
  /** Swap in a rebuilt game + sim + sprite mapping and re-sync the view. */
  applyGame(game: Game, sim: Sim, sprites: SpriteMap): void;
  /** Swap only the sprite mapping and repaint the active view. */
  applySprites(sprites: SpriteMap): void;
  /** Drop the title screen's cached game list so it re-reads the shelf. */
  refreshTitleGames(): void;
  /** Replace the game lister the title screen uses (fresh-from-disk in dev). */
  setGamesLister(list: () => Promise<GameListing[]>): void;
}

type ViteHot = NonNullable<ImportMeta["hot"]>;

const CHIP_PREF_KEY = "llmrpg:forge:chip";

export function initForge(hot: ViteHot, host: ForgeHost): void {
  const forge = new Forge(host);
  hot.on("forge:update", (data: { gameId: string; file: string }) => forge.onUpdate(data));
  host.setGamesLister(listGamesFresh);
  console.info(`[forge] watching games/${host.gameId} — edits hot-reload (F9 toggles chip)`);
}

/** Fresh-from-disk game text via the dev middleware; null when absent. */
async function fetchGameFile(gameId: string, file: string): Promise<string | null> {
  const res = await fetch(`/__forge/games/${encodeURIComponent(gameId)}/${file}`, {
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`/__forge ${file}: HTTP ${res.status}`);
  return res.text();
}

/** Fresh listing for the title screen's "Choose Game" shelf. */
async function listGamesFresh(): Promise<GameListing[]> {
  const res = await fetch("/__forge/list", { cache: "no-store" });
  if (!res.ok) throw new Error(`/__forge/list: HTTP ${res.status}`);
  const ids = (await res.json()) as string[];
  return Promise.all(
    ids.map(async (id) => {
      try {
        const text = await fetchGameFile(id, "game.json");
        if (text !== null) {
          const meta = (JSON.parse(text) as { meta?: { title?: unknown } } | null)?.meta;
          const title = typeof meta?.title === "string" ? meta.title : id;
          return { id, title, loads: true };
        }
      } catch {
        /* unreadable — fall through */
      }
      return { id, title: id, loads: false };
    }),
  );
}

// ---- catalog compatibility checks ----------------------------------------

// Optional-chained: a catalog-free narrative game simply has none of these,
// and stays snapshot-compatible as long as the party/inventory are empty.
const hasSpecies = (game: Game, id: string) =>
  game.catalog?.species?.some((s) => s.id === id) ?? false;
const hasMove = (game: Game, id: string) =>
  game.catalog?.moves?.some((m) => m.id === id) ?? false;
const hasItem = (game: Game, id: string) =>
  game.catalog?.items?.some((i) => i.id === id) ?? false;

/** Every combatant's species and known moves still exist in the new game. */
function partyOk(game: Game, party: Combatant[]): boolean {
  return party.every(
    (c) => hasSpecies(game, c.speciesId) && c.moves.every((m) => hasMove(game, m.moveId)),
  );
}

function battleOk(game: Game, battle: BattleState): boolean {
  return partyOk(game, battle.player.party) && partyOk(game, battle.enemy.party);
}

class Forge {
  private host: ForgeHost;
  private pending = new Set<string>();
  private debounce: number | undefined;
  private busy = false;
  private rerun = false;

  // status chip state
  private valid = true;
  private lastReloadAt: number | null = null;

  // dom
  private chip: HTMLElement;
  private chipDot: HTMLElement;
  private chipTime: HTMLElement;
  private overlay: HTMLElement | null = null;
  private toastEl: HTMLElement;
  private toastTimer: number | undefined;

  constructor(host: ForgeHost) {
    this.host = host;
    this.chipDot = el("span", "");
    this.chipTime = el("span", "");
    this.chip = this.buildChip();
    this.toastEl = this.buildToast();
    window.setInterval(() => this.renderChip(), 1000);
    window.addEventListener("keydown", (ev) => {
      if (ev.key === "F9") {
        ev.preventDefault();
        this.toggleChip();
      }
    });
  }

  onUpdate(data: { gameId: string; file: string }): void {
    if (data.gameId !== this.host.gameId) {
      // Another game changed: only the title screen's shelf cares.
      this.host.refreshTitleGames();
      return;
    }
    this.pending.add(data.file);
    window.clearTimeout(this.debounce);
    this.debounce = window.setTimeout(() => void this.run(), 80);
  }

  private async run(): Promise<void> {
    if (this.busy) {
      this.rerun = true; // a save landed mid-reload; run again after
      return;
    }
    this.busy = true;
    const files = new Set(this.pending);
    this.pending.clear();
    try {
      if (files.has("game.json")) await this.reloadGame();
      else if (files.has("sprites.json")) await this.reloadSprites();
    } catch (err) {
      console.warn("[forge] reload failed:", err);
    } finally {
      this.busy = false;
      if (this.rerun) {
        this.rerun = false;
        window.clearTimeout(this.debounce);
        this.debounce = window.setTimeout(() => void this.run(), 80);
      }
    }
  }

  // ---- game.json reload --------------------------------------------------

  private async reloadGame(): Promise<void> {
    const id = this.host.gameId;
    const file = `games/${id}/game.json`;

    const text = await fetchGameFile(id, "game.json");
    if (text === null) {
      this.markInvalid([`${file} is missing on disk.`], file);
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (e) {
      this.markInvalid([`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`], file);
      return;
    }
    const result = validateGame(data);
    if (!result.ok) {
      this.markInvalid(result.errors, file);
      return;
    }
    const game = result.game!;
    const sprites = await this.fetchSpriteMap();

    const old = this.host.getSim();
    let sim: Sim;
    let toast: string;
    if (this.host.getMode() === "title") {
      sim = new Sim(game, old.seed);
      toast = "reloaded";
    } else {
      ({ sim, toast } = this.rebuildSim(game, old));
    }
    this.host.applyGame(game, sim, sprites);
    this.markValid();
    this.toast(toast);
  }

  /**
   * Carry the running sim's snapshot into the edited game when it still fits:
   * the player's map/tile must exist and be walkable and the party must still
   * be expressible in the new catalog. An incompatible battle alone is
   * dropped (back to the overworld, position kept); anything worse restarts
   * fresh at the new game's start.
   */
  private rebuildSim(game: Game, old: Sim): { sim: Sim; toast: string } {
    const fresh = () => ({ sim: new Sim(game, old.seed), toast: "reloaded — restarted" });
    const snap = old.snapshot();

    const map = game.maps[snap.map];
    if (!map) return fresh();
    const row = map.rows[snap.playerY] as string | undefined;
    if (row === undefined || snap.playerX < 0 || snap.playerX >= [...row].length) return fresh();
    const tile = game.legend[[...row][snap.playerX]];
    if (!tile || !tile.walkable) return fresh();
    if (!partyOk(game, snap.party)) return fresh();

    // Unknown items would crash the battle bag later — drop them quietly.
    snap.inventory = snap.inventory.filter((e) => hasItem(game, e.itemId));

    let toast = "reloaded — position kept";
    if (snap.battle && !battleOk(game, snap.battle)) {
      snap.battle = null;
      snap.battleTrainer = null;
      toast = "reloaded — battle ended, position kept";
    }
    try {
      // Round-trip the pruned battle aliasing exactly as a save file would.
      const sim = Sim.fromSnapshot(game, snap);
      // Smoke-check the state the views will render from. Catalog-free games
      // have nothing to cross-check (party/inventory are already empty here).
      void sim.currentMap;
      void sim.tileAt(snap.playerX, snap.playerY);
      const catalog = game.catalog;
      if (catalog) {
        for (const c of sim.state.party) void speciesById(catalog, c.speciesId);
        for (const c of sim.state.party)
          for (const m of c.moves) void moveById(catalog, m.moveId);
        for (const e of sim.state.inventory) void itemById(catalog, e.itemId);
      }
      return { sim, toast };
    } catch (err) {
      console.warn("[forge] snapshot restore failed — starting fresh:", err);
      return fresh();
    }
  }

  // ---- sprites.json reload -----------------------------------------------

  private async reloadSprites(): Promise<void> {
    this.host.applySprites(await this.fetchSpriteMap());
    this.lastReloadAt = Date.now();
    this.renderChip();
    this.toast("sprites reloaded");
  }

  /** Fresh sprite mapping; missing/broken degrades to glyphs (like boot). */
  private async fetchSpriteMap(): Promise<SpriteMap> {
    let doc: unknown = {};
    try {
      const text = await fetchGameFile(this.host.gameId, "sprites.json");
      if (text !== null) doc = JSON.parse(text);
    } catch (e) {
      console.warn(`[forge] games/${this.host.gameId}/sprites.json unreadable — using glyphs:`, e);
      doc = {};
    }
    try {
      return loadSpriteMap(doc, this.host.loaded);
    } catch (e) {
      console.warn(`[forge] games/${this.host.gameId}/sprites.json rejected — using glyphs:`, e);
      return loadSpriteMap({}, this.host.loaded);
    }
  }

  // ---- validity state ----------------------------------------------------

  private markValid(): void {
    this.valid = true;
    this.lastReloadAt = Date.now();
    this.hideOverlay();
    this.renderChip();
  }

  private markInvalid(errors: string[], file: string): void {
    this.valid = false;
    this.showOverlay(errors, file);
    this.renderChip();
    console.warn(`[forge] ${file} rejected — last good game kept running:\n` + errors.join("\n"));
  }

  // ---- error overlay -----------------------------------------------------

  private showOverlay(errors: string[], file: string): void {
    this.hideOverlay();
    const overlay = el("div", "");
    overlay.id = "forge-overlay";
    overlay.style.cssText =
      "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:10000;" +
      "max-width:min(720px,calc(100vw - 32px));max-height:70vh;overflow:auto;" +
      "background:#2b1215;color:#ffd9d9;border:1px solid #f85149;border-radius:8px;" +
      "box-shadow:0 8px 32px rgba(0,0,0,.6);font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;" +
      "padding:14px 16px;";

    const head = el("div", "");
    head.style.cssText = "display:flex;align-items:baseline;gap:10px;margin-bottom:8px;";
    const title = el("strong", `⚒ forge — ${file} won't load`);
    title.style.cssText = "color:#f85149;flex:1;";
    const close = el("button", "×");
    close.style.cssText =
      "background:none;border:none;color:#ffd9d9;font-size:18px;cursor:pointer;" +
      "line-height:1;padding:0 2px;";
    close.title = "Dismiss (reappears on the next bad save)";
    close.addEventListener("click", () => this.hideOverlay());
    head.append(title, close);

    const list = document.createElement("ul");
    list.style.cssText = "margin:0 0 10px;padding-left:20px;";
    for (const err of errors) {
      const li = el("li", err);
      li.style.cssText = "margin:4px 0;white-space:pre-wrap;overflow-wrap:anywhere;";
      list.append(li);
    }

    const hint = el("div", "The last good version is still running — waiting for next save…");
    hint.style.cssText = "color:#e3b341;font-style:italic;";

    overlay.append(head, list, hint);
    document.body.append(overlay);
    this.overlay = overlay;
  }

  private hideOverlay(): void {
    this.overlay?.remove();
    this.overlay = null;
  }

  // ---- status chip -------------------------------------------------------

  private buildChip(): HTMLElement {
    const chip = el("div", "");
    chip.id = "forge-chip";
    chip.style.cssText =
      "position:fixed;right:10px;bottom:10px;z-index:9999;display:flex;align-items:center;" +
      "gap:7px;background:rgba(16,20,28,.88);color:#c9d1d9;border:1px solid #30363d;" +
      "border-radius:999px;padding:4px 12px;font:12px ui-monospace,Menlo,Consolas,monospace;" +
      "pointer-events:none;user-select:none;";
    this.chipDot.style.cssText =
      "width:8px;height:8px;border-radius:50%;background:#3fb950;display:inline-block;";
    this.chipTime.style.cssText = "color:#8b949e;";
    chip.append(el("span", `⚒ ${this.host.gameId}`), this.chipDot, this.chipTime);
    if (localStorage.getItem(CHIP_PREF_KEY) === "0") chip.style.display = "none";
    document.body.append(chip);
    this.renderChip();
    return chip;
  }

  private renderChip(): void {
    this.chipDot.style.background = this.valid ? "#3fb950" : "#f85149";
    this.chipDot.title = this.valid ? "game.json valid" : "game.json invalid";
    this.chipTime.textContent = this.lastReloadAt === null ? "—" : ago(this.lastReloadAt);
  }

  private toggleChip(): void {
    const hidden = this.chip.style.display === "none";
    this.chip.style.display = hidden ? "flex" : "none";
    try {
      localStorage.setItem(CHIP_PREF_KEY, hidden ? "1" : "0");
    } catch {
      /* storage disabled — preference just doesn't stick */
    }
  }

  // ---- toast -------------------------------------------------------------

  private buildToast(): HTMLElement {
    const toast = el("div", "");
    toast.id = "forge-toast";
    toast.style.cssText =
      "position:fixed;left:50%;bottom:48px;transform:translateX(-50%);z-index:9999;" +
      "background:rgba(16,20,28,.92);color:#7ee787;border:1px solid #2ea043;" +
      "border-radius:6px;padding:6px 14px;font:13px ui-monospace,Menlo,Consolas,monospace;" +
      "opacity:0;transition:opacity .25s;pointer-events:none;";
    document.body.append(toast);
    return toast;
  }

  private toast(text: string): void {
    this.toastEl.textContent = `⚒ ${text}`;
    this.toastEl.style.opacity = "1";
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toastEl.style.opacity = "0";
    }, 1800);
  }
}

function el(tag: string, text: string): HTMLElement {
  const e = document.createElement(tag);
  if (text) e.textContent = text;
  return e;
}

/** "now", "12s ago", "3m ago". */
function ago(t: number): string {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 1) return "now";
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}
