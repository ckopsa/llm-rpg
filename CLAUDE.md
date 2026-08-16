# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->


## Build & Test

```bash
npm install       # npm workspaces monorepo (Node 22+)
npm test          # engine tests (vitest) incl. full deterministic playthrough
npm run validate -- games/demo/game.json   # validate a game file
npm run play -- --actions "east,interact"  # stateless replay-mode play (agent-friendly)
npm run play      # interactive terminal REPL
npm run web       # Vite dev server for the human-facing renderer
npm run mcp       # MCP stdio server (observe/act/reset/save_game/load_game/validate_game)
```

## Architecture Overview

A 2D RPG engine designed for LLMs to build and play. **Everything is data**: a game is one JSON document (see `games/demo/game.json`), validated by zod schemas with actionable error messages, simulated deterministically, and rendered two ways from the same engine.

- `packages/engine` — pure TypeScript, no I/O; all randomness through the seeded serializable `Rng`:
  - `schema.ts` — `GameSchema`: `meta`, required `catalog`, shared `legend`, `maps` (rows/entities/portals/encounters), `player` (`party` up to 6 `{ speciesId, level }`, `money`, `inventory` `[{ itemId, qty }]`, optional `respawn { map, x, y }` for defeat). Interaction gates: `requiresFlag` and `forbidsFlag` (skipped when the flag IS set — one-time gifts, starter pedestals). Commands: `say`, `set_flag`, `win`, `give_species`, `give_item`, `give_money`, `heal_party`, `sell` (spatial shop counter: player buys 1x `itemId` for `price`, shortfall named on failure). Entities may carry a `trainer` block: `party` (1..6 `{ speciesId, level }`), `defeatFlag`, optional `lineOfSight { dir, range >= 1 }`, `rewardMoney`, `rewardCommands`, `intro`/`defeatText`/`outro`. `validateGame` cross-checks encounter tables, command refs (interactions AND rewardCommands), trainer parties, and party members against the catalog.
  - `catalog.ts` — type chart, moves, species (learnset, `evolvesTo`, `catchRate`, `xpYield`) and items (`kind: "heal" | "capture"`; heal requires `amount`, capture requires `ballMod`, optional `price`); `statsAtLevel`, `movesKnownAtLevel`.
  - `battle.ts` — deterministic turn-based `Battle` (actions: move/switch/item/catch/run; outcomes: player_won/enemy_won/fled/captured). XP on enemy faint = `floor(xpYield * enemyLevel / 5)`; total XP for level L = `L^3`; level-ups recompute stats (heal by the HP gain) and learn learnset moves, replacing the oldest of 4. Catch p = `clamp(catchRate * ballMod * (1.3 - hp/maxHp), 0.05, 0.95)`.
  - `sim.ts` — overworld `Sim`; stepping onto a wild tile immediately starts a wild battle sharing the sim's Rng (`state.battle` non-null). In battle only battle actions are accepted: `move1..move4` (`m1..m4`), `switch1..switch6` (`s1..s6`), `item1..item9`, `catch` (alias `snare`), `run`. Battle end flows back: evolution checks at battle end; captures join the party (max 6, else gently released); defeat heals the party, halves money, respawns at `player.respawn` (default start). Empty or all-fainted party blocks wild tiles. Trainer battles (mode `"trainer"`: no run, no catch, capture items not consumed) start by interacting with an undefeated trainer or automatically via line-of-sight after any move (straight along `dir` within `range`, blocked by non-walkable tiles or blocking entities); `state.battleTrainer` tracks the trainer; victory sets `defeatFlag`, pays `rewardMoney`, runs `rewardCommands`, says `defeatText`, and afterwards the trainer chats via `interactions` (or `outro` as fallback). Trainers don't engage a player with no battle-ready kindred. `snapshot()` (state + rng + seed) includes battle state and round-trips through JSON; `Sim.fromSnapshot(game, snapshot)` restores everything, mid-battle included.
  - `observe.ts` / `battleObserve.ts` — AI-facing text renderers; `observe(sim)` switches to `describeBattle` (with inventory-aware action list) while a battle is active; undefeated trainers are tagged in the Nearby list.
  - `save.ts` — pure save-file codec: `makeSaveFile(sim)` / `loadSaveFile(game, data)` wrap snapshots in `{ gameId, gameVersion, snapshot }`; wrong gameId errors actionably, version mismatch warns but loads.
- `packages/play` — AI-facing interfaces: CLI with interactive + `--actions` replay modes (battle actions supported; `save [slot]`/`load [slot]` in the REPL, `--from <slot>` to resume a replay; saves live in `<gameDir>/saves/<slot>.json`, gitignored, default slot `quick`), MCP server (`observe`/`act`/`reset`/`save_game`/`load_game`/`validate_game`)
- `apps/web` — human-facing Vite app (emoji grid, arrow keys); text-mode battle panel (1-4 moves, 5-9 items 1-5, Shift+1..6 switch, C catch, X run); imports engine source directly
- `games/<id>/game.json` — game content (catalog embedded); a game is a directory of data
- `docs/design/emberwood.md` — design bible for the full game content

## Conventions & Patterns

- The sim is deterministic with no wall-clock or RNG; a playthrough is a replayable action list — through battles. Keep it that way — tests depend on it.
- Validation errors must name the fix, not just the failure (see `validateGame`).
- Engine stays renderer-agnostic and Node/browser-portable: no `node:` imports in `packages/engine/src`.
- New game mechanics = new zod-schema'd data (commands, interactions), not arbitrary code in game files.
- Action words are 1-based (`move1`, `switch2`, `item3`); `Action`/`PlayerAction` indexes are 0-based.
