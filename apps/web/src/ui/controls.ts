/**
 * Touch and gamepad input — so the game plays on a phone, a tablet, or a
 * Steam Deck, not only at a keyboard.
 *
 * Both surfaces synthesize the SAME KeyboardEvents the keyboard produces and
 * dispatch them on `window`. That is deliberate: main.ts already routes keys
 * through a careful modal cascade (passage pane owns the stage, then title,
 * then cutscene, then pause, then ending, then battle, then a pending choice,
 * then the overworld), and re-implementing that cascade for two more input
 * devices is how the three of them drift apart. One state machine, three ways
 * to feed it — and the sim stays the single authority, so replay determinism
 * is untouched.
 *
 * Movement is held-key based (OverworldView tracks `held` and walks a tile per
 * tween), so directions send keydown on press and keyup on release; holding
 * the d-pad walks, exactly like holding an arrow key.
 */

/** Buttons in the W3C "standard gamepad" mapping that we care about. */
const PAD_BUTTONS: Record<number, string> = {
  0: "e", // A / cross — interact, advance, confirm
  1: "Escape", // B / circle — back, refuse
  2: "v", // X / square — read aloud
  3: "m", // Y / triangle — mute
  9: "p", // Start — pause & save
  12: "ArrowUp",
  13: "ArrowDown",
  14: "ArrowLeft",
  15: "ArrowRight",
};
/** Directions repeat while held; everything else fires once per press. */
const HELD = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
/** Stick deflection before it counts as a direction. */
const DEADZONE = 0.5;

/**
 * `code` matters as much as `key`: main.ts's cascade matches on `ev.key`, but
 * OverworldView's movement matches on `ev.code` (so WASD works on any layout).
 * A synthetic event missing `code` is silently ignored by the walker, which
 * looks exactly like broken controls — so always send both.
 */
const CODES: Record<string, string> = {
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  Escape: "Escape",
  Enter: "Enter",
  " ": "Space",
};
const codeFor = (key: string): string =>
  CODES[key] ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key);

function send(type: "keydown" | "keyup", key: string): void {
  window.dispatchEvent(
    new KeyboardEvent(type, { key, code: codeFor(key), bubbles: true, cancelable: true }),
  );
}

interface TouchButton {
  key: string;
  label: string;
  cls: string;
}

const PAD: TouchButton[] = [
  { key: "ArrowUp", label: "▲", cls: "up" },
  { key: "ArrowLeft", label: "◀", cls: "left" },
  { key: "ArrowRight", label: "▶", cls: "right" },
  { key: "ArrowDown", label: "▼", cls: "down" },
];
const ACTIONS: TouchButton[] = [
  { key: "e", label: "OK", cls: "ok" },
  { key: "p", label: "☰", cls: "menu" },
];

type Source = "touch" | "pad";

export class Controls {
  private root: HTMLElement;
  /** Who is holding each key. A key is released only when NOBODY holds it,
   *  so a thumb on the d-pad and a stick pushed the same way don't fight. */
  private held = new Map<string, Set<Source>>();
  /** Buttons the pad wanted last frame — the pad gives no events, so edges
   *  have to be diffed by hand. */
  private padPrev = new Set<string>();
  private padIndex: number | null = null;
  /** Earliest release time per key, so a quick tap still walks one tile: the
   *  walker only steps when it sees a direction held during a frame. */
  private minRelease = new Map<string, number>();

  constructor(root: HTMLElement) {
    this.root = root;
    this.buildTouch();
    // A pad may be connected before or after load; polling handles both, but
    // this makes the on-screen controls disappear when a real pad shows up.
    window.addEventListener("gamepadconnected", (ev) => {
      // Defensive: the index is a hint for polling, not a requirement, and a
      // throwing listener here would take the whole input layer down.
      const index = (ev as Partial<GamepadEvent>).gamepad?.index;
      if (typeof index === "number") this.padIndex = index;
      this.root.classList.add("has-pad");
    });
    window.addEventListener("gamepaddisconnected", () => {
      this.padIndex = null;
      this.root.classList.remove("has-pad");
    });
  }

  /** Whether this device wants on-screen controls at all. */
  static touchLikely(): boolean {
    return (
      navigator.maxTouchPoints > 0 ||
      window.matchMedia?.("(pointer: coarse)").matches === true
    );
  }

