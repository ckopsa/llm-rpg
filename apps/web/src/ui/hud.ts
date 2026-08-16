/**
 * Overworld HUD: map name + money chips and a compact party strip
 * (name, level, HP bar per kindred).
 */
import type { Sim } from "@llm-rpg/engine";
import { speciesById } from "@llm-rpg/engine";

/** "east-road" -> "East Road". */
export function prettyMapName(id: string): string {
  return id
    .split(/[-_]/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export function hpClass(hp: number, maxHp: number): string {
  const f = maxHp > 0 ? hp / maxHp : 0;
  if (f <= 0.2) return "low";
  if (f <= 0.5) return "mid";
  return "high";
}

export function hpBarHtml(hp: number, maxHp: number): string {
  const pct = maxHp > 0 ? Math.max(0, Math.min(100, (100 * hp) / maxHp)) : 0;
  return `<div class="hpbar"><div class="hpfill ${hpClass(hp, maxHp)}" style="width:${pct}%"></div></div>`;
}

export function updateHud(sim: Sim, mapEl: HTMLElement, moneyEl: HTMLElement): void {
  mapEl.textContent = prettyMapName(sim.state.map);
  moneyEl.textContent = `${sim.state.money} coins`;
}

export function updateParty(sim: Sim, container: HTMLElement): void {
  const cards = sim.state.party.map((c) => {
    const species = speciesById(sim.game.catalog, c.speciesId);
    const fainted = c.hp <= 0 ? " fainted" : "";
    return `<div class="party-card${fainted}">
      <div class="party-line"><span class="party-name">${species.name}</span><span class="party-lv">Lv ${c.level}</span></div>
      ${hpBarHtml(c.hp, c.maxHp)}
    </div>`;
  });
  container.innerHTML = cards.join("");
  container.classList.toggle("hidden", cards.length === 0);
}
