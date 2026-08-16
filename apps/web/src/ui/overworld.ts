/**
 * Overworld view: renders live Sim state through the sprite Renderer and
 * turns held keys into engine move actions (one tile per tween, so held
 * arrows glide). The Sim stays authoritative — the renderer only ever
 * mirrors positions the engine already accepted.
 */
import type { Entity, Sim } from "@llm-rpg/engine";
import type { Renderer, Direction, MapData, TileGrid } from "../render/renderer";
import type { SpriteMap } from "../render/spriteMap";
import { hasBattleContent } from "./hud";
import type { MessageBox } from "./messages";

export interface WorldHolder {
  sim: Sim;
}

export interface OverworldHooks {
  /** A wild battle started (sim.state.battle is set); fired post-step. */
  onBattleStart(): void;
  /** The player crossed a portal; caller fades, then calls rebuild(). */
  onPortal(): void;
  /** Any state change worth refreshing the HUD/party strip for. */
  onStateChange(): void;
  /** Fired synchronously right after every sim.act() this view dispatches,
   *  BEFORE its events reach the message box — the cutscene player collects
   *  `lastCues` here so chatter gates behind playback. */
  onActed?(): void;
}

/**
 * Build renderer MapData for any map of the game: base rows with the sim's
 * `tileOverrides` applied (set_tile repaints), resolved through the sprite
 * map. Shared by the overworld rebuild and the cutscene player's observed
 * scenes. `skipOverrides` omits specific overridden tiles — the cutscene
 * player uses it so a tile whose set_tile cue hasn't played yet still shows
 * its pre-repaint art.
 */
export function buildMapData(
  sim: Sim,
  mapId: string,
  spriteMap: SpriteMap,
  skipOverrides?: { x: number; y: number }[],
): MapData {
  const def = sim.game.maps[mapId];
  const legend = sim.game.legend;
  const rows = def.rows.map((r) => [...r]);
  const height = rows.length;
  const width = rows[0].length;

  const overrides = sim.state.tileOverrides?.[mapId] ?? [];
  for (const t of overrides) {
    if (skipOverrides?.some((s) => s.x === t.x && s.y === t.y)) continue;
    if (t.y >= 0 && t.y < height && t.x >= 0 && t.x < width) rows[t.y][t.x] = t.char;
  }

  const ground: TileGrid = [];
  const overlay: TileGrid = [];
  for (let y = 0; y < height; y++) {
    const g: (string | null)[] = [];
    const o: (string | null)[] = [];
    for (let x = 0; x < width; x++) {
      const tile = legend[rows[y][x]];
      const resolved = spriteMap.tileSprites(tile.name, tile.glyph);
      g.push(resolved.ground);
      o.push(resolved.overlay);
    }
    ground.push(g);
    overlay.push(o);
  }
  return { layers: [ground, overlay], width, height };
}

const warnedSprites = new Set<string>();

/**
 * Sprite id for an (effective) entity: its own `sprite` field first — this
 * is how variant sprites land, the engine resolves the active variant into
 * the entities it returns — then the game's sprites.json mapping, then the
 * emoji glyph. An unknown `sprite` id warns once and falls through.
 */
export function entitySpriteFor(
  e: Entity,
  spriteMap: SpriteMap,
  hasSprite: (id: string) => boolean,
): string {
  if (e.sprite) {
    if (hasSprite(e.sprite)) return e.sprite;
    if (!warnedSprites.has(e.sprite)) {
      warnedSprites.add(e.sprite);
      console.warn(
        `Entity "${e.id}": sprite id "${e.sprite}" is not in the manifest — falling back`,
      );
    }
  }
  return spriteMap.entitySprite(e.id, e.glyph);
}

const KEY_DIRS: Record<string, Direction> = {
  ArrowUp: "north",
  ArrowDown: "south",
  ArrowLeft: "west",
  ArrowRight: "east",
  KeyW: "north",
  KeyS: "south",
  KeyA: "west",
  KeyD: "east",
};

const filterMoves = (events: string[]) =>
  events.filter(
    // Steps are visible on the canvas, and the win/ending marker lines have
    // their own screen (ui/ending.ts).
    (e) =>
      !e.startsWith("You move ") &&
      e !== "*** YOU WIN ***" &&
      !/^\*\*\* THE END — .+ \*\*\*$/.test(e),
  );

