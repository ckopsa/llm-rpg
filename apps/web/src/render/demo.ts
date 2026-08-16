/**
 * Standalone sprite/renderer demo (served at /sprites.html).
 *
 * Self-contained: no engine imports. Arrow keys / WASD walk the player with
 * tweening, walk cycles, camera follow, animated water and tall grass; static
 * NPCs stand around; a strip below cycles through the battler roster.
 */
import { loadManifest, type LoadedManifest } from "./manifest";
import {
  DIR_DELTAS,
  Renderer,
  drawSpriteFrame,
  type Direction,
  type MapData,
  type TileGrid,
} from "./renderer";

const MAP_W = 28;
const MAP_H = 20;

/** Tile ids the player cannot enter (demo-level rule, not renderer logic). */
const SOLID = new Set([
  "water",
  "water_deep",
  "rock",
  "cave",
  "tree_nw",
  "tree_ne",
  "tree_sw",
  "tree_se",
  "house_roof_nw",
  "house_roof_ne",
  "house_roof_sw",
  "house_roof_se",
  "house_wall_w",
  "house_wall_e",
]);

function buildMap(): MapData {
  const ground: TileGrid = [];
  const decor: TileGrid = [];
  for (let y = 0; y < MAP_H; y++) {
    ground.push(new Array(MAP_W).fill("grass"));
    decor.push(new Array(MAP_W).fill(null));
  }

  // Northern cliff border.
  for (let x = 0; x < MAP_W; x++) ground[0][x] = "rock";
  ground[0][20] = "cave"; // a cave mouth in the cliff

  // Water along the east edge: animated shoreline, deep water beyond.
  for (let y = 0; y < MAP_H; y++) {
    ground[y][23] = "water";
    for (let x = 24; x < MAP_W; x++) ground[y][x] = "water_deep";
  }

  // Path: horizontal road with a branch up to the house.
  for (let x = 1; x <= 22; x++) ground[10][x] = "path";
  for (let y = 6; y <= 10; y++) ground[y][4] = "path";
  ground[10][12] = "flowers";
  ground[6][5] = "flowers";

  // Sandy cove by the shore.
  for (let y = 12; y <= 14; y++) for (let x = 20; x <= 22; x++) ground[y][x] = "sand";

  // Tall grass patch (wild encounters live here someday) — transparent
  // overlay tufts drawn on the decor layer above plain grass.
  for (let y = 12; y <= 16; y++) for (let x = 8; x <= 13; x++) decor[y][x] = "tall_grass";

  // House (2 wide x 3 tall) on the ground north of the path branch.
  const hx = 3;
  const hy = 3;
  decor[hy][hx] = "house_roof_nw";
  decor[hy][hx + 1] = "house_roof_ne";
  decor[hy + 1][hx] = "house_roof_sw";
  decor[hy + 1][hx + 1] = "house_roof_se";
  decor[hy + 2][hx] = "house_wall_w";
  decor[hy + 2][hx + 1] = "house_wall_e";

  // Trees: a western treeline plus scattered pairs.
  const tree = (x: number, y: number) => {
    decor[y][x] = "tree_nw";
    decor[y][x + 1] = "tree_ne";
    decor[y + 1][x] = "tree_sw";
    decor[y + 1][x + 1] = "tree_se";
  };
  for (let y = 1; y < MAP_H - 2; y += 2) tree(0, y);
  tree(8, 2);
  tree(11, 3);
  tree(16, 5);
  tree(18, 2);
  tree(14, 13);
  tree(3, 15);
  tree(6, 17);
  tree(16, 17);

  return { layers: [ground, decor], width: MAP_W, height: MAP_H };
}

function isSolid(map: MapData, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return true;
  return map.layers.some((layer) => {
    const t = layer[y][x];
    return t != null && SOLID.has(t);
  });
}

