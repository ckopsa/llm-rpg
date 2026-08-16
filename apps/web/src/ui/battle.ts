/**
 * Battle screen: DOM panels + battler canvases over the stage, menu-driven
 * actions mirroring the engine's battle actions, events fed through the
 * shared message box one beat at a time.
 *
 * The BattleState reference captured at enter() stays valid after the Sim
 * settles the battle (the object is aliased, not rebuilt), so the final
 * HP bars and outcome can play out while the overworld already moved on.
 */
import {
  itemById,
  moveById,
  parseAction,
  speciesById,
  xpForLevel,
} from "@llm-rpg/engine";
import type { BattleState, Catalog, Combatant } from "@llm-rpg/engine";
import type { LoadedManifest } from "../render/manifest";
import { drawSpriteFrame } from "../render/renderer";
import type { SpriteMap } from "../render/spriteMap";
import { hpClass } from "./hud";
import type { MessageBox } from "./messages";
import type { WorldHolder } from "./overworld";

type MenuKind = "root" | "moves" | "items" | "party";

/** Optional UI sounds; the view works fine without them. */
export interface MenuSfx {
  blip(): void;
  confirm(): void;
}

interface MenuOption {
  label: string;
  detail: string;
  enabled: boolean;
  reason: string;
  word?: string;
  submenu?: MenuKind;
}

const ADVANCE_KEYS = new Set(["Enter", " ", "e", "E", "z", "Z"]);

export class BattleView {
  private root: HTMLElement;
  private world: WorldHolder;
  private loaded: LoadedManifest;
  private spriteMap: SpriteMap;
  private msg: MessageBox;

  private bs: BattleState | null = null;
  private sfx: MenuSfx | null = null;
  private menuKind: MenuKind = "root";
  private menuIndex = 0;
  private forcedSwitch = false;
  ended = false;

  // DOM
  private enemyName!: HTMLElement;
  private enemyLv!: HTMLElement;
  private enemyHp!: HTMLElement;
  private enemyBox!: HTMLElement;
  private enemyCanvas!: HTMLCanvasElement;
  private enemyGlyph!: HTMLElement;
  private allyName!: HTMLElement;
  private allyLv!: HTMLElement;
  private allyHp!: HTMLElement;
  private allyHpNum!: HTMLElement;
  private allyXp!: HTMLElement;
  private allyBox!: HTMLElement;
  private allyCanvas!: HTMLCanvasElement;
  private allyGlyph!: HTMLElement;
  private menuEl!: HTMLElement;
  private menuTitle!: HTMLElement;
  private menuList!: HTMLElement;
  private menuHint!: HTMLElement;

  private lastEnemySpecies = "";
  private lastAllySpecies = "";

  constructor(
    root: HTMLElement,
    world: WorldHolder,
    loaded: LoadedManifest,
    spriteMap: SpriteMap,
    msg: MessageBox,
    sfx: MenuSfx | null = null,
  ) {
    this.root = root;
    this.world = world;
    this.loaded = loaded;
    this.spriteMap = spriteMap;
    this.msg = msg;
    this.sfx = sfx;
    this.buildDom();
  }

  /** Outcome of the battle being shown, or null (used for the victory sting
   *  after the sim has already settled the battle away). */
  outcome(): BattleState["outcome"] | null {
    return this.bs?.outcome ?? null;
  }

  /** The catalog, asserted present: catalog-free games never enter battle
   *  paths (guarded by hasBattleContent), so inside a battle it exists. */
  private get catalog(): Catalog {
    return this.world.sim.game.catalog!;
  }

