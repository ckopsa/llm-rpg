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
 *   ui/choice.ts         dialogue choice menu over sim.state.pendingChoice
 *   ui/passage.ts        long-form passage pane ("scripture mode")
 *   ui/cutscene.ts       paced playback of sim.state.lastCues
 *   ui/ending.ts         ending screens over sim.state.ending
 *   ui/hud.ts            map/money chips + party strip
 */
import { applyLanguage, parseAction, Sim, validateGame } from "@llm-rpg/engine";
import { AudioEngine } from "./audio/audio";
import { Narrator, shouldSpeak } from "./audio/speech";
import tracksData from "./audio/tracks.json";
import {
  fallbackGameId,
  listGames,
  listLanguages,
  loadLanguageText,
  selectedLanguage,
  loadGameRaw,
  loadSpritesRaw,
  selectedGameId,
} from "./games";
import { loadManifest } from "./render/manifest";
import { Renderer } from "./render/renderer";
import { loadSpriteMap, type SpriteMap } from "./render/spriteMap";
import { hasAnySave, newestSlot, readSlot, writeSlot, type SlotId } from "./saves";
import { BattleView } from "./ui/battle";
import { ChoiceMenu } from "./ui/choice";
import { CutscenePlayer } from "./ui/cutscene";
import { EndingScreen } from "./ui/ending";
import { hasBattleContent, updateHud, updateParty, updateObjective } from "./ui/hud";
import { MessageBox } from "./ui/messages";
import { OverworldView, presentableEvents, type WorldHolder } from "./ui/overworld";
import { PassagePane, type Passage } from "./ui/passage";
import { PausePanel } from "./ui/pause";
import { Controls } from "./ui/controls";
import { TitleScreen } from "./ui/title";

