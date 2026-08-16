/**
 * Ending screen: shown once cues, chatter, and passages drain after
 * `sim.state.ending` becomes non-null. Replaces the old hardcoded win
 * banner — every ending (victory included) routes through here.
 *
 * Styling is data-driven off the ending id: "victory" gets the warm gold
 * treatment, every other id the cool muted one — no per-game id lists.
 * The ending's own text carries the weight; a "Return to title" prompt
 * closes the moment.
 */
import { prettyMapName } from "./hud";

export interface Ending {
  id: string;
  text: string;
}

export interface EndingHooks {
  onTitle(): void;
  confirm?(): void;
}

const CLOSE_KEYS = new Set(["Enter", " ", "e", "E", "z", "Z", "r", "R"]);

export class EndingScreen {
  private root: HTMLElement;
  private hooks: EndingHooks;

  constructor(root: HTMLElement, hooks: EndingHooks) {
    this.root = root;
    this.hooks = hooks;
  }

  get visible(): boolean {
    return !this.root.classList.contains("hidden");
  }

  show(ending: Ending): void {
    if (this.visible) return;
    const warm = ending.id === "victory";
    this.root.classList.toggle("warm", warm);
    this.root.classList.toggle("cool", !warm);
    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    // "bitter-peace" -> "Bitter Peace"; victory keeps its own word.
    const kicker = warm ? "Victory" : prettyMapName(ending.id);
    this.root.innerHTML = `
      <div class="ending-inner">
        <div class="ending-kicker">${esc(kicker)}</div>
        <div class="ending-text">${esc(ending.text)}</div>
        <div class="ending-hint">Press Enter — return to the title</div>
      </div>`;
    this.root.querySelector(".ending-inner")!.addEventListener("click", () => this.close());
    this.root.classList.remove("hidden");
  }

  hide(): void {
    this.root.classList.add("hidden");
  }

  /** All keys route here while visible. Close keys return to the title;
   *  everything else is swallowed (the game has ended). */
  handleKey(ev: KeyboardEvent): boolean {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return false;
    if (CLOSE_KEYS.has(ev.key)) {
      this.close();
      return true;
    }
    return ev.key.length === 1 || ev.key.startsWith("Arrow") || ev.key === "Escape";
  }

  private close(): void {
    this.hooks.confirm?.();
    this.hide();
    this.hooks.onTitle();
  }
}