  private buildDom(): void {
    this.root.innerHTML = `
      <div class="combatant enemy">
        <div class="panel enemy-panel">
          <div class="panel-line"><span class="c-name"></span><span class="c-lv"></span></div>
          <div class="hpbar"><div class="hpfill high"></div></div>
        </div>
        <div class="battler-box enemy-box">
          <canvas class="c-canvas"></canvas>
          <div class="c-glyph hidden"></div>
          <div class="platform"></div>
        </div>
      </div>
      <div class="combatant ally">
        <div class="battler-box ally-box">
          <canvas class="c-canvas"></canvas>
          <div class="c-glyph hidden"></div>
          <div class="platform"></div>
        </div>
        <div class="panel ally-panel">
          <div class="panel-line"><span class="c-name"></span><span class="c-lv"></span></div>
          <div class="hpbar"><div class="hpfill high"></div></div>
          <div class="panel-foot"><span class="hp-num"></span><span class="xp-label">XP</span></div>
          <div class="xpbar"><div class="xpfill"></div></div>
        </div>
      </div>
      <div class="battle-menu hidden">
        <div class="menu-title"></div>
        <ul class="menu-list"></ul>
        <div class="menu-hint"></div>
      </div>`;
    const q = (sel: string) => this.root.querySelector(sel) as HTMLElement;
    const enemy = q(".combatant.enemy");
    this.enemyName = enemy.querySelector(".c-name")!;
    this.enemyLv = enemy.querySelector(".c-lv")!;
    this.enemyHp = enemy.querySelector(".hpfill")!;
    this.enemyBox = enemy.querySelector(".battler-box")!;
    this.enemyCanvas = enemy.querySelector(".c-canvas")!;
    this.enemyGlyph = enemy.querySelector(".c-glyph")!;
    const ally = q(".combatant.ally");
    this.allyName = ally.querySelector(".c-name")!;
    this.allyLv = ally.querySelector(".c-lv")!;
    this.allyHp = ally.querySelector(".hpfill")!;
    this.allyHpNum = ally.querySelector(".hp-num")!;
    this.allyXp = ally.querySelector(".xpfill")!;
    this.allyBox = ally.querySelector(".battler-box")!;
    this.allyCanvas = ally.querySelector(".c-canvas")!;
    this.allyGlyph = ally.querySelector(".c-glyph")!;
    this.menuEl = q(".battle-menu");
    this.menuTitle = q(".menu-title");
    this.menuList = q(".menu-list");
    this.menuHint = q(".menu-hint");
  }

  /** Begin showing the battle currently active on the sim. */
  enter(): void {
    const battle = this.world.sim.battle;
    if (!battle) return;
    this.bs = battle.state;
    this.ended = false;
    this.menuKind = "root";
    this.menuIndex = 0;
    this.forcedSwitch = false;
    this.lastEnemySpecies = "";
    this.lastAllySpecies = "";
    this.msg.setIdleHide(false);
    this.menuEl.classList.add("hidden");
    this.refresh();
  }

  leave(): void {
    this.bs = null;
    this.msg.setIdleHide(true);
  }

  /** Dev-only forge hook: swap the sprite mapping and repaint battlers. */
  setSpriteMap(map: SpriteMap): void {
    this.spriteMap = map;
    this.lastEnemySpecies = "";
    this.lastAllySpecies = "";
    if (this.bs) this.refresh();
  }

  /**
   * Per-frame: reveal the menu once messages drain; report whether the
   * battle is fully over (outcome reached and every message played).
   */
  tick(): boolean {
    if (!this.bs) return true;
    const busy = this.msg.busy();
    if (!busy && !this.ended) {
      if (this.bs.needsSwitch && !this.forcedSwitch) {
        this.forcedSwitch = true;
        this.menuKind = "party";
        this.menuIndex = this.firstAliveBenched();
      }
      this.showMenu();
    } else {
      this.menuEl.classList.add("hidden");
    }
    return this.ended && !busy;
  }

  /** All battle-mode keys route here. Returns true when consumed. */
  handleKey(ev: KeyboardEvent): boolean {
    if (!this.bs) return false;
    if (this.msg.busy() || this.ended) {
      if (ADVANCE_KEYS.has(ev.key)) this.msg.advance();
      return true;
    }
    const word = this.directWord(ev);
    if (word) {
      this.act(word);
      return true;
    }
    switch (ev.key) {
      case "ArrowUp":
      case "ArrowLeft":
        this.moveSelection(-1);
        return true;
      case "ArrowDown":
      case "ArrowRight":
        this.moveSelection(1);
        return true;
      case "Enter":
      case " ":
      case "e":
      case "E":
      case "z":
      case "Z":
        this.select();
        return true;
      case "Escape":
      case "Backspace":
        if (this.menuKind !== "root" && !this.bs.needsSwitch) {
          this.menuKind = "root";
          this.menuIndex = 0;
          this.showMenu();
        }
        return true;
    }
    return false;
  }

  /** Legacy direct keys: 1-4 moves, 5-9 items, Shift+1-6 switch, C catch, X run. */
  private directWord(ev: KeyboardEvent): string | undefined {
    const m = /^Digit([1-9])$/.exec(ev.code);
    if (m) {
      const n = Number(m[1]);
      if (ev.shiftKey) return n <= 6 ? `switch${n}` : undefined;
      // Inside the item submenu digits pick items; elsewhere the global
      // scheme applies (1-4 moves, 5-9 first five item slots).
      if (this.menuKind === "items") return `item${n}`;
      if (n <= 4) return `move${n}`;
      return `item${n - 4}`;
    }
    if (ev.key === "c" || ev.key === "C") return "catch";
    if (ev.key === "x" || ev.key === "X") return "run";
    return undefined;
  }

