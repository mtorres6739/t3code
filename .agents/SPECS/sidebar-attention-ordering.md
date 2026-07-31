# Sidebar Attention Ordering Spec

## Purpose

Make the default nested T3 Code Pi sidebar behave like an operational queue: users can manually organize both projects and threads, while work that needs human action automatically rises above the manual baseline with a clear, durable indicator.

## Non-Goals

- Replacing the sidebar with a kanban board or adding arbitrary folders/tags.
- Persisting layout in the server database or syncing manual order across devices in this iteration.
- Redesigning Sidebar V2's flat-list/project-scope information architecture.
- Treating actively running work as requiring human attention.

## Interfaces and Data

- Extend the local UI state with `threadOrder: string[]`, keyed by scoped thread keys.
- Persist `completionAttentionSince` as a per-client rollout epoch so existing historical completions do not flood the attention queue.
- Extend `SidebarThreadSortOrder` with `manual` so the setting can represent persisted drag order.
- Keep existing `projectOrder` and `manual` project sort behavior.
- Add pure attention helpers in `Sidebar.logic.ts` that return an attention label and timestamp for a thread, then promote attention items above a supplied baseline without disturbing non-attention order.

## Attention States

The following states require action:

1. Pending approval
2. Awaiting user input
3. Failed turn/session
4. Actionable plan ready
5. Latest agent turn completed and has not been addressed

Working/connecting threads are visible but do not enter the attention band.

A completed turn remains `Ready for review` when opened. It clears only when:

- a newer user message/turn starts after that completion;
- the thread is settled; or
- the thread leaves the active sidebar through archive/delete.

## Ordering Rules

1. Start with the selected baseline order: updated, created, or persisted manual order.
2. Partition items into attention and non-attention groups.
3. Sort attention items by attention timestamp descending; use the baseline index as the deterministic tie-breaker.
4. Preserve baseline order exactly for non-attention items.
5. A project attention timestamp is the newest attention timestamp among its visible child threads, so the project group rises with its newest actionable child.
6. Manual drag changes the baseline order. If the relevant sort mode is not already manual, the first completed drag switches it to manual.
7. Attention promotion remains authoritative over manual placement until the attention state clears.

## Interaction and Accessibility

- Projects and threads use dnd-kit pointer and keyboard sensors.
- Drag activation must not steal normal row clicks, context menus, rename controls, or multi-select.
- Thread rows expose a standard drag handle with an accessible label; project rows retain their established sortable affordance.
- Attention uses existing semantic status colors and text labels. Project headers show the highest-priority state plus an actionable count when collapsed.
- No decorative continuous animation; movement uses the existing reduced-motion-safe sidebar list animation.

## Surfaces

- Web and desktop: full project/thread drag behavior and attention ordering.
- Mobile: no drag affordance because it uses a separate navigation surface; attention state semantics remain compatible through shared thread data.
- Sidebar V2: reuse durable completion/attention semantics and attention-first active ordering where practical, without adding project drag UI to its scope menu.

## Edge Cases

- Invalid timestamps sink behind valid attention timestamps without destabilizing the list.
- Never-visited historical completions must not all become actionable; only completions created after the feature's durable acknowledgement baseline or currently unaddressed latest work should promote. Existing last-visited data remains a migration input.
- A project with multiple physical/environment members uses scoped keys and promotes from any grouped member.
- Deleting/archiving stale IDs does not corrupt persisted order; unknown IDs are ignored and new items append to the baseline.
- Dragging an attention item changes its eventual baseline position but does not move it below non-attention items while it remains actionable.

## Acceptance Criteria

- Dragging a project persists its manual baseline and switches project sort to manual when needed.
- Dragging a thread persists its manual baseline and switches thread sort to manual when needed.
- Pending approval/input, failure, plan-ready, and newly completed work appear above non-attention work.
- The newest actionable completion appears first.
- Opening a completed thread does not clear `Ready for review`; replying or settling does.
- A project with an actionable child moves above projects without actionable children and exposes a clear indicator/count.
- Non-attention items retain the exact manual baseline order.
- Existing updated/created sort options continue to work as baselines.
- Focused tests, web typecheck, formatting/lint, and diagnostics pass.

## Test Plan

- Pure tests for attention classification, durable completion semantics, attention timestamp ordering, and stable baseline preservation.
- UI-state tests for parsing, persisting, and reordering `threadOrder`.
- Sidebar logic tests for project promotion and manual thread order.
- Focused component/logic tests for drag mode transitions where practical.
- Web package typecheck and targeted diagnostics.