const OVERWORLD_HELP =
  "Move: Arrows / WASD / d-pad · Interact: E / Space / Enter / A · Pause & save: P · Mute: M · Read aloud: V · What now: H · Title: R";
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

  // Language overlay: same game, other words (games/<id>/lang.<code>.json).
  // A bad or missing overlay is never fatal — the game's own words stand.
  const languages = listLanguages(gameId);
  const languageNames = new Map<string, string>();
  await Promise.all(
    languages.map(async (code) => {
      try {
        const text = await loadLanguageText(gameId, code);
        const parsed = JSON.parse(text!) as { name?: string };
        if (parsed.name) languageNames.set(code, parsed.name);
      } catch {
        /* an unreadable overlay simply keeps its code as its label */
      }
    }),
  );
  let language = selectedLanguage();
  let languageVoice: string | undefined;
  if (language && languages.includes(language)) {
    try {
      const text = await loadLanguageText(gameId, language);
      const overlay = JSON.parse(text!);
      const applied = applyLanguage(game, overlay);
      const revalidated = validateGame(JSON.parse(JSON.stringify(applied.game)));
      if (revalidated.ok) {
        game = revalidated.game!;
        languageVoice = overlay.voice;
        if (applied.missing.length > 0) {
          console.info(
            `language "${language}": ${applied.missing.length} string(s) left in the original words`,
          );
        }
      } else {
        console.warn(`language "${language}" produced an invalid game — using the original words`, revalidated.errors);
        language = null;
      }
    } catch (err) {
      console.warn(`language "${language}" could not be loaded — using the original words:`, err);
      language = null;
    }
  } else if (language) {
    console.warn(`no language "${language}" for ${gameId} — using the original words`);
    language = null;
  }

  document.title = game.meta.title;
  $("title").textContent = game.meta.title;
  $("goal").textContent = game.meta.goal;

  let loaded;
  try {
    loaded = await loadManifest(`${import.meta.env.BASE_URL}assets/manifest.json`);
  } catch (err) {
    fail(String(err));
  }
  // Missing/broken sprites.json degrades to all-emoji rendering.
  const spritesRaw = (await loadSpritesRaw(gameId)) ?? {};
  let spriteMap: SpriteMap;
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
  const endingEl = $("ending");
  const battleEl = $("battle");
  const helpEl = $("help");
  const partyEl = $("party");
  const hudMapEl = $("hud-map");
  const hudMoneyEl = $("hud-money");
  const objectiveEl = $("objective");
  const objectiveTextEl = $("objective-text");
  const muteEl = $("mute");
  const narrateEl = $("narrate");

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

  // ---- read-aloud -------------------------------------------------------
  // Narration exists so a player who can't read yet can play: the message
  // box, passage pane, choice menu and ending screen all hand their text
  // here, and their pacing follows the voice instead of a timer.
  const narrator = new Narrator();
  const renderNarrate = () => {
    const hint = narrator.voiceHint();
    const mute = narrator.enabled && hint !== null; // on, but nothing audible
    narrateEl.textContent = mute ? "\u{26A0} V" : narrator.enabled ? "\u{1F5E3} V" : "\u{1F4AC} V";
    const voice = narrator.localVoice ? ` · ${narrator.localVoice}` : "";
    narrateEl.title = mute
      ? hint!
      : narrator.enabled
        ? `Reading aloud (${narrator.rateName}${voice}) — V to stop, Shift+V for speed`
        : "Read aloud (V)";
    narrateEl.classList.toggle("on", narrator.enabled && !mute);
    narrateEl.classList.toggle("warn", mute);
  };
  narrator.onChange = renderNarrate;
  if (narrator.available) {
    narrateEl.classList.remove("hidden");
    renderNarrate();
    narrateEl.addEventListener("click", () => {
      const on = narrator.toggle();
      narrator.unlock();
      const hint = narrator.voiceHint();
      if (on && hint) msg.push([hint]);
      renderNarrate();
    });
  }
  window.addEventListener("pointerdown", () => narrator.unlock(), { once: true });
  // Prefer the dev server's local Piper voice when it is there — it works in
  // browsers whose own speech is broken (Brave on Linux), and never leaves
  // the machine. Falls back to Web Speech silently.
  void narrator.connectLocal(`${import.meta.env.BASE_URL}__tts`).then((ok) => {
    if (ok) {
      narrateEl.classList.remove("hidden");
      // A script may name the voice it was written to be read in.
      if (languageVoice) narrator.useLocalVoice(languageVoice);
    }
    renderNarrate();
  });

  /** Pacing hook shared by the message box and the passage pane. Returns
   *  null for stage directions and when narration is off, which leaves the
   *  caller on its own timing. */
  const narrate = (text: string, done: () => void): (() => void) | null => {
    if (!narrator.enabled || !shouldSpeak(text)) return null;
    return narrator.speak(text, done);
  };

  // ---- fitting the stage to the screen ----------------------------------
  // The stage is a fixed 768x576 design surface; scale the whole thing rather
  // than making a dozen overlays responsive. Leaves room for the header, help
  // line and (on touch devices) the on-screen controls.
  const app = $("app");
  const controlsEl = $("touch-controls");
  const fitStage = (): void => {
    const chromeH =
      $("top").getBoundingClientRect().height +
      $("help").getBoundingClientRect().height +
      (controlsEl.classList.contains("shown") && !controlsEl.classList.contains("has-pad")
        ? controlsEl.getBoundingClientRect().height + 16
        : 0) +
      56; // body padding + flex gaps
    const availW = Math.max(240, document.documentElement.clientWidth - 32);
    const availH = Math.max(200, window.innerHeight - chromeH);
    const scale = Math.min(availW / 768, availH / 576);
    // Never blow the art up past its design size; small screens scale down.
    const clamped = Math.min(scale, 1);
    app.style.setProperty("--stage-scale", String(clamped));
    app.classList.toggle("stage-downscaled", clamped < 1);
  };
  const controls = new Controls(controlsEl);
  fitStage();
  window.addEventListener("resize", fitStage);
  window.addEventListener("orientationchange", fitStage);
  // A pad appearing hides the thumb d-pad, which gives the stage more room.
  window.addEventListener("gamepadconnected", () => window.setTimeout(fitStage, 0));
  window.addEventListener("gamepaddisconnected", () => window.setTimeout(fitStage, 0));

  const world: WorldHolder = { sim: new Sim(game) };
  const renderer = new Renderer(canvas, loaded, {
    viewportTilesX: 12,
    viewportTilesY: 9,
    scale: 4,
    walkMs: 140,
  });
  const msg = new MessageBox($("msgbox"));
  msg.onShow = (text) => audio.sfxForEvent(text);
  msg.narrate = narrate;

  // Passage pane ("scripture mode"): long-form text reads here, not in the
  // chatter box. Ordinary messages hold until the reading closes — and until
  // any cutscene finishes, so cue-accompanying chatter shows AFTER playback.
  const passagePane = new PassagePane($("passage"));
  passagePane.narrate = narrate;
  msg.gate = () => passagePane.open || cutscene.holding;

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
  /** One-time ending effects (sting/autosave) already ran for this ending. */
  let endingHandled = false;
  /** play_music cue override: sticks while the player stays on the map it
   *  was set on; a map change hands music back to the normal mapping. */
  let musicOverride: { track: string; map: string } | null = null;

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
    // A NEW objective is worth saying out loud once; an unchanged one is not.
    const changed = updateObjective(world.sim, objectiveEl, objectiveTextEl);
    if (changed) pendingObjectiveSpeech = changed;
  }

  /** Set when the objective changes; spoken once the stage quiets so it does
   *  not talk over the line that just explained why it changed. */
  let pendingObjectiveSpeech: string | null = null;

  /** Read the standing objective aloud — the "I'm lost, what now?" button. */
  function sayObjective(): void {
    const text = objectiveTextEl.textContent?.trim();
    if (text) narrator.say(text);
    else narrator.say(game.meta.goal);
  }
  $("objective-say").addEventListener("click", (ev) => {
    ev.preventDefault();
    audio.sfx("blip");
    sayObjective();
  });

  function autosave(): void {
    const res = writeSlot(game.meta.id, "auto", world.sim);
    if (!res.ok) console.warn(res.error);
  }

  const overworld = new OverworldView(renderer, world, spriteMap, msg, {
    onBattleStart: () => void enterBattle(),
    onPortal: () => void portalFade(),
    onStateChange: refreshHud,
    // Collect cues synchronously after every act, BEFORE its chatter is
    // pushed — msg.gate then holds the chatter until playback finishes.
    // With no cues in flight, variant appearance syncs immediately.
    onActed: () => {
      cutscene.collect(world.sim);
      if (!cutscene.holding) overworld.syncAppearance();
    },
  });

  // Cutscene player: paces lastCues (walks, pans, observed scenes, title
  // cards, effects) while the rest of the stage gates on `holding`.
  const cutscene = new CutscenePlayer(renderer, world, stage, {
    spriteMap: () => spriteMap,
    rebuild: () => overworld.rebuild(),
    renderMapId: () => overworld.renderMapId,
    playMusic: (track) => {
      musicOverride = { track: audio.resolveTrack(track), map: world.sim.state.map };
      updateMusic();
    },
  });

  const menuSfx = { blip: () => audio.sfx("blip"), confirm: () => audio.sfx("confirm") };
  const battle = new BattleView(battleEl, world, loaded, spriteMap, msg, menuSfx);

  // Ending screen: every ending (victory included) lands here once the
  // stage quiets; closing returns to the title.
  const endingScreen = new EndingScreen(endingEl, {
    onTitle: () => returnToTitle(),
    confirm: menuSfx.confirm,
    speak: (text) => narrator.say(text),
    hush: () => narrator.stop(),
  });

  // Choice menu: engine dialogue choices (sim.state.pendingChoice) as a
  // small menu above the message box. Confirming dispatches chooseN through
  // the same act() path as every other input; the loop's tick re-opens it
  // for nested follow-up choices once the resulting chatter drains.
  const choiceMenu = new ChoiceMenu($("choice"), world, msg, {
    choose: (word) => {
      const action = parseAction(word);
      if (!action) return;
      const events = world.sim.act(action);
      cutscene.collect(world.sim);
      msg.push(presentableEvents(world.sim, events));
      if (!cutscene.holding) overworld.syncAppearance();
      refreshHud();
    },
    ...menuSfx,
    speak: (text) => narrator.say(text),
  });

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
      // A fresh sim may already carry the start map's enter-trigger output
      // (cues + events) — beginPlay plays and shows them.
      beginPlay([game.meta.goal], true);
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
      speak: (text: string) => narrator.say(text),
    ...(languages.length > 0
      ? {
          languages: {
            options: () => [
              { code: null, name: "Full" },
              ...languages.map((code) => ({ code, name: languageNames.get(code) ?? code })),
            ],
            active: () => language,
            choose: (code: string | null) => {
              const url = new URL(window.location.href);
              if (code) url.searchParams.set("lang", code);
              else url.searchParams.delete("lang");
              window.location.href = url.toString();
            },
          },
        }
      : {}),
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
    ...(narrator.available
      ? {
          narration: {
            enabled: () => narrator.enabled,
            rateName: () => narrator.rateName,
            toggle: () => {
              narrator.toggle();
              narrator.unlock();
              renderNarrate();
            },
            hint: () => narrator.voiceHint(),
            voice: () =>
              narrator.localVoice
                ? { name: narrator.localVoice, count: narrator.localVoices.length }
                : null,
            cycleVoice: () => {
              const name = narrator.cycleLocalVoice();
              if (name) narrator.say(`This is ${name.replace(/^[a-z]{2}_[A-Z]{2}-/, "").replace(/-/g, " ")}.`);
              renderNarrate();
            },
            cycleRate: () => {
              narrator.cycleRate();
              narrator.say(`Reading speed: ${narrator.rateName}`);
              renderNarrate();
            },
          },
        }
      : {}),
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

  /** Enter gameplay with whatever sim `world.sim` now holds. `freshStart`
   *  marks a brand-new sim: its start-map enter-trigger cues play and its
   *  initial events show (saves would replay stale ones, so loads skip). */
  function beginPlay(intro: string[], freshStart = false): void {
    titleScreen.hide();
    pause.hide();
    msg.clear();
    msg.setIdleHide(true);
    passagePane.clear();
    cutscene.cancel();
    endingScreen.hide();
    battle.leave();
    endingHandled = world.sim.state.ending !== null;
    musicOverride = null;
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
    if (freshStart) cutscene.collect(world.sim); // before any push: chatter gates
    msg.push(intro);
    if (freshStart) {
      msg.push(presentableEvents(world.sim, [...world.sim.state.lastEvents]));
    }
  }

  function returnToTitle(): void {
    // Suspend-style save, mid-battle included — EXCEPT after a non-victory
    // ending: the auto slot keeps its pre-ending save so Continue resumes
    // before the end, not inside it.
    const ending = world.sim.state.ending;
    if (mode !== "title" && !(ending && ending.id !== "victory")) autosave();
    mode = "title";
    narrator.stop();
    pause.hide();
    msg.clear();
    passagePane.clear();
    cutscene.cancel();
    endingScreen.hide();
    battle.leave();
    battleEl.classList.add("hidden");
    stage.classList.remove("battle-mode");
    overworld.releaseKeys();
    musicOverride = null;
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
    if (ev.key === "h" || ev.key === "H") {
      ev.preventDefault();
      sayObjective();
      return;
    }
    if (ev.key === "v" || ev.key === "V") {
      ev.preventDefault();
      if (!narrator.available) return;
      if (ev.shiftKey) {
        narrator.cycleRate();
        narrator.say(`Reading speed: ${narrator.rateName}`);
      } else if (narrator.toggle()) {
        const hint = narrator.voiceHint();
        if (hint) msg.push([hint]);
        else narrator.say("Reading aloud.");
      }
      renderNarrate();
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
    if (cutscene.holding) {
      // A cutscene owns the stage: advance keys skip the current cue,
      // everything else waits for the sequence to finish.
      if (cutscene.handleKey(ev)) ev.preventDefault();
      return;
    }
    if (pause.visible) {
      if (pause.handleKey(ev)) ev.preventDefault();
      return;
    }
    if (endingScreen.visible) {
      if (endingScreen.handleKey(ev)) ev.preventDefault();
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
    if (choiceMenu.active) {
      // A pending choice owns the overworld: menu keys only until it's
      // answered — movement, interact, and pause all wait. (M was handled
      // above; the forge's F9 listener is its own.)
      if (choiceMenu.handleKey(ev)) ev.preventDefault();
      return;
    }
    if (ev.key === "p" || ev.key === "P" || ev.key === "Escape") {
      ev.preventDefault();
      overworld.releaseKeys();
      audio.sfx("blip");
      pause.show();
      return;
    }
    if (world.sim.state.ending) {
      // The game has ended: only let remaining chatter be advanced while
      // the ending screen waits its turn.
      if (ev.key === "e" || ev.key === "E" || ev.key === " " || ev.key === "Enter") {
        ev.preventDefault();
        msg.advance();
      }
      return;
    }
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
    if (world.sim.state.ending) return; // the ending moment owns audio
    if (world.sim.state.battle || mode === "battle") {
      audio.setMusic(audio.battleTrack);
      return;
    }
    // A play_music cue override holds until the player leaves that map.
    if (musicOverride && musicOverride.map !== world.sim.state.map) musicOverride = null;
    audio.setMusic(musicOverride?.track ?? audio.trackForMap(world.sim.state.map));
  }

  /** One-time ending effects + screen, once the stage has quieted. */
  function presentEnding(ending: { id: string; text: string }): void {
    if (!endingHandled) {
      endingHandled = true;
      audio.setMusic(null);
      if (ending.id === "victory") {
        audio.sting("victory");
        // Non-victory endings deliberately do NOT autosave: the auto slot
        // keeps its pre-ending save, so Continue resumes before the end.
        autosave();
      }
    }
    endingScreen.show(ending);
  }

  const loop = () => {
    // Gamepads emit no events — poll once a frame. Presses become the same
    // synthetic KeyboardEvents the on-screen buttons send, so every input
    // device goes through one routing cascade.
    controls.tick();
    if (
      pendingObjectiveSpeech !== null &&
      !cutscene.holding &&
      !passagePane.open &&
      !msg.busy() &&
      !choiceMenu.active
    ) {
      const text = pendingObjectiveSpeech;
      pendingObjectiveSpeech = null;
      narrator.say(text);
    }
    // Cutscenes gate everything: passages, chatter, choices, movement, and
    // the ending screen all queue behind playback.
    if (mode !== "title" && !cutscene.holding) pumpPassages();
    cutscene.tick(
      mode === "overworld" && !transitioning && !passagePane.open && !pause.visible,
    );
    // The choice menu opens only once the stage is quiet: overworld, no
    // fade, no cutscene, no passage on top, no pause, chatter drained (same
    // sequencing the battle menu uses). Any other frame state hides it.
    choiceMenu.tick(
      mode === "overworld" &&
        !transitioning &&
        !cutscene.holding &&
        !passagePane.open &&
        !pause.visible &&
        !world.sim.state.ending &&
        !msg.busy(),
    );
    if (mode !== "title" && !transitioning && !passagePane.open && !cutscene.holding) {
      if (mode === "overworld") {
        const ending = world.sim.state.ending;
        if (!ending) {
          // A pending choice blocks walking (the engine would reject each
          // step anyway — this keeps the rejections out of the chatter).
          if (!pause.visible && !choiceMenu.active) overworld.tick();
        } else if (!msg.busy()) {
          presentEnding(ending);
        }
      } else if (battle.tick()) {
        void exitBattle();
      }
    }
    updateMusic();
    requestAnimationFrame(loop);
  };

  // Debug/test handles (used by the CDP walkthrough; harmless in play).
  (window as unknown as { __world: WorldHolder }).__world = world;
  (window as unknown as { __ui: unknown }).__ui = {
    get mode() {
      return mode;
    },
    get cutsceneHolding() {
      return cutscene.holding;
    },
    get endingVisible() {
      return endingScreen.visible;
    },
    get msgBusy() {
      return msg.busy();
    },
  };

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
        cutscene.cancel();
        endingScreen.hide(); // the loop re-shows it if the game is still ended
        endingHandled = world.sim.state.ending !== null; // don't re-sting/save
        musicOverride = null;
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