  private static readonly MIN_HOLD_MS = 120;

  private hold(key: string, src: Source): void {
    const holders = this.held.get(key) ?? new Set<Source>();
    const wasEmpty = holders.size === 0;
    holders.add(src);
    this.held.set(key, holders);
    if (wasEmpty) {
      this.minRelease.set(key, performance.now() + Controls.MIN_HOLD_MS);
      send("keydown", key);
    }
  }

  private letGo(key: string, src: Source): void {
    const holders = this.held.get(key);
    if (!holders?.delete(src)) return;
    if (holders.size > 0) return;
    const notBefore = this.minRelease.get(key) ?? 0;
    const wait = notBefore - performance.now();
    const finish = () => {
      // Re-pressed while we waited: that press owns the key now.
      if (this.held.has(key)) return;
      this.minRelease.delete(key);
      send("keyup", key);
    };
    this.held.delete(key);
    if (wait > 0) window.setTimeout(finish, wait);
    else finish();
  }

  private holdsFor(src: Source): string[] {
    return [...this.held].filter(([, who]) => who.has(src)).map(([key]) => key);
  }

  /** Release everything one source is holding (a pad vanishing mid-walk). */
  releaseAll(src: Source): void {
    for (const key of this.holdsFor(src)) this.letGo(key, src);
  }

  private buildTouch(): void {
    if (!Controls.touchLikely()) return;
    this.root.classList.add("shown");
    const mk = (b: TouchButton): HTMLElement => {
      const el = document.createElement("button");
      el.className = `tc-btn tc-${b.cls}`;
      el.type = "button";
      el.textContent = b.label;
      el.setAttribute("aria-label", b.key);
      // Pointer events cover touch, pen and mouse in one path. Capture keeps
      // the release with this element even if the finger slides off it, which
      // is the difference between "walked too far" and "stopped where I let go".
      el.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        el.setPointerCapture(ev.pointerId);
        el.classList.add("pressed");
        this.hold(b.key, "touch");
        if (!HELD.has(b.key)) this.letGo(b.key, "touch"); // taps are instantaneous
      });
      const up = (ev: PointerEvent) => {
        ev.preventDefault();
        el.classList.remove("pressed");
        this.letGo(b.key, "touch");
      };
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
      // Never let a long press raise the text-selection or context menus.
      el.addEventListener("contextmenu", (ev) => ev.preventDefault());
      return el;
    };

    const dpad = document.createElement("div");
    dpad.className = "tc-dpad";
    PAD.forEach((b) => dpad.append(mk(b)));
    const actions = document.createElement("div");
    actions.className = "tc-actions";
    ACTIONS.forEach((b) => actions.append(mk(b)));
    this.root.replaceChildren(dpad, actions);
  }

  /**
   * Poll the gamepad once per frame (browsers give no button events). Called
   * from the rAF loop.
   */
  tick(): void {
    const pads = navigator.getGamepads?.() ?? [];
    const pad =
      (this.padIndex !== null ? pads[this.padIndex] : null) ??
      pads.find((p) => p && p.connected) ??
      null;
    if (!pad) {
      // Unplugged mid-walk: drop only what the pad was holding, never touch's.
      this.releaseAll("pad");
      this.padPrev.clear();
      return;
    }
    if (!this.root.classList.contains("has-pad")) this.root.classList.add("has-pad");

    const wanted = new Set<string>();
    for (const [index, key] of Object.entries(PAD_BUTTONS)) {
      if (pad.buttons[Number(index)]?.pressed) wanted.add(key);
    }
    // Left stick doubles as the d-pad.
    const [x = 0, y = 0] = pad.axes;
    if (x < -DEADZONE) wanted.add("ArrowLeft");
    if (x > DEADZONE) wanted.add("ArrowRight");
    if (y < -DEADZONE) wanted.add("ArrowUp");
    if (y > DEADZONE) wanted.add("ArrowDown");

    for (const key of wanted) {
      if (HELD.has(key)) {
        this.hold(key, "pad"); // directions repeat while held
      } else if (!this.padPrev.has(key)) {
        send("keydown", key); // everything else fires once, on the press edge
        send("keyup", key);
      }
    }
    for (const key of this.padPrev) {
      if (!wanted.has(key) && HELD.has(key)) this.letGo(key, "pad");
    }
    this.padPrev = wanted;
  }
}