/**
 * The engine mirrors every passage into `lastEvents` as one multi-line
 * string (so text observers see it); the web renders passages in the
 * passage pane instead, so the mirrored strings are dropped from the
 * chatter box. Exact-match against the engine's rendering — anything that
 * doesn't match passes through untouched, and pre-passage engines
 * (no lastPassages) are a no-op.
 */
function withoutPassageEvents(sim: Sim, events: string[]): string[] {
  const passages = (sim.state as { lastPassages?: unknown }).lastPassages;
  if (!Array.isArray(passages) || passages.length === 0) return events;
  const rendered = new Set<string>();
  for (const p of passages as { title?: string; lines?: string[]; citation?: string }[]) {
    if (!Array.isArray(p?.lines)) continue;
    const parts: string[] = [];
    if (p.title !== undefined) parts.push(p.title, "");
    parts.push(...p.lines);
    if (p.citation !== undefined) parts.push(`— ${p.citation}`);
    rendered.add(parts.join("\n"));
  }
  return events.filter((e) => !rendered.has(e));
}

/**
 * The engine also mirrors a presented choice into the events stream — the
 * prompt, each numbered label, and a "Choose an option: choose1..N." hint —
 * so text observers can play. The web renders the choice as a menu instead
 * (ui/choice.ts), so the mirrored lines are dropped from the chatter box.
 * Exact-match against the live pendingChoice, same policy as the passage
 * filter above: fail-open — no pending choice, or a shape this doesn't
 * recognize, filters nothing.
 */
function withoutChoiceMirror(sim: Sim, events: string[]): string[] {
  const pc = (sim.state as { pendingChoice?: unknown }).pendingChoice as
    | { prompt?: unknown; options?: { label?: unknown }[] }
    | null
    | undefined;
  if (!pc || typeof pc.prompt !== "string" || !Array.isArray(pc.options)) return events;
  const mirror = new Set<string>([pc.prompt]);
  pc.options.forEach((o, i) => {
    if (typeof o?.label === "string") mirror.add(`${i + 1}) ${o.label}`);
  });
  mirror.add(`Choose an option: choose1..choose${pc.options.length}.`);
  return events.filter((e) => !mirror.has(e));
}

/**
 * Full chatter-box filter for overworld action events: canvas-visible move
 * lines, passage-pane mirrors, and choice-menu mirrors are all dropped.
 * Used for every overworld dispatch — move, interact, and choose (main.ts).
 */
export function presentableEvents(sim: Sim, events: string[]): string[] {
  return withoutChoiceMirror(sim, withoutPassageEvents(sim, filterMoves(events)));
}

export class OverworldView {
  private renderer: Renderer;
  private world: WorldHolder;
  private spriteMap: SpriteMap;
  private msg: MessageBox;
  private hooks: OverworldHooks;

  private held: Direction[] = [];
  private playerFacing: Direction = "south";
  /** Map id the renderer is currently built for (rebuild sets it). */
  private renderMap = "";
  /** Blocks input while a battle intro or map fade is in flight. */
  private suspended = false;
  private lastBlocked = "";
  private lastBlockedAt = 0;

  constructor(
    renderer: Renderer,
    world: WorldHolder,
    spriteMap: SpriteMap,
    msg: MessageBox,
    hooks: OverworldHooks,
  ) {
    this.renderer = renderer;
    this.world = world;
    this.spriteMap = spriteMap;
    this.msg = msg;
    this.hooks = hooks;
  }

  /** Map id the renderer currently shows (the cutscene player's baseline). */
  get renderMapId(): string {
    return this.renderMap;
  }

