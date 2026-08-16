import type { Sim } from "./sim.js";
import { speciesById } from "./catalog.js";
import { describeBattle } from "./battleObserve.js";

/**
 * The text observer is the AI-facing "renderer": everything a player needs
 * to act, as a compact string. The web renderer draws the same state for
 * humans; neither view knows anything the other doesn't.
 */

export function renderGrid(sim: Sim): string {
  // Effective entities: overlays (moved/spawned/removed) and variant glyphs.
  const glyphs = new Map<string, string>();
  for (const e of sim.entitiesOn(sim.state.map)) {
    const key = `${e.x},${e.y}`;
    if (!glyphs.has(key)) glyphs.set(key, e.glyph);
  }
  const lines: string[] = [];
  for (let y = 0; y < sim.height; y++) {
    let line = "";
    for (let x = 0; x < sim.width; x++) {
      if (x === sim.state.playerX && y === sim.state.playerY) {
        line += sim.game.player.glyph;
        continue;
      }
      // Portals render as their underlying tile — they look like open ground.
      line += glyphs.get(`${x},${y}`) ?? sim.tileAt(x, y).glyph;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function describeDirection(dx: number, dy: number): string {
  const parts: string[] = [];
  if (dy < 0) parts.push(`${-dy} north`);
  if (dy > 0) parts.push(`${dy} south`);
  if (dx > 0) parts.push(`${dx} east`);
  if (dx < 0) parts.push(`${-dx} west`);
  return parts.join(", ") || "here";
}

export function describe(sim: Sim): string {
  const { state, game } = sim;
  const lines: string[] = [];
  lines.push(`${game.meta.title} — turn ${state.turn}`);
  lines.push(`Goal: ${game.meta.goal}`);
  if (state.won) lines.push("Status: WON");
  else if (state.ending) lines.push(`Status: ENDED — ${state.ending.id}`);
  lines.push(`Map: ${state.map}`);
  lines.push(`You are at (${state.playerX}, ${state.playerY}).`);
  // Party lines are catalog-bound (a catalog-free narrative game has no
  // party); money is always available.
  if (state.party.length > 0) {
    const summary = state.party
      .map((c) => {
        const species = speciesById(game.catalog!, c.speciesId);
        return `${species.name} Lv${c.level} ${c.hp}/${c.maxHp} HP`;
      })
      .join(" · ");
    lines.push(`Party: ${summary}`);
  }
  lines.push(`Money: ${state.money}`);

  const nearby = sim
    .entitiesOn(state.map)
    .map((e) => ({ e, dx: e.x - state.playerX, dy: e.y - state.playerY }))
    .filter(({ dx, dy }) => Math.abs(dx) + Math.abs(dy) <= 6)
    .sort((a, b) => Math.abs(a.dx) + Math.abs(a.dy) - (Math.abs(b.dx) + Math.abs(b.dy)));
  if (nearby.length > 0) {
    lines.push("Nearby:");
    for (const { e, dx, dy } of nearby) {
      const battler =
        e.trainer && !state.flags.includes(e.trainer.defeatFlag)
          ? " (a trainer, looking for a battle)"
          : "";
      lines.push(`  ${e.glyph} ${e.name} — ${describeDirection(dx, dy)}${battler}`);
    }
  }

  if (sim.currentMap.portals.length > 0) {
    lines.push("Exits:");
    for (const p of sim.currentMap.portals) {
      const dx = p.x - state.playerX;
      const dy = p.y - state.playerY;
      lines.push(`  Portal to ${p.toMap} — ${describeDirection(dx, dy)}`);
    }
  }

  if (state.flags.length > 0) lines.push(`Flags: ${state.flags.join(", ")}`);
  const varEntries = Object.entries(state.vars);
  if (varEntries.length > 0) {
    lines.push(
      `Vars: ${varEntries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")}`,
    );
  }
  if (state.lastEvents.length > 0) {
    lines.push("Last events:");
    // Multi-line events (passages) print in full, every line indented —
    // never truncated into a single window line.
    for (const ev of state.lastEvents) {
      for (const line of ev.split("\n")) lines.push(`  ${line}`);
    }
  }
  // A pending choice replaces the action list: only choose1..N are valid.
  const pc = state.pendingChoice;
  if (pc) {
    lines.push(`Choice: ${pc.prompt}`);
    pc.options.forEach((o, i) => lines.push(`  ${i + 1}) ${o.label}`));
    lines.push(`Actions: choose1..choose${pc.options.length}`);
  } else {
    lines.push("Actions: north | south | east | west | interact");
  }
  return lines.join("\n");
}

export function observe(sim: Sim): string {
  // A battle replaces the overworld view entirely: it is the whole screen.
  if (sim.battle) {
    // A battle can only exist in a catalog game.
    return describeBattle(sim.game.catalog!, sim.battle, sim.state.inventory);
  }
  return `${renderGrid(sim)}\n\n${describe(sim)}`;
}
