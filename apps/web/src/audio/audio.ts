/**
 * Data-driven chiptune engine: WebAudio oscillators only, no audio files.
 *
 * All musical content lives in tracks.json:
 *   tracks: { [name]: { tempo, loop, lengthBeats, voices: [{ wave, gain,
 *            notes: [{ t, dur, midi | freq, wave?, gain? }] }] } }
 *            (t/dur in beats, converted via tempo)
 *   sfx:    { [name]: { notes: [...] } }  (t/dur in seconds)
 *   music:  map-id substring -> track name, plus default/battle/victory.
 *
 * The AudioContext is created lazily on the first user gesture (autoplay
 * policy); every public method is a safe no-op before that or if WebAudio is
 * unavailable. Malformed data disables the engine with a console.warn —
 * audio must never crash the game.
 *
 * Debug: add ?audiodebug=1 to the URL to log track scheduling.
 */

type Wave = "square" | "triangle" | "sine" | "sawtooth" | "noise";

interface NoteEvent {
  t: number;
  dur: number;
  midi?: number;
  freq?: number;
  wave?: Wave;
  gain?: number;
}

interface Voice {
  wave?: Wave;
  gain?: number;
  notes: NoteEvent[];
}

interface TrackDef {
  tempo: number;
  loop: boolean;
  lengthBeats: number;
  voices: Voice[];
}

interface MusicMap {
  byMapSubstring: Record<string, string>;
  default: string;
  battle: string;
  victory: string;
}

interface AudioData {
  masterGain: number;
  music: MusicMap;
  tracks: Record<string, TrackDef>;
  sfx: Record<string, { notes: NoteEvent[] }>;
}

/** One playing (or fading) music track: its gain bus + live sources. */
interface Playback {
  name: string;
  gain: GainNode;
  sources: Set<AudioScheduledSourceNode>;
  /** ctx time the next loop iteration starts at. */
  nextLoopAt: number;
  stopped: boolean;
}

const MUTE_KEY = "llmrpg:muted";
const LOOKAHEAD_S = 1.2;
const TICK_MS = 300;
const FADE_S = 0.35;

const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

function debugEnabled(): boolean {
  return new URLSearchParams(window.location.search).has("audiodebug");
}

export class AudioEngine {
  private data: AudioData | null;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private current: Playback | null = null;
  private fading: Playback[] = [];
  private timer: number | null = null;
  private desiredMusic: string | null = null;
  private mutedFlag: boolean;
  /** Called whenever the mute state flips (updates the speaker chip). */
  onMuteChange: ((muted: boolean) => void) | null = null;

  constructor(data: unknown) {
    this.data = AudioEngine.validate(data);
    let muted = false;
    try {
      muted = window.localStorage.getItem(MUTE_KEY) === "1";
    } catch {
      /* storage unavailable — default unmuted */
    }
    this.mutedFlag = muted;
  }

  /** Light structural check; returns null (engine disabled) on bad data. */
  private static validate(data: unknown): AudioData | null {
    const d = data as Partial<AudioData> | null;
    if (
      !d ||
      typeof d !== "object" ||
      typeof d.masterGain !== "number" ||
      !d.music ||
      typeof d.music.default !== "string" ||
      !d.tracks ||
      !d.sfx
    ) {
      console.warn("Audio data malformed — sound disabled.");
      return null;
    }
    return d as AudioData;
  }

  get enabled(): boolean {
    return this.data !== null;
  }

  get muted(): boolean {
    return this.mutedFlag;
  }

