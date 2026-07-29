# Pi

Pi is a first-class T3 Code provider that runs the Pi coding agent over JSONL RPC (`pi --mode rpc`).

## Requirements

- A working Pi install on the machine running the T3 server (for example `/opt/homebrew/bin/pi`)
- Pi credentials / providers already configured for the environment where T3 will spawn Pi

T3 reuses your existing Pi installation, skills, extensions, project context files, and credentials. It does not copy Pi state into T3 userdata.

## Settings

In Settings → Providers → Pi:

- **Binary path** — optional. Defaults to `pi` resolved on the login-shell PATH. When set, T3 uses that path for version probes, model discovery, and session spawn.

Disable Pi by turning the instance off or setting `providers.pi.enabled` to `false`.

## Models and thinking

- Models come only from Pi RPC discovery (`get_available_models`). There is no static fallback catalog.
- Thinking levels come only from `get_available_thinking_levels` for the selected model.
- Model identity is `provider/id` (for example `anthropic/claude-sonnet-4-20250514`) and is sent back with `set_model`.

If discovery fails, Pi stays installed-but-unavailable with an error message and no fake models.

## Session behavior

- Each thread gets a Pi RPC child process with the project cwd so user/project skills and extensions resolve naturally.
- One T3 turn lifecycle per accepted send. Pi `agent_settled` ends the turn; `agent_end` alone is not terminal (retry/compaction may continue).
- Assistant messages open lazily on the first visible text or thinking delta so tool-only intermediate steps do not create blank bubbles.
- Interrupt sends Pi `abort` and settles the turn when the agent reports settlement (or immediately if the process already exited).

## Extension UI (v1 bounds)

Pi extensions can request user interaction over the RPC extension UI sub-protocol:

| Method                                                                | T3 behavior                                    |
| --------------------------------------------------------------------- | ---------------------------------------------- |
| `select`                                                              | Bridged as a user-input question               |
| `confirm`                                                             | Bridged as a Yes/No user-input question        |
| `input`                                                               | Bridged as a free-text user-input question     |
| `editor`                                                              | Cancelled with an explicit unsupported message |
| `notify` / `setStatus` / `setWidget` / `setTitle` / `set_editor_text` | Logged or ignored (fire-and-forget)            |

There is no fake Codex-style approval model for Pi in v1. Full-access runtime mode is the expected path.

## Text generation

Commit/PR/branch/title generation through Pi is stubbed in v1. Chat execution is the supported surface; other providers remain available for text generation.

## Troubleshooting

- **Binary not found** — install Pi or set the binary path to the absolute executable.
- **Installed but no models** — configure Pi providers/credentials, then refresh the provider status.
- **Model discovery failed** — check that `pi --mode rpc` can start and that the configured binary matches a recent Pi version with RPC support.
