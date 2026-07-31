# Sidebar Attention Ordering TODO

- [x] Inspect current sidebar sorting, status, drag, and persistence boundaries.
  - Verify: `Sidebar.tsx`, `SidebarV2.tsx`, `Sidebar.logic.ts`, `uiStateStore.ts`, and settings contracts mapped.
- [x] Confirm product behavior with Mathew.
  - Verify: both dimensions draggable; attention overrides; reply/settle clears.
- [x] Add pure attention classification and stable promotion helpers.
  - Verify: focused `Sidebar.logic.test.ts` cases.
- [x] Persist manual thread order and support the manual thread sort mode.
  - Verify: focused `uiStateStore.test.ts` and contracts/type checks.
- [x] Add thread drag-and-drop and first-drag manual-mode transitions.
  - Verify: focused sidebar tests plus web typecheck.
- [x] Promote projects from actionable child threads and strengthen indicators.
  - Verify: project ordering/status tests.
- [x] Keep Sidebar V2 attention semantics aligned where practical.
  - Verify: Sidebar V2 sorting/status logic tests.
- [x] Run focused verification and independent review.
  - Verify: tests, lint, typecheck, LSP/Pi Lens, reviewed diff.
- [x] Update durable notes and ACP.
  - Verify: scoped commit and successful push with `.pi/` untouched.
