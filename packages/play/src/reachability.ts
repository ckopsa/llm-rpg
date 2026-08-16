import type { Command, Entity, Game, Interaction, Trigger } from "@llm-rpg/engine";

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
 *
 * `teleport_player` commands are treated as EDGES: when a teleport's host
 * (the entity whose dialogue carries it, or the map trigger) is reachable in
 * a pass, its destination becomes reachable too, iterated to a fixpoint.
 * The optimistic pass fires every teleport; the pessimistic pass only
 * ungated ones (no `when`/`requiresFlag` anywhere on the command's chain).
 *
 * STATED LIMITATION (reported in `limitations`, not silently wrong): the
 * analysis is static. Runtime world overlays — `spawn_entity` blockers,
 * `set_tile` repaints that open or close paths, `remove_entity`/`move_entity`
 * — are NOT simulated. A game that relies on them should be verified with
 * the explore playtest, which runs the real sim.
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

/** One `teleport_player` command found in the game, used as a BFS edge. */
export interface TeleportEdge {
  /** Where the command lives, e.g. "entity ferryman on shore" or
   *  "trigger court-scene on court". */
  source: string;
  toMap: string;
  toX: number;
  toY: number;
  /** True when a `when`/`requiresFlag` gate sits anywhere on the command's
   *  chain (command, interaction, trigger, choice option) — gated teleports
   *  fire only in the optimistic pass. */
  gated: boolean;
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
  /** Every teleport_player command, with its host site and gating. Each is
   *  a reachability edge when its host is reachable. */
  teleports: TeleportEdge[];
  /** Honest boundaries of the static analysis for THIS game: named dynamic
   *  features (set_tile, spawn_entity, ...) it does not simulate. Empty when
   *  the game uses none of them. */
  limitations: string[];
  verdict: "pass" | "fail";
  summary: string;
}

const DIRS: readonly [number, number][] = [
  [0, -1],
  [0, 1],
  [1, 0],
  [-1, 0],
];

/** Where a teleport command lives — what must be reachable for it to fire. */
type TeleportHost =
  | { kind: "entity"; map: string; x: number; y: number }
  | { kind: "trigger"; map: string; on: "enter" | "step"; tiles?: { x: number; y: number }[] };

interface InternalTeleport extends TeleportEdge {
  host: TeleportHost;
}

/** Dynamic-overlay command types the static analysis cannot simulate. */
const DYNAMIC_COMMANDS = ["set_tile", "spawn_entity", "remove_entity", "move_entity"] as const;

interface CommandScan {
  teleports: InternalTeleport[];
  /** Which DYNAMIC_COMMANDS the game actually uses. */
  dynamicUsed: Set<string>;
}

/** Walk every command list (interactions, rewardCommands, triggers, nested
 *  choice options and spawn_entity payload dialogue) once: harvest
 *  teleport_player edges with their host + gating, and note dynamic-overlay
 *  commands for the limitations report. */
function scanCommands(game: Game): CommandScan {
  const teleports: InternalTeleport[] = [];
  const dynamicUsed = new Set<string>();

  const walk = (commands: Command[], gated: boolean, host: TeleportHost, source: string): void => {
    for (const cmd of commands) {
      const g = gated || cmd.when !== undefined;
      if ((DYNAMIC_COMMANDS as readonly string[]).includes(cmd.type)) dynamicUsed.add(cmd.type);
      if (cmd.type === "teleport_player") {
        teleports.push({ source, toMap: cmd.mapId, toX: cmd.x, toY: cmd.y, gated: g, host });
      }
      if (cmd.type === "choice") {
        for (const o of cmd.options) walk(o.commands, g || o.when !== undefined, host, source);
      }
      if (cmd.type === "spawn_entity") {
        // A spawned entity's dialogue needs the spawn to have run first:
        // keep the spawn site as host and treat it as gated (conservative
        // for the pessimistic pass).
        walkEntity(
          cmd.entity as Entity,
          true,
          host,
          `${source} (spawned ${cmd.entity.id})`,
        );
      }
    }
  };

  const walkEntity = (e: Entity, gated: boolean, host: TeleportHost, source: string): void => {
    for (const i of e.interactions as Interaction[]) {
      const g = gated || i.when !== undefined || i.requiresFlag !== undefined;
      walk(i.commands, g, host, source);
    }
    if (e.trainer?.rewardCommands) {
      // Reward commands need a battle won first — gated, conservatively.
      walk(e.trainer.rewardCommands, true, host, source);
    }
  };

  for (const [mapId, def] of Object.entries(game.maps)) {
    for (const e of def.entities) {
      walkEntity(e, false, { kind: "entity", map: mapId, x: e.x, y: e.y }, `entity ${e.id} on ${mapId}`);
    }
    for (const t of (def.triggers ?? []) as Trigger[]) {
      const host: TeleportHost = {
        kind: "trigger",
        map: mapId,
        on: t.on,
        ...(t.tiles !== undefined ? { tiles: t.tiles } : {}),
      };
      walk(t.commands, t.when !== undefined, host, `trigger ${t.id} on ${mapId}`);
    }
  }
  return { teleports, dynamicUsed };
}

interface Pass {
  /** Reachable tile coordinates per map ("x,y" keys). */
  reach: Map<string, Set<string>>;
  /** Portal source tiles the BFS actually stepped onto ("map:x,y" keys). */
  traversedPortals: Set<string>;
}

/** One BFS pass. Portal source tiles are traversed as edges (the player
 *  never stands on them), so the DESTINATION tile is what gets marked
 *  reachable — mirroring Sim.doMove's transfer. Teleport edges whose host
 *  becomes reachable seed further BFS rounds, to a fixpoint; the pessimistic
 *  pass uses only ungated teleports. */
function reachableTiles(game: Game, optimistic: boolean, teleports: InternalTeleport[]): Pass {
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
  const drain = (): void => {
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
  };
  drain();

  /** Whether a teleport's host site is reachable under the current pass. */
  const hostActive = (h: TeleportHost): boolean => {
    const set = reach.get(h.map);
    if (!set || set.size === 0) return false;
    if (h.kind === "entity") {
      return DIRS.some(([dx, dy]) => set.has(`${h.x + dx},${h.y + dy}`));
    }
    if (h.on === "enter") return true;
    return (h.tiles ?? []).some((t) => set.has(`${t.x},${t.y}`));
  };

  const usable = teleports.filter((t) => optimistic || !t.gated);
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const t of usable) {
      const destRows = grids.get(t.toMap);
      if (!destRows || t.toY >= destRows.length || t.toX >= destRows[0].length) continue;
      const set = reach.get(t.toMap)!;
      const key = `${t.toX},${t.toY}`;
      if (set.has(key)) continue;
      if (!hostActive(t.host)) continue;
      set.add(key);
      queue.push([t.toMap, t.toX, t.toY]);
      progressed = true;
    }
    if (progressed) drain();
  }
  return { reach, traversedPortals };
}

