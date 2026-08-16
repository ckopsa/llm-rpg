/**
 * Cutscene player: paces the engine's renderer-directed cues
 * (sim.state.lastCues) into a watchable sequence.
 *
 * The sim is already in its FINAL post-cutscene configuration when an act
 * returns — the cues describe the journey. This player collects the cues
 * synchronously after every overworld act (before the act's chatter reaches
 * the message box), then plays them strictly in array order while the rest
 * of the UI holds:
 *
 *   - main.ts routes all keys here while `holding` (advance keys skip the
 *     CURRENT cue only, never the whole sequence);
 *   - the message box gates on `holding`, so accompanying events show AFTER
 *     playback (say/passage keep their own surfaces as usual);
 *   - the passage pane, choice menu, ending screen, and overworld movement
 *     all wait on `holding` in the main loop.
 *
 * Observed scenes: a camera_focus onto another map fades out, builds THAT
 * map from the same game+overlay state, and plays there; release (or the end
 * of the sequence) fades back to the player's map. When a scene is built
 * mid-sequence, entities and tiles with cues still pending are wound back to
 * their pre-cue configuration so the remaining cues still read as changes.
 *
 * Playback always ends with an authoritative overworld.rebuild(), so the
 * view lands exactly on the sim's final state no matter what was skipped.
 */
import type { Cue, Sim } from "@llm-rpg/engine";
import type { Renderer } from "../render/renderer";
import type { SpriteMap } from "../render/spriteMap";
import { glyphSprite } from "../render/spriteMap";
import { buildMapData, entitySpriteFor, type WorldHolder } from "./overworld";

// ---- pacing constants ------------------------------------------------------
/** One `wait` beat. */
const BEAT_MS = 350;
/** Per-tile cue walk (a touch slower than the player's 140ms — readable). */
const STEP_MS = 180;
/** Same-map camera pan (focus and release). */
const PAN_MS = 550;
/** Spawn fade-in / removal fade-out. */
const SPAWN_MS = 400;
const REMOVE_MS = 400;
/** set_tile repaint flash. */
const TILE_MS = 400;
/** Observed-scene swap: fade out, then in, each. */
const SCENE_FADE_MS = 260;
/** screen_effect durations. */
const SHAKE_MS = 500;
const FLASH_MS = 450;
const FADE_OUT_MS = 400;
const FADE_HOLD_MS = 250;
const FADE_IN_MS = 400;
/** Title card: minimum time before an advance key is accepted, and the
 *  longest it waits for one before advancing itself. */
const TITLE_MIN_MS = 1000;
const TITLE_HOLD_MS = 4000;
const TITLE_FADE_MS = 300;
/** Small breath between cues. */
const CUE_GAP_MS = 90;

const ADVANCE_KEYS = new Set(["Enter", " ", "e", "E", "z", "Z"]);

export interface CutsceneHooks {
  /** The live sprite mapping (dev forge can hot-swap it). */
  spriteMap(): SpriteMap;
  /** Authoritative final resync — the overworld rebuild. */
  rebuild(): void;
  /** Map id the overworld renderer currently shows. */
  renderMapId(): string;
  /** play_music cue: request a music override (caller resolves the track). */
  playMusic(track: string): void;
}

export class CutscenePlayer {
  private renderer: Renderer;
  private world: WorldHolder;
  private hooks: CutsceneHooks;
  private stage: HTMLElement;

  private fxEl: HTMLElement;
  private titleEl: HTMLElement;
  private titleTextEl: HTMLElement;
  private titleSubEl: HTMLElement;
  private titleHintEl: HTMLElement;

  private queue: Cue[] = [];
  private playing = false;
  private cancelled = false;
  /** Map the cutscene is currently showing (starts as the overworld's). */
  private viewMapId = "";
  private skipRequested = false;
  private skipResolvers = new Set<() => void>();

