# Pi Command Discovery TODO

- [x] Configure Pi to load top-level `~/.claude/commands/*.md` files.
  - Verify: live RPC inventory reports the Claude command paths.
- [x] Add Pi command response types and parser.
  - Verify: focused `PiRpcClient` tests.
- [x] Fetch commands during Pi RPC discovery without making discovery brittle.
  - Verify: fake RPC test covers success and `get_commands` failure fallback.
- [x] Map discovered Pi commands into `ServerProvider.slashCommands`.
  - Verify: focused `PiProvider` mapping tests.
- [x] Keep large command-list search efficient and mobile hints consistent.
  - Verify: shared web search test plus web/mobile typechecks.
- [x] Run diagnostics and focused tests.
  - Verify: package test command and Pi Lens/LSP diagnostics.
- [x] Verify the live Pi inventory.
  - Verify: direct RPC inventory reports 530 commands and all 46 top-level Claude command names.
- [x] Update durable project notes and ACP.
  - Verify: clean staged diff, commit, and successful push.
