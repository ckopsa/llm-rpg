# Agent Instructions

## Project: llm-rpg

A 2D RPG engine designed for LLMs to build and play. **Everything is data**: a game is one JSON document (`games/demo/game.json`), zod-validated with actionable errors, simulated deterministically, rendered as text for AI players (`packages/play`: CLI + MCP) and as a web grid for humans (`apps/web`). Engine core in `packages/engine` is pure TS — no I/O, no `node:` imports; all randomness flows through the seeded, serializable `Rng` so (seed + action list) fully determines a playthrough, battles included. Games are multi-map overworlds: `maps` connected by `portals`, with `wild` legend tiles rolling per-map `encounters` tables against the embedded `catalog` (type chart, moves, species, items). A wild-tile hit starts a battle immediately (`state.battle`); battle actions are `move1..4`, `switch1..6`, `item1..9`, `catch`, `run` (catch/run wild-only). Entities with a `trainer` block ({ party, defeatFlag, lineOfSight?, rewardMoney?, rewardCommands?, intro/defeatText/outro }) battle on interact or on sight (`state.battleTrainer`); victory sets the flag and pays rewards, and defeated trainers chat like NPCs. Party (max 6), catching, XP (cubic curve, per faint), leveling, and evolution are wired through `Sim`; defeat respawns at `player.respawn` and halves money. Commands: `say`, `set_flag`, `set_var`, `add_var`, `passage`, `choice`, `win`, `give_species`, `give_item`, `give_money`, `heal_party`, `sell` (spatial shop counter: buy 1x itemId for price); interactions gate on `requiresFlag`/`forbidsFlag` plus the unified optional `when` condition object (`{flag}`/`{notFlag}`/`{var,op,value}` with `eq|ne|lt|lte|gt|gte`/`all`/`any`/`not`, evaluated by `evalWhen` over `{flags, vars, money}` — `"money"` is a built-in readable var, missing vars read as 0/""). Every command also takes `when` (skipped silently when false). Vars (`state.vars`, numbers or strings, via `set_var`/`add_var`) and passages (`passage {title?, lines[], citation?}` → `state.lastPassages` + one formatted multi-line event, cleared per act like `lastEvents`) are snapshot-safe. Dialogue choices: `choice { prompt, options: [{ label, when?, commands }] }` (overworld-only — a validation error inside trainer `rewardCommands`) presents the `when`-open options, SUSPENDS the rest of the current command list, and sets `state.pendingChoice`; the sim then accepts only `choose1..choose9` (alias `o1..o9`) — the chosen option's commands run, then the suspended commands resume (nested choices stack); zero open options = explanatory event + skip; snapshot-safe mid-choice. `catalog` is OPTIONAL: a catalog-free game is a narrative game — validation errors (naming the fix) on wild tiles, encounter zones, trainers, `give_species`/`give_item`/`sell`, and non-empty starting party/inventory; `heal_party` becomes a gentle no-op event and battles never engage. Save/load: `sim.snapshot()` / `Sim.fromSnapshot` restore everything mid-battle included; `makeSaveFile`/`loadSaveFile` add the `{ gameId, gameVersion, snapshot }` guard; CLI `save`/`load [slot]` + `--from <slot>`, MCP `save_game`/`load_game`, files in `<gameDir>/saves/` (gitignored). Narrative layer (djt.3–5): maps take `triggers: [{id, on: "enter"|"step"|"turn", tiles?, once (default true), when?, commands}]` — `enter` fires on arrival (game start for the start map, portal, `teleport_player`; not respawn), `step` on landing on a listed tile, `turn` once at the end of any action that actually advanced the world (not rejected actions, battle actions, or while a choice is pending) for the map the player ends on — with `once: false` plus `add_var`/`when` this is the action economy / ambient motion / timed pressure hook (tick and react in ONE command list: command-level `when` runs per command, trigger-level `when` is gated before any trigger runs); fired-once tracking in `state.firedTriggers` ("mapId:id"); a failing `when` skips WITHOUT marking fired; trigger commands run through the execFrames pipeline (choice/passage work; trigger `say` is narrator-voiced/bare; a trigger firing mid-continuation queues after all pending work; a battle engaging the same move wins and the trigger stays unfired). Cutscene/world commands: `move_entity {entityId, path, quiet?}` (blocked step = stop + event; `quiet` keeps the cue but drops the events, for ambient motion), `spawn_entity {mapId?, entity}`, `remove_entity`, `set_tile {mapId?, x, y, char}`, plus renderer cues `wait {beats}`, `camera_focus {entityId}|{mapId?,x,y}|{release}`, `play_music {track}`, `screen_effect {shake|flash|fade}`, `show_title {text, subtitle?}` — world edits live in serializable overlays (`state.entityOverrides`/`spawnedEntities`/`tileOverrides`) consulted by every read; cue records land in `state.lastCues` (cleared per act). Endings: `end {id, text}` sets `state.ending` and stops the sim (`win` = sugar for `end{id:"victory"}`; `won` true iff id === "victory"; ungated `end` must be last; `validateGame` returns `endings`; playtest reports carry `ending` + stopReason "ended"). `teleport_player {mapId, x, y}` relocates and fires the target's enter triggers. Variants: `entity.variants: [{id, when?, glyph?, sprite?, name?}]` (first when-match wins, base fallback) + `set_variant {entityId, variantId | clear}` forcing via `state.variantOverrides`; observers and `say` speaker names use the effective glyph/name everywhere; `sprite` passes through for the web layer. Observed scenes need no machinery: camera_focus/spawn/move work on other maps (the heavenly-court pattern: show_title → camera_focus other map → passage/say → release).

