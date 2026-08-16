/**
 * Pause panel (key P on the overworld): save to one of three slots, load a
 * slot or the autosave, or return to the title screen. Keyboard and click.
 * Slot rows show where and when each save was made; damaged saves are named
 * gently and stay unloadable rather than crashing anything.
 */
import { MANUAL_SLOTS, peekSlot, prettyTime, type SlotId, type SlotPeek } from "../saves";
import { prettyMapName } from "./hud";

interface PauseItem {
  label: string;
  detail: string;
  enabled: boolean;
  reason?: string;
  action: () => void;
}

export interface PauseHooks {
  gameId(): string;
  /** Save the live sim to a slot; returns a short human message. */
  onSave(slot: SlotId): string;
  /** Load a slot into the live game; returns null on success, else an error. */
  onLoad(slot: SlotId): string | null;
  onTitle(): void;
  blip(): void;
  confirm(): void;
}

function slotLabel(peek: SlotPeek): string {
  if (!peek.exists) return "empty";
  if (peek.corrupt) return "damaged — can't be read";
  const where = peek.mapId ? prettyMapName(peek.mapId) : "somewhere";
  const when = prettyTime(peek.savedAt);
  return when ? `${where} · ${when}` : where;
}

export class PausePanel {
  private root: HTMLElement;
  private hooks: PauseHooks;
  private items: PauseItem[] = [];
  private index = 0;
  private note = "";

  constructor(root: HTMLElement, hooks: PauseHooks) {
    this.root = root;
    this.hooks = hooks;
  }

  get visible(): boolean {
    return !this.root.classList.contains("hidden");
  }

  show(): void {
    this.index = 0;
    this.note = "";
    this.root.classList.remove("hidden");
    this.render();
  }

  hide(): void {
    this.root.classList.add("hidden");
  }

  /** Pause-mode keys. Returns true when consumed. */
  handleKey(ev: KeyboardEvent): boolean {
    if (!this.visible) return false;
    switch (ev.key) {
      case "ArrowUp":
      case "ArrowLeft":
        this.move(-1);
        return true;
      case "ArrowDown":
      case "ArrowRight":
        this.move(1);
        return true;
      case "Enter":
      case " ":
      case "e":
      case "E":
      case "z":
      case "Z":
        this.select();
        return true;
      case "Escape":
      case "p":
      case "P":
        this.hooks.blip();
        this.hide();
        return true;
    }
    return true; // swallow everything else while paused
  }

  private move(delta: number): void {
    if (this.items.length === 0) return;
    this.index = (this.index + delta + this.items.length) % this.items.length;
    this.hooks.blip();
    this.render();
  }

  private select(): void {
    const item = this.items[this.index];
    if (!item) return;
    if (!item.enabled) {
      this.hooks.blip();
      this.note = item.reason ?? "";
      this.render();
      return;
    }
    this.hooks.confirm();
    item.action();
  }

  private buildItems(): PauseItem[] {
    const gameId = this.hooks.gameId();
    const items: PauseItem[] = [
      {
        label: "Resume",
        detail: "",
        enabled: true,
        action: () => this.hide(),
      },
    ];
    for (const slot of MANUAL_SLOTS) {
      const peek = peekSlot(gameId, slot);
      items.push({
        label: `Save · Slot ${slot}`,
        detail: slotLabel(peek),
        enabled: true,
        action: () => {
          this.note = this.hooks.onSave(slot);
          this.render();
        },
      });
    }
    const loadable: { slot: SlotId; name: string }[] = [
      { slot: "1", name: "Load · Slot 1" },
      { slot: "2", name: "Load · Slot 2" },
      { slot: "3", name: "Load · Slot 3" },
      { slot: "auto", name: "Load · Autosave" },
    ];
    for (const { slot, name } of loadable) {
      const peek = peekSlot(gameId, slot);
      items.push({
        label: name,
        detail: slotLabel(peek),
        enabled: peek.exists && !peek.corrupt,
        reason: peek.corrupt
          ? "That save is damaged — best leave it be."
          : "Nothing saved there yet.",
        action: () => {
          const err = this.hooks.onLoad(slot);
          if (err) {
            this.note = err;
            this.render();
          } else {
            this.hide();
          }
        },
      });
    }
    items.push({
      label: "Return to Title",
      detail: "",
      enabled: true,
      action: () => {
        this.hide();
        this.hooks.onTitle();
      },
    });
    return items;
  }

  private render(): void {
    this.items = this.buildItems();
    if (this.index >= this.items.length) this.index = 0;
    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const list = this.items
      .map((item, i) => {
        const cls = [i === this.index ? "sel" : "", item.enabled ? "" : "disabled"]
          .filter(Boolean)
          .join(" ");
        const detail = item.detail
          ? `<span class="pause-detail">${esc(item.detail)}</span>`
          : "";
        return `<li class="${cls}" data-i="${i}"><span class="pause-label">${esc(item.label)}</span>${detail}</li>`;
      })
      .join("");
    this.root.innerHTML = `
      <div class="pause-panel">
        <div class="pause-title">Paused</div>
        <ul class="pause-list">${list}</ul>
        <div class="pause-note">${esc(this.note) || "Arrows · Enter · P/Esc close"}</div>
      </div>`;
    this.root.querySelectorAll<HTMLElement>(".pause-list li").forEach((li) => {
      const i = Number(li.dataset.i);
      li.addEventListener("mouseenter", () => {
        if (this.index !== i) {
          this.index = i;
          this.render();
        }
      });
      li.addEventListener("click", () => {
        this.index = i;
        this.select();
      });
    });
  }
}
