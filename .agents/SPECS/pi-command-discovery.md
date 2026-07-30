# Pi Command Discovery Spec

## Purpose

Expose the commands reported by Pi RPC in T3 Code's existing provider slash-command autocomplete, while loading Mathew's top-level Claude command templates into Pi.

## Non-Goals

- Reimplement Pi commands inside T3 Code.
- Emulate Pi's TUI-only commands such as `/settings` or `/hotkeys`.
- Add a second composer command UI.
- Discover project-local commands separately for every workspace; provider health snapshots remain environment-scoped.

## Interfaces

- Pi RPC probe sends `{"type":"get_commands"}` during existing model discovery.
- Parsed commands become `ServerProvider.slashCommands` entries with `name`, optional `description`, and optional input hint.
- Web, desktop, and mobile use their existing provider slash-command composer menus.
- `~/.pi/agent/settings.json` lists the top-level Markdown files in `~/.claude/commands` under `prompts`.

## Key Decisions

- Reuse the existing short-lived Pi RPC health probe rather than spawn a second process.
- Command discovery is fail-soft: model discovery remains healthy if `get_commands` is unsupported or fails.
- Dedupe command names case-insensitively while preserving the first useful description/hint.
- Include extension, prompt, and skill commands exactly as Pi reports them. Skill commands therefore autocomplete as `/skill:name`, which is Pi's correct invocation syntax.
- Keep T3's existing slash autocomplete components unchanged; they already consume `ServerProvider.slashCommands` on web/desktop/mobile.

## Edge Cases and Failure Modes

- Missing or malformed command data returns an empty command list.
- Empty command names are discarded.
- Duplicate command names are merged case-insensitively.
- Pi versions without `get_commands` still report models and remain usable.
- Pi TUI-only commands remain absent because RPC explicitly does not expose them.

## Acceptance Criteria

- Pi RPC discovery parses extension, prompt, and skill commands.
- A ready Pi provider snapshot includes discovered commands in `slashCommands`.
- Failed command discovery does not fail model discovery.
- Focused Pi provider/RPC tests pass.
- A live Pi RPC probe sees all intended top-level Claude command templates, except names intentionally shadowed by equivalent extension commands.
- Existing web and mobile composer code displays the populated provider command list without frontend changes.

## Test Plan

- Unit-test malformed and valid `get_commands` response parsing.
- Extend the fake Pi RPC script and discovery assertions.
- Test command mapping/deduplication into server provider slash commands.
- Run focused server tests and type diagnostics.
- Run a live `pi --mode rpc` command inventory check.
