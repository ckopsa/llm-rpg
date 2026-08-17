/**
 * Creature Studio: a child designs a kindred and it becomes real.
 *
 * One screen, one interaction model: Up/Down moves between rows, Left/Right
 * changes the focused row, Enter commits. That is the same shape as the pause
 * panel and the title menu, so a child who can use those can use this — and it
 * works on a keyboard, a click, or a gamepad d-pad without three code paths.
 *
 * The rules are NOT enforced here. `applyRoster` in the engine owns them (stats
 * must total exactly 240, moves and types must exist, ids may not collide), and
 * this screen only surfaces what it says. A UI that re-implements the rules is a
 * UI that eventually disagrees with them.
 *
 * Everything above the DOM line is pure and unit-tested; the canvas work is
 * confined to the bottom, the way sketchImport.ts splits.
 */
import {
  ROSTER_STAT_BUDGET,
  RosterSchema,
  applyRoster,
  validateGame,
  type Game,
  type Roster,
  type RosterEntry,
} from "@llm-rpg/engine";

/** How much one Left/Right press moves a stat. Coarse on purpose: a child is
 *  spending 240 points, not tuning a spreadsheet. */
export const STAT_STEP = 5;
export const STAT_MIN = 10;
/** Up to five, comfortably inside the schema's max of seven. */
export const MAX_MOVES = 5;

/** Badges a child picks from; also the text fallback when art is missing. */
export const GLYPHS = ["🐣", "🦖", "🐙", "🦋", "🐝", "🐲", "🌟", "🍄", "⚡", "❄️", "🔥", "🌊"];

/** Hue steps offered by the colour row, in degrees. */
export const HUES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];

export interface StudioDraft {
  name: string;
  glyph: string;
  type: string;
  hp: number;
  atk: number;
  def: number;
  spd: number;
  moves: string[];
  /** Index into the available body list, or -1 for an imported drawing. */
  bodyIndex: number;
  hueIndex: number;
}

export function freshDraft(type: string): StudioDraft {
  const each = ROSTER_STAT_BUDGET / 4;
  return {
    name: "",
    glyph: GLYPHS[0],
    type,
    hp: each,
    atk: each,
    def: each,
    spd: each,
    moves: [],
    bodyIndex: 0,
    hueIndex: 0,
  };
}

export function spentPoints(d: Pick<StudioDraft, "hp" | "atk" | "def" | "spd">): number {
  return d.hp + d.atk + d.def + d.spd;
}

export function remainingPoints(d: Pick<StudioDraft, "hp" | "atk" | "def" | "spd">): number {
  return ROSTER_STAT_BUDGET - spentPoints(d);
}

/**
 * Nudge one stat, keeping the total at or under budget.
 *
 * Raising is refused rather than silently stealing from another stat: a child
 * who cannot see where the points went learns nothing from the budget.
 */
export function adjustStat(
  d: StudioDraft,
  stat: "hp" | "atk" | "def" | "spd",
  delta: number,
): StudioDraft {
  const next = d[stat] + delta;
  if (next < STAT_MIN) return d;
  if (delta > 0 && remainingPoints(d) < delta) return d;
  return { ...d, [stat]: next };
}