  constructor(renderer: Renderer, world: WorldHolder, stage: HTMLElement, hooks: CutsceneHooks) {
    this.renderer = renderer;
    this.world = world;
    this.stage = stage;
    this.hooks = hooks;

    this.fxEl = document.createElement("div");
    this.fxEl.id = "cutfx";
    this.titleEl = document.createElement("div");
    this.titleEl.id = "cutscene-title";
    this.titleEl.innerHTML = `
      <div class="cut-title-card">
        <div class="cut-title-text"></div>
        <div class="cut-title-sub hidden"></div>
        <div class="cut-title-hint">Press Enter</div>
      </div>`;
    this.titleTextEl = this.titleEl.querySelector(".cut-title-text")!;
    this.titleSubEl = this.titleEl.querySelector(".cut-title-sub")!;
    this.titleHintEl = this.titleEl.querySelector(".cut-title-hint")!;
    stage.append(this.fxEl, this.titleEl);
  }

  /** True while cues are queued or playing — the whole UI gates on this. */
  get holding(): boolean {
    return this.queue.length > 0 || this.playing;
  }

  /** True while a sequence is actually on screen (keys route here). */
  get active(): boolean {
    return this.playing;
  }

  /**
   * Drain the sim's lastCues into the play queue. Call synchronously right
   * after any overworld act() — before its events reach the message box —
   * and once at game start (the start map's enter trigger runs during
   * Sim construction). Feature-detected and consumed by splice, so a cue is
   * queued exactly once and older engines are a no-op.
   */
  collect(sim: Sim): void {
    const cues = (sim.state as { lastCues?: unknown }).lastCues;
    if (!Array.isArray(cues) || cues.length === 0) return;
    this.queue.push(...(cues.splice(0, cues.length) as Cue[]));
  }

  /** Per-frame from the main loop: start playback once the stage allows. */
  tick(canStart: boolean): void {
    if (canStart && !this.playing && this.queue.length > 0) void this.play();
  }

  /** Advance keys skip the current cue; everything else is swallowed. */
  handleKey(ev: KeyboardEvent): boolean {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return false;
    if (ADVANCE_KEYS.has(ev.key)) {
      this.requestSkip();
      return true;
    }
    return ev.key.length === 1 || ev.key.startsWith("Arrow") || ev.key === "Escape";
  }

  /** Drop everything (title return, loads, forge reloads). The caller is
   *  responsible for any rebuild; this just stops and clears the DOM. */
  cancel(): void {
    this.queue = [];
    if (this.playing) {
      this.cancelled = true;
      this.requestSkip();
    } else {
      this.resetDom();
    }
  }

  // ---- playback core -------------------------------------------------------

  private requestSkip(): void {
    this.skipRequested = true;
    for (const resolve of this.skipResolvers) resolve();
    this.skipResolvers.clear();
  }