  private act(word: string): void {
    const action = parseAction(word);
    if (!action) return;
    const events = this.world.sim.act(action);
    this.msg.push(events);
    this.refresh();
    if (this.bs && this.bs.outcome !== "ongoing") {
      this.ended = true;
    } else if (this.bs && !this.bs.needsSwitch) {
      this.menuKind = "root";
      this.menuIndex = 0;
      this.forcedSwitch = false;
    }
    this.menuEl.classList.add("hidden");
  }

  private firstAliveBenched(): number {
    const s = this.bs!;
    const i = s.player.party.findIndex((c, idx) => c.hp > 0 && idx !== s.player.active);
    return Math.max(0, i);
  }

  private moveSelection(delta: number): void {
    const options = this.options();
    if (options.length === 0) return;
    this.menuIndex = (this.menuIndex + delta + options.length) % options.length;
    this.sfx?.blip();
    this.showMenu();
  }

  private select(): void {
    const options = this.options();
    const opt = options[this.menuIndex];
    if (!opt) return;
    if (!opt.enabled) {
      this.sfx?.blip();
      this.menuHint.textContent = opt.reason;
      return;
    }
    this.sfx?.confirm();
    if (opt.submenu) {
      this.menuKind = opt.submenu;
      this.menuIndex = 0;
      this.showMenu();
      return;
    }
    if (opt.word) this.act(opt.word);
  }

  private hasCaptureItem(): boolean {
    const sim = this.world.sim;
    return sim.state.inventory.some(
      (e) => itemById(this.catalog, e.itemId).kind === "capture",
    );
  }

  private options(): MenuOption[] {
    const s = this.bs!;
    const sim = this.world.sim;
    const catalog = this.catalog;
    const me = s.player.party[s.player.active];

    if (this.menuKind === "moves") {
      const allOut = me.moves.every((m) => m.pp <= 0);
      return me.moves.map((slot, i) => {
        const move = moveById(catalog, slot.moveId);
        return {
          label: move.name,
          detail: `${move.type} · PP ${slot.pp}/${move.pp}`,
          enabled: allOut || slot.pp > 0,
          reason: "No PP left for that move.",
          word: `move${i + 1}`,
        };
      });
    }
    if (this.menuKind === "items") {
      return sim.state.inventory.slice(0, 9).map((entry, i) => {
        const item = itemById(catalog, entry.itemId);
        const detail =
          item.kind === "heal" ? `heals ${item.amount} HP` : `capture ×${item.ballMod}`;
        const capturing = item.kind === "capture";
        return {
          label: `${item.name} ×${entry.qty}`,
          detail,
          enabled: !(capturing && s.mode === "trainer"),
          reason: "You can't catch another keeper's kindred.",
          word: `item${i + 1}`,
        };
      });
    }
    if (this.menuKind === "party") {
      return s.player.party.map((c, i) => {
        const species = speciesById(catalog, c.speciesId);
        const fainted = c.hp <= 0;
        const active = i === s.player.active;
        return {
          label: species.name,
          detail: `Lv ${c.level} · ${c.hp}/${c.maxHp} HP${active ? " · out" : ""}`,
          enabled: !fainted && !active,
          reason: fainted ? "Too weary to battle." : "Already out.",
          word: `switch${i + 1}`,
        };
      });
    }
    // root
    const wild = s.mode === "wild";
    const hasItems = sim.state.inventory.length > 0;
    return [
      { label: "Fight", detail: "", enabled: true, reason: "", submenu: "moves" },
      {
        label: "Bag",
        detail: "",
        enabled: hasItems,
        reason: "Your bag is empty.",
        submenu: "items",
      },
      {
        label: "Kindred",
        detail: "",
        enabled: s.player.party.length > 1,
        reason: "No other kindred with you.",
        submenu: "party",
      },
      {
        label: "Catch",
        detail: "",
        enabled: wild && this.hasCaptureItem(),
        reason: wild ? "You need a snare to catch." : "Not in a keeper's battle.",
        word: "catch",
      },
      {
        label: "Run",
        detail: "",
        enabled: wild,
        reason: "You can't run from a keeper's battle.",
        word: "run",
      },
    ];
  }

  private menuTitleText(): string {
    const s = this.bs!;
    const catalog = this.catalog;
    const me = s.player.party[s.player.active];
    const name = speciesById(catalog, me.speciesId).name;
    switch (this.menuKind) {
      case "moves":
        return `${name}'s moves`;
      case "items":
        return "Bag";
      case "party":
        return s.needsSwitch ? "Choose your next kindred" : "Kindred";
      default:
        return `What will ${name} do?`;
    }
  }