/** A slug for the species id, unique against ids already in the game. */
export function slugifyId(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "kindred";
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 500; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/** Moves a creature of this type may learn: its own type plus normal, so
 *  every choice is a real move id from the target game's catalog. */
export function moveCandidates(game: Game, type: string): { id: string; name: string }[] {
  const moves = game.catalog?.moves ?? [];
  return moves
    .filter((m) => (m.type === type || m.type === "normal") && m.power > 0)
    .map((m) => ({ id: m.id, name: m.name }));
}

/** Types a child can choose — whatever the target game's chart declares. */
export function typeOptions(game: Game): string[] {
  return [...(game.catalog?.typeChart.types ?? [])];
}

/**
 * The map a studio creature is released into: the game's designated paddock if
 * it has one, else any map that already rolls encounters. Returns null when the
 * game has nowhere for a wild creature to live, which the UI reports rather
 * than guessing.
 */
export function releaseMapId(game: Game): string | null {
  const ids = Object.keys(game.maps);
  const paddock = ids.find((id) => /paddock/.test(id));
  if (paddock) return paddock;
  return ids.find((id) => game.maps[id].encounters) ?? null;
}

/**
 * Ids already spoken for: the shipped species AND anything already in the
 * roster. Missing the second half means a child who names two creatures the
 * same thing gets an id collision from the engine instead of an auto-numbered
 * name, which is a confusing way to learn that "Rex" was taken.
 */
export function takenIds(game: Game, existing: Roster | null): string[] {
  return [
    ...(game.catalog?.species ?? []).map((s) => s.id),
    ...(existing?.entries ?? []).map((e) => e.id),
  ];
}

export function buildEntry(
  draft: StudioDraft,
  opts: { id: string; mapId: string; spriteDataUrl?: string },
): RosterEntry {
  return {
    id: opts.id,
    name: draft.name.trim(),
    glyph: draft.glyph,
    types: [draft.type],
    baseStats: { hp: draft.hp, atk: draft.atk, def: draft.def, spd: draft.spd },
    moves: [...draft.moves],
    ...(opts.spriteDataUrl ? { spriteDataUrl: opts.spriteDataUrl } : {}),
    location: { mapId: opts.mapId, minLevel: 4, maxLevel: 8, weight: 3 },
  };
}

/**
 * Everything stopping this draft from being saved, in words a child can act on.
 *
 * The engine has the final say — the last check actually runs `applyRoster` and
 * `validateGame` on the real game, so the studio can never save something the
 * loader would then refuse.
 */
export function draftProblems(game: Game, draft: StudioDraft, existing: Roster | null): string[] {
  const problems: string[] = [];
  if (!draft.name.trim()) problems.push("Give it a name.");
  const left = remainingPoints(draft);
  if (left > 0) problems.push(`Spend ${left} more point${left === 1 ? "" : "s"}.`);
  if (left < 0) problems.push(`That is ${-left} too many points.`);
  if (draft.moves.length === 0) problems.push("Pick at least one move.");
  if (!releaseMapId(game)) problems.push("This game has nowhere to release a creature.");
  if (problems.length > 0) return problems;

  // The real gate: build it and ask the engine.
  const mapId = releaseMapId(game)!;
  const entry = buildEntry(draft, {
    id: slugifyId(draft.name, takenIds(game, existing)),
    mapId,
  });
  const roster: Roster = {
    version: 1,
    entries: [...(existing?.entries ?? []), entry],
  };
  const parsed = RosterSchema.safeParse(roster);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => `${i.path.join(".") || "entry"}: ${i.message}`);
  }
  const applied = applyRoster(game, parsed.data);
  if (applied.errors.length > 0) return applied.errors;
  const revalidated = validateGame(JSON.parse(JSON.stringify(applied.game)));
  if (!revalidated.ok) return revalidated.errors;
  return [];
}

// ---------------------------------------------------------------------------
// Rows: the flat list the screen renders and the keys drive.
// ---------------------------------------------------------------------------

export type StudioRowKind =
  | { kind: "body" }
  | { kind: "colour" }
  | { kind: "name" }
  | { kind: "glyph" }
  | { kind: "type" }
  | { kind: "stat"; stat: "hp" | "atk" | "def" | "spd" }
  | { kind: "movesHeader" }
  | { kind: "move"; id: string; name: string }
  | { kind: "import" }
  | { kind: "save" }
  | { kind: "cancel" };

export interface StudioRow {
  row: StudioRowKind;
  label: string;
  value: string;
  /** True when Left/Right does something on this row. */
  adjustable: boolean;
}

const STAT_LABELS: Record<string, string> = {
  hp: "Health",
  atk: "Attack",
  def: "Defence",
  spd: "Speed",
};

