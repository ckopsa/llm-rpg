/**
 * Read-aloud narration over the Web Speech API — so a player who can't read
 * yet can still play.
 *
 * Design rules, all of them about a listener rather than a reader:
 *  - Nothing auto-advances out from under the voice. The message box, the
 *    passage pane and the ending screen hand this class a `done` callback and
 *    wait for it, so pacing follows the speech instead of a character count.
 *  - The choice menu is spoken as a numbered list, and moving the caret reads
 *    the highlighted option — the menu is usable without seeing it.
 *  - Mechanical chatter ("You move north.", music and camera cues) is NOT
 *    read. Hearing "You move north" on every step is unbearable; the filter
 *    fails open, so any event the engine grows later is spoken by default.
 *
 * Brave on Linux is the worst case and the one that motivated the local
 * backend: `speechSynthesis` exists, `getVoices()` is empty, and `speak()`
 * answers `error: synthesis-failed`.
 *
 * Everything is feature-detected: with no speechSynthesis the class reports
 * `available === false`, `speak` runs its `done` callback immediately, and
 * every caller degrades to its old timing.
 *
 * TWO BACKENDS, local first:
 *  1. A Piper voice served by the dev server at /__tts (see piper-plugin.ts).
 *     Neural, offline, ~130ms for a three-second line, and — the reason it
 *     exists — it works in browsers whose own speech is broken or absent.
 *  2. The browser's Web Speech API, when there is no local server.
 * The local backend is probed once at startup; everything downstream sees the
 * same `speak(text, done) -> cancel | null` contract either way.
 *
 * Linux gotcha, and the reason `hasVoice` exists separately from `available`:
 * Chromium-family browsers (Chrome, Brave, Edge) ship no TTS engine on Linux
 * — they delegate to speech-dispatcher. Without it the API is fully present
 * and `speak()` succeeds, but `getVoices()` is empty and nothing is audible.
 * Silence with a working-looking toggle is the worst possible failure for the
 * player this feature exists for, so callers surface `voiceHint()` instead.
 */

const ENABLED_KEY = "llmrpg:narrate";
const RATE_KEY = "llmrpg:narrate-rate";
const VOICE_KEY = "llmrpg:narrate-voice";

/** Reading speeds, slowest first — a young listener usually wants 0.8. */
export const RATES = [0.7, 0.8, 0.9, 1, 1.15] as const;
export const RATE_NAMES = ["slowest", "slow", "easy", "normal", "brisk"] as const;

/** Events that are stage directions, not speech. Anything not listed here is
 *  spoken — a new engine event reads aloud rather than going silent. */
const SKIP = [
  /^You move (north|south|east|west)\.$/,
  /^♪/,
  /^The scene (turns to|returns)/,
  / moves (north|south|east|west)(, (north|south|east|west))*\.$/,
  / stops — the way (north|south|east|west) is blocked\.$/,
  /^…$/,
];

export function shouldSpeak(text: string): boolean {
  const t = text.trim();
  if (t === "") return false;
  return !SKIP.some((re) => re.test(t));
}

/**
 * Make engine text speakable. Speech engines say "dash" or stumble on the
 * typographic punctuation the games are written in, and a citation reads
 * better as words than as "Job 1 colon 1".
 */
export function speakable(text: string): string {
  return text
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, " ") // emoji glyphs
    .replace(/^—\s*/, "")
    .replace(/\s*—\s*/g, ", ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\b(\d+):(\d+)(–(\d+))?/g, (_m, ch, v, _r, v2) =>
      v2 ? `chapter ${ch} verses ${v} to ${v2}` : `chapter ${ch} verse ${v}`,
    )
    .replace(/\bWEB\b/g, "World English Bible")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cancels a pending utterance. Calling it never fires that utterance's
 *  `done` callback. */
export type Cancel = () => void;

