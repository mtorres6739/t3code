# Pi Provider TODO

- [x] Install repository dependencies and capture baseline focused tests.
  - Verify: `vp i`
  - Verify: run the existing focused provider driver/adapter/settings tests selected during implementation.

- [x] Add Pi settings/contracts and provider presentation metadata.
  - Verify: focused contract settings/model tests.

- [x] Implement strict LF-delimited Pi JSONL RPC client with correlated requests and scoped child cleanup.
  - Verify: focused Pi RPC client tests covering chunking, CRLF input, command errors, exit, and timeout.

- [x] Implement Pi provider probe, version detection, dynamic model discovery, and real thinking levels.
  - Verify: focused Pi provider tests with fake child plus one gated live discovery test.

- [x] Implement Pi adapter lifecycle and canonical runtime event mapping.
  - Verify: focused adapter/event tests for text, reasoning, tools, tool-only intermediate messages, retry, settlement, abort, and failure cleanup.

- [x] Register the Pi driver in `BUILT_IN_DRIVERS` and expose it in web/mobile pickers.
  - Verify: focused registry, web model/provider selection, and mobile provider option tests.

- [x] Bridge bounded extension UI requests and document v1 limitations.
  - Verify: synthetic select/confirm/input/editor adapter tests.

- [x] Add fork-only side-by-side desktop identity and disable official updater behavior.
  - Verify: focused desktop identity, launcher, protocol, and updater tests.

- [x] Build macOS arm64 artifact and install `/Applications/T3 Code Pi.app`.
  - Verify: inspect plist bundle id/name, code signature state, user-data/home paths, and launch health.

- [x] Run isolated live Pi smoke test.
  - Verified dynamic model discovery, prompt completion, recommendation chips, one-click follow-up sending, and terminal lifecycle settlement.

- [x] Add deterministic contextual next-step prompt chips.
  - Verify: chips appear only after settled assistant turns, use the normal send path, and hide while a composer draft or pending interaction exists.
  - Verify: Pi selectable, models populate, thinking applies, prompt/tool turn renders, interrupt/second prompt works, no blank assistant messages.

- [x] Review diff, update documentation, commit provider and branding separately, and push `feat/pi-provider`.
  - Verify: clean git status and remote branch points to validated commits.