  /**
   * Create/resume the AudioContext. Call from a user-gesture handler
   * (keydown/pointerdown); safe to call repeatedly.
   */
  unlock(): void {
    if (!this.data) return;
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) {
        console.warn("WebAudio unavailable — sound disabled.");
        this.data = null;
        return;
      }
      try {
        this.ctx = new Ctor();
      } catch (e) {
        console.warn("AudioContext failed — sound disabled:", e);
        this.data = null;
        return;
      }
      this.master = this.ctx.createGain();
      this.master.gain.value = this.mutedFlag ? 0 : this.data.masterGain;
      this.master.connect(this.ctx.destination);
      this.timer = window.setInterval(() => this.tick(), TICK_MS);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    // Start whatever music was requested before the ctx existed.
    if (this.desiredMusic && !this.current) this.startTrack(this.desiredMusic);
  }

  toggleMute(): boolean {
    this.mutedFlag = !this.mutedFlag;
    try {
      window.localStorage.setItem(MUTE_KEY, this.mutedFlag ? "1" : "0");
    } catch {
      /* fine */
    }
    if (this.ctx && this.master && this.data) {
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.linearRampToValueAtTime(this.mutedFlag ? 0 : this.data.masterGain, t + 0.05);
    }
    this.onMuteChange?.(this.mutedFlag);
    return this.mutedFlag;
  }

  /** Track name for a map id via the data's substring mapping. */
  trackForMap(mapId: string): string {
    if (!this.data) return "route";
    const id = mapId.toLowerCase();
    for (const [needle, track] of Object.entries(this.data.music.byMapSubstring)) {
      if (id.includes(needle) && this.data.tracks[track]) return track;
    }
    return this.data.music.default;
  }

  get battleTrack(): string {
    return this.data?.music.battle ?? "battle";
  }

  /**
   * Resolve a free-form track id (play_music cues) to a known track:
   * an exact track name plays as-is; anything else lands on the substring
   * mapping (so "hearth-theme" finds "town"), then the default. A game can
   * name tracks the web app has never heard of and still get music.
   */
  resolveTrack(name: string): string {
    if (!this.data) return "route";
    if (this.data.tracks[name]) return name;
    return this.trackForMap(name);
  }

  /**
   * Request background music. Crossfades when the track changes; no-op when
   * it is already playing. `null` fades music out.
   */
  setMusic(name: string | null): void {
    this.desiredMusic = name;
    if (!this.data || !this.ctx) return;
    if (this.current && !this.current.stopped && this.current.name === name) return;
    if (this.current) this.fadeOut(this.current);
    this.current = null;
    if (name) this.startTrack(name);
  }

  /** Play a non-looping track once, ducking the music beneath it. */
  sting(name: string): void {
    if (!this.data || !this.ctx || !this.master) return;
    const def = this.data.tracks[name];
    if (!def) return;
    const t0 = this.ctx.currentTime + 0.03;
    const bus = this.ctx.createGain();
    bus.connect(this.master);
    const dur = this.scheduleTrackOnce(def, t0, bus, null);
    if (this.current) {
      const g = this.current.gain.gain;
      const t = this.ctx.currentTime;
      g.cancelScheduledValues(t);
      g.linearRampToValueAtTime(0.25, t + 0.1);
      g.setValueAtTime(0.25, t0 + dur - 0.2);
      g.linearRampToValueAtTime(1, t0 + dur + 0.3);
    }
    if (debugEnabled()) console.debug(`[audio] sting "${name}" at ${t0.toFixed(2)}s`);
  }

  sfx(name: string): void {
    if (!this.data || !this.ctx || !this.master || this.mutedFlag) return;
    const def = this.data.sfx[name];
    if (!def?.notes) return;
    const t0 = this.ctx.currentTime + 0.01;
    for (const note of def.notes) {
      this.scheduleNote(note, t0 + note.t, note.dur, note.wave ?? "square", note.gain ?? 0.25, this.master, null);
    }
  }

  /** Map engine event text to a one-shot sound. */
  sfxForEvent(text: string): void {
    if (/fainted!/.test(text)) return this.sfx("faint");
    if (/Gotcha!|joined your party/.test(text)) return this.sfx("catch");
    if (/grew to Lv|learned |flame steadies/.test(text)) return this.sfx("levelup");
    if (/recovered \d+ HP|rested and warm/.test(text)) return this.sfx("heal");
    if (/took \d+ damage/.test(text)) return this.sfx("hit");
  }

  // ---- internals --------------------------------------------------------

  private startTrack(name: string): void {
    if (!this.data || !this.ctx || !this.master) return;
    const def = this.data.tracks[name];
    if (!def) {
      console.warn(`Unknown music track "${name}" — staying quiet.`);
      return;
    }
    const bus = this.ctx.createGain();
    bus.gain.value = 0;
    bus.connect(this.master);
    const t = this.ctx.currentTime;
    bus.gain.linearRampToValueAtTime(1, t + FADE_S);
    const playback: Playback = {
      name,
      gain: bus,
      sources: new Set(),
      nextLoopAt: t + 0.05,
      stopped: false,
    };
    this.current = playback;
    if (debugEnabled()) console.debug(`[audio] start track "${name}"`);
    this.tick(); // schedule the first iteration immediately
  }

  /** Lookahead scheduler: keep the current loop topped up. */
  private tick(): void {
    const playback = this.current;
    if (!playback || playback.stopped || !this.ctx || !this.data) return;
    const def = this.data.tracks[playback.name];
    if (!def) return;
    while (playback.nextLoopAt < this.ctx.currentTime + LOOKAHEAD_S) {
      const dur = this.scheduleTrackOnce(def, playback.nextLoopAt, playback.gain, playback);
      if (debugEnabled()) {
        console.debug(
          `[audio] scheduled "${playback.name}" iteration at ${playback.nextLoopAt.toFixed(2)}s (${dur.toFixed(2)}s long)`,
        );
      }
      if (!def.loop) break;
      playback.nextLoopAt += dur;
    }
  }

  /** Schedule every note of one track iteration; returns its length in s. */
  private scheduleTrackOnce(
    def: TrackDef,
    t0: number,
    out: GainNode,
    playback: Playback | null,
  ): number {
    const spb = 60 / def.tempo; // seconds per beat
    for (const voice of def.voices) {
      const wave = voice.wave ?? "square";
      const vGain = voice.gain ?? 0.4;
      for (const note of voice.notes) {
        this.scheduleNote(
          note,
          t0 + note.t * spb,
          note.dur * spb,
          note.wave ?? wave,
          (note.gain ?? 1) * vGain,
          out,
          playback,
        );
      }
    }
    return def.lengthBeats * spb;
  }

  private getNoiseBuffer(): AudioBuffer {
    if (!this.noiseBuffer) {
      const ctx = this.ctx!;
      const len = Math.floor(ctx.sampleRate * 0.5);
      this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    return this.noiseBuffer;
  }

  /** One note: oscillator (or noise burst) through a tiny ADSR envelope. */
  private scheduleNote(
    note: NoteEvent,
    at: number,
    durS: number,
    wave: Wave,
    gain: number,
    out: GainNode,
    playback: Playback | null,
  ): void {
    const ctx = this.ctx!;
    const env = ctx.createGain();
    env.connect(out);
    const attack = 0.008;
    const release = 0.04;
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(gain, at + attack);
    env.gain.setValueAtTime(gain, Math.max(at + attack, at + durS - 0.01));
    env.gain.linearRampToValueAtTime(0, at + durS + release);

    let source: AudioScheduledSourceNode;
    if (wave === "noise") {
      const src = ctx.createBufferSource();
      src.buffer = this.getNoiseBuffer();
      src.loop = true;
      source = src;
    } else {
      const osc = ctx.createOscillator();
      osc.type = wave;
      const hz = note.freq ?? (note.midi !== undefined ? midiHz(note.midi) : 440);
      osc.frequency.setValueAtTime(hz, at);
      source = osc;
    }
    source.connect(env);
    source.start(at);
    source.stop(at + durS + release + 0.01);
    if (playback) {
      playback.sources.add(source);
      source.onended = () => playback.sources.delete(source);
    }
  }

  private fadeOut(playback: Playback): void {
    playback.stopped = true;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    playback.gain.gain.cancelScheduledValues(t);
    playback.gain.gain.setValueAtTime(playback.gain.gain.value, t);
    playback.gain.gain.linearRampToValueAtTime(0, t + FADE_S);
    this.fading.push(playback);
    window.setTimeout(() => {
      for (const src of playback.sources) {
        try {
          src.stop();
        } catch {
          /* already stopped */
        }
      }
      playback.sources.clear();
      playback.gain.disconnect();
      this.fading = this.fading.filter((p) => p !== playback);
    }, FADE_S * 1000 + 80);
  }
}
