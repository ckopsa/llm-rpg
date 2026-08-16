/**
 * Passage pane ("scripture mode"): a dignified full-stage reading surface
 * for long-form text — multi-line passages with an optional heading and a
 * citation. Deliberately distinct from the GBA chatter box: generous
 * padding, serif type, and no auto-advance — the reader turns the pages
 * (Enter/Space/E, or click) and the text carries the weight.
 *
 * Pages are measured against the pane for real (line elements are appended
 * until the pane overflows), so wrapped lines still fit; the citation joins
 * the final page or takes one of its own. Page numbers are quiet roman
 * numerals ("ii / iv").
 *
 * While open, main.ts routes all game input here and gates the ordinary
 * message box, so passages read in stillness; queued passages play
 * sequentially and ordinary chatter resumes after the last one closes.
 *
 * The engine half (sim.state.lastPassages) may not exist yet — main.ts
 * feature-detects that; this class just renders whatever it is handed and
 * quietly drops anything that isn't passage-shaped.
 *
 * Read-aloud: with `narrate` set, each page is spoken and the pane turns its
 * own pages when the voice reaches the end — a listener never has to know
 * that a page break happened. Advance keys still work and cut the voice short.
 */

export interface Passage {
  title?: string;
  lines: string[];
  citation?: string;
}

const ADVANCE_KEYS = new Set(["Enter", " ", "e", "E", "z", "Z"]);

function isPassage(p: unknown): p is Passage {
  if (typeof p !== "object" || p === null) return false;
  const lines = (p as { lines?: unknown }).lines;
  return Array.isArray(lines) && lines.every((l) => typeof l === "string");
}

/** 1 -> "i", 4 -> "iv": quiet page numbers for the corner of a page. */
function roman(n: number): string {
  const table: [number, string][] = [
    [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"],
    [100, "c"], [90, "xc"], [50, "l"], [40, "xl"],
    [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
  ];
  let out = "";
  for (const [value, glyph] of table) {
    while (n >= value) {
      out += glyph;
      n -= value;
    }
  }
  return out || "i";
}

export class PassagePane {
  private root: HTMLElement;
  private titleEl: HTMLElement;
  private bodyEl: HTMLElement;
  private pageEl: HTMLElement;
  private queue: Passage[] = [];
  private pages: HTMLElement[][] = [];
  private pageIndex = 0;
  private isOpen = false;
  /** Optional read-aloud hook. Return a cancel function to have the pane
   *  turn its pages on `done` instead of waiting for a keypress. */
  narrate: ((text: string, done: () => void) => (() => void) | null) | null = null;
  private speaking: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    root.innerHTML = `
      <div class="passage-panel">
        <div class="passage-title hidden"></div>
        <div class="passage-body"></div>
        <div class="passage-foot">
          <span class="passage-page"></span>
          <span class="passage-more">&#9660;</span>
        </div>
      </div>`;
    this.titleEl = root.querySelector(".passage-title")!;
    this.bodyEl = root.querySelector(".passage-body")!;
    this.pageEl = root.querySelector(".passage-page")!;
    root.querySelector(".passage-panel")!.addEventListener("click", () => this.advance());
  }

  /** True while a passage is on screen (main.ts blocks game input then). */
  get open(): boolean {
    return this.isOpen;
  }

  /** Queue passages for reading; opens the pane if it isn't already. */
  enqueue(passages: Passage[]): void {
    const valid = passages.filter(isPassage);
    if (valid.length === 0) return;
    this.queue.push(...valid);
    if (!this.isOpen) {
      this.isOpen = true;
      this.root.classList.remove("hidden"); // visible first: pagination measures layout
      this.showNextPassage();
    }
  }

  /**
   * All keys route here while open. Advance keys turn the page; arrows and
   * plain characters are swallowed (no page scroll, no typing); modified
   * combos and function keys stay with the browser. Returns true when the
   * default should be prevented — the caller blocks game input regardless.
   */
  handleKey(ev: KeyboardEvent): boolean {
    if (!this.isOpen) return false;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return false;
    if (ADVANCE_KEYS.has(ev.key)) {
      this.advance();
      return true;
    }
    return ev.key.length === 1 || ev.key.startsWith("Arrow");
  }

  /** Drop everything and close (title return, loads, forge reloads). */
  clear(): void {
    this.queue = [];
    this.close();
  }

  private close(): void {
    this.stopSpeaking();
    this.isOpen = false;
    this.pages = [];
    this.root.classList.add("hidden");
  }

  private stopSpeaking(): void {
    this.speaking?.();
    this.speaking = null;
  }

  private advance(): void {
    if (!this.isOpen) return;
    this.stopSpeaking();
    if (this.pageIndex < this.pages.length - 1) {
      this.pageIndex++;
      this.renderPage();
    } else {
      this.showNextPassage();
    }
  }

  private showNextPassage(): void {
    const passage = this.queue.shift();
    if (!passage) {
      this.close();
      return;
    }
    const title = passage.title ?? "";
    this.titleEl.textContent = title;
    this.titleEl.classList.toggle("hidden", title === "");
    this.paginate(passage);
    this.pageIndex = 0;
    this.renderPage();
  }

  /** Fill the pane line by line; overflow starts the next page. */
  private paginate(passage: Passage): void {
    const els: HTMLElement[] = passage.lines.map((line) => {
      const el = document.createElement("div");
      const blank = line.trim() === "";
      el.className = blank ? "passage-line blank" : "passage-line";
      el.textContent = blank ? " " : line;
      return el;
    });
    if (passage.citation) {
      const cite = document.createElement("div");
      cite.className = "passage-citation";
      cite.textContent = `— ${passage.citation}`;
      els.push(cite);
    }

    const pages: HTMLElement[][] = [];
    let page: HTMLElement[] = [];
    this.bodyEl.replaceChildren();
    for (const el of els) {
      this.bodyEl.append(el);
      if (page.length > 0 && this.bodyEl.scrollHeight > this.bodyEl.clientHeight) {
        pages.push(page);
        this.bodyEl.replaceChildren(el); // el opens the next page
        page = [el];
      } else {
        page.push(el);
      }
    }
    if (page.length > 0 || pages.length === 0) pages.push(page);
    this.pages = pages;
  }

  private renderPage(): void {
    this.stopSpeaking();
    const page = this.pages[this.pageIndex];
    this.bodyEl.replaceChildren(...page);
    this.pageEl.textContent =
      this.pages.length > 1
        ? `${roman(this.pageIndex + 1)} / ${roman(this.pages.length)}`
        : "";

    // Read the page, then turn it. The title only belongs to the first page.
    const heading =
      this.pageIndex === 0 && !this.titleEl.classList.contains("hidden")
        ? `${this.titleEl.textContent}. `
        : "";
    const body = page.map((el) => el.textContent ?? "").join(" ");
    this.speaking =
      this.narrate?.(`${heading}${body}`, () => {
        this.speaking = null;
        this.advance();
      }) ?? null;
  }
}
