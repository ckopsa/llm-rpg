// Regenerates the README golden path by driving the Sim directly: BFS to the
// nearest unambiguous stand tile for each target, so the published action list
// is verified rather than hand-counted. Run: npx tsx games/trial-of-job/tools/golden-path.mjs
// Drive the Sim directly, auto-routing to each target, so the golden path can
// be regenerated rather than hand-counted.
import { readFileSync } from "node:fs";
import { Sim, validateGame } from "../../../packages/engine/src/index.ts";

const raw = JSON.parse(readFileSync(new URL("../game.json", import.meta.url), "utf8"));
const res = validateGame(raw);
if (!res.ok) throw new Error(res.errors.join("\n"));
const game = res.game;

const sim = new Sim(game);
const actions = [];
const log = [];
const DIRS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };

function act(a) {
  const ev = sim.act(a);
  for (const e of ev) if (/^There is no|^A choice is before you|has nothing to say|nothing next to you/.test(e)) throw new Error(`rejected ${JSON.stringify(a)}: ${e}`);
  actions.push(a.type === "move" ? a.dir : a.type === "choose" ? `choose${a.index + 1}` : a.type);
  log.push(...ev);
  return ev;
}

/** Shortest walking paths from the player to every reachable tile on the
 *  current map. Blocking entities and portal tiles are walls. */
function paths() {
  const out = new Map();
  const start = [sim.state.playerX, sim.state.playerY];
  const blocked = new Set(
    sim.entitiesOn(sim.state.map).filter((e) => e.blocking).map((e) => `${e.x},${e.y}`),
  );
  const portals = new Set(sim.currentMap.portals.map((p) => `${p.x},${p.y}`));
  out.set(start.join(","), []);
  const q = [start];
  while (q.length) {
    const [x, y] = q.shift();
    const path = out.get(`${x},${y}`);
    for (const [dir, [dx, dy]] of Object.entries(DIRS)) {
      const nx = x + dx, ny = y + dy, k = `${nx},${ny}`;
      if (out.has(k)) continue;
      if (nx < 0 || ny < 0 || ny >= sim.height || nx >= sim.width) continue;
      if (!game.legend[sim.currentMap.rows[ny][nx]]?.walkable) continue;
      if (blocked.has(k) || portals.has(k)) continue;
      out.set(k, [...path, dir]);
      q.push([nx, ny]);
    }
  }
  return out;
}

/** Walk to (tx,ty) by the shortest route. */
function goAdjacent(tx, ty) {
  const p = paths().get(`${tx},${ty}`);
  if (!p) return false;
  for (const d of p) act({ type: "move", dir: d });
  return true;
}

/** Which entity an `interact` from (x,y) would actually hit — the sim takes
 *  the FIRST entity at manhattan distance 1, not the one you are facing
 *  (llm-rpg-3pj). Route only to tiles where that resolves to the target. */
function interactTargetFrom(x, y) {
  return sim.entitiesOn(sim.state.map).find(
    (e) => Math.abs(e.x - x) + Math.abs(e.y - y) === 1,
  )?.id;
}

function tend(id) {
  const eff = sim.entitiesOn(sim.state.map).find((x) => x.id === id);
  if (!eff) throw new Error(`${id} not on ${sim.state.map}`);
  const spots = Object.values(DIRS)
    .map(([dx, dy]) => [eff.x - dx, eff.y - dy])
    // The stand tile must exist, be walkable, be unoccupied, and resolve the
    // ambiguous interact (llm-rpg-3pj) to the entity we actually want.
    .filter(([x, y]) => x >= 0 && y >= 0 && x < sim.width && y < sim.height)
    .filter(([x, y]) => game.legend[sim.currentMap.rows[y][x]]?.walkable)
    .filter(([x, y]) => !sim.entitiesOn(sim.state.map).some((e) => e.x === x && e.y === y && e.blocking))
    .filter(([x, y]) => interactTargetFrom(x, y) === id);
  if (!spots.length) throw new Error(`no clean stand tile for ${id}`);
  const reach = paths();
  const best = spots
    .filter(([x, y]) => reach.has(`${x},${y}`))
    .sort((a, b) => reach.get(`${a[0]},${a[1]}`).length - reach.get(`${b[0]},${b[1]}`).length)[0];
  if (!best) throw new Error(`no route to ${id}`);
  goAdjacent(best[0], best[1]);
  act({ type: "interact" });
}

function portalTo(mapId) {
  const p = sim.currentMap.portals.find((q) => q.toMap === mapId);
  const reach = paths();
  const spot = Object.values(DIRS)
    .map(([dx, dy]) => [p.x - dx, p.y - dy])
    .filter(([x, y]) => reach.has(`${x},${y}`))
    .sort((a, b) => reach.get(`${a[0]},${a[1]}`).length - reach.get(`${b[0]},${b[1]}`).length)[0];
  goAdjacent(spot[0], spot[1]);
  const [dx, dy] = [p.x - sim.state.playerX, p.y - sim.state.playerY];
  act({ type: "move", dir: dx === 1 ? "east" : dx === -1 ? "west" : dy === 1 ? "south" : "north" });
}

const day = (...ids) => {
  for (const id of ids) {
    if (id === "@feast") { portalTo("feast-house"); continue; }
    if (id === "@uz") { portalTo("uz-estate"); continue; }
    tend(id);
  }
  tend("altar"); // closes the day
};

day("shepherd-boy", "camel-string");
day("plowman", "wife");
// dusk walks you home from the feast house, so no return portal step
day("@feast", "eldest-son", "sister-at-feast");

console.log("--- after three days ---");
console.log("day:", sim.state.vars.day, "| flags:", sim.state.flags.filter((f) => f.startsWith("tended") || f.startsWith("offering")).join(", "));

// Step off the altar to fire the court of heaven, then east along the road.
goAdjacent(3, 6);
console.log("\n--- court of heaven fired:", sim.state.flags.includes("wager_struck"), "---");

// Walk to the road and east until the calamity.
const before = log.length;
goAdjacent(7, 8);
for (let x = 8; x <= 11 && !sim.state.flags.includes("calamity"); x++) {
  act({ type: "move", dir: "east" });
}

// ── The rest of the game (unchanged by the Act I rebuild) ──────────────────
const choose = (n) => act({ type: "choose", index: n - 1 });
/** interact with `id`, n times. */
function talk(id, n = 1) {
  for (let i = 0; i < n; i++) tend(id);
}

talk("courtyard-dust", 3);                 // tear the robe, shave the head, fall down
talk("ash-wife"); choose(1);               // hold your integrity
goAdjacent(7, 4);                    // step east — the three friends arrive
talk("ash-seat", 7);                       // seven days of silence
for (const who of ["eliphaz", "bildad", "zophar"]) { talk(who); choose(1); }
for (const who of ["eliphaz", "bildad", "zophar"]) { talk(who); choose(1); }
talk("elihu");
for (const w of ["waystone-foundations", "waystone-sea", "waystone-storehouses", "waystone-wild"]) talk(w);
talk("waystone-last"); choose(1);          // "I lay my hand on my mouth"
for (const who of ["eliphaz-restored", "bildad-restored", "zophar-restored"]) talk(who);
goAdjacent(7, 7);                    // walk into the yard — restoration
talk("household-gate");                    // stand in the gate

console.log("ending:", JSON.stringify(sim.state.ending?.id), "| turns:", actions.length);
console.log("\nGOLDEN PATH:\n" + actions.join(","));
