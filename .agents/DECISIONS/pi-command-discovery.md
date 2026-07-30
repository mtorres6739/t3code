# Pi Command Discovery Decisions

## Chosen approach

Enrich the existing Pi provider health snapshot with `get_commands` results from the same RPC subprocess used for model discovery.

## Alternatives rejected

### Add a new T3-specific command registry

Rejected because Pi is already the source of truth for extensions, prompt templates, and skills. A duplicate registry would drift.

### Add a frontend-only command catalog

Rejected because it would not reflect the active Pi installation and would require separate web/mobile synchronization.

### Map Pi skills into T3's `$skill` contract

Rejected because T3's current skill insertion emits `$name`, while Pi's correct syntax is `/skill:name`. Pi skill commands stay in the provider slash-command list.

### Load the entire `~/.claude/commands` directory as one prompt source

Rejected because Pi recursively discovered nested support templates and checklists as commands. The settings file explicitly lists the intended top-level command files.

## Assumptions

- T3 Code launches Pi with the inherited user environment and user home.
- Provider-level discovery is sufficient for Mathew's global command library.
- Existing composer provider-command support is the correct UI boundary.
- Because Mathew's Pi installation exposes more than 500 commands, web ranking collects then sorts once instead of repeatedly inserting into an ordered array; mobile also displays argument hints when descriptions are absent.
