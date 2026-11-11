# CLAUDE.md

## Checks in Claude web sessions

- In Claude web sessions, `.claude/hooks/session-start.sh` installs the dependencies.
- Run `.claude/hooks/check.sh` before every push and pull request.
- Pushes and pull requests are blocked until it passes on the exact code being pushed.
- Never bypass, skip or weaken checks to get past this gate.
- If a check cannot run, tell the user.

## Governing principle

Set by the owner in the handbook (GitHub: `ServesYouRice/handbook`). Read its `README.md`, `standards.md` and `projects/nextra.md` before hosting, packaging or architecture work.

- Nextra is a finished product, built with best practices and the right technology, not a demo. Do not choose the cheap option now and defer the proper one "until needed".
- Do not overkill either. It is one process with no database, sized for a handful of viewers, and it stays that way unless the owner changes the scope.
- Free tiers first. A paid service is taken only once a limit is actually hit.
- Verification is local: `.claude/hooks/check.sh` (`npm run release:prep` and the browser tests). Hosted CI is allowed only to build and test on platforms the dev PC cannot run, which here is the Windows and macOS packages. The server image is released locally with `npm run release:image`.
