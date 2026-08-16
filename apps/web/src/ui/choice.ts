/**
 * Choice menu: the engine's `choice` dialogue rendered as a small vertical
 * menu anchored above the message box — dark panel, gold accent, selection
 * caret, matching the pause/title menus' visual language.
 *
 * The engine is the authority: while `sim.state.pendingChoice` is non-null
 * the sim accepts only `choose1..chooseN`, so this menu simply presents the
 * pending options and dispatches the matching action word through the same
 * path as every other input. main.ts's rAF loop calls `tick()` each frame:
 * the menu opens once the chatter box drains (and any passage pane closes),
 * closes on confirm, and re-opens by itself when the chosen option leads to
 * a nested follow-up choice.
 *
 * Read-aloud: the menu is spoken as a numbered list when it opens, and moving
 * the caret reads the highlighted option — which is what makes a choice
 * answerable by someone who is listening rather than reading. Number keys
 * still pick directly, so "press two" is a complete instruction.
 *
 * There is no cancel — the engine has no "unchoose" — so Escape just shakes
 * the panel with a blip. Number keys 1-9 pick directly; arrows/W-S move and
 * Enter/Space/E confirm. Everything is feature-detected against the live
 * pendingChoice shape and fails open: a drifted engine shape means no menu
 * (and no blocked input), never a crash.
 */
import type { MessageBox } from "./messages";
import type { WorldHolder } from "./overworld";

export interface ChoiceHooks {
  /** Dispatch a `chooseN` action word through the shared action path. */
  choose(word: string): void;
  blip(): void;
  confirm(): void;
  /** Optional read-aloud. Called with the prompt and options when the menu
   *  opens, and with a single option as the caret moves. */
  speak?(text: string): void;
}

/** The slice of `pendingChoice` this menu renders. */
interface PendingLike {
  prompt: string;
  options: { label: string }[];
}

const ADVANCE_KEYS = new Set(["Enter", " ", "e", "E", "z", "Z"]);

/** The live pending choice when it is menu-shaped, else null (fail-open). */
function pendingOf(world: WorldHolder): PendingLike | null {
  const pc = (world.sim.state as { pendingChoice?: unknown }).pendingChoice;
  if (typeof pc !== "object" || pc === null) return null;
  const { prompt, options } = pc as { prompt?: unknown; options?: unknown };
  if (typeof prompt !== "string" || !Array.isArray(options) || options.length === 0) {
    return null;
  }
  const labelled = options.every(
    (o) => typeof (o as { label?: unknown } | null)?.label === "string",
  );
  return labelled ? { prompt, options: options as { label: string }[] } : null;
}

export class ChoiceMenu {
  private root: HTMLElement;
  private world: WorldHolder;
  private msg: MessageBox;
  private hooks: ChoiceHooks;

  private panel: HTMLElement;
  private promptEl: HTMLElement;
  private listEl: HTMLElement;

  private index = 0;
  private isOpen = false;
  /** Identity of the pendingChoice object last rendered — a new object
   *  (nested/follow-up choice) rebuilds the list and resets the caret. */
  private lastPending: unknown = null;

  constructor(root: HTMLElement, world: WorldHolder, msg: MessageBox, hooks: ChoiceHooks) {
    this.root = root;
    this.world = world;
    this.msg = msg;
    this.hooks = hooks;
    root.innerHTML = `
      <div class="choice-panel">
        <div class="choice-prompt"></div>
        <ul class="choice-list"></ul>
        <div class="choice-hint">Arrows · Enter · 1-9</div>
      </div>`;
    this.panel = root.querySelector(".choice-panel")!;
    this.promptEl = root.querySelector(".choice-prompt")!;
    this.listEl = root.querySelector(".choice-list")!;
  }

  /** True while the sim is locked to a choice (menu shown or about to be).
   *  main.ts blocks movement/interact/pause on this, not on visibility, so
   *  the lock holds even while preceding chatter is still draining. */
  get active(): boolean {
    return pendingOf(this.world) !== null;
  }

  /** True while the menu is actually on screen. */
  get open(): boolean {
    return this.isOpen;
  }

