# Sidebar Attention Ordering Decisions

## Product decision

Use the existing default nested sidebar as the primary organization surface. It already exposes projects, nested threads, project drag-and-drop, status pills, and grouping, making it the smallest path to the requested behavior.

## Confirmed preferences

- Both projects and individual threads are manually reorderable.
- Attention overrides the manual baseline.
- Newest attention item is first.
- Opening a completed thread does not count as actioning it.
- Replying/starting the next turn or explicitly settling the thread clears completion attention.

## Architecture decisions

- Persist thread order beside `projectOrder` in the existing local Zustand UI state. This matches current project-order scope and avoids a server migration.
- Treat manual order as a baseline, not an absolute top-level ordering. Attention is a temporary derived layer, so clearing attention naturally returns the item to its manual position.
- Derive attention from durable thread/session data rather than a new mutable `needsAttention` flag. This avoids cross-device acknowledgement races and stale flags.
- Persist one rollout epoch per client. Completions after that epoch require review; older historical completions do not flood the queue on upgrade. Opening a thread is intentionally irrelevant.
- Keep `hasUnseenCompletion` for legacy unread presentation, but use separate unaddressed-completion semantics for operational attention.
- Use existing dnd-kit dependencies and interaction patterns; do not add another drag library.
- Mobile remains non-draggable because its navigation is structurally different. It persists its own rollout epoch and shares `Ready for review` semantics across both mobile list variants.
- Drag operations update the non-attention baseline, never the temporarily promoted display order. Clearing attention therefore returns the item to the position the user actually chose.

## Rejected alternatives

- **Pure activity sorting:** noisy and does not preserve the user's organization.
- **Manual-only ordering with badges:** misses the requirement that actionable work automatically rises.
- **Opening clears attention:** too easy to lose work simply by inspecting it.
- **Dedicated database ordering/events:** unnecessary for a personal UI preference and expands remote/event-sourcing scope.
- **Full Sidebar V2 redesign:** larger than needed and currently hides project groups behind a scope picker.

## Design note

Use text labels, compact badges, counts, and existing semantic colors. Do not add side accent stripes or decorative animation. The status should answer both “why is this at the top?” and “what action is required?”

## Tooling note

The requested Impeccable v4.0.4 update was attempted with `npx impeccable update`, but the updater reported `cannot access update`. The current task continues under the loaded v3.9.1 guidance.
