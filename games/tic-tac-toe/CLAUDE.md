# Working agreement

This project now lives inside the blog repo and ships to Cloudflare. Read
`README.md` for the layout and the two transports before changing anything under
`src/worker/` or `src/server/`.

## Before any code

- Read `requirements.md` first. It is the source of truth, not the chat history.
- If a requirement is ambiguous, append the question to `OPEN_QUESTIONS.md` and
  pick the simplest reasonable option. Do not stall, do not silently guess.
- Plan before implementing anything non-trivial. Show the plan, wait for approval.

## How to build

- Build one vertical slice at a time: end to end, thin, with a passing test.
  Never scaffold many empty layers up front.
- Stop after each slice and report what changed. Do not chain multiple slices.
- `git add -A && git commit` after each green slice so the diff stays reviewable.
- A rule change belongs in `rules.ts` or `rooms.ts`, never in a transport. Both
  the Worker and the Node server drive those, which is what stops them diverging.
- Standard library first. Do not add a dependency without asking.
- Keep files under ~300 lines. Split rather than grow.

## Testing

- For a bug: write the failing test first, show it fail, then fix it.
- Tests must exercise real behavior. No asserting on mocks you just configured.

## Never do this

- No placeholder or stub implementations presented as done.
- No `except: pass`, no swallowed errors, no fallback that hides a failure.
- No `# TODO: implement` left in a path the tests claim to cover.
- No editing tests to make them pass. Fix the code.
- If you cannot make something work, say so explicitly. Do not fake it.

## Reporting back

- After each change: what you changed, what you did NOT handle, and the riskiest
  assumption you made. Two or three lines, no summaries of code I can read.
