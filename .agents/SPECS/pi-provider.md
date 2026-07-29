# Pi Provider Spec

## Purpose

Add Pi as a first-class T3 Code provider through Pi's JSONL RPC mode and ship a local macOS build named **T3 Code Pi** beside the official signed T3 Code app. The fork must reuse Mathew's existing Pi installation and configuration without touching official T3 state.

## Non-Goals

- No direct patching of `/Applications/T3 Code (Alpha).app`.
- No in-process Pi SDK embedding in v1.
- No fake Codex-style approval model.
- No static fallback model catalog or synthetic thinking levels.
- No provider-native server-side slash-command parser.
- No upstream pull request unless Mathew asks.
- No official auto-update feed for the fork.

## Interfaces

### Provider identity

- Driver kind: `pi`
- Default instance id: `pi`
- Default binary resolution: `pi` on the captured login-shell PATH
- Optional configured binary path: used consistently for probe, discovery, and session spawn
- Session runtime: `pi --mode rpc`
- Project cwd is passed to Pi so user/project skills, extensions, prompts, context files, settings, models, and credentials resolve naturally.

### Required RPC commands

- `get_available_models`
- `get_available_thinking_levels`
- `get_state`
- `set_model`
- `set_thinking_level`
- `prompt`
- `steer` / `follow_up` where T3 interaction mode requires them
- `abort`
- `extension_ui_response`

### Event boundary

Pi JSONL events are decoded and mapped at the adapter boundary into T3 canonical provider runtime events. The client never receives raw Pi protocol objects as application state.

- One T3 `turn.started` and one terminal turn event per accepted send.
- Assistant message items open lazily on the first visible text delta.
- Tool-only/intermediate Pi messages never create empty assistant bubbles.
- `agent_end` is not terminal when retry, compaction, or continuation remains.
- `agent_settled` is the normal terminal signal.
- Tool lifecycle events map to T3 tool items with stable call ids.
- Extension `select`, `confirm`, and `input` requests bridge to T3 user input.
- Extension `editor` is cancelled with an explicit unsupported message in v1.
- Fire-and-forget extension UI requests are logged or ignored safely.

### Models and thinking

- Models come only from Pi RPC discovery.
- Model identity round-trips to `set_model` using the provider/id fields Pi returns.
- Thinking options come only from `get_available_thinking_levels` for the selected model.
- Supported values are Pi-native: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` as returned.

### Side-by-side desktop identity

- Product name: `T3 Code Pi`
- macOS bundle id: `com.mathewtorres.t3code.pi`
- User-data directory: `t3code-pi`
- T3 home: `~/.t3-pi`
- Protocol: `t3code-pi://`
- Auto-updater: disabled unless a fork-owned feed is explicitly configured later
- Official `/Applications/T3 Code (Alpha).app`, `~/Library/Application Support/t3code`, and `~/.t3/userdata` remain untouched.

## Key Decisions

- Use subprocess RPC rather than embedding `AgentSession` to match T3's provider boundary and isolate Pi versions/processes.
- Implement against current `ProviderDriver` / `ProviderInstanceRegistry` architecture, using old fork PRs only as behavioral references.
- Keep provider implementation and local branding as separate commits so the provider work remains reviewable and branding remains fork-only.
- Stub provider-specific text-generation support in v1 if the current driver interface requires it; chat execution is the required feature.
- Reuse existing Pi credentials/resources rather than copying them into T3 state.

## Edge Cases and Failure Modes

- Missing or non-executable configured Pi binary.
- JSONL records split across arbitrary stdout chunks; only LF is a delimiter and trailing CR is stripped.
- Unknown future Pi events must not crash the provider.
- Spawn, handshake, model switch, thinking switch, or prompt rejection must clean up in-flight state.
- Mid-turn child exit must fail the turn, emit session exit, and remove the process/session mapping.
- Interrupt must send `abort`, settle the turn, and remain safe if the process already exited.
- Extension UI requests must time out/cancel rather than deadlock Pi.
- Model discovery failure produces no fake models and a clear unavailable/error snapshot.
- Non-Pi users must not pay repeated Pi discovery cost.
- Fork bundle identity or T3 home must never collide with the official app.

## Acceptance Criteria

- Pi is selectable in T3 Code Pi when `/opt/homebrew/bin/pi` is usable.
- Pi is unavailable/disabled when missing, broken, or explicitly disabled.
- T3 reports the installed Pi version and dynamically discovered models.
- Model and thinking selections apply before the next prompt.
- A Pi turn can read/edit/run tools in a test project and render streaming text/tool progress.
- Tool-only intermediate steps do not render blank assistant messages.
- Spawn/start/send/model-switch failures leave no orphaned Pi child or poisoned T3 session.
- Interrupt works and the session can accept a later prompt.
- Pi user/project skills, extensions, and context files load from the natural cwd/environment.
- Focused provider/contracts/web/desktop tests pass.
- A macOS arm64 build installs as `/Applications/T3 Code Pi.app` beside official T3 Code.
- The fork launches with a distinct bundle id, protocol, user-data directory, and `~/.t3-pi` home.
- Official T3 Code still launches and its data is unchanged.

## Next-Step Recommendations

After a completed assistant response, T3 Code Pi shows 2–4 one-click prompt chips above the composer.

- Clicking a chip sends the prompt through the normal composer/turn path.
- Explicit `Next steps` bullets in the assistant response take priority.
- When no explicit list exists, deterministic local rules recommend actions based on completion, failures, blockers, plans, or generic continuation.
- Recommendations disappear while a turn, approval, user-input request, plan follow-up, or thread load is active.
- Recommendation generation makes no hidden model call and incurs no extra provider cost.

## Test Plan

- Unit tests for JSONL framing, request correlation, process-exit cleanup, and unknown events.
- Pure event-mapping fixtures for text, reasoning, tool-only turns, retries, settlement, abort, and extension UI.
- Driver/provider tests for binary path, version probe, dynamic models, and missing binary.
- Adapter integration tests with a fake Pi RPC child.
- Focused web tests for provider picker, model selection, and thinking options.
- Focused desktop identity/update tests for bundle/user-data/protocol/home isolation.
- One live smoke test against `/opt/homebrew/bin/pi` in an isolated temporary project and fork home.