export function buildRows(
  game: Game,
  draft: StudioDraft,
  bodies: readonly string[],
  hasDrawing: boolean,
): StudioRow[] {
  const rows: StudioRow[] = [];
  const bodyName = draft.bodyIndex < 0 ? "my drawing" : `body ${draft.bodyIndex + 1} of ${bodies.length}`;
  rows.push({ row: { kind: "body" }, label: "Body", value: bodyName, adjustable: true });
  rows.push({
    row: { kind: "colour" },
    label: "Colour",
    value: draft.hueIndex === 0 ? "as drawn" : `shifted ${HUES[draft.hueIndex]}°`,
    adjustable: true,
  });
  rows.push({ row: { kind: "name" }, label: "Name", value: draft.name || "…", adjustable: false });
  rows.push({ row: { kind: "glyph" }, label: "Badge", value: draft.glyph, adjustable: true });
  rows.push({ row: { kind: "type" }, label: "Kind", value: draft.type, adjustable: true });

  const left = remainingPoints(draft);
  for (const stat of ["hp", "atk", "def", "spd"] as const) {
    rows.push({
      row: { kind: "stat", stat },
      label: STAT_LABELS[stat],
      value: String(draft[stat]),
      adjustable: true,
    });
  }
  rows.push({
    row: { kind: "movesHeader" },
    label: "Moves",
    value: `${draft.moves.length} of ${MAX_MOVES}`,
    adjustable: false,
  });
  for (const m of moveCandidates(game, draft.type)) {
    rows.push({
      row: { kind: "move", id: m.id, name: m.name },
      label: `  ${draft.moves.includes(m.id) ? "☑" : "☐"} ${m.name}`,
      value: "",
      adjustable: false,
    });
  }
  rows.push({
    row: { kind: "import" },
    label: hasDrawing ? "Use a different drawing" : "Use my own drawing",
    value: "",
    adjustable: false,
  });
  rows.push({
    row: { kind: "save" },
    label: "Set it loose",
    value: left === 0 ? "" : `${left > 0 ? left + " points left" : "too many points"}`,
    adjustable: false,
  });
  rows.push({ row: { kind: "cancel" }, label: "Back", value: "", adjustable: false });
  return rows;
}

/** Toggle a move on the draft, respecting MAX_MOVES. */
export function toggleMove(draft: StudioDraft, id: string): StudioDraft {
  if (draft.moves.includes(id)) {
    return { ...draft, moves: draft.moves.filter((m) => m !== id) };
  }
  if (draft.moves.length >= MAX_MOVES) return draft;
  return { ...draft, moves: [...draft.moves, id] };
}

/** Left/Right on a row. Returns the draft unchanged when nothing applies. */
export function adjustRow(
  draft: StudioDraft,
  row: StudioRowKind,
  dir: -1 | 1,
  bodyCount: number,
  types: readonly string[],
): StudioDraft {
  const wrap = (i: number, n: number) => (n === 0 ? 0 : (i + dir + n) % n);
  switch (row.kind) {
    case "body":
      return bodyCount === 0 ? draft : { ...draft, bodyIndex: wrap(Math.max(0, draft.bodyIndex), bodyCount) };
    case "colour":
      return { ...draft, hueIndex: wrap(draft.hueIndex, HUES.length) };
    case "glyph":
      return { ...draft, glyph: GLYPHS[wrap(GLYPHS.indexOf(draft.glyph), GLYPHS.length)] };
    case "type": {
      const i = Math.max(0, types.indexOf(draft.type));
      const nextType = types[wrap(i, types.length)] ?? draft.type;
      // Moves belong to the old type; drop the ones the new type cannot learn.
      return { ...draft, type: nextType, moves: [] };
    }
    case "stat":
      return adjustStat(draft, row.stat, dir * STAT_STEP);
    default:
      return draft;
  }
}

// ---------------------------------------------------------------------------
// The screen. Thin: it renders rows, routes keys, and draws the preview.
// ---------------------------------------------------------------------------

import { recolorSprite, type PixelBuffer } from "../render/recolor";
import { convertSketch, decodeImageFile, pixelBufferToCanvas } from "../render/sketchImport";
import { type LoadedManifest } from "../render/manifest";
import { drawSpriteFrame } from "../render/renderer";

export interface StudioHooks {
  game(): Game;
  gameId(): string;
  loaded(): LoadedManifest;
  /** The game's sprites.json document, so taken battlers are not offered. */
  spritesDoc(): unknown;
  /** The roster already saved, so a new creature is added rather than replacing. */
  existingRoster(): Roster | null;
  /** Persist the roster; return null on success or a message on failure. */
  save(roster: Roster): string | null;
  onClose(): void;
  blip(): void;
  confirm(): void;
  speak?(text: string): void;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Battler sprites the shipped game is not already using. */
export function freeBodies(loaded: LoadedManifest, spritesDoc: unknown): string[] {
  const used = new Set<string>(
    Object.values(((spritesDoc as { species?: Record<string, string> })?.species) ?? {}),
  );
  return Object.entries(loaded.manifest.sprites)
    .filter(([id, s]) => s.sheet.startsWith("battler") && !used.has(id))
    .map(([id]) => id)
    .sort();
}

export class StudioScreen {
  private root: HTMLElement;
  private hooks: StudioHooks;
  private draft: StudioDraft;
  private rows: StudioRow[] = [];
  private index = 0;
  private bodies: string[] = [];
  private drawing: PixelBuffer | null = null;
  private note = "";

