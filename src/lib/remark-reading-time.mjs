import { toString } from "mdast-util-to-string";

// Build-time reading time: walk the parsed markdown/MDX tree, count words in
// the prose, and expose the estimate as frontmatter (`minutesRead`) so layouts
// can read it without any client-side JS. ~220 wpm, min 1 minute.
const WORDS_PER_MINUTE = 220;

export function remarkReadingTime() {
  return function (tree, { data }) {
    const text = toString(tree);
    const words = text.split(/\s+/).filter(Boolean).length;
    const minutes = Math.max(1, Math.round(words / WORDS_PER_MINUTE));
    data.astro.frontmatter.minutesRead = minutes;
  };
}
