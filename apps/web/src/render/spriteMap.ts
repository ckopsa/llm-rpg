/**
 * Sprite mapping: connects a game's abstract legend/catalog to concrete
 * sprite ids in the loaded manifest.
 *
 * The mapping document (games/<game>/sprites.json) has four sections:
 *   tiles:    tile NAME (from the game legend) -> sprite id, or
 *             { base?, overlay } for transparent overlay tiles (tall grass)
 *   species:  species id -> battler sprite id
 *   entities: entity id -> character sprite id
 *   player:   character sprite id
 *
 * The loader is deliberately forgiving: a missing mapping, or a mapping that
 * names a sprite the manifest doesn't have, degrades to the game's emoji
 * glyph (rendered with fillText) instead of crashing. Bad references are
 * reported once via console.warn so authors notice.
 */
import { z } from "zod";
import type { LoadedManifest } from "./manifest";

/** Prefix marking a "sprite id" that is really an emoji glyph to fillText. */
export const GLYPH_PREFIX = "glyph:";

export function glyphSprite(glyph: string): string {
  return GLYPH_PREFIX + glyph;
}

export function isGlyphSprite(id: string): boolean {
  return id.startsWith(GLYPH_PREFIX);
}

const TileMappingSchema = z.union([
  z.string().min(1),
  z.object({
    /** Full tile drawn beneath the overlay. Defaults to nothing. */
    base: z.string().min(1).optional(),
    /** Transparent sprite drawn above the base (e.g. tall-grass tufts). */
    overlay: z.string().min(1),
  }),
]);

export const SpriteMapSchema = z.object({
  tiles: z.record(TileMappingSchema).default({}),
  species: z.record(z.string().min(1)).default({}),
  entities: z.record(z.string().min(1)).default({}),
  player: z.string().min(1).optional(),
});

export type SpriteMapDoc = z.infer<typeof SpriteMapSchema>;

export interface ResolvedTile {
  /** Ground-layer sprite id (may be a glyph: fallback). */
  ground: string;
  /** Optional overlay sprite id drawn above the ground. */
  overlay: string | null;
}

export class SpriteMap {
  private tiles = new Map<string, ResolvedTile>();
  private species = new Map<string, string>();
  private entities = new Map<string, string>();
  private playerId: string | null;

  constructor(
    tiles: Map<string, ResolvedTile>,
    species: Map<string, string>,
    entities: Map<string, string>,
    playerId: string | null,
  ) {
    this.tiles = tiles;
    this.species = species;
    this.entities = entities;
    this.playerId = playerId;
  }

  /** Sprites for a tile by legend name; falls back to its emoji glyph. */
  tileSprites(tileName: string, glyph: string): ResolvedTile {
    return this.tiles.get(tileName) ?? { ground: glyphSprite(glyph), overlay: null };
  }

  /** Battler sprite id for a species, or null when unmapped. */
  speciesSprite(speciesId: string): string | null {
    return this.species.get(speciesId) ?? null;
  }

  /** Character sprite for an entity by id; falls back to its emoji glyph. */
  entitySprite(entityId: string, glyph: string): string {
    return this.entities.get(entityId) ?? glyphSprite(glyph);
  }

  /** Character sprite for the player; falls back to the player glyph. */
  playerSprite(glyph: string): string {
    return this.playerId ?? glyphSprite(glyph);
  }
}

/**
 * Parse a sprite-map document and resolve it against a loaded manifest.
 * Structural errors throw (the file is malformed); dangling sprite ids only
 * warn and fall back to glyph rendering, so a partial map never crashes.
 */
export function loadSpriteMap(data: unknown, loaded: LoadedManifest): SpriteMap {
  const result = SpriteMapSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  at ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(`Sprite map failed schema validation:\n${issues}`);
  }
  const doc = result.data;
  const known = (id: string) => Boolean(loaded.manifest.sprites[id]);
  const warnings: string[] = [];
  const checked = (context: string, id: string): string | null => {
    if (known(id)) return id;
    warnings.push(`${context}: sprite id "${id}" is not in the manifest — using glyph fallback`);
    return null;
  };

  const tiles = new Map<string, ResolvedTile>();
  for (const [name, mapping] of Object.entries(doc.tiles)) {
    if (typeof mapping === "string") {
      const id = checked(`tiles.${name}`, mapping);
      if (id) tiles.set(name, { ground: id, overlay: null });
      continue;
    }
    const overlay = checked(`tiles.${name}.overlay`, mapping.overlay);
    const base = mapping.base ? checked(`tiles.${name}.base`, mapping.base) : null;
    if (overlay) tiles.set(name, { ground: base ?? overlay, overlay: base ? overlay : null });
    else if (base) tiles.set(name, { ground: base, overlay: null });
  }

  const species = new Map<string, string>();
  for (const [sid, spriteId] of Object.entries(doc.species)) {
    const id = checked(`species.${sid}`, spriteId);
    if (id) species.set(sid, id);
  }

  const entities = new Map<string, string>();
  for (const [eid, spriteId] of Object.entries(doc.entities)) {
    const id = checked(`entities.${eid}`, spriteId);
    if (id) entities.set(eid, id);
  }

  const playerId = doc.player ? checked("player", doc.player) : null;

  if (warnings.length > 0) {
    console.warn(`Sprite map: ${warnings.length} unresolved mapping(s):\n` + warnings.join("\n"));
  }
  return new SpriteMap(tiles, species, entities, playerId);
}
