/**
 * Language overlays: one game, many scripts.
 *
 * A game is a single JSON document, and its STRUCTURE — maps, entities,
 * triggers, flags, choices, endings — is the thing that must not be
 * duplicated. Only the words change between a scholarly retelling and one a
 * five-year-old can follow, so a language file carries words, not structure:
 *
 *   games/<id>/lang.<code>.json
 *   {
 *     "name": "Simple words",
 *     "voice": "en_US-amy-medium",          // optional read-aloud preference
 *     "strings": { "<original text>": "<replacement>", ... },
 *     "patches": [ { "path": "maps.x.entities.y...", "value": ... } ]
 *   }
 *
 * Strings are keyed by the ORIGINAL English text (gettext's msgid trick), so
 * an overlay survives entities being moved, renamed or reordered — the only
 * thing that invalidates an entry is the source text itself being rewritten,
 * which is exactly when a translation *should* be revisited. Multi-line
 * passages key on their lines joined by "\n" and may be replaced by a string
 * or by an array of lines (a retelling rarely wants the same line count).
 *
 * `patches` set arbitrary paths for the rare non-text change — dropping a whole
 * dialogue round from a shortened variant, or moving a threshold that depends
 * on how many beats survive. They are applied BEFORE the string pass, so
 * anything a patch splices in is translated like the rest of the document;
 * a patch that needs to win over a translation should carry final text.
 *
 * `applyLanguage` is pure: it deep-clones and returns a new game, so the
 * source document is never mutated and the untranslated game stays playable.
 * It reports every key that matched nothing, which is how a translation is
 * kept honest as the source text changes.
 */
import type { Command, Entity, Game, Interaction } from "./schema.js";

export interface LanguageOverlay {
  /** Human-readable name for a language picker ("Simple words"). */
  name: string;
  description?: string;
  /** Preferred text-to-speech voice id for this script, if any. */
  voice?: string;
  /** Original text -> replacement. Passage bodies key on lines.join("\n"). */
  strings?: Record<string, string | string[]>;
  /** Non-text overrides, applied after strings. */
  patches?: { path: string; value: unknown }[];
}

export interface LanguageResult {
  game: Game;
  /** Overlay keys that matched nothing — stale entries, or typos. */
  unused: string[];
  /** Source strings with no overlay entry — the untranslated remainder. */
  missing: string[];
}

/** Set `path` ("maps.uz.entities.0.name") on a plain object graph. */
function setPath(root: unknown, path: string, value: unknown): boolean {
  const parts = path.split(".");
  let node = root as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) {
    const next = (node as Record<string, unknown>)[part];
    if (next === null || typeof next !== "object") return false;
    node = next as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (!(last in node)) return false;
  node[last] = value;
  return true;
}

export function applyLanguage(game: Game, overlay: LanguageOverlay): LanguageResult {
  const clone = structuredClone(game) as Game;

  // Structure first: a patch may add, drop or reshape content, and whatever it
  // leaves behind must still go through the translation pass below.
  const unusedPatches: string[] = [];
  for (const patch of overlay.patches ?? []) {
    if (!setPath(clone, patch.path, structuredClone(patch.value))) {
      unusedPatches.push(`patch:${patch.path}`);
    }
  }

  const strings = overlay.strings ?? {};
  const used = new Set<string>();
  const missing = new Set<string>();

  /** Replace one single-line string, recording whether it was covered. */
  const one = (text: string | undefined): string | undefined => {
    if (text === undefined || text.trim() === "") return text;
    const hit = strings[text];
    if (hit === undefined) {
      missing.add(text);
      return text;
    }
    used.add(text);
    return Array.isArray(hit) ? hit.join(" ") : hit;
  };

  /** Replace a multi-line body, which may change line count. */
  const many = (lines: string[]): string[] => {
    const key = lines.join("\n");
    const hit = strings[key];
    if (hit === undefined) {
      missing.add(key);
      return lines;
    }
    used.add(key);
    return Array.isArray(hit) ? hit : [hit];
  };

  const walkCommands = (commands: Command[] | undefined): void => {
    for (const cmd of commands ?? []) {
      switch (cmd.type) {
        case "say":
        case "win":
          cmd.text = one(cmd.text)!;
          break;
        case "end":
          cmd.text = one(cmd.text)!;
          break;
        case "passage":
          cmd.lines = many(cmd.lines);
          if (cmd.title !== undefined) cmd.title = one(cmd.title);
          if (cmd.citation !== undefined) cmd.citation = one(cmd.citation);
          break;
        case "set_objective":
          // The standing objective is player-facing text like any other, and
          // is exactly what a struggling reader most needs in their words.
          cmd.text = one(cmd.text) ?? cmd.text;
          break;
        case "show_title":
          cmd.text = one(cmd.text)!;
          if (cmd.subtitle !== undefined) cmd.subtitle = one(cmd.subtitle);
          break;
        case "choice":
          cmd.prompt = one(cmd.prompt)!;
          for (const option of cmd.options) {
            option.label = one(option.label)!;
            walkCommands(option.commands);
          }
          break;
        case "spawn_entity":
          walkEntity(cmd.entity as Entity);
          break;
        default:
          break;
      }
    }
  };

  const walkInteractions = (interactions: Interaction[] | undefined): void => {
    for (const interaction of interactions ?? []) walkCommands(interaction.commands);
  };

  function walkEntity(entity: Entity): void {
    entity.name = one(entity.name)!;
    for (const variant of entity.variants ?? []) {
      if (variant.name !== undefined) variant.name = one(variant.name);
    }
    if (entity.trainer) {
      const t = entity.trainer;
      if (t.intro !== undefined) t.intro = one(t.intro);
      if (t.defeatText !== undefined) t.defeatText = one(t.defeatText);
      if (t.outro !== undefined) t.outro = one(t.outro);
      walkCommands(t.rewardCommands);
    }
    walkInteractions(entity.interactions);
  }

  clone.meta.title = one(clone.meta.title)!;
  clone.meta.goal = one(clone.meta.goal)!;
  for (const tile of Object.values(clone.legend)) tile.name = one(tile.name)!;
  for (const map of Object.values(clone.maps)) {
    for (const entity of map.entities) walkEntity(entity);
    for (const trigger of map.triggers ?? []) walkCommands(trigger.commands);
  }

  return {
    game: clone,
    unused: [...Object.keys(strings).filter((k) => !used.has(k)), ...unusedPatches],
    missing: [...missing],
  };
}
