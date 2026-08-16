/**
 * Emberwood web app: canvas overworld + battle screen over the live engine.
 *
 * Modules:
 *   games.ts             game discovery (games/* glob) + ?game= selection
 *   saves.ts             localStorage save slots over the engine save codec
 *   audio/audio.ts       data-driven WebAudio chiptune music + SFX
 *   audio/tracks.json    the actual tunes (note events) + map->track mapping
 *   render/manifest.ts   sprite manifest loader (schema + images)
 *   render/renderer.ts   tile/entity canvas renderer (tweens, camera, glyphs)
 *   render/spriteMap.ts  game -> sprite id mapping (games/<id>/sprites.json)
 *   ui/title.ts          title screen (New Game / Continue / Choose Game)
 *   ui/pause.ts          pause panel (save slots, load, return to title)
 *   ui/overworld.ts      overworld view: map build, movement queue, portals
 *   ui/battle.ts         battle screen: panels, battlers, menus
 *   ui/messages.ts       GBA-style sequential message box
 *   ui/passage.ts        long-form passage pane ("scripture mode")
 *   ui/hud.ts            map/money chips + party strip
 */
import { Sim, validateGame } from "@llm-rpg/engine";
import { AudioEngine } from "./audio/audio";
import tracksData from "./audio/tracks.json";
import {
  fallbackGameId,
  listGames,
  loadGameRaw,
  loadSpritesRaw,
  selectedGameId,
} from "./games";
import { loadManifest } from "./render/manifest";
import { Renderer } from "./render/renderer";
import { loadSpriteMap } from "./render/spriteMap";
import { hasAnySave, newestSlot, readSlot, writeSlot, type SlotId } from "./saves";
import { BattleView } from "./ui/battle";
import { hasBattleContent, updateHud, updateParty } from "./ui/hud";
import { MessageBox } from "./ui/messages";
import { OverworldView, type WorldHolder } from "./ui/overworld";
import { PassagePane, type Passage } from "./ui/passage";
import { PausePanel } from "./ui/pause";
import { TitleScreen } from "./ui/title";

const OVERWORLD_HELP =
  "Move: Arrows / WASD · Interact: E / Space / Enter · Pause & save: P · Mute: M · Title: R";
const BATTLE_HELP =
  "Battle: Arrows + Enter · Esc back · direct keys 1-4 moves, 5-9 items, Shift+1-6 switch, C catch, X run";

const $ = (id: string) => document.getElementById(id)!;
const statusEl = $("status");

