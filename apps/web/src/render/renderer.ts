/**
 * Reusable canvas-2D renderer for tile maps + animated sprite entities.
 *
 * Design constraints:
 * - Consumes plain data (2D arrays of tile ids, entity lists) so it can later
 *   render engine state without importing the engine.
 * - Integer scaling of 16px source tiles (default 3x), crisp pixels.
 * - Time-based animation clock driven by requestAnimationFrame.
 * - Entities tween smoothly tile-to-tile (~120ms) with facing-based
 *   walk/idle animations; camera follows a target with map-edge clamping.
 */
import type { Anim, LoadedManifest, LoadedSheet } from "./manifest";
import { isGlyphSprite, GLYPH_PREFIX } from "./spriteMap";

export type Direction = "north" | "south" | "east" | "west";

/** A map layer: [row][col] of sprite ids (tiles), or null for empty. */
export type TileGrid = (string | null)[][];

export interface MapData {
  /** Drawn bottom-up: layers[0] is the ground, later layers overlay it. */
  layers: TileGrid[];
  width: number;
  height: number;
}

export interface EntityInit {
  id: string;
  spriteId: string;
  /** Position in tile coordinates. */
  x: number;
  y: number;
  facing?: Direction;
}

interface Tween {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  start: number;
  duration: number;
}

interface Entity {
  id: string;
  spriteId: string;
  x: number;
  y: number;
  facing: Direction;
  /** Base anim name ("idle" | "walk"); resolved against facing per frame. */
  animBase: string;
  /** Clock time the current anim started (for frame phase). */
  animStart: number;
  tween: Tween | null;
}

export interface RendererOptions {
  /** Viewport size in tiles (letterboxed, fixed). Default 20x15. */
  viewportTilesX?: number;
  viewportTilesY?: number;
  /** Source pixels per map tile. Default 16. */
  tileSize?: number;
  /** Integer display scale. Default 3 (16px -> 48px). */
  scale?: number;
  /** Tile-to-tile walk duration in ms. Default 120. */
  walkMs?: number;
}

export const DIR_DELTAS: Record<Direction, [number, number]> = {
  north: [0, -1],
  south: [0, 1],
  east: [1, 0],
  west: [-1, 0],
};

function pickAnim(
  loaded: LoadedManifest,
  spriteId: string,
  base: string,
  facing: Direction,
): { anim: Anim; sheet: LoadedSheet } {
  const sprite = loaded.manifest.sprites[spriteId];
  if (!sprite) throw new Error(`Unknown sprite id "${spriteId}"`);
  const anims = sprite.anims;
  const anim =
    anims[`${base}_${facing}`] ?? anims[base] ?? anims[`idle_${facing}`] ?? anims["idle"];
  if (!anim) {
    throw new Error(
      `Sprite "${spriteId}" has no anim for "${base}"/"${facing}" and no "idle" fallback`,
    );
  }
  return { anim, sheet: loaded.sheets.get(sprite.sheet)! };
}

/** Frame index for a time-based clock (seconds) into an anim. */
export function animFrame(anim: Anim, timeSec: number): [number, number] {
  const i = Math.floor(timeSec * anim.fps) % anim.frames.length;
  return anim.frames[i];
}

/**
 * Draw one sprite frame at a canvas pixel position (top-left of its cell).
 * Standalone helper — also used for non-map UI like battler strips.
 */
