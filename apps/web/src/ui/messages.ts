/**
 * GBA-style message box: engine event strings play one at a time, latest
 * message prominent, with a small "more" indicator while others wait.
 *
 * Pacing: each message auto-advances after a delay scaled by its length;
 * Enter/Space/E advance immediately. `busy()` is true until the queue is
 * drained and the last message has been on screen a beat — battle menus and
 * end-of-battle transitions wait on it, which is what makes fights read as
 * sequences instead of a log dump.
 *
 * Display is generic over event text: unknown future engine events render
 * fine; only presentation (emphasis styling) pattern-matches known beats.
 *
 * Read-aloud: when `narrate` is set and claims a message, the length-scaled
 * timer is replaced by the voice — the box moves on when the narrator says
 * the line is finished, never before. That is what keeps the game playable
 * for someone who is listening rather than reading.
 */

interface Queued {
  text: string;
  cls: string;
}

/** Beats worth a moment of emphasis (faints, wins, level-ups, evolutions). */
const EMPHASIS = [
  /fainted!/,
  /You won the battle/,
  /You lost the battle/i,
  /grew to Lv/,
  /learned /,
  /flame steadies/,
  /Gotcha!/,
  /joined your party/,
  /YOU WIN/,
];

function classify(text: string): string {
  return EMPHASIS.some((re) => re.test(text)) ? "em" : "";
}

export class MessageBox {
  private root: HTMLElement;
  private textEl: HTMLElement;
  private moreEl: HTMLElement;
  private queue: Queued[] = [];
  private current: Queued | null = null;
  private shownAt = 0;
  private timer: number | null = null;
  private hideTimer: number | null = null;
  /** True once the shown message's dwell elapsed with nothing queued. */
  private settled = false;
  /** When true (overworld), the box hides a few seconds after draining. */
  private idleHide = true;
  /** Optional hook fired as each message becomes visible (SFX etc.). */
  onShow: ((text: string) => void) | null = null;
  /** While this returns true, queued messages wait (e.g. a passage pane is
   *  open) — ordinary chatter resumes once the reading closes. */
  gate: (() => boolean) | null = null;
  /** Optional read-aloud pacing. Return a cancel function to take over this
   *  message's timing (the box then waits for `done`), or null to leave it
   *  on the normal length-scaled timer. */
  narrate: ((text: string, done: () => void) => (() => void) | null) | null = null;
  /** Cancels the in-flight utterance, when one owns the current message. */
  private speaking: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.textEl = root.querySelector(".msg-text")!;
    this.moreEl = root.querySelector(".msg-more")!;
  }

  setIdleHide(idleHide: boolean): void {
    this.idleHide = idleHide;
    if (!idleHide) {
      if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  push(events: string[]): void {
    for (const text of events) {
      if (!text) continue;
      this.queue.push({ text, cls: classify(text) });
    }
    if ((!this.current || this.settled) && this.queue.length > 0) this.showNext();
  }

  /** True while messages are still playing (or the last needs its beat). */
  busy(): boolean {
    if (this.queue.length > 0) return true;
    if (this.speaking) return true;
    if (!this.current || this.settled) return false;
    const dwell = this.current.cls === "em" ? 700 : 350;
    return performance.now() - this.shownAt < dwell;
  }

  /** User pressed an advance key. Returns true if the press was consumed.
   *  Barge-in: a key cuts the voice short rather than being ignored. */
  advance(): boolean {
    const wasSpeaking = this.stopSpeaking();
    if (this.queue.length > 0) {
      this.showNext();
      return true;
    }
    if (wasSpeaking) {
      // Last message, voice cut short: settle it as the timer would have.
      this.settled = true;
      if (this.idleHide) {
        this.hideTimer = window.setTimeout(() => {
          this.root.classList.add("hidden");
          this.current = null;
        }, 2600);
      }
      return true;
    }
    return false;
  }

  /** Cancel any in-flight narration. Returns whether there was one. */
  private stopSpeaking(): boolean {
    if (!this.speaking) return false;
    this.speaking();
    this.speaking = null;
    return true;
  }

  clear(): void {
    this.stopSpeaking();
    this.queue = [];
    this.current = null;
    this.settled = false;
    if (this.timer !== null) window.clearTimeout(this.timer);
    if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
    this.timer = null;
    this.hideTimer = null;
    this.root.classList.add("hidden");
  }

  private showNext(): void {
    if (this.gate?.()) {
      // Held: poll gently until the gate lifts, then play on.
      if (this.timer !== null) window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.showNext(), 200);
      return;
    }
    this.stopSpeaking();
    const next = this.queue.shift();
    if (!next) return;
    this.current = next;
    this.settled = false;
    this.shownAt = performance.now();
    this.root.classList.remove("hidden");
    this.onShow?.(next.text);
    this.textEl.textContent = next.text;
    this.textEl.className = `msg-text ${next.cls}`.trim();
    this.moreEl.classList.toggle("hidden", this.queue.length === 0);

    if (this.timer !== null) window.clearTimeout(this.timer);
    if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);

    const onDone = () => {
      this.speaking = null;
      if (this.queue.length > 0) {
        this.showNext();
        return;
      }
      this.settled = true;
      if (this.idleHide) {
        this.hideTimer = window.setTimeout(() => {
          this.root.classList.add("hidden");
          this.current = null;
        }, 2600);
      }
    };

    // The voice paces the box when it claims the line; otherwise the old
    // length-scaled dwell does.
    this.speaking = this.narrate?.(next.text, onDone) ?? null;
    if (this.speaking) return;
    const dwell =
      (next.cls === "em" ? 1200 : 750) + Math.min(1000, next.text.length * 12);
    this.timer = window.setTimeout(onDone, dwell);
  }
}