  /**
   * Per-frame sync from the rAF loop. `canShow` is the caller's gating —
   * overworld mode, no transition, no passage pane, no pause, chatter
   * drained — so the menu sequences after whatever the choice's own say
   * lines put in the message box, exactly like the battle menu does.
   */
  tick(canShow: boolean): void {
    const pending = pendingOf(this.world);
    if (!pending || !canShow) {
      this.hide();
      return;
    }
    const raw = (this.world.sim.state as { pendingChoice?: unknown }).pendingChoice;
    if (!this.isOpen || raw !== this.lastPending) {
      this.lastPending = raw;
      this.index = 0;
      this.isOpen = true;
      this.render(pending);
      this.root.classList.remove("hidden");
      this.hooks.speak?.(
        [
          pending.prompt,
          ...pending.options.map((o, i) => `${i + 1}. ${o.label}`),
        ].join(". "),
      );
    }
  }

  hide(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.lastPending = null;
    this.root.classList.add("hidden");
  }

  /**
   * All overworld keys route here while a choice is pending (the caller
   * returns regardless, so game input stays blocked). Returns true when the
   * default should be prevented; modified combos and function keys stay
   * with the browser.
   */
  handleKey(ev: KeyboardEvent): boolean {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return false;
    if (!this.isOpen) {
      // Chatter before the menu is still playing: advance keys speed it
      // along; everything else waits for the menu.
      if (ADVANCE_KEYS.has(ev.key)) {
        this.msg.advance();
        return true;
      }
      return ev.key.length === 1 || ev.key.startsWith("Arrow");
    }
    const pending = pendingOf(this.world);
    if (!pending) return false;
    const digit = /^Digit([1-9])$/.exec(ev.code);
    if (digit) {
      const n = Number(digit[1]);
      if (n <= pending.options.length) this.confirm(n - 1);
      else this.refuse();
      return true;
    }
    switch (ev.key) {
      case "ArrowUp":
      case "ArrowLeft":
      case "w":
      case "W":
        this.move(-1, pending);
        return true;
      case "ArrowDown":
      case "ArrowRight":
      case "s":
      case "S":
        this.move(1, pending);
        return true;
      case "Enter":
      case " ":
      case "e":
      case "E":
      case "z":
      case "Z":
        this.confirm(this.index);
        return true;
      case "Escape":
      case "Backspace":
        // No cancel — a choice must be answered. A small shake says so.
        this.refuse();
        return true;
    }
    return ev.key.length === 1;
  }

  private move(delta: number, pending: PendingLike): void {
    const n = pending.options.length;
    this.index = (this.index + delta + n) % n;
    this.hooks.blip();
    this.renderSelection();
    this.hooks.speak?.(`${this.index + 1}. ${pending.options[this.index].label}`);
  }

  private confirm(index: number): void {
    const pending = pendingOf(this.world);
    if (!pending || index < 0 || index >= pending.options.length) return;
    this.hooks.confirm();
    // Close first: the dispatch may present a nested follow-up choice, and
    // tick() re-opens for it (fresh list, caret reset) once chatter drains.
    this.hide();
    this.hooks.choose(`choose${index + 1}`);
  }

  private refuse(): void {
    this.hooks.blip();
    this.panel.classList.remove("shake");
    void this.panel.offsetWidth; // restart the animation
    this.panel.classList.add("shake");
  }

  private render(pending: PendingLike): void {
    this.promptEl.textContent = pending.prompt;
    this.listEl.replaceChildren(
      ...pending.options.map((opt, i) => {
        const li = document.createElement("li");
        const num = document.createElement("span");
        num.className = "choice-num";
        num.textContent = String(i + 1);
        const label = document.createElement("span");
        label.className = "choice-label";
        label.textContent = opt.label;
        li.append(num, label);
        li.addEventListener("mouseenter", () => {
          if (this.index !== i) {
            this.index = i;
            this.hooks.blip();
            this.renderSelection();
            this.hooks.speak?.(`${i + 1}. ${opt.label}`);
          }
        });
        li.addEventListener("click", () => this.confirm(i));
        return li;
      }),
    );
    this.renderSelection();
  }

  private renderSelection(): void {
    [...this.listEl.children].forEach((li, i) => {
      li.classList.toggle("sel", i === this.index);
    });
  }
}