  constructor(root: HTMLElement, hooks: StudioHooks) {
    this.root = root;
    this.hooks = hooks;
    this.draft = freshDraft(typeOptions(hooks.game())[0] ?? "normal");
  }

  get visible(): boolean {
    return !this.root.classList.contains("hidden");
  }

  show(): void {
    const game = this.hooks.game();
    this.bodies = freeBodies(this.hooks.loaded(), this.hooks.spritesDoc());
    this.draft = freshDraft(typeOptions(game)[0] ?? "normal");
    this.drawing = null;
    this.index = 0;
    this.note = "";
    this.root.classList.remove("hidden");
    this.render();
  }

  hide(): void {
    this.root.classList.add("hidden");
  }

  /** Returns true when the key was consumed (caller should preventDefault). */
  handleKey(ev: KeyboardEvent): boolean {
    if (!this.visible) return false;
    const input = this.root.querySelector<HTMLInputElement>(".studio-name-input");
    if (input && document.activeElement === input) {
      // Typing owns the keyboard; only Enter/Escape hand it back.
      if (ev.key === "Enter" || ev.key === "Escape") {
        this.draft = { ...this.draft, name: input.value };
        input.blur();
        this.render();
        return true;
      }
      return false; // let the character reach the field
    }
    switch (ev.key) {
      case "ArrowUp":
        this.move(-1);
        return true;
      case "ArrowDown":
        this.move(1);
        return true;
      case "ArrowLeft":
        this.adjust(-1);
        return true;
      case "ArrowRight":
        this.adjust(1);
        return true;
      case "Enter":
      case " ":
      case "e":
      case "E":
        void this.activate();
        return true;
      case "Escape":
        this.hooks.blip();
        this.hooks.onClose();
        return true;
    }
    return true; // swallow the rest while the studio owns the screen
  }

  private move(delta: number): void {
    if (this.rows.length === 0) return;
    this.index = (this.index + delta + this.rows.length) % this.rows.length;
    this.hooks.blip();
    this.render();
  }

  private adjust(dir: -1 | 1): void {
    const row = this.rows[this.index]?.row;
    if (!row) return;
    const before = this.draft;
    this.draft = adjustRow(
      this.draft,
      row,
      dir,
      this.bodies.length,
      typeOptions(this.hooks.game()),
    );
    if (this.draft !== before) this.hooks.blip();
    this.render();
  }

  private async activate(): Promise<void> {
    const row = this.rows[this.index]?.row;
    if (!row) return;
    switch (row.kind) {
      case "name": {
        const input = this.root.querySelector<HTMLInputElement>(".studio-name-input");
        input?.focus();
        input?.select();
        return;
      }
      case "move":
        this.draft = toggleMove(this.draft, row.id);
        this.hooks.blip();
        this.render();
        return;
      case "import":
        await this.importDrawing();
        return;
      case "save":
        this.commit();
        return;
      case "cancel":
        this.hooks.blip();
        this.hooks.onClose();
        return;
      default:
        this.hooks.blip();
        return;
    }
  }

  private async importDrawing(): Promise<void> {
    const picker = document.createElement("input");
    picker.type = "file";
    picker.accept = "image/*";
    picker.addEventListener("change", async () => {
      const file = picker.files?.[0];
      if (!file) return;
      this.note = "Looking at your drawing…";
      this.render();
      try {
        const decoded = await decodeImageFile(file);
        this.drawing = convertSketch(decoded).image;
        this.draft = { ...this.draft, bodyIndex: -1 };
        this.note = "That's your drawing, in the game's colours.";
      } catch (err) {
        // A photo that cannot be read must not take the screen down with it.
        this.note = `That picture couldn't be used (${err instanceof Error ? err.message : String(err)}).`;
      }
      this.render();
    });
    picker.click();
  }

