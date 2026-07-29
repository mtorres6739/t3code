# Pi Provider Decisions

## Chosen approach

Build a maintained side-by-side fork named **T3 Code Pi** using Pi subprocess RPC.

## Approaches considered

### 1. Side-by-side maintained fork — chosen

Pros: real Pi runtime, full T3 UI, official install preserved, testable adapter boundary, future upstream rebases possible.

Cons: meaningful implementation and ongoing rebase/build maintenance.

### 2. Patch official `app.asar` — rejected

Enabling the disabled UI card alone cannot work because current T3 has no registered Pi driver. A binary patch would also break signing and be overwritten by updates.

### 3. Route Pi through OpenCode — rejected

This would execute OpenCode, not Pi's actual runtime, resources, sessions, tools, extensions, and RPC events.

### 4. Pi-specific desktop gateway — deferred

Gripi/Paseo are quicker but do not provide the requested T3 Code control surface.

### 5. Wait for official support — rejected for now

T3 v0.0.30 exposes a disabled `Pi Agent — Coming Soon` card and upstream issue #402, but maintainers have said they are not adding providers currently.

## Architectural decisions

- RPC subprocess, not in-process Pi SDK.
- Current T3 `ProviderDriver` SPI, not the architecture from older reference forks.
- Dynamic Pi model and thinking discovery; no fallbacks.
- Lazy assistant item creation and terminal settlement on `agent_settled`.
- Full-access provider semantics in v1; do not fake unsupported approvals.
- Bridge `select`, `confirm`, and `input`; cancel unsupported multiline editor requests explicitly.
- Provider code and fork branding land as separate commits.
- Local fork updates are manual until a fork-owned updater feed exists.
- One-click next-step chips are generated locally from the final assistant text, preferring explicit `Next steps` bullets and using deterministic fallbacks. This avoids hidden model calls, surprise token spend, and conversation pollution.

## Side-by-side identity

- App: `T3 Code Pi`
- Bundle: `com.mathewtorres.t3code.pi`
- Protocol: `t3code-pi`
- Electron user data: `t3code-pi`
- T3 home: `~/.t3-pi`

## References

- Upstream issue: https://github.com/pingdotgg/t3code/issues/402
- Reference implementation: https://github.com/IgorWarzocha/t3code/pull/1
- Pi RPC docs: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`