```bash
npm install && npm test                    # build + engine tests (vitest)
npm run validate -- games/demo/game.json   # validate a game file
npm run play -- --actions "east,interact"  # stateless agent-friendly play
npm run web                                # human-facing Vite renderer
```

Read-aloud (apps/web, `src/audio/speech.ts`, key V): narrates dialogue, passages, the choice menu, title and endings over the Web Speech API so a non-reader can play. The message box and passage pane take their pacing from the voice (passages self-turn); the choice menu speaks its numbered options and re-reads the highlighted one on caret move; `shouldSpeak` filters stage directions and fails open. Invariant: a waiter on the narrator is ALWAYS released (supersede / error / watchdog) — a stranded waiter freezes the game. Two backends, local first: a Piper voice served at `/__tts` (piper-plugin.ts spawns tools/piper-server.py; offline, ~130ms/line, voice+rate switchable) then Web Speech. The local one exists because Linux browsers often cannot speak at all — Brave exposes 0 voices and returns `synthesis-failed` — so `hasVoice`/`voiceHint()` are separate from `available` and the "on but silent" state is shown, never silent.

Language overlays (`language.ts`): one game, many scripts. `games/<id>/lang.<code>.json` = `{name, voice?, strings, patches}`; `strings` keyed by the ORIGINAL text (passages on `lines.join("\n")`, value may be an array), `patches` `{path,value}` applied BEFORE strings so spliced-in content is translated too. `applyLanguage` is pure and returns `{game, unused, missing}`; uncovered strings keep the original words; the result must still pass `validateGame`. Web app: title-screen "Words:" row + `?lang=<code>`, falls back to the game's own words on any error.

Input (apps/web `src/ui/controls.ts`): touch d-pad + gamepad both synthesize the same KeyboardEvents as the keyboard and dispatch on `window`, feeding main.ts's single modal cascade. Synthetic events must set `code` AND `key` (movement matches `ev.code`), and directions need a ~120ms minimum hold or a tap never steps. The 768x576 stage is scaled by one transform (`--stage-scale`) so it fits phones; `#stage-fit` reserves the scaled box.

See CLAUDE.md for full conventions.

## Issue Tracking

This project uses **bd** (beads) for issue tracking. Run `bd prime` for full workflow context.

> **Architecture in one line:** Issues live in a local Dolt database
> (`.beads/dolt/`); cross-machine sync uses `bd dolt push/pull` (a
> git-compatible protocol), stored under `refs/dolt/data` on your git
> remote — separate from `refs/heads/*` where your code lives.
> `.beads/issues.jsonl` is a passive export, not the wire protocol.
>
> See [SYNC_CONCEPTS.md](https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md)
> for the one-screen overview and anti-patterns (don't treat JSONL as the
> source of truth; don't `bd import` during normal operation; don't
> reach for third-party Dolt hosting before trying the default).

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work atomically
bd close <id>         # Complete work
bd dolt push          # Push beads data to remote
```

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts.

Shell commands like `cp`, `mv`, and `rm` may be aliased to include `-i` (interactive) mode on some systems, causing the agent to hang indefinitely waiting for y/n input.

**Use these forms instead:**
```bash
# Force overwrite without prompting
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file

# For recursive operations
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

**Other commands that may prompt:**
- `scp` - use `-o BatchMode=yes` for non-interactive
- `ssh` - use `-o BatchMode=yes` to fail instead of prompting
- `apt-get` - use `-y` flag
- `brew` - use `HOMEBREW_NO_AUTO_UPDATE=1` env var

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

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