  /** Sleep that resolves early when the current cue is skipped. */
  private sleep(ms: number): Promise<void> {
    if (this.skipRequested || this.cancelled) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.skipResolvers.delete(done);
        resolve();
      }, ms);
      const done = () => {
        window.clearTimeout(timer);
        resolve();
      };
      this.skipResolvers.add(done);
    });
  }

  /** Sleep that ignores skips (title-card minimum beat). */
  private sleepHard(ms: number): Promise<void> {
    if (this.cancelled) return Promise.resolve();
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  private async play(): Promise<void> {
    this.playing = true;
    this.viewMapId = this.hooks.renderMapId() || this.world.sim.state.map;
    try {
      while (this.queue.length > 0 && !this.cancelled) {
        const cue = this.queue.shift()!;
        this.skipRequested = false;
        try {
          await this.playCue(cue);
        } catch (err) {
          console.warn("[cutscene] cue failed — continuing:", cue, err);
        }
        if (this.queue.length > 0 && !this.cancelled) {
          this.skipRequested = false;
          await this.sleep(CUE_GAP_MS);
        }
      }
    } finally {
      await this.finish();
      this.playing = false;
    }
  }

  private async finish(): Promise<void> {
    if (this.cancelled) {
      this.cancelled = false;
      this.resetDom();
      return;
    }
    this.skipRequested = false;
    const playerMap = this.world.sim.state.map;
    if (this.viewMapId !== playerMap) {
      // Observed scene never released, or the player teleported mid-list:
      // return home through the same quick fade.
      this.fxEl.classList.add("dark");
      await this.sleepHard(SCENE_FADE_MS);
      this.hooks.rebuild();
      this.fxEl.classList.remove("dark");
      await this.sleepHard(SCENE_FADE_MS);
    } else {
      // Authoritative resync — skipped cues, variant swaps, everything.
      this.hooks.rebuild();
    }
    this.resetDom();
  }

  private resetDom(): void {
    this.fxEl.classList.remove("dark", "flash");
    this.titleEl.classList.remove("show");
    this.titleHintEl.classList.remove("on");
    this.stage.classList.remove("fx-shake");
  }

  private async playCue(cue: Cue): Promise<void> {
    switch (cue.kind) {
      case "move_entity":
        return this.playMove(cue);
      case "spawn_entity":
        return this.playSpawn(cue);
      case "remove_entity":
        return this.playRemove(cue);
      case "set_tile":
        return this.playSetTile(cue);
      case "wait":
        return this.sleep(cue.beats * BEAT_MS);
      case "camera_focus":
        return this.playCamera(cue);
      case "play_music":
        this.hooks.playMusic(cue.track);
        return;
      case "screen_effect":
        return this.playEffect(cue.effect);
      case "show_title":
        return this.playTitle(cue.text, cue.subtitle);
      default:
        // Future cue kinds: state is already final; just don't crash.
        return;
    }
  }

  // ---- cue implementations -------------------------------------------------

  private async playMove(cue: Extract<Cue, { kind: "move_entity" }>): Promise<void> {
    if (cue.mapId !== this.viewMapId) return;
    const id = `npc:${cue.entityId}`;
    if (!this.renderer.hasEntity(id)) {
      this.addSceneEntity(cue.entityId, cue.mapId, cue.from.x, cue.from.y);
    }
    this.renderer.placeEntity(id, cue.from.x, cue.from.y);
    for (const dir of cue.steps) {
      if (this.skipRequested || this.cancelled) {
        this.renderer.placeEntity(id, cue.to.x, cue.to.y);
        return;
      }
      this.renderer.walk(id, dir, STEP_MS);
      await this.sleep(STEP_MS + 20);
    }
    if (this.skipRequested) this.renderer.placeEntity(id, cue.to.x, cue.to.y);
    if (cue.blocked !== undefined) {
      // The blocked step stops the walk: face the way and hold a beat.
      this.renderer.face(id, cue.blocked);
      await this.sleep(180);
    }
  }

  private async playSpawn(cue: Extract<Cue, { kind: "spawn_entity" }>): Promise<void> {
    if (cue.mapId !== this.viewMapId) return;
    const id = `npc:${cue.entityId}`;
    if (!this.renderer.hasEntity(id)) {
      this.addSceneEntity(cue.entityId, cue.mapId, cue.x, cue.y, { alpha: 0, glyph: cue.glyph });
    }
    this.renderer.placeEntity(id, cue.x, cue.y);
    this.renderer.fadeEntity(id, 1, SPAWN_MS);
    await this.sleep(SPAWN_MS);
    this.renderer.setEntityAlpha(id, 1);
  }

  private async playRemove(cue: Extract<Cue, { kind: "remove_entity" }>): Promise<void> {
    if (cue.mapId !== this.viewMapId) return;
    const id = `npc:${cue.entityId}`;
    if (!this.renderer.hasEntity(id)) return;
    this.renderer.fadeEntity(id, 0, REMOVE_MS);
    await this.sleep(REMOVE_MS);
    this.renderer.removeEntity(id);
  }

  private async playSetTile(cue: Extract<Cue, { kind: "set_tile" }>): Promise<void> {
    if (cue.mapId !== this.viewMapId) return;
    const tile = this.world.sim.game.legend[cue.char];
    if (!tile) return;
    const resolved = this.hooks.spriteMap().tileSprites(tile.name, tile.glyph);
    this.renderer.setTile(cue.x, cue.y, resolved.ground, resolved.overlay);
    this.renderer.flashTile(cue.x, cue.y, TILE_MS);
    await this.sleep(TILE_MS);
  }

  private async playCamera(cue: Extract<Cue, { kind: "camera_focus" }>): Promise<void> {
    const playerMap = this.world.sim.state.map;
    if (cue.release) {
      if (this.viewMapId !== playerMap) {
        await this.sceneSwap(playerMap, null);
      } else {
        this.renderer.releaseCameraFocus(PAN_MS);
        await this.sleep(PAN_MS);
        if (this.skipRequested) this.renderer.finishCameraPan();
      }
      return;
    }
    const targetMap = cue.mapId ?? this.viewMapId;
    const target =
      cue.entityId !== undefined
        ? { entityId: `npc:${cue.entityId}`, x: cue.x, y: cue.y }
        : { x: cue.x, y: cue.y };
    if (targetMap !== this.viewMapId) {
      // Observed scene: quick fade out, show THAT map, fade in on target.
      await this.sceneSwap(targetMap, target);
      return;
    }
    this.renderer.focusCamera(target, PAN_MS);
    await this.sleep(PAN_MS);
    if (this.skipRequested) this.renderer.finishCameraPan();
  }

  private async playEffect(effect: "shake" | "flash" | "fade"): Promise<void> {
    if (effect === "shake") {
      this.stage.classList.remove("fx-shake");
      void this.stage.offsetWidth; // restart the animation
      this.stage.classList.add("fx-shake");
      await this.sleep(SHAKE_MS);
      this.stage.classList.remove("fx-shake");
      return;
    }
    if (effect === "flash") {
      this.fxEl.classList.remove("flash");
      void this.fxEl.offsetWidth;
      this.fxEl.classList.add("flash");
      await this.sleep(FLASH_MS);
      this.fxEl.classList.remove("flash");
      return;
    }
    // fade: to black, hold a breath, back.
    this.fxEl.classList.add("dark");
    await this.sleep(FADE_OUT_MS + FADE_HOLD_MS);
    this.fxEl.classList.remove("dark");
    await this.sleep(FADE_IN_MS);
  }

  private async playTitle(text: string, subtitle?: string): Promise<void> {
    this.titleTextEl.textContent = text;
    this.titleSubEl.textContent = subtitle ?? "";
    this.titleSubEl.classList.toggle("hidden", subtitle === undefined);
    this.titleHintEl.classList.remove("on");
    this.titleEl.classList.add("show");
    // A title card holds its minimum beat regardless of key mashing…
    await this.sleepHard(TITLE_MIN_MS);
    if (!this.cancelled) {
      // …then advances on a fresh keypress (or by itself, eventually).
      this.skipRequested = false;
      this.titleHintEl.classList.add("on");
      await this.sleep(TITLE_HOLD_MS);
    }
    this.titleEl.classList.remove("show");
    this.titleHintEl.classList.remove("on");
    await this.sleepHard(TITLE_FADE_MS);
  }

  // ---- observed scenes -----------------------------------------------------

  /**
   * Fade to black, rebuild the view for `mapId` (final state wound back past
   * any still-pending cues on that map), set the camera, fade back in.
   */
  private async sceneSwap(
    mapId: string,
    focus: { entityId?: string; x?: number; y?: number } | null,
  ): Promise<void> {
    this.fxEl.classList.add("dark");
    await this.sleepHard(SCENE_FADE_MS);
    this.buildScene(mapId);
    if (focus) {
      const target =
        focus.entityId !== undefined && this.renderer.hasEntity(focus.entityId)
          ? { entityId: focus.entityId }
          : { x: focus.x, y: focus.y };
      this.renderer.focusCamera(target, 0);
    } else {
      this.renderer.releaseCameraFocus(0);
    }
    this.viewMapId = mapId;
    this.fxEl.classList.remove("dark");
    await this.sleepHard(SCENE_FADE_MS);
  }

  /**
   * Build renderer map + entities for `mapId` from the sim's (final) state,
   * wound back for cues still in the queue: entities with a pending
   * spawn cue are held out, entities with a pending move start at that
   * cue's `from`, entities already removed but with a pending remove cue are
   * temporarily restored, and tiles with a pending set_tile keep their
   * pre-repaint art.
   */
  private buildScene(mapId: string): void {
    const sim = this.world.sim;
    const spriteMap = this.hooks.spriteMap();
    const hasSprite = (id: string) => this.renderer.hasSprite(id);

    const pendingFrom = new Map<string, { x: number; y: number }>();
    const pendingSpawn = new Set<string>();
    const pendingRemoves: { entityId: string; x: number; y: number }[] = [];
    const pendingTiles: { x: number; y: number }[] = [];
    for (const c of this.queue) {
      if (c.kind === "move_entity" && c.mapId === mapId) {
        if (!pendingFrom.has(c.entityId) && !pendingSpawn.has(c.entityId)) {
          pendingFrom.set(c.entityId, c.from);
        }
      } else if (c.kind === "spawn_entity" && c.mapId === mapId) {
        pendingSpawn.add(c.entityId);
      } else if (c.kind === "remove_entity" && c.mapId === mapId) {
        pendingRemoves.push({ entityId: c.entityId, x: c.x, y: c.y });
      } else if (c.kind === "set_tile" && c.mapId === mapId) {
        pendingTiles.push({ x: c.x, y: c.y });
      }
    }

    this.renderer.setMap(buildMapData(sim, mapId, spriteMap, pendingTiles));
    this.renderer.clearEntities();

    const placed = new Set<string>();
    for (const e of sim.entitiesOn(mapId)) {
      if (pendingSpawn.has(e.id)) continue; // appears via its spawn cue
      const at = pendingFrom.get(e.id) ?? e;
      this.renderer.addEntity({
        id: `npc:${e.id}`,
        spriteId: entitySpriteFor(e, spriteMap, hasSprite),
        x: at.x,
        y: at.y,
        facing: "south",
      });
      placed.add(e.id);
    }
    for (const r of pendingRemoves) {
      if (!placed.has(r.entityId)) this.addSceneEntity(r.entityId, mapId, r.x, r.y);
    }
    if (sim.state.map === mapId) {
      this.renderer.addEntity({
        id: "player",
        spriteId: spriteMap.playerSprite(sim.game.player.glyph),
        x: sim.state.playerX,
        y: sim.state.playerY,
        facing: "south",
      });
      this.renderer.followCamera("player");
    }
  }

  /**
   * Add one entity to the scene at (x, y), resolving its appearance from
   * the sim's effective state, its placed definition, or a glyph fallback —
   * used when a cue references something the renderer doesn't hold yet.
   */
  private addSceneEntity(
    entityId: string,
    mapId: string,
    x: number,
    y: number,
    opts: { alpha?: number; glyph?: string } = {},
  ): void {
    const sim = this.world.sim;
    const spriteMap = this.hooks.spriteMap();
    const hasSprite = (id: string) => this.renderer.hasSprite(id);
    const effective =
      sim.entitiesOn(mapId).find((e) => e.id === entityId) ??
      Object.values(sim.game.maps)
        .flatMap((d) => d.entities)
        .find((e) => e.id === entityId);
    const spriteId = effective
      ? entitySpriteFor(effective, spriteMap, hasSprite)
      : glyphSprite(opts.glyph ?? "?");
    this.renderer.addEntity({
      id: `npc:${entityId}`,
      spriteId,
      x,
      y,
      facing: "south",
      alpha: opts.alpha ?? 1,
    });
  }
}