export class Narrator {
  private synth: SpeechSynthesis | null = null;
  private voice: SpeechSynthesisVoice | null = null;
  private on: boolean;
  private rateIndex: number;
  /** Bumped on every speak/stop; a stale utterance's handlers no-op. */
  private generation = 0;
  private keepAlive: number | null = null;
  /**
   * The caller currently waiting on the voice, if any. Exactly one exists at
   * a time, and it MUST always be released — a caller that waits forever is
   * a frozen game. A new utterance releases the previous waiter (its line was
   * cut short, so it should move on); only an explicit `cancel` drops one
   * without firing, because there the caller is handling the beat itself.
   */
  private waiting: { done: () => void; watchdog: number | null } | null = null;

  /** Local Piper endpoint, once probed. null = not available/not probed. */
  private local: { base: string; voice: string; voices: string[] } | null = null;
  /** The audio element playing a local utterance, if any. */
  private audio: HTMLAudioElement | null = null;

  /** Fired whenever enabled/rate changes, for chrome that shows the state. */
  onChange: (() => void) | null = null;

  constructor() {
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      this.synth = window.speechSynthesis;
    }
    let on = false;
    let rate = 1;
    try {
      on = window.localStorage.getItem(ENABLED_KEY) === "1";
      const stored = Number(window.localStorage.getItem(RATE_KEY));
      if (RATES.includes(stored as (typeof RATES)[number])) rate = stored;
    } catch {
      /* storage unavailable — narration off, normal speed */
    }
    this.on = on;
    this.rateIndex = Math.max(0, RATES.indexOf(rate as (typeof RATES)[number]));
    if (this.synth) {
      this.pickVoice();
      // Chrome populates voices asynchronously.
      this.synth.addEventListener?.("voiceschanged", () => {
        this.pickVoice();
        this.onChange?.(); // a late voice list flips `hasVoice`
      });
    }
  }

  /**
   * Probe the local Piper endpoint. Safe to call once at startup; on success
   * every later utterance uses it in preference to the browser's own voice.
   * `base` defaults to the dev server's proxy but can point anywhere (a
   * static build can run the Python script itself and pass its URL).
   */
  async connectLocal(base = "/__tts"): Promise<boolean> {
    try {
      const res = await fetch(`${base}/health`, { cache: "no-store" });
      if (!res.ok) return false;
      const body = (await res.json()) as { ok?: boolean; voice?: string; voices?: string[] };
      if (!body.ok || !body.voice) return false;
      const voices = body.voices?.length ? body.voices : [body.voice];
      let voice = body.voice;
      try {
        const saved = window.localStorage.getItem(VOICE_KEY);
        if (saved && voices.includes(saved)) voice = saved;
      } catch {
        /* storage unavailable — the server's default voice it is */
      }
      this.local = { base, voice, voices };
      this.onChange?.();
      return true;
    } catch {
      return false;
    }
  }

  /** Name of the local voice in use, or null when running on Web Speech. */
  get localVoice(): string | null {
    return this.local?.voice ?? null;
  }

  /** Every local voice available, empty when running on Web Speech. */
  get localVoices(): string[] {
    return this.local?.voices ?? [];
  }

  /** Select a specific local voice by name; ignored when unavailable. */
  useLocalVoice(name: string): boolean {
    if (!this.local || !this.local.voices.includes(name)) return false;
    this.local.voice = name;
    this.onChange?.();
    return true;
  }

  /** Switch to the next local voice, wrapping. Returns the new name. */
  cycleLocalVoice(): string | null {
    if (!this.local || this.local.voices.length < 2) return this.local?.voice ?? null;
    const i = this.local.voices.indexOf(this.local.voice);
    this.local.voice = this.local.voices[(i + 1) % this.local.voices.length];
    try {
      window.localStorage.setItem(VOICE_KEY, this.local.voice);
    } catch {
      /* storage unavailable — the choice just won't survive a reload */
    }
    this.onChange?.();
    return this.local.voice;
  }

  /** Whether this browser exposes the speech API at all, OR a local voice
   *  server is reachable — either way something can speak. */
  get available(): boolean {
    return this.synth !== null || this.local !== null;
  }

  /** Whether anything can actually be heard. A local Piper voice settles it;
   *  otherwise it needs the browser to have a voice installed, which on Linux
   *  it often does not (the API works, but every utterance is silent). */
  get hasVoice(): boolean {
    return this.local !== null || (this.synth?.getVoices() ?? []).length > 0;
  }

  /** Null when speech should work; otherwise a plain-language explanation of
   *  why nothing will be heard. Shown on screen, because by definition the
   *  player cannot be told about it out loud. */
  voiceHint(): string | null {
    if (this.local) return null; // a local voice always works
    if (!this.available) return "This browser can't read aloud.";
    if (!this.hasVoice) {
      return navigator.userAgent.includes("Linux")
        ? "No voice available. Run the game with `npm run web` for the built-in Piper voice, or install a system speech engine and restart the browser."
        : "No speech voice is installed. Add one in your system's speech settings, then reload this page.";
    }
    return null;
  }

  get enabled(): boolean {
    return this.on && this.available;
  }

  get rate(): number {
    return RATES[this.rateIndex];
  }

  get rateName(): string {
    return RATE_NAMES[this.rateIndex];
  }

  toggle(): boolean {
    if (!this.available) return false;
    this.on = !this.on;
    if (!this.on) this.stop();
    this.persist();
    return this.on;
  }

  /** Step to the next reading speed, wrapping. */
  cycleRate(): number {
    this.rateIndex = (this.rateIndex + 1) % RATES.length;
    this.persist();
    return this.rate;
  }

  /**
   * Speak `text`, calling `done` when the voice finishes. Returns a cancel
   * function, or null when nothing will be spoken — a null return is the
   * caller's signal to fall back to its own timing, and `done` is NOT called
   * in that case.
   */
  speak(text: string, done?: () => void): Cancel | null {
    if (!this.enabled) return null;
    const body = speakable(text);
    if (body === "") return null;
    if (this.local) return this.speakLocal(body, done);
    if (!this.synth) return null;

    // Whatever was being read is over — release its waiter before starting.
    this.release();
    const gen = ++this.generation;
    this.synth.cancel();
    const utter = new SpeechSynthesisUtterance(body);
    utter.rate = this.rate;
    utter.pitch = 1;
    if (this.voice) utter.voice = this.voice;

    const finish = () => {
      if (gen !== this.generation) return; // superseded; `release` handled it
      this.stopKeepAlive();
      this.release();
    };
    utter.onend = finish;
    // A failed utterance must not strand the caller waiting forever.
    utter.onerror = finish;

    if (done) {
      // ...and neither must a silent one. Chrome drops `end` often enough
      // (no voices installed, a backgrounded tab, the engine wedging) that
      // without this the game would simply stop, which for the player this
      // feature exists for is indistinguishable from a crash. Generous:
      // roughly the utterance's own length, doubled, plus a floor.
      const words = body.split(/\s+/).length;
      const budget = 3000 + (words / (2.6 * this.rate)) * 2000;
      this.waiting = { done, watchdog: window.setTimeout(finish, budget) };
    }

    try {
      this.synth.speak(utter);
    } catch {
      // A speech engine that refuses the utterance must not take the game
      // down with it: drop back to the caller's own timing.
      this.drop();
      this.generation++;
      return null;
    }
    this.startKeepAlive();
    return () => {
      if (gen !== this.generation) return;
      this.generation++;
      this.drop(); // the caller is taking over this beat: do NOT fire `done`
      this.stopKeepAlive();
      this.synth?.cancel();
    };
  }

  /**
   * Local Piper backend. Same contract as the Web Speech path: `done` fires
   * exactly once (playback end, fetch/decode failure, or supersession), and
   * the returned cancel silences without firing it. No watchdog is needed —
   * an <audio> element that never ends still errors, and a failed fetch
   * rejects — but a superseded utterance must still release its waiter.
   */
  private speakLocal(body: string, done?: () => void): Cancel {
    this.release();
    const gen = ++this.generation;
    this.stopAudio();
    if (done) this.waiting = { done, watchdog: null };

    const local = this.local!;
    const url =
      `${local.base}/speak?rate=${this.rate}` +
      `&voice=${encodeURIComponent(local.voice)}` +
      `&text=${encodeURIComponent(body)}`;
    let objectUrl: string | null = null;
    const finish = () => {
      if (gen !== this.generation) return; // superseded; `release` handled it
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      this.release();
    };

    void (async () => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) throw new Error(`tts ${res.status}`);
        const blob = await res.blob();
        if (gen !== this.generation) return; // cancelled while synthesizing
        objectUrl = URL.createObjectURL(blob);
        const audio = new Audio(objectUrl);
        this.audio = audio;
        audio.onended = finish;
        audio.onerror = finish;
        await audio.play();
      } catch {
        finish();
      }
    })();

    return () => {
      if (gen !== this.generation) return;
      this.generation++;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      this.drop(); // the caller is taking over this beat
      this.stopAudio();
    };
  }

  private stopAudio(): void {
    if (!this.audio) return;
    this.audio.onended = null;
    this.audio.onerror = null;
    this.audio.pause();
    this.audio = null;
  }

  /** Speak without anyone waiting on it (menu captions, option labels). */
  say(text: string): void {
    this.speak(text);
  }

  /** Silence immediately, releasing any waiter so nothing can hang. */
  stop(): void {
    this.generation++;
    this.stopKeepAlive();
    this.stopAudio();
    this.synth?.cancel();
    this.release();
  }

  /** Fire the pending waiter's `done` exactly once. */
  private release(): void {
    const waiting = this.waiting;
    if (!waiting) return;
    this.waiting = null;
    if (waiting.watchdog !== null) window.clearTimeout(waiting.watchdog);
    waiting.done();
  }

  /** Forget the pending waiter WITHOUT firing it (explicit caller cancel). */
  private drop(): void {
    if (this.waiting?.watchdog != null) window.clearTimeout(this.waiting.watchdog);
    this.waiting = null;
  }

  /** Some engines need a first utterance inside a user gesture. Harmless
   *  otherwise: an empty string is not audible. */
  unlock(): void {
    if (!this.enabled || this.local || !this.synth) return;
    if (this.synth.speaking || this.synth.pending) return;
    this.synth.speak(new SpeechSynthesisUtterance(" "));
  }

  private persist(): void {
    try {
      window.localStorage.setItem(ENABLED_KEY, this.on ? "1" : "0");
      window.localStorage.setItem(RATE_KEY, String(this.rate));
    } catch {
      /* storage unavailable — the setting just won't survive a reload */
    }
    this.onChange?.();
  }

  private pickVoice(): void {
    const voices = this.synth?.getVoices() ?? [];
    if (voices.length === 0) return;
    const lang = (document.documentElement.lang || navigator.language || "en").slice(0, 2);
    // Prefer an on-device voice in the page language: no network round trip,
    // which matters because every line of dialogue goes through here.
    this.voice =
      voices.find((v) => v.localService && v.lang.startsWith(lang) && v.default) ??
      voices.find((v) => v.localService && v.lang.startsWith(lang)) ??
      voices.find((v) => v.lang.startsWith(lang)) ??
      voices.find((v) => v.default) ??
      voices[0] ??
      null;
  }

  /**
   * Chrome stops long utterances after ~15s unless the synth is nudged.
   * Passages are long, so the nudge is not optional here.
   */
  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAlive = window.setInterval(() => {
      if (!this.synth?.speaking) return;
      this.synth.pause();
      this.synth.resume();
    }, 10_000);
  }

  private stopKeepAlive(): void {
    if (this.keepAlive !== null) window.clearInterval(this.keepAlive);
    this.keepAlive = null;
  }
}
