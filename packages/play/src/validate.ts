import { readFileSync } from "node:fs";
import { validateGame } from "@llm-rpg/engine";
import { resolveGamePath } from "./load.js";

const path = resolveGamePath(process.argv[2]);
const raw = JSON.parse(readFileSync(path, "utf8"));
const result = validateGame(raw);
if (result.ok) {
  const g = result.game!;
  const maps = Object.keys(g.maps);
  const entityCount = Object.values(g.maps).reduce((n, m) => n + m.entities.length, 0);
  console.log(
    `✓ ${path} is a valid game: "${g.meta.title}" (${maps.length} map(s): ${maps.join(", ")}; ${entityCount} entities)`,
  );
  for (const w of result.warnings) console.warn(`  ⚠ ${w}`);
} else {
  console.error(`✗ ${path} has ${result.errors.length} problem(s):`);
  for (const e of result.errors) console.error(`  - ${e}`);
  process.exit(1);
}
