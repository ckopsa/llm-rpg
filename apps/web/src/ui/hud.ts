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

/**
 * The standing objective. Unlike chatter this stays on screen, because the
 * common failure is not missing the instruction — it is losing it three
 * minutes later. Returns the text when it CHANGED, so the caller can speak it
 * (feature-detected: pre-objective engines simply never show the bar).
 */
export function updateObjective(sim: Sim, bar: HTMLElement, textEl: HTMLElement): string | null {
  const objective = (sim.state as { objective?: unknown }).objective;
  const text = typeof objective === "string" && objective.trim() !== "" ? objective : null;
  bar.classList.toggle("hidden", text === null);
  if (text === null) {
    textEl.textContent = "";
    return null;
  }
  const changed = textEl.textContent !== text;
  if (changed) textEl.textContent = text;
  return changed ? text : null;
}

/**
 * True when the loaded game has battle content: a catalog with at least one
 * species. A catalog-free narrative game must never enter battle paths, so
 * every battle affordance checks this first. Optional-chained on purpose —
 * it stays cheap and safe whether the engine has made `catalog` optional yet
 * or not.
 */
export function hasBattleContent(sim: Sim): boolean {
  return (sim.game.catalog?.species?.length ?? 0) > 0;
}

export function updateParty(sim: Sim, container: HTMLElement): void {
  const catalog = sim.game.catalog;
  // Catalog-free (battle-less) games have no party strip at all — and no
  // species to resolve names against, so bail before any lookups.
  if (!catalog || (catalog.species?.length ?? 0) === 0 || sim.state.party.length === 0) {
    container.innerHTML = "";
    container.classList.add("hidden");
    return;
  }
  const cards = sim.state.party.map((c) => {
    const species = speciesById(catalog, c.speciesId);
    const fainted = c.hp <= 0 ? " fainted" : "";
    return `<div class="party-card${fainted}">
      <div class="party-line"><span class="party-name">${species.name}</span><span class="party-lv">Lv ${c.level}</span></div>
      ${hpBarHtml(c.hp, c.maxHp)}
    </div>`;
  });
  container.innerHTML = cards.join("");
  container.classList.remove("hidden");
}
