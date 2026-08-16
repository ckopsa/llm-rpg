/**
 * Dev-only sample passages for the passage pane (?passagetest=1).
 *
 * Imported exclusively from main.ts inside the `import.meta.hot` guard, so —
 * exactly like forge.ts — this module and every line of text in it are
 * tree-shaken out of production builds. It exists so pagination, styling,
 * and input blocking can be verified before any game ships passage content.
 */
import type { Passage } from "./ui/passage";

export function samplePassages(): Passage[] {
  return [
    {
      title: "The Voice from the Whirlwind",
      lines: [
        "Where wast thou when I laid the foundations of the earth?",
        "declare, if thou hast understanding.",
        "Who hath laid the measures thereof, if thou knowest?",
        "or who hath stretched the line upon it?",
        "Whereupon are the foundations thereof fastened?",
        "or who laid the corner stone thereof;",
        "When the morning stars sang together,",
        "and all the sons of God shouted for joy?",
        "Or who shut up the sea with doors,",
        "when it brake forth, as if it had issued out of the womb?",
        "When I made the cloud the garment thereof,",
        "and thick darkness a swaddlingband for it,",
      ],
      citation: "Job 38:4–9",
    },
    // A second, untitled passage with a stanza break: exercises the queue,
    // the no-heading layout, and blank-line rendering.
    {
      lines: [
        "Canst thou bind the sweet influences of Pleiades,",
        "or loose the bands of Orion?",
        "",
        "Canst thou bring forth Mazzaroth in his season?",
        "or canst thou guide Arcturus with his sons?",
      ],
      citation: "Job 38:31–32",
    },
  ];
}
