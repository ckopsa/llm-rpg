import type { Entity, Game } from "@llm-rpg/engine";

/**
 * Static reachability analyzer — the fast build-critic. Pure BFS from the
 * player start through walkable tiles and portals; no Sim, no battles, no
 * encounters, no randomness. Runs in milliseconds even on Emberwood, so a
 * forge loop can call it after every edit.
 *
 * Two passes over the same graph:
 *  - OPTIMISTIC: entities with `passableWithFlag` are treated as already
 *    open (the flag may become obtainable), so this pass answers "could a
 *    player who earns every flag get here?". Anything unreachable here is a
 *    hard authoring bug.
 *  - PESSIMISTIC: blocking entities never open (flags are never earned).
 *    The delta between the passes shows exactly which content sits behind
 *    flag gates — expected for badge gates, alarming for your starter town.
 */

export interface MapReachability {
  id: string;
  optimistic: boolean;
  pessimistic: boolean;
}

export interface EntityRef {
  id: string;
  name: string;
  map: string;
  x: number;
  y: number;
}

export interface PortalIssue {
  map: string;
  /** Index into maps[map].portals. */
  index: number;
  x: number;
  y: number;
  toMap: string;
  toX: number;
  toY: number;
  reason: string;
}

export interface WildZoneIssue {
  map: string;
  reason: string;
}

export interface ReachabilityReport {
  start: { map: string; x: number; y: number };
  /** Every map, in definition order, with per-pass reachability. */
  maps: MapReachability[];
  /** Maps unreachable even optimistically — hard bugs. */
  unreachableMaps: string[];
  /** Maps reachable optimistically but not pessimistically: flag-gated. */
  flagGatedMaps: string[];
  /** Entities no reachable tile is adjacent to, even optimistically —
   *  `interact` can never target them. */
  unreachableEntities: EntityRef[];
  /** Entities interactable only in the optimistic pass. */
  flagGatedEntities: EntityRef[];
  /** Dead doors (optimistic pass): portals whose source tile is never
   *  entered from the start — so their destination is never reached through
   *  them — plus portals with an invalid destination. */
  orphanPortals: PortalIssue[];
  /** Encounter zones that can never fire: no reachable wild tile. */
  wildZoneIssues: WildZoneIssue[];
  verdict: "pass" | "fail";
  summary: string;
}

const DIRS: readonly [number, number][] = [
  [0, -1],
  [0, 1],
  [1, 0],
  [-1, 0],
];

interface Pass {
  /** Reachable tile coordinates per map ("x,y" keys). */
  reach: Map<string, Set<string>>;
  /** Portal source tiles the BFS actually stepped onto ("map:x,y" keys). */
  traversedPortals: Set<string>;
}

/** One BFS pass. Portal source tiles are traversed as edges (the player
 *  never stands on them), so the DESTINATION tile is what gets marked
 *  reachable — mirroring Sim.doMove's transfer. */
function reachableTiles(game: Game, optimistic: boolean): Pass {
  const grids = new Map<string, string[][]>();
  for (const [id, def] of Object.entries(game.maps)) {
    grids.set(id, def.rows.map((r) => [...r]));
  }
  const blocked = (e: Entity): boolean =>
    e.blocking && !(optimistic && e.passableWithFlag !== undefined);

  const reach = new Map<string, Set<string>>(
    Object.keys(game.maps).map((id) => [id, new Set<string>()]),
  );
  const traversedPortals = new Set<string>();
  const start = game.player;
  const startRows = grids.get(start.map);
  if (!startRows || start.y >= startRows.length || start.x >= startRows[0].length) {
    // Invalid start — validateGame reports this; nothing is reachable.
    return { reach, traversedPortals };
  }
  reach.get(start.map)!.add(`${start.x},${start.y}`);
  const queue: [string, number, number][] = [[start.map, start.x, start.y]];
  let head = 0;
  while (head < queue.length) {
    const [mapId, x, y] = queue[head++];
    const def = game.maps[mapId];
    const rows = grids.get(mapId)!;
    for (const [dx, dy] of DIRS) {
      let nm = mapId;
      let nx = x + dx;
      let ny = y + dy;
      if (ny < 0 || ny >= rows.length || nx < 0 || nx >= rows[0].length) continue;
      const tile = game.legend[rows[ny][nx]];
      if (!tile?.walkable) continue;
      const ent = def.entities.find((e) => e.x === nx && e.y === ny);
      if (ent && blocked(ent)) continue;
      const portal = def.portals.find((p) => p.x === nx && p.y === ny);
      if (portal) {
        traversedPortals.add(`${mapId}:${portal.x},${portal.y}`);
        const destRows = grids.get(portal.toMap);
        if (
          !destRows ||
          portal.toY >= destRows.length ||
          portal.toX >= destRows[0].length
        ) {
          continue; // broken destination — reported as an orphan portal
        }
        nm = portal.toMap;
        nx = portal.toX;
        ny = portal.toY;
      }
      const key = `${nx},${ny}`;
      const set = reach.get(nm)!;
      if (set.has(key)) continue;
      set.add(key);
      queue.push([nm, nx, ny]);
    }
  }
  return { reach, traversedPortals };
}

