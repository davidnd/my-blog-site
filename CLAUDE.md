# my-blog-site — working notes for Claude

Astro blog. Posts are `.mdx` in `src/content/blog/`. Frontmatter schema lives in
`src/content.config.ts`: `title`, `description`, `pubDate` (not `date`), optional
`updatedDate`, `tags`, `draft`, `comments`, `reactions`.

## Author voice
- Prose, not bullet lists, in the body. Short, declarative, opinionated.
- **No em-dashes.** Use colons, semicolons, commas, periods. (Every existing post has zero.)
- `**bold**` is used to highlight the one key phrase in a paragraph.
- Straight quotes, second person ("we"/"our").

## Diagrams — the house style (reuse this for the next post)
The blog has **no Mermaid rendering** wired up (only `remarkReadingTime` in
`astro.config.mjs`). Diagrams are **hand-authored static SVGs** in `public/images/`,
embedded with:

```mdx
<figure className="architecture-diagram">
  <img src="/images/<name>.svg" alt="..." />
</figure>
```

`.architecture-diagram` (in `src/styles/global.css`) is a full-bleed, horizontally
scrollable container with a `min-width: 1040px` SVG, so author diagrams ~1200px+ wide.

Generate them with `scripts/diagrams/generate.mjs` (pure Node, no browser):
`node scripts/diagrams/generate.mjs`. It writes the SVGs; copy them to `public/images/`.
To preview without a browser: `python3 -c "import cairosvg; cairosvg.svg2png(...)"`.

### Palette (matches the existing diagrams; white canvas, NOT the cream site theme)
- Font: `Source Serif 4, Georgia, Cambria, Times New Roman, Times, serif`
- Lines/arrows: `#475569`, arrowhead marker same. Dashed = `stroke-dasharray="6 5"`.
- Node fills are soft tints with a matching darker stroke + text:
  - **green** (services): fill `#f0fdf4`, stroke `#16a34a`, text `#166534`
  - **amber** (external systems / notes): fill `#fffbeb`/`#fef3c7`, stroke `#d97706`/`#f59e0b`, text `#92400e`
  - **indigo** (stores / actors): fill `#eef2ff`, stroke `#4f46e5`, text `#3730a3`
  - **red** (terminal failure): fill `#fef2f2`, stroke `#dc2626`, text `#991b1b`
  - **gray** (neutral terminal): fill `#f3f4f6`, stroke `#6b7280`, text `#374151`
  - **plane/group box**: fill `#f8fafc`, stroke `#94a3b8`
- Title: 16px bold `#0f172a` centered at top. Edge labels: ~12.5px on a white pad
  (`opacity 0.95`) so they read over lines.

### Layout rules learned the hard way (don't regress)
- Leave a full label-width gap between boxes so transition labels sit in open space,
  never clipped by an adjacent box.
- Keep sequence-diagram lifelines/frames **above** the bottom actor row; a frame border
  through a box name looks broken.
- Notes/labels go in empty space, never overlapping a box's name (e.g. put "source of
  truth" on the arrow, not on top of the target node).
- Separate opposing arrows between the same two nodes (offset, or curve one out to the side).

## Pushing
Both `git commit` and `git push` work from this connected folder. When a change is
done and tested, commit and push it (to `origin main`) without asking for permission.
