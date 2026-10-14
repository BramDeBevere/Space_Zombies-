# Project Memory

## Current Goal

Add one small reusable zombie archetype to the game: the existing Runner type.

## Agreed Plan

1. Keep the existing Runner implementation as the one new archetype.
2. Review its balance against the existing zombie types; adjust only a few values if needed.
3. Run available checks and record results, including browser behavior that remains untested.

## Important Decisions

- `AGENTS.md` contains collaboration instructions; `MEMORY.md` contains project context and progress.
- Task progress lives in `MEMORY.md`, separate from the collaboration rules.
- Only lowercase `AGENTS.md` currently exists; uppercase `AGENTS.MD` was checked and is absent.
- `package.json` defines `npm run check` as `node --check main.js`.
- The new type is a small, orange “Runner”: faster and less durable than a Walker, appearing occasionally from wave 2 onward.
- Approved Runner defaults: speed `5.4`, health `65`, scale `0.86`, damage `10`, and orange/brown colors.

## Progress

- Added the Runner to `ZOMBIE_TYPES` and selected it with the existing wave picker.
- The Runner reuses the existing zombie creation, movement, health, damage, and network paths.
- Browser test result: works very good.

## Checks

- `npm` and `node` are unavailable on this server, so `npm run check` and `node --check main.js` could not run.
- JavaScript syntax is untested in this environment.
- `git diff --check` passed for the prior change.
- Browser behavior was tested and reported as working very good.

## Status

Complete. No further implementation step is pending.