function interactable(reach: Map<string, Set<string>>, mapId: string, e: Entity): boolean {
  const set = reach.get(mapId)!;
  return DIRS.some(([dx, dy]) => set.has(`${e.x + dx},${e.y + dy}`));
}

export function analyzeReachability(game: Game): ReachabilityReport {
  const optimisticPass = reachableTiles(game, true);
  const pessimisticPass = reachableTiles(game, false);
  const optimistic = optimisticPass.reach;
  const pessimistic = pessimisticPass.reach;

  const maps: MapReachability[] = Object.keys(game.maps).map((id) => ({
    id,
    optimistic: optimistic.get(id)!.size > 0,
    pessimistic: pessimistic.get(id)!.size > 0,
  }));
  const unreachableMaps = maps.filter((m) => !m.optimistic).map((m) => m.id);
  const flagGatedMaps = maps.filter((m) => m.optimistic && !m.pessimistic).map((m) => m.id);

  const unreachableEntities: EntityRef[] = [];
  const flagGatedEntities: EntityRef[] = [];
  let entitiesTotal = 0;
  for (const [mapId, def] of Object.entries(game.maps)) {
    for (const e of def.entities) {
      entitiesTotal += 1;
      const ref: EntityRef = { id: e.id, name: e.name, map: mapId, x: e.x, y: e.y };
      if (!interactable(optimistic, mapId, e)) unreachableEntities.push(ref);
      else if (!interactable(pessimistic, mapId, e)) flagGatedEntities.push(ref);
    }
  }

  const orphanPortals: PortalIssue[] = [];
  for (const [mapId, def] of Object.entries(game.maps)) {
    for (const [index, p] of def.portals.entries()) {
      const issue = (reason: string) =>
        orphanPortals.push({
          map: mapId,
          index,
          x: p.x,
          y: p.y,
          toMap: p.toMap,
          toX: p.toX,
          toY: p.toY,
          reason,
        });
      const entered = optimisticPass.traversedPortals.has(`${mapId}:${p.x},${p.y}`);
      const dest = optimistic.get(p.toMap);
      const destRows = game.maps[p.toMap]?.rows;
      if (!dest || !destRows) {
        issue(
          `destination map "${p.toMap}" is not defined${entered ? "" : "; the portal is also never entered from the player start"}`,
        );
      } else if (p.toY >= destRows.length || p.toX >= [...destRows[0]].length) {
        issue(
          `destination (${p.toX}, ${p.toY}) is outside map "${p.toMap}"`,
        );
      } else if (!entered) {
        const destReached = dest.has(`${p.toX},${p.toY}`);
        issue(
          `never entered from the player start — its source tile can't be stepped onto${destReached ? "" : `, and its destination (${p.toX}, ${p.toY}) on "${p.toMap}" is unreachable`}`,
        );
      }
    }
  }

  const wildZoneIssues: WildZoneIssue[] = [];
  for (const [mapId, def] of Object.entries(game.maps)) {
    if (!def.encounters) continue;
    const rows = def.rows.map((r) => [...r]);
    const reach = optimistic.get(mapId)!;
    let wildTiles = 0;
    let reachableWild = 0;
    rows.forEach((row, y) =>
      row.forEach((ch, x) => {
        if (!game.legend[ch]?.wild) return;
        wildTiles += 1;
        if (reach.has(`${x},${y}`)) reachableWild += 1;
      }),
    );
    if (wildTiles === 0) {
      wildZoneIssues.push({
        map: mapId,
        reason: "encounters zone defined but the map has no wild tiles",
      });
    } else if (reachableWild === 0) {
      wildZoneIssues.push({
        map: mapId,
        reason: `none of the map's ${wildTiles} wild tiles are reachable from the player start — the encounter zone can never fire`,
      });
    }
  }

  const problems =
    unreachableMaps.length +
    unreachableEntities.length +
    orphanPortals.length +
    wildZoneIssues.length;
  const verdict: "pass" | "fail" = problems === 0 ? "pass" : "fail";
  const mapCount = maps.length;
  const pessimisticCount = maps.filter((m) => m.pessimistic).length;
  const summary =
    verdict === "pass"
      ? `all ${mapCount} maps reachable and all ${entitiesTotal} entities interactable from the start` +
        (flagGatedMaps.length > 0
          ? `; pessimistic pass reaches ${pessimisticCount}/${mapCount} maps (${flagGatedMaps.length} flag-gated: ${flagGatedMaps.join(", ")})`
          : "; no flag gates detected")
      : `${unreachableMaps.length} unreachable map(s), ${unreachableEntities.length} unreachable entit(y/ies), ${orphanPortals.length} orphan portal(s), ${wildZoneIssues.length} dead wild zone(s)`;

  return {
    start: { map: game.player.map, x: game.player.x, y: game.player.y },
    maps,
    unreachableMaps,
    flagGatedMaps,
    unreachableEntities,
    flagGatedEntities,
    orphanPortals,
    wildZoneIssues,
    verdict,
    summary,
  };
}