function interactable(reach: Map<string, Set<string>>, mapId: string, e: Entity): boolean {
  const set = reach.get(mapId)!;
  return DIRS.some(([dx, dy]) => set.has(`${e.x + dx},${e.y + dy}`));
}

export function analyzeReachability(game: Game): ReachabilityReport {
  const scan = scanCommands(game);
  const optimisticPass = reachableTiles(game, true, scan.teleports);
  const pessimisticPass = reachableTiles(game, false, scan.teleports);
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

  const teleports: TeleportEdge[] = scan.teleports.map(({ source, toMap, toX, toY, gated }) => ({
    source,
    toMap,
    toX,
    toY,
    gated,
  }));
  const limitations: string[] = [];
  if (scan.dynamicUsed.size > 0) {
    limitations.push(
      `this game uses ${[...scan.dynamicUsed].sort().join(", ")} — the analysis is static and does NOT simulate runtime world overlays (repainted tiles, spawned/moved/removed entities), so a cutscene that opens or walls off a path is not modeled here; verify with the explore playtest, which runs the real sim`,
    );
  }
  if (teleports.length > 0) {
    limitations.push(
      "teleport_player commands are modeled as edges: a destination counts as reachable when the teleport's host entity/trigger is reachable; when-gated teleports fire only in the optimistic pass",
    );
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
    teleports,
    limitations,
    verdict,
    summary,
  };
}