const KEY_DIRS: Record<string, Direction> = {
  ArrowUp: "north",
  ArrowDown: "south",
  ArrowLeft: "west",
  ArrowRight: "east",
  KeyW: "north",
  KeyS: "south",
  KeyA: "west",
  KeyD: "east",
};

function setupOverworld(loaded: LoadedManifest): { renderer: Renderer; map: MapData } {
  const canvas = document.getElementById("game") as HTMLCanvasElement;
  const renderer = new Renderer(canvas, loaded, {
    viewportTilesX: 20,
    viewportTilesY: 15,
    scale: 3,
    walkMs: 120,
  });
  const map = buildMap();
  renderer.setMap(map);

  renderer.addEntity({ id: "player", spriteId: "player", x: 16, y: 10, facing: "south" });
  renderer.addEntity({ id: "elder", spriteId: "elder", x: 5, y: 6, facing: "south" });
  renderer.addEntity({ id: "guard", spriteId: "guard", x: 15, y: 10, facing: "west" });
  renderer.addEntity({ id: "villager", spriteId: "npc1", x: 21, y: 13, facing: "east" });
  renderer.followCamera("player");
  renderer.start();
  return { renderer, map };
}

function setupBattlerStrip(loaded: LoadedManifest): void {
  const canvas = document.getElementById("battlers") as HTMLCanvasElement;
  const ids = Object.keys(loaded.manifest.sprites)
    .filter((id) => id.startsWith("battler_"))
    .sort();
  const SHOWN = 8;
  const CELL_W = 104;
  const CELL_H = 84;
  const SCALE = 2;
  canvas.width = SHOWN * CELL_W * SCALE;
  canvas.height = CELL_H * SCALE;
  const ctx = canvas.getContext("2d")!;

  const start = performance.now();
  const frame = () => {
    const t = (performance.now() - start) / 1000;
    ctx.fillStyle = "#1c2331";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Rotate which 8 battlers are on show every 2.5s; each plays its idle anim.
    const offset = Math.floor(t / 2.5) % ids.length;
    for (let i = 0; i < SHOWN; i++) {
      const id = ids[(offset + i) % ids.length];
      const sprite = loaded.manifest.sprites[id];
      const sheet = loaded.sheets.get(sprite.sheet)!;
      const dx = i * CELL_W * SCALE + ((CELL_W - sheet.def.tileW) / 2) * SCALE;
      const dy = (CELL_H - 2 - sheet.def.tileH) * SCALE;
      drawSpriteFrame(ctx, loaded, id, "idle", t, dx, dy, SCALE);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

async function main(): Promise<void> {
  const status = document.getElementById("status")!;
  let loaded: LoadedManifest;
  try {
    loaded = await loadManifest(`${import.meta.env.BASE_URL}assets/manifest.json`);
  } catch (err) {
    status.textContent = String(err);
    status.classList.add("error");
    throw err;
  }
  status.remove();

  const { renderer, map } = setupOverworld(loaded);
  setupBattlerStrip(loaded);

  // Input: track held direction keys; issue one-tile walks when idle.
  const held: Direction[] = [];
  window.addEventListener("keydown", (ev) => {
    const dir = KEY_DIRS[ev.code];
    if (!dir) return;
    ev.preventDefault();
    if (!held.includes(dir)) held.unshift(dir);
  });
  window.addEventListener("keyup", (ev) => {
    const dir = KEY_DIRS[ev.code];
    if (!dir) return;
    const i = held.indexOf(dir);
    if (i >= 0) held.splice(i, 1);
  });

  const tick = () => {
    const dir = held[0];
    if (dir && !renderer.isMoving("player")) {
      const pos = renderer.getEntityPos("player")!;
      const [dx, dy] = DIR_DELTAS[dir];
      if (isSolid(map, pos.x + dx, pos.y + dy)) {
        renderer.face("player", dir); // turn in place when blocked
      } else {
        renderer.walk("player", dir);
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

main();