function fail(message: string): never {
  statusEl.textContent = message;
  statusEl.classList.add("error");
  throw new Error(message);
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Friendly full-screen error for a game that failed to load/validate. */
function showGameError(gameId: string, errors: string[]): void {
  const back = fallbackGameId(gameId);
  const link = back
    ? `<a class="status-link" href="?game=${encodeURIComponent(back)}">Play ${escapeHtml(back)} instead</a>`
    : "";
  statusEl.classList.add("error");
  statusEl.innerHTML = `
    <div class="status-error">
      <div class="status-head">The game "${escapeHtml(gameId)}" won't light just yet.</div>
      <ul class="status-list">${errors.map((e) => `<li>${escapeHtml(e)}</li>`).join("")}</ul>
      ${link}
    </div>`;
}

async function main(): Promise<void> {
  const gameId = selectedGameId();

  const raw = await loadGameRaw(gameId);
  if (!raw.ok) {
    showGameError(gameId, [raw.error]);
    return;
  }
  const result = validateGame(raw.data);
  if (!result.ok) {
    showGameError(gameId, result.errors);
    return;
  }
  let game = result.game!; // `let`: the dev-only forge hot-swaps it in place

  document.title = game.meta.title;
  $("title").textContent = game.meta.title;
  $("goal").textContent = game.meta.goal;

  let loaded;
  try {
    loaded = await loadManifest("/assets/manifest.json");
  } catch (err) {
    fail(String(err));
  }
  // Missing/broken sprites.json degrades to all-emoji rendering.
  const spritesRaw = (await loadSpritesRaw(gameId)) ?? {};
  let spriteMap;
  try {
    spriteMap = loadSpriteMap(spritesRaw, loaded);
  } catch (err) {
    console.warn(`games/${gameId}/sprites.json rejected — using emoji glyphs:`, err);
    spriteMap = loadSpriteMap({}, loaded);
  }
  statusEl.remove();

  const stage = $("stage");
  const canvas = $("game") as HTMLCanvasElement;
  const fadeEl = $("fade");
  const bannerEl = $("banner");
  const battleEl = $("battle");
  const helpEl = $("help");
  const partyEl = $("party");
  const hudMapEl = $("hud-map");
  const hudMoneyEl = $("hud-money");
  const muteEl = $("mute");

  bannerEl.innerHTML = `
    <div class="banner-title">The road is yours.</div>
    <div class="banner-body">The whole valley at your back, warm again.
    The hearth will keep till you next set out.</div>
    <div class="banner-hint">Press R to return to the title</div>`;

  // ---- audio ------------------------------------------------------------
  const audio = new AudioEngine(tracksData);
  const renderMute = () => {
    muteEl.textContent = audio.muted ? "\u{1F507} M" : "\u{1F50A} M";
  };
  audio.onMuteChange = renderMute;
  renderMute();
  muteEl.classList.remove("hidden");
  muteEl.addEventListener("click", () => {
    audio.unlock();
    audio.toggleMute();
  });
  // Autoplay policy: the context only exists after a real user gesture.
  window.addEventListener("pointerdown", () => audio.unlock());

  const world: WorldHolder = { sim: new Sim(game) };
  const renderer = new Renderer(canvas, loaded, {
    viewportTilesX: 12,
    viewportTilesY: 9,
    scale: 4,
    walkMs: 140,
  });
  const msg = new MessageBox($("msgbox"));
  msg.onShow = (text) => audio.sfxForEvent(text);

  // Passage pane ("scripture mode"): long-form text reads here, not in the
  // chatter box. Ordinary messages hold until the reading closes.
  const passagePane = new PassagePane($("passage"));
  msg.gate = () => passagePane.open;

  /**
   * Feature-detected drain of the engine's long-form passages. The engine
   * half populates `sim.state.lastPassages` during act() (cleared at the
   * start of each act, like lastEvents); until it lands this is a no-op.
   * Consumed by splice so a passage is queued exactly once.
   */
  function pumpPassages(): void {
    const passages = (world.sim.state as { lastPassages?: unknown }).lastPassages;
    if (!Array.isArray(passages) || passages.length === 0) return;
    passagePane.enqueue(passages.splice(0, passages.length) as Passage[]);
  }

  let mode: "title" | "overworld" | "battle" = "title";
  let transitioning = false;
  let wonStung = false;

  const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
  async function fade(during: () => void): Promise<void> {
    transitioning = true;
    fadeEl.classList.add("dark");
    await wait(240);
    during();
    await wait(60);
    fadeEl.classList.remove("dark");
    await wait(240);
    transitioning = false;
  }

  function refreshHud(): void {
    updateHud(world.sim, hudMapEl, hudMoneyEl);
    updateParty(world.sim, partyEl);
  }

  function autosave(): void {
    const res = writeSlot(game.meta.id, "auto", world.sim);
    if (!res.ok) console.warn(res.error);
  }

  const overworld = new OverworldView(renderer, world, spriteMap, msg, {
    onBattleStart: () => void enterBattle(),
    onPortal: () => void portalFade(),
    onStateChange: refreshHud,
  });
  const menuSfx = { blip: () => audio.sfx("blip"), confirm: () => audio.sfx("confirm") };
  const battle = new BattleView(battleEl, world, loaded, spriteMap, msg, menuSfx);

  async function portalFade(): Promise<void> {
    await fade(() => {
      overworld.rebuild();
      refreshHud();
    });
    autosave(); // silent autosave on every map transition
  }

  async function enterBattle(): Promise<void> {
    await fade(() => {
      stage.classList.add("battle-mode");
      battleEl.classList.remove("hidden");
      battle.enter();
      helpEl.textContent = BATTLE_HELP;
      mode = "battle";
    });
  }

  async function exitBattle(): Promise<void> {
    const outcome = battle.outcome();
    if (outcome === "player_won" || outcome === "captured") audio.sting("victory");
    await fade(() => {
      battle.leave();
      battleEl.classList.add("hidden");
      stage.classList.remove("battle-mode");
      overworld.rebuild();
      overworld.releaseKeys();
      refreshHud();
      helpEl.textContent = OVERWORLD_HELP;
      mode = "overworld";
    });
    autosave(); // silent autosave after every battle
  }

  // ---- title / pause / save flow ----------------------------------------

  // Indirection so the dev-only forge can swap in a fresh-from-disk lister.
  let gamesLister = listGames;

  const titleEl = $("title-screen");
  const pauseEl = $("pause");

  const titleScreen = new TitleScreen(titleEl, {
    onNewGame: () => {
      world.sim = new Sim(game);
      beginPlay([game.meta.goal]);
    },
    onContinue: () => {
      const slot = newestSlot(game.meta.id);
      if (!slot) {
        titleScreen.hint("No saves yet — the road is still unwalked.");
        return;
      }
      loadIntoPlay(slot, true);
    },
    onChooseGame: (id) => {
      window.location.search = `?game=${encodeURIComponent(id)}`;
    },
    listGames: () => gamesLister(),
    ...menuSfx,
  });

  const pause = new PausePanel(pauseEl, {
    gameId: () => game.meta.id,
    onSave: (slot: SlotId) => {
      const res = writeSlot(game.meta.id, slot, world.sim);
      return res.ok ? `Saved to slot ${slot}. The fire will keep.` : res.error;
    },
    onLoad: (slot: SlotId) => loadIntoPlay(slot, false),
    onTitle: () => returnToTitle(),
    ...menuSfx,
  });

  /**
   * Load a slot into live play. Returns null on success, else a gentle
   * error string. From the title, errors surface as a title hint.
   */
  function loadIntoPlay(slot: SlotId, fromTitle: boolean): string | null {
    const res = readSlot(game, slot);
    if (!res.ok) {
      if (fromTitle) titleScreen.hint(res.error);
      return res.error;
    }
    world.sim = res.sim;
    beginPlay(res.warnings.length > 0 ? res.warnings : ["Welcome back. The fire kept."]);
    return null;
  }

  /** Enter gameplay with whatever sim `world.sim` now holds. */
  function beginPlay(intro: string[]): void {
    titleScreen.hide();
    pause.hide();
    msg.clear();
    msg.setIdleHide(true);
    passagePane.clear();
    battle.leave();
    bannerEl.classList.add("hidden");
    wonStung = false;
    overworld.releaseKeys();
    if (world.sim.state.battle && hasBattleContent(world.sim)) {
      // A save taken mid-battle (engine supports it) resumes into the fight.
      stage.classList.add("battle-mode");
      battleEl.classList.remove("hidden");
      battle.enter();
      helpEl.textContent = BATTLE_HELP;
      mode = "battle";
    } else {
      battleEl.classList.add("hidden");
      stage.classList.remove("battle-mode");
      overworld.rebuild();
      helpEl.textContent = OVERWORLD_HELP;
      mode = "overworld";
    }
    refreshHud();
    msg.push(intro);
  }

  function returnToTitle(): void {
    if (mode !== "title") autosave(); // suspend-style save, mid-battle included
    mode = "title";
    pause.hide();
    msg.clear();
    passagePane.clear();
    battle.leave();
    battleEl.classList.add("hidden");
    stage.classList.remove("battle-mode");
    bannerEl.classList.add("hidden");
    overworld.releaseKeys();
    audio.setMusic(null);
    titleScreen.show(game.meta.title, game.meta.goal, gameId, hasAnySave(game.meta.id));
  }

  // ---- input -------------------------------------------------------------

  window.addEventListener("keydown", (ev) => {
    audio.unlock(); // first keypress anywhere satisfies autoplay policy
    if (ev.key === "m" || ev.key === "M") {
      ev.preventDefault();
      audio.toggleMute();
      return;
    }
    if (passagePane.open) {
      // A passage owns the stage: everything but mute waits until it closes.
      if (passagePane.handleKey(ev)) ev.preventDefault();
      return;
    }
    if (mode === "title") {
      if (titleScreen.handleKey(ev)) ev.preventDefault();
      return;
    }
    if (pause.visible) {
      if (pause.handleKey(ev)) ev.preventDefault();
      return;
    }
    if (ev.key === "r" || ev.key === "R") {
      ev.preventDefault();
      if (window.confirm("Return to the title screen? (Your progress autosaves.)")) {
        returnToTitle();
      }
      return;
    }
    if (transitioning) return;
    if (mode === "battle") {
      if (battle.handleKey(ev)) ev.preventDefault();
      return;
    }
    if (ev.key === "p" || ev.key === "P" || ev.key === "Escape") {
      ev.preventDefault();
      overworld.releaseKeys();
      audio.sfx("blip");
      pause.show();
      return;
    }
    if (world.sim.state.won) return;
    if (overworld.handleKeyDown(ev)) {
      ev.preventDefault();
      return;
    }
    if (ev.key === "e" || ev.key === "E" || ev.key === " " || ev.key === "Enter") {
      ev.preventDefault();
      if (msg.advance()) return; // waiting dialogue advances before new talk
      overworld.interact();
    }
  });
  window.addEventListener("keyup", (ev) => {
    if (mode === "overworld" && !pause.visible) overworld.handleKeyUp(ev);
  });

  /** Keep the music matched to where we are; setMusic no-ops on repeats. */
  function updateMusic(): void {
    if (mode === "title") return; // returnToTitle already faded it out
    if (world.sim.state.won) return; // victory sting owns the win moment
    if (world.sim.state.battle || mode === "battle") {
      audio.setMusic(audio.battleTrack);
    } else {
      audio.setMusic(audio.trackForMap(world.sim.state.map));
    }
  }

  const loop = () => {
    if (mode !== "title") pumpPassages();
    if (mode !== "title" && !transitioning && !passagePane.open) {
      if (mode === "overworld") {
        if (!world.sim.state.won) {
          if (!pause.visible) overworld.tick();
        } else if (!msg.busy()) {
          bannerEl.classList.remove("hidden");
          if (!wonStung) {
            wonStung = true;
            audio.setMusic(null);
            audio.sting("victory");
            autosave();
          }
        }
      } else if (battle.tick()) {
        void exitBattle();
      }
    }
    updateMusic();
    requestAnimationFrame(loop);
  };

  // Debug/test handle (used by the CDP walkthrough; harmless in play).
  (window as unknown as { __world: WorldHolder }).__world = world;

  // ---- forge live reload (dev only; this whole block tree-shakes out) ----
  if (import.meta.hot) {
    const { initForge } = await import("./forge");
    initForge(import.meta.hot, {
      gameId,
      loaded,
      getSim: () => world.sim,
      getMode: () => mode,
      applyGame: (g, sim, sprites) => {
        game = g;
        world.sim = sim;
        spriteMap = sprites;
        overworld.setSpriteMap(sprites);
        battle.setSpriteMap(sprites);
        document.title = g.meta.title;
        $("title").textContent = g.meta.title;
        $("goal").textContent = g.meta.goal;
        if (mode === "title") {
          titleScreen.show(g.meta.title, g.meta.goal, gameId, hasAnySave(g.meta.id));
          return;
        }
        msg.clear();
        passagePane.clear();
        bannerEl.classList.add("hidden"); // the loop re-shows it if still won
        wonStung = world.sim.state.won; // don't re-sting a preserved win
        if (world.sim.state.battle && hasBattleContent(world.sim)) {
          stage.classList.add("battle-mode");
          battleEl.classList.remove("hidden");
          battle.enter();
          helpEl.textContent = BATTLE_HELP;
          mode = "battle";
        } else {
          battle.leave();
          battleEl.classList.add("hidden");
          stage.classList.remove("battle-mode");
          overworld.rebuild();
          overworld.releaseKeys();
          helpEl.textContent = OVERWORLD_HELP;
          mode = "overworld";
        }
        refreshHud();
      },
      applySprites: (sprites) => {
        spriteMap = sprites;
        overworld.setSpriteMap(sprites); // battle repaints inside its setter
        battle.setSpriteMap(sprites);
        if (mode === "overworld") overworld.rebuild();
      },
      refreshTitleGames: () => titleScreen.refreshGames(),
      setGamesLister: (fn) => {
        gamesLister = fn;
      },
    });

    // Passage-pane verification (?passagetest=1): queue sample passages on
    // load so pagination/styling can be checked before any game has passage
    // content. Dev-only — the dynamic import tree-shakes out of prod builds.
    if (new URLSearchParams(window.location.search).get("passagetest") === "1") {
      const { samplePassages } = await import("./passagetest");
      passagePane.enqueue(samplePassages());
    }
  }

  renderer.start();
  requestAnimationFrame(loop);
  titleScreen.show(game.meta.title, game.meta.goal, gameId, hasAnySave(game.meta.id));
}

void main();