  private showMenu(): void {
    const options = this.options();
    if (this.menuIndex >= options.length) this.menuIndex = 0;
    this.menuTitle.textContent = this.menuTitleText();
    this.menuList.innerHTML = options
      .map((o, i) => {
        const cls = [
          i === this.menuIndex ? "sel" : "",
          o.enabled ? "" : "disabled",
        ]
          .filter(Boolean)
          .join(" ");
        const detail = o.detail ? `<span class="opt-detail">${o.detail}</span>` : "";
        return `<li class="${cls}"><span class="opt-label">${o.label}</span>${detail}</li>`;
      })
      .join("");
    const sel = options[this.menuIndex];
    this.menuHint.textContent =
      sel && !sel.enabled
        ? sel.reason
        : this.menuKind === "root"
          ? "Arrows · Enter"
          : "Arrows · Enter · Esc back";
    this.menuEl.classList.remove("hidden");
  }

  /** Sync panels + battler sprites from the (aliased) battle state. */
  refresh(): void {
    const s = this.bs;
    if (!s) return;
    const catalog = this.catalog;
    const enemy = s.enemy.party[s.enemy.active];
    const ally = s.player.party[s.player.active];

    const enemySpecies = speciesById(catalog, enemy.speciesId);
    this.enemyName.textContent = enemySpecies.name;
    this.enemyLv.textContent = `Lv ${enemy.level}`;
    this.setHp(this.enemyHp, enemy);
    if (enemy.speciesId !== this.lastEnemySpecies) {
      this.lastEnemySpecies = enemy.speciesId;
      this.drawBattler(this.enemyCanvas, this.enemyGlyph, enemy.speciesId, 150, false);
      this.enemyBox.classList.remove("gone");
    }
    this.enemyBox.classList.toggle("gone", enemy.hp <= 0);

    const allySpecies = speciesById(catalog, ally.speciesId);
    this.allyName.textContent = allySpecies.name;
    this.allyLv.textContent = `Lv ${ally.level}`;
    this.setHp(this.allyHp, ally);
    this.allyHpNum.textContent = `${ally.hp}/${ally.maxHp} HP`;
    this.allyXp.style.width = `${this.xpPct(ally)}%`;
    if (ally.speciesId !== this.lastAllySpecies) {
      this.lastAllySpecies = ally.speciesId;
      this.drawBattler(this.allyCanvas, this.allyGlyph, ally.speciesId, 180, true);
      this.allyBox.classList.remove("gone");
    }
    this.allyBox.classList.toggle("gone", ally.hp <= 0);
  }

  private setHp(fill: HTMLElement, c: Combatant): void {
    const pct = c.maxHp > 0 ? Math.max(0, Math.min(100, (100 * c.hp) / c.maxHp)) : 0;
    fill.style.width = `${pct}%`;
    fill.className = `hpfill ${hpClass(c.hp, c.maxHp)}`;
  }

  private xpPct(c: Combatant): number {
    const cur = xpForLevel(c.level);
    const next = xpForLevel(c.level + 1);
    const span = next - cur;
    if (span <= 0) return 0;
    return Math.max(0, Math.min(100, (100 * (c.xp - cur)) / span));
  }

  private drawBattler(
    canvas: HTMLCanvasElement,
    glyphEl: HTMLElement,
    speciesId: string,
    targetPx: number,
    flip: boolean,
  ): void {
    const spriteId = this.spriteMap.speciesSprite(speciesId);
    const sprite = spriteId ? this.loaded.manifest.sprites[spriteId] : undefined;
    if (!spriteId || !sprite) {
      // Unmapped species: big emoji glyph instead of a battler sprite.
      const species = speciesById(this.catalog, speciesId);
      canvas.classList.add("hidden");
      glyphEl.classList.remove("hidden");
      glyphEl.textContent = species.glyph;
      return;
    }
    canvas.classList.remove("hidden");
    glyphEl.classList.add("hidden");
    const sheet = this.loaded.sheets.get(sprite.sheet)!;
    const scale = Math.max(2, Math.round(targetPx / sheet.def.tileH));
    canvas.width = sheet.def.tileW * scale;
    canvas.height = sheet.def.tileH * scale;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (flip) {
      ctx.save();
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    drawSpriteFrame(ctx, this.loaded, spriteId, "idle", 0, 0, 0, scale);
    if (flip) ctx.restore();
  }
}