  /**
   * (Re)sync map + entities from the sim. Call on start, portals, resets,
   * and after cutscene playback. Uses EFFECTIVE state throughout: tile
   * overrides, moved/spawned/removed entities, and variant appearance.
   */
  rebuild(): void {
    const sim = this.world.sim;
    this.renderMap = sim.state.map;
    this.renderer.setMap(buildMapData(sim, sim.state.map, this.spriteMap));

    this.renderer.clearEntities();
    const hasSprite = (id: string) => this.renderer.hasSprite(id);
    for (const e of sim.entitiesOn(sim.state.map)) {
      this.renderer.addEntity({
        id: `npc:${e.id}`,
        spriteId: entitySpriteFor(e, this.spriteMap, hasSprite),
        x: e.x,
        y: e.y,
        facing: "south",
      });
    }
    this.renderer.addEntity({
      id: "player",
      spriteId: this.spriteMap.playerSprite(sim.game.player.glyph),
      x: sim.state.playerX,
      y: sim.state.playerY,
      facing: this.playerFacing,
    });
    this.renderer.followCamera("player");
    this.suspended = false;
  }

  /**
   * Light appearance resync: swap already-placed entities' sprites to their
   * current effective (variant) appearance. Called after acts that don't
   * warrant a full rebuild — a set_flag flipping a when-driven variant shows
   * up immediately, without resetting tweens or the camera.
   */
  syncAppearance(): void {
    const sim = this.world.sim;
    const hasSprite = (id: string) => this.renderer.hasSprite(id);
    for (const e of sim.entitiesOn(sim.state.map)) {
      const id = `npc:${e.id}`;
      if (this.renderer.hasEntity(id)) {
        this.renderer.setEntitySprite(id, entitySpriteFor(e, this.spriteMap, hasSprite));
      }
    }
  }

  suspend(): void {
    this.suspended = true;
  }

  /** Dev-only forge hook: swap the sprite mapping (caller calls rebuild()). */
  setSpriteMap(map: SpriteMap): void {
    this.spriteMap = map;
  }

  releaseKeys(): void {
    this.held = [];
  }

  /** Returns true if the key was a movement key (consumed). */
  handleKeyDown(ev: KeyboardEvent): boolean {
    const dir = KEY_DIRS[ev.code];
    if (!dir) return false;
    if (!this.held.includes(dir)) this.held.unshift(dir);
    return true;
  }

  handleKeyUp(ev: KeyboardEvent): void {
    const dir = KEY_DIRS[ev.code];
    if (!dir) return;
    const i = this.held.indexOf(dir);
    if (i >= 0) this.held.splice(i, 1);
  }

  interact(): void {
    if (this.suspended || this.renderer.isMoving("player")) return;
    const sim = this.world.sim;
    const events = sim.act({ type: "interact" });
    this.hooks.onActed?.();
    this.msg.push(presentableEvents(sim, events));
    if (sim.state.battle && hasBattleContent(sim)) {
      // Trainers battle when spoken to.
      this.suspended = true;
      window.setTimeout(() => this.hooks.onBattleStart(), 240);
    }
    this.hooks.onStateChange();
  }

  /** Per-frame movement step; call from the main rAF loop while active. */
  tick(): void {
    if (this.suspended) return;
    const dir = this.held[0];
    if (!dir) return;
    if (this.renderer.isMoving("player")) return;

    const sim = this.world.sim;
    const prevMap = sim.state.map;
    const prevX = sim.state.playerX;
    const prevY = sim.state.playerY;
    const rawEvents = sim.act({ type: "move", dir });
    this.hooks.onActed?.();
    const events = presentableEvents(sim, rawEvents);
    this.playerFacing = dir;

    if (sim.state.map !== prevMap) {
      this.suspended = true;
      this.msg.push(events);
      this.hooks.onPortal();
      this.hooks.onStateChange();
      return;
    }

    const moved = sim.state.playerX !== prevX || sim.state.playerY !== prevY;
    if (moved) {
      this.renderer.walk("player", dir);
      this.msg.push(events);
      if (sim.state.battle && hasBattleContent(sim)) {
        this.suspended = true;
        // Let the step-into-the-grass tween land before the battle swallows
        // the screen.
        window.setTimeout(() => this.hooks.onBattleStart(), 240);
      }
      this.hooks.onStateChange();
    } else {
      this.renderer.face("player", dir);
      // Bumping a wall repeats fast — only voice a blocked reason when it
      // changes or after a beat.
      const text = events.join(" ");
      const now = performance.now();
      if (text && (text !== this.lastBlocked || now - this.lastBlockedAt > 1600)) {
        this.msg.push(events);
        this.lastBlocked = text;
        this.lastBlockedAt = now;
      }
    }
  }
}
