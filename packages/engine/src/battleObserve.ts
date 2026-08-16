import type { Catalog, Item, Species } from "./catalog.js";
import { itemById, moveById, speciesById } from "./catalog.js";
import type { Battle, Combatant } from "./battle.js";
import type { InventoryEntry } from "./schema.js";

/**
 * The battle observer is the AI-facing battle "renderer": everything a
 * player needs to choose an action, as a compact string. Mirrors observe.ts:
 * state in, text out, no hidden information.
 *
 * Pass the player's inventory to list usable items (item1..itemN) and to
 * decide whether "catch" is offered. Action words match parseAction:
 * move1..move4, switch1..switch6, item1..item9, catch, run.
 */

export function hpBar(hp: number, maxHp: number, width = 10): string {
  const filled =
    hp <= 0 ? 0 : Math.max(1, Math.round((width * hp) / Math.max(1, maxHp)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function combatantLine(species: Species, c: Combatant): string {
  const types = species.types.join("/");
  return `${species.glyph} ${species.name} Lv${c.level} [${types}] ${hpBar(c.hp, c.maxHp)} ${c.hp}/${c.maxHp} HP`;
}

function itemLabel(item: Item): string {
  if (item.kind === "heal") return `${item.name} (heals ${item.amount} HP)`;
  return `${item.name} (capture, ${item.ballMod}x)`;
}

const OUTCOME_TEXT = {
  player_won: "you won",
  enemy_won: "you lost",
  fled: "you fled",
  captured: "caught it",
} as const;

export function describeBattle(
  catalog: Catalog,
  battle: Battle,
  inventory: InventoryEntry[] = [],
): string {
  const s = battle.state;
  const lines: string[] = [];
  const mode = s.mode === "wild" ? "Wild battle" : "Trainer battle";
  lines.push(`${mode} — round ${s.round}`);

  const enemy = s.enemy.party[s.enemy.active];
  const mine = s.player.party[s.player.active];
  lines.push(`Enemy: ${combatantLine(speciesById(catalog, enemy.speciesId), enemy)}`);
  lines.push(`You:   ${combatantLine(speciesById(catalog, mine.speciesId), mine)}`);

  if (s.enemy.party.length > 1) {
    const standing = s.enemy.party.filter((c) => c.hp > 0).length;
    lines.push(`Enemy party: ${standing}/${s.enemy.party.length} able to battle.`);
  }

  lines.push("Your moves:");
  mine.moves.forEach((slot, i) => {
    const move = moveById(catalog, slot.moveId);
    lines.push(
      `  move${i + 1} — ${move.name} (${move.type}, ${move.category}) power ${move.power}, PP ${slot.pp}/${move.pp}`,
    );
  });
  if (mine.moves.every((m) => m.pp === 0)) {
    lines.push("  (all PP exhausted — any move action uses Flail)");
  }

  lines.push("Your party:");
  s.player.party.forEach((c, i) => {
    const species = speciesById(catalog, c.speciesId);
    const marks: string[] = [];
    if (i === s.player.active) marks.push("active");
    if (c.hp <= 0) marks.push("fainted");
    const suffix = marks.length > 0 ? ` (${marks.join(", ")})` : "";
    lines.push(`  [${i + 1}] ${species.name} Lv${c.level} ${c.hp}/${c.maxHp} HP${suffix}`);
  });

  const usable = inventory.slice(0, 9);
  if (usable.length > 0) {
    lines.push("Your items:");
    usable.forEach((entry, i) => {
      const item = itemById(catalog, entry.itemId);
      lines.push(`  item${i + 1} — ${itemLabel(item)} x${entry.qty}`);
    });
  }

  if (s.lastEvents.length > 0) {
    lines.push("Last events:");
    for (const ev of s.lastEvents) lines.push(`  ${ev}`);
  }

  if (s.outcome !== "ongoing") {
    lines.push(`Outcome: ${OUTCOME_TEXT[s.outcome]}. The battle is over.`);
    return lines.join("\n");
  }
  if (s.needsSwitch) {
    lines.push("Your creature fainted — you must switch.");
    lines.push(`Actions: switch1..switch${s.player.party.length}`);
    return lines.join("\n");
  }
  const actions = [`move1..move${Math.max(1, mine.moves.length)}`];
  if (s.player.party.length > 1) actions.push(`switch1..switch${s.player.party.length}`);
  if (usable.length > 0) actions.push(`item1..item${usable.length}`);
  if (s.mode === "wild") {
    const hasSnare = usable.some(
      (e) => itemById(catalog, e.itemId).kind === "capture",
    );
    if (hasSnare) actions.push("catch");
    actions.push("run");
  }
  lines.push(`Actions: ${actions.join(" | ")}`);
  return lines.join("\n");
}