  private commit(): void {
    const game = this.hooks.game();
    const problems = draftProblems(game, this.draft, this.hooks.existingRoster());
    if (problems.length > 0) {
      this.note = problems[0];
      this.hooks.blip();
      this.render();
      return;
    }
    const mapId = releaseMapId(game)!;
    const existingForIds = this.hooks.existingRoster();
    const sprite = this.previewBuffer();
    const entry = buildEntry(this.draft, {
      id: slugifyId(this.draft.name, takenIds(game, existingForIds)),
      mapId,
      spriteDataUrl: sprite ? pixelBufferToCanvas(sprite).toDataURL("image/png") : undefined,
    });
    const existing = this.hooks.existingRoster();
    const roster: Roster = { version: 1, entries: [...(existing?.entries ?? []), entry] };
    const error = this.hooks.save(roster);
    if (error) {
      this.note = error;
      this.render();
      return;
    }
    this.hooks.confirm();
  }

  /** The sprite as it currently looks: chosen body (or drawing) plus colour. */
  private previewBuffer(): PixelBuffer | null {
    const base = this.drawing ?? this.bodySprite();
    if (!base) return null;
    const hue = HUES[this.draft.hueIndex] ?? 0;
    return hue === 0 ? base : recolorSprite(base, { hueRotateDeg: hue });
  }

  /** Pull the chosen battler's cell out of its sheet as pixels. */
  private bodySprite(): PixelBuffer | null {
    const loaded = this.hooks.loaded();
    const id = this.bodies[Math.max(0, this.draft.bodyIndex)];
    if (!id) return null;
    const sprite = loaded.manifest.sprites[id];
    const sheet = sprite && loaded.sheets.get(sprite.sheet);
    if (!sheet) return null;
    const { tileW, tileH } = sheet.def;
    const canvas = document.createElement("canvas");
    canvas.width = tileW;
    canvas.height = tileH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = false;
    drawSpriteFrame(ctx, loaded, id, "idle", 0, 0, 0, 1);
    const data = ctx.getImageData(0, 0, tileW, tileH);
    return { width: data.width, height: data.height, data: data.data };
  }

  private render(): void {
    const game = this.hooks.game();
    this.rows = buildRows(game, this.draft, this.bodies, this.drawing !== null);
    if (this.index >= this.rows.length) this.index = this.rows.length - 1;

    const list = this.rows
      .map((r, i) => {
        const sel = i === this.index ? " sel" : "";
        const arrows = r.adjustable && i === this.index ? `<span class="studio-arrows">‹ ›</span>` : "";
        const value =
          r.row.kind === "name"
            ? `<input class="studio-name-input" type="text" maxlength="16" value="${esc(this.draft.name)}" placeholder="name it" />`
            : `<span class="studio-val">${esc(r.value)}</span>`;
        return `<li class="${sel.trim()}" data-i="${i}"><span class="studio-label">${esc(r.label)}</span>${value}${arrows}</li>`;
      })
      .join("");

    const left = remainingPoints(this.draft);
    this.root.innerHTML = `
      <div class="studio-inner">
        <h2 class="studio-head">Creature Studio</h2>
        <div class="studio-body">
          <div class="studio-preview"><div class="studio-canvas"></div>
            <p class="studio-points">${left === 0 ? "All points spent" : left > 0 ? `${left} points left` : `${-left} too many`}</p>
          </div>
          <ul class="menu-list studio-rows">${list}</ul>
        </div>
        <p class="studio-note">${esc(this.note)}</p>
        <p class="menu-hint">Up/Down choose · Left/Right change · Enter pick · Esc back</p>
      </div>`;

    const holder = this.root.querySelector(".studio-canvas");
    const buf = this.previewBuffer();
    if (holder && buf) {
      const canvas = pixelBufferToCanvas(buf);
      canvas.style.width = `${buf.width * 2}px`;
      canvas.style.height = `${buf.height * 2}px`;
      canvas.style.imageRendering = "pixelated";
      holder.appendChild(canvas);
    } else if (holder) {
      holder.textContent = this.draft.glyph;
    }

    this.root.querySelectorAll<HTMLElement>(".studio-rows li").forEach((li) => {
      const i = Number(li.dataset.i);
      li.addEventListener("mouseenter", () => {
        if (this.index !== i) {
          this.index = i;
          this.render();
        }
      });
      li.addEventListener("click", () => {
        this.index = i;
        void this.activate();
      });
    });
    const input = this.root.querySelector<HTMLInputElement>(".studio-name-input");
    input?.addEventListener("input", () => {
      this.draft = { ...this.draft, name: input.value };
    });
    this.hooks.speak?.(this.rows[this.index]?.label ?? "");
  }
}