export function drawSpriteFrame(
  ctx: CanvasRenderingContext2D,
  loaded: LoadedManifest,
  spriteId: string,
  animName: string,
  timeSec: number,
  dx: number,
  dy: number,
  scale: number,
): void {
  const sprite = loaded.manifest.sprites[spriteId];
  if (!sprite) throw new Error(`Unknown sprite id "${spriteId}"`);
  const anim = sprite.anims[animName] ?? sprite.anims["idle"];
  if (!anim) throw new Error(`Sprite "${spriteId}" has no anim "${animName}" or "idle"`);
  const sheet = loaded.sheets.get(sprite.sheet)!;
  const [col, row] = animFrame(anim, timeSec);
  const { tileW, tileH } = sheet.def;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    sheet.image,
    col * tileW,
    row * tileH,
    tileW,
    tileH,
    Math.round(dx),
    Math.round(dy),
    tileW * scale,
    tileH * scale,
  );
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private loaded: LoadedManifest;

  private tileSize: number;
  private scale: number;
  private viewW: number; // viewport width in tiles
  private viewH: number;
  private walkMs: number;

  private map: MapData | null = null;
  private entities = new Map<string, Entity>();
  private cameraTargetId: string | null = null;

  private rafId = 0;
  private startTime = 0;
  private running = false;

  constructor(canvas: HTMLCanvasElement, loaded: LoadedManifest, opts: RendererOptions = {}) {
    this.canvas = canvas;
    this.loaded = loaded;
    this.tileSize = opts.tileSize ?? 16;
    this.scale = Math.max(1, Math.floor(opts.scale ?? 3));
    this.viewW = opts.viewportTilesX ?? 20;
    this.viewH = opts.viewportTilesY ?? 15;
    this.walkMs = opts.walkMs ?? 120;

    canvas.width = this.viewW * this.tileSize * this.scale;
    canvas.height = this.viewH * this.tileSize * this.scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    this.ctx = ctx;
    ctx.imageSmoothingEnabled = false;
  }

  /** Seconds since start(); the shared animation clock. */
  now(): number {
    return (performance.now() - this.startTime) / 1000;
  }

  setMap(map: MapData): void {
    for (const layer of map.layers) {
      if (layer.length !== map.height || layer.some((row) => row.length !== map.width)) {
        throw new Error(
          `Map layer shape mismatch: expected ${map.width}x${map.height}; ` +
            `got rows=${layer.length}, cols=${layer[0]?.length ?? 0}`,
        );
      }
    }
    this.map = map;
  }

  addEntity(init: EntityInit): void {
    if (!isGlyphSprite(init.spriteId) && !this.loaded.manifest.sprites[init.spriteId]) {
      throw new Error(`Entity "${init.id}": unknown sprite id "${init.spriteId}"`);
    }
    this.entities.set(init.id, {
      id: init.id,
      spriteId: init.spriteId,
      x: init.x,
      y: init.y,
      facing: init.facing ?? "south",
      animBase: "idle",
      animStart: this.now(),
      tween: null,
    });
  }

  removeEntity(id: string): void {
    this.entities.delete(id);
  }

  getEntityPos(id: string): { x: number; y: number; facing: Direction } | null {
    const e = this.entities.get(id);
    return e ? { x: e.x, y: e.y, facing: e.facing } : null;
  }

  isMoving(id: string): boolean {
    return this.entities.get(id)?.tween != null;
  }

  /** Turn in place without moving. */
  face(id: string, dir: Direction): void {
    const e = this.entities.get(id);
    if (e) e.facing = dir;
  }

  /**
   * Start a smooth one-tile walk in `dir`. Returns false if the entity is
   * already mid-tween (callers decide collision rules before calling).
   */
  walk(id: string, dir: Direction): boolean {
    const e = this.entities.get(id);
    if (!e || e.tween) return false;
    const [dx, dy] = DIR_DELTAS[dir];
    e.facing = dir;
    e.animBase = "walk";
    e.animStart = this.now();
    e.tween = {
      fromX: e.x,
      fromY: e.y,
      toX: e.x + dx,
      toY: e.y + dy,
      start: performance.now(),
      duration: this.walkMs,
    };
    e.x += dx;
    e.y += dy;
    return true;
  }

  followCamera(entityId: string): void {
    this.cameraTargetId = entityId;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startTime = performance.now();
    const loop = () => {
      if (!this.running) return;
      this.draw();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  /** Interpolated position in tile units (fractional while tweening). */
  private interpPos(e: Entity, nowMs: number): { x: number; y: number } {
    if (!e.tween) return { x: e.x, y: e.y };
    const t = Math.min(1, (nowMs - e.tween.start) / e.tween.duration);
    if (t >= 1) {
      e.tween = null;
      e.animBase = "idle";
      e.animStart = this.now();
      return { x: e.x, y: e.y };
    }
    return {
      x: e.tween.fromX + (e.tween.toX - e.tween.fromX) * t,
      y: e.tween.fromY + (e.tween.toY - e.tween.fromY) * t,
    };
  }

  /**
   * Fallback for unmapped tiles/entities: draw an emoji glyph filling one
   * tile cell, given the cell's top-left in canvas pixels.
   */
  private drawGlyph(glyphId: string, dx: number, dy: number): void {
    const glyph = glyphId.slice(GLYPH_PREFIX.length);
    const px = this.tileSize * this.scale;
    const ctx = this.ctx;
    ctx.font = `${Math.floor(px * 0.85)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(glyph, Math.round(dx + px / 2), Math.round(dy + px / 2 + px * 0.05));
  }

  private cameraOrigin(nowMs: number): { x: number; y: number } {
    // Camera position in source-pixel units (before display scaling).
    const ts = this.tileSize;
    const mapW = (this.map?.width ?? this.viewW) * ts;
    const mapH = (this.map?.height ?? this.viewH) * ts;
    const viewW = this.viewW * ts;
    const viewH = this.viewH * ts;

    let cx = viewW / 2;
    let cy = viewH / 2;
    const target = this.cameraTargetId ? this.entities.get(this.cameraTargetId) : null;
    if (target) {
      const p = this.interpPos(target, nowMs);
      cx = (p.x + 0.5) * ts;
      cy = (p.y + 0.5) * ts;
    }
    // Clamp to map edges; center if the map is smaller than the viewport.
    const x =
      mapW <= viewW ? (mapW - viewW) / 2 : Math.max(0, Math.min(mapW - viewW, cx - viewW / 2));
    const y =
      mapH <= viewH ? (mapH - viewH) / 2 : Math.max(0, Math.min(mapH - viewH, cy - viewH / 2));
    return { x, y };
  }

  private draw(): void {
    const nowMs = performance.now();
    const timeSec = this.now();
    const ctx = this.ctx;
    const ts = this.tileSize;
    const s = this.scale;

    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.map) return;

    const cam = this.cameraOrigin(nowMs);
    // Snap camera to whole display pixels to keep pixel art crisp.
    const camX = Math.round(cam.x * s) / s;
    const camY = Math.round(cam.y * s) / s;

    const firstCol = Math.max(0, Math.floor(camX / ts));
    const firstRow = Math.max(0, Math.floor(camY / ts));
    const lastCol = Math.min(this.map.width - 1, Math.ceil((camX + this.viewW * ts) / ts));
    const lastRow = Math.min(this.map.height - 1, Math.ceil((camY + this.viewH * ts) / ts));

    // Tile layers, bottom-up.
    for (const layer of this.map.layers) {
      for (let row = firstRow; row <= lastRow; row++) {
        for (let col = firstCol; col <= lastCol; col++) {
          const tileId = layer[row][col];
          if (!tileId) continue;
          if (isGlyphSprite(tileId)) {
            this.drawGlyph(tileId, (col * ts - camX) * s, (row * ts - camY) * s);
            continue;
          }
          const { anim, sheet } = pickAnim(this.loaded, tileId, "idle", "south");
          const [fc, fr] = animFrame(anim, timeSec);
          const { tileW, tileH } = sheet.def;
          ctx.drawImage(
            sheet.image,
            fc * tileW,
            fr * tileH,
            tileW,
            tileH,
            Math.round((col * ts - camX) * s),
            // Anchor tall tiles to their cell's bottom edge.
            Math.round((row * ts - camY + ts - tileH) * s),
            tileW * s,
            tileH * s,
          );
        }
      }
    }

    // Entities, y-sorted so lower entities draw in front.
    const drawList = [...this.entities.values()]
      .map((e) => ({ e, p: this.interpPos(e, nowMs) }))
      .sort((a, b) => a.p.y - b.p.y);
    for (const { e, p } of drawList) {
      if (isGlyphSprite(e.spriteId)) {
        this.drawGlyph(e.spriteId, (p.x * ts - camX) * s, (p.y * ts - camY) * s);
        continue;
      }
      const { anim, sheet } = pickAnim(this.loaded, e.spriteId, e.animBase, e.facing);
      const phase = timeSec - (e.animBase === "walk" ? 0 : e.animStart);
      const [fc, fr] = animFrame(anim, phase);
      const { tileW, tileH } = sheet.def;
      ctx.drawImage(
        sheet.image,
        fc * tileW,
        fr * tileH,
        tileW,
        tileH,
        Math.round((p.x * ts - camX) * s),
        // Feet on the tile: bottom of the sprite aligns to the cell bottom.
        Math.round((p.y * ts - camY + ts - tileH) * s),
        tileW * s,
        tileH * s,
      );
    }
  }
}
