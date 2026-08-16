/**
 * Title screen: game name in ember-glow lettering, subtitle from meta.goal,
 * and a small menu — New Game / Continue / Choose Game. Keyboard (arrows +
 * Enter) and click both work. "Choose Game" flips to a list of every game
 * discovered in games/*, the seed of the built-games gallery.
 */
import type { GameListing } from "../games";

interface TitleItem {
  label: string;
  detail?: string;
  enabled: boolean;
  reason?: string;
  action: () => void;
}

export interface TitleHooks {
  onNewGame(): void;
  onContinue(): void;
  /** Navigate to another game (usually a page reload with ?game=id). */
  onChooseGame(id: string): void;
  /** Lazy game listing for the chooser view. */
  listGames(): Promise<GameListing[]>;
  /** Any interaction sound. */
  blip(): void;
  confirm(): void;
}

export class TitleScreen {
  private root: HTMLElement;
  private hooks: TitleHooks;
  private gameTitle = "";
  private subtitle = "";
  private currentGameId = "";
  private canContinue = false;
  private view: "main" | "games" = "main";
  private items: TitleItem[] = [];
  private index = 0;
  private listings: GameListing[] | null = null;

  constructor(root: HTMLElement, hooks: TitleHooks) {
    this.root = root;
    this.hooks = hooks;
  }

  show(gameTitle: string, subtitle: string, gameId: string, canContinue: boolean): void {
    this.gameTitle = gameTitle;
    this.subtitle = subtitle;
    this.currentGameId = gameId;
    this.canContinue = canContinue;
    this.view = "main";
    this.index = 0;
    this.root.classList.remove("hidden");
    this.render();
  }

  hide(): void {
    this.root.classList.add("hidden");
  }

  get visible(): boolean {
    return !this.root.classList.contains("hidden");
  }

  /** Title-mode keys. Returns true when consumed. */
  handleKey(ev: KeyboardEvent): boolean {
    if (!this.visible) return false;
    switch (ev.key) {
      case "ArrowUp":
      case "ArrowLeft":
        this.move(-1);
        return true;
      case "ArrowDown":
      case "ArrowRight":
        this.move(1);
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
        if (this.view === "games") {
          this.view = "main";
          this.index = 0;
          this.hooks.blip();
          this.render();
        }
        return true;
    }
    return false;
  }

  private move(delta: number): void {
    if (this.items.length === 0) return;
    this.index = (this.index + delta + this.items.length) % this.items.length;
    this.hooks.blip();
    this.render();
  }

  private select(): void {
    const item = this.items[this.index];
    if (!item) return;
    if (!item.enabled) {
      this.hooks.blip();
      this.setHint(item.reason ?? "");
      return;
    }
    this.hooks.confirm();
    item.action();
  }

  private mainItems(): TitleItem[] {
    return [
      { label: "New Game", enabled: true, action: () => this.hooks.onNewGame() },
      {
        label: "Continue",
        enabled: this.canContinue,
        reason: "No saves yet — the road is still unwalked.",
        action: () => this.hooks.onContinue(),
      },
      {
        label: "Choose Game",
        enabled: true,
        action: () => {
          this.view = "games";
          this.index = 0;
          this.render();
          void this.loadListings();
        },
      },
    ];
  }

  private gamesItems(): TitleItem[] {
    if (!this.listings) return [{ label: "Reading the shelf…", enabled: false, action: () => {} }];
    const items: TitleItem[] = this.listings.map((g) => ({
      label: g.title,
      detail: g.id === this.currentGameId ? `${g.id} · current` : g.id,
      enabled: g.loads,
      reason: "That game's file won't open right now.",
      action: () => {
        if (g.id === this.currentGameId) {
          this.view = "main";
          this.index = 0;
          this.render();
        } else {
          this.hooks.onChooseGame(g.id);
        }
      },
    }));
    items.push({
      label: "Back",
      enabled: true,
      action: () => {
        this.view = "main";
        this.index = 0;
        this.render();
      },
    });
    return items;
  }

  private async loadListings(): Promise<void> {
    if (this.listings) return;
    this.listings = await this.hooks.listGames();
    if (this.visible && this.view === "games") this.render();
  }

  /** Dev-only forge hook: drop cached listings so the shelf re-reads. */
  refreshGames(): void {
    this.listings = null;
    if (this.visible && this.view === "games") {
      this.render();
      void this.loadListings();
    }
  }

  /** Show a gentle one-line notice under the menu (e.g. a bad save). */
  hint(text: string): void {
    this.setHint(text);
  }

  private setHint(text: string): void {
    const el = this.root.querySelector(".title-hint");
    if (el) el.textContent = text || "Arrows · Enter";
  }

  private render(): void {
    this.items = this.view === "main" ? this.mainItems() : this.gamesItems();
    if (this.index >= this.items.length) this.index = 0;
    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const list = this.items
      .map((item, i) => {
        const cls = [i === this.index ? "sel" : "", item.enabled ? "" : "disabled"]
          .filter(Boolean)
          .join(" ");
        const detail = item.detail ? `<span class="title-item-detail">${esc(item.detail)}</span>` : "";
        return `<li class="${cls}" data-i="${i}"><span>${esc(item.label)}</span>${detail}</li>`;
      })
      .join("");
    const heading =
      this.view === "games"
        ? `<div class="title-section">Games on the shelf</div>`
        : "";
    this.root.innerHTML = `
      <div class="title-inner">
        <div class="title-flame">🔥</div>
        <h1 class="title-name">${esc(this.gameTitle)}</h1>
        <p class="title-sub">${esc(this.subtitle)}</p>
        ${heading}
        <ul class="title-menu">${list}</ul>
        <p class="title-hint">${this.view === "games" ? "Arrows · Enter · Esc back" : "Arrows · Enter"}</p>
      </div>`;
    this.root.querySelectorAll<HTMLElement>(".title-menu li").forEach((li) => {
      const i = Number(li.dataset.i);
      li.addEventListener("mouseenter", () => {
        if (this.index !== i) {
          this.index = i;
          this.render();
        }
      });
      li.addEventListener("click", () => {
        this.index = i;
        this.select();
      });
    });
  }
}
