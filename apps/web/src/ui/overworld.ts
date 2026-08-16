/**
 * Overworld view: renders live Sim state through the sprite Renderer and
 * turns held keys into engine move actions (one tile per tween, so held
 * arrows glide). The Sim stays authoritative — the renderer only ever
 * mirrors positions the engine already accepted.
 */
import type { Sim } from "@llm-rpg/engine";
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
    // Steps are visible on the canvas, and the win line has its own banner.
    (e) => !e.startsWith("You move ") && e !== "*** YOU WIN ***",
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

export class OverworldView {
  private renderer: Renderer;
  private world: WorldHolder;
  private spriteMap: SpriteMap;
  private msg: MessageBox;
  private hooks: OverworldHooks;

  private held: Direction[] = [];
  private npcIds: string[] = [];
  private playerFacing: Direction = "south";
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

  /** (Re)sync map + entities from the sim. Call on start, portals, resets. */
  rebuild(): void {
    const sim = this.world.sim;
    const def = sim.currentMap;
    const legend = sim.game.legend;
    const rows = def.rows.map((r) => [...r]);
    const height = rows.length;
    const width = rows[0].length;

    const ground: TileGrid = [];
    const overlay: TileGrid = [];
    for (let y = 0; y < height; y++) {
      const g: (string | null)[] = [];
      const o: (string | null)[] = [];
      for (let x = 0; x < width; x++) {
        const tile = legend[rows[y][x]];
        const resolved = this.spriteMap.tileSprites(tile.name, tile.glyph);
        g.push(resolved.ground);
        o.push(resolved.overlay);
      }
      ground.push(g);
      overlay.push(o);
    }
    const map: MapData = { layers: [ground, overlay], width, height };
    this.renderer.setMap(map);

    this.renderer.removeEntity("player");
    for (const id of this.npcIds) this.renderer.removeEntity(id);
    this.npcIds = [];
    for (const e of def.entities) {
      const id = `npc:${e.id}`;
      this.renderer.addEntity({
        id,
        spriteId: this.spriteMap.entitySprite(e.id, e.glyph),
        x: e.x,
        y: e.y,
        facing: "south",
      });
      this.npcIds.push(id);
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
    this.msg.push(withoutPassageEvents(sim, filterMoves(events)));
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
    const events = withoutPassageEvents(sim, filterMoves(sim.act({ type: "move", dir })));
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
