# TUI Core Renderer — Reactive Retained Host Tree, Damage Scheduling, and Frame Composition

This document describes the core terminal rendering engine in `@oh-my-pi/pi-tui`. The subsystem implementation is located in:

- [`packages/tui/src/root.ts`](../packages/tui/src/root.ts) — reactive root mounting (`render()`), dependency wiring, and teardown.
- [`packages/tui/src/host/`](../packages/tui/src/host/) — retained host tree (`HostNode`), universal Solid renderer (`renderer.ts`), damage classification, and intrinsic element implementations.
- [`packages/tui/src/compositor/`](../packages/tui/src/compositor/) — compositor loop, frame planning, transcript retirement, and cache-aware subtree painting.
- [`packages/tui/src/style/`](../packages/tui/src/style/) — token cascade, recipe resolution, and reactive theme propagation.
- [`packages/tui/src/document/`](../packages/tui/src/document/) — text and output documents with range-invalidated syntax caching.
- [`packages/tui/src/tui.ts`](../packages/tui/src/tui.ts) — terminal driver, hardware cursor synchronization, erase-before-scroll, and CPR anchor recovery.
- [`packages/tui/src/terminal.ts`](../packages/tui/src/terminal.ts) — raw mode, CSI protocol parsing, and capability negotiation.
- [`packages/tui/src/testing.ts`](../packages/tui/src/testing.ts) — headless in-memory test root, row serialization, and instrumentation counters.

---

## 1. The Retained Host Tree and Universal Renderer

The rendering pipeline abandons full-tree immediate painting. Instead, it maintains a persistent, retained hierarchy of **`HostNode`** objects created and updated by a SolidJS universal renderer (`solid-js/universal` via `@oh-my-pi/pi-tui/host/renderer`):

```ts
export type HostNodeKind = "element" | "text";

export interface HostNode {
  readonly id: number;
  readonly kind: HostNodeKind;
  readonly tag: string;            // Intrinsic tag name or "" for text
  parent: HostElement | null;
  props: Record<string, unknown>;  // Current reactive props
  text: string;                    // Text content for text nodes
  children: HostNode[];            // Child elements
  damage: Damage;                  // Invalidation bitset
  cache: RichText;                 // Per-node cached paint runs
  cacheWidth: number;              // Width at which cache was painted
  cacheEpoch: number;              // Global style/width epoch
  element?: ElementImpl;           // Intrinsic element implementation
}
```

When reactive state changes, Solid updates only the targeted `HostNode`'s properties or text content directly. Function components execute **only once** on mount; they do not re-run on subsequent state updates.

---

## 2. Damage Classification and Invalidation Pipeline

Instead of coarse, pull-based invalidation (`requestRender()`), every property mutation is classified by its intrinsic element's `propDamage(name)` method into a fine-grained `Damage` bitset:

```ts
export const enum Damage {
  None = 0,
  Paint = 1,        // Style, color, background, attribute changes (re-record runs without measuring)
  Text = 2,         // Text content change (measure text; layout only if row count changes)
  Layout = 4,       // Sizing, padding, child insertion/removal/movement
  Link = 8,         // Clickable hyperlink changes
  Interaction = 16, // Focus and selection changes
}
```

### Invalidation Mechanics

1. **Property Mutation**: A reactive setter updates a prop via `setProp(node, name, value)`.
2. **Classification**: `elementImpl.propDamage(name)` determines the damage class.
3. **Damage Bubbling (`markDamage`)**:
   - `Damage.Layout` and `Damage.Text` bubble up the parent chain to ancestors whose geometry depends on child bounds.
   - `Damage.Paint` invalidates the nearest cached ancestor.
4. **Compositor Notification**: The host root marks its frame provider dirty and schedules a render flush on the terminal engine.

---

## 3. Compositor Flush Cycle

The compositor operates on an adaptive, coalesced cadence (30fps ceiling with 50% duty cycle backpressure and a 64 KiB output backlog limit). When a flush occurs:

```text
1. Apply Event Batch (Solid batch())
   │
2. Settle Reactive Graph (Signals -> Memos -> Effects propagate to HostNodes)
   │
3. Execute Layout Hooks (createLayoutEffect callbacks)
   │
4. Resolve Dirty Styles (Cascade: defaults -> inherited -> variant -> recipe -> props)
   │
5. Paint Dirty Subtrees (RichText cache replay for clean nodes; paint for dirty)
   │
6. Compose TerminalFramePlan (HistoryBatch + mutable Viewport RichText)
   │
7. Terminal Emission (Synchronized output CSI 2026 -> Delta ANSI emission)
   │
8. Execute Commit Hooks (createCommitEffect callbacks)
```

### Cache Replay vs. Repaint

During the paint pass (`paintHostTree`):
- Clean subtrees whose width matches `cacheWidth` and whose epoch matches `cacheEpoch` **replay** their pre-recorded `RichText` runs directly into the parent frame buffer without executing layout or element painting logic.
- Only nodes with `damage !== Damage.None` re-invoke their `elementImpl.paint(...)` handler.
- Once painted, the node clears its damage bitset and caches the painted `RichText`.

Native layout preserves presentation boundaries without ANSI round trips:
- Nested full-width `<hr variant="frame">` rows join the enclosing frame; `labelColor` and `titleBold` remain independent of border styling.
- Status glyphs occupy their actual preset width, so changing the status invalidates layout rather than paint alone.
- `Style.NONE` inherits enclosing fills; `Style.RESET` explicitly preserves terminal defaults through those fills, including overflow markers and their trailing padding.
- Code slices retain syntax scope from the complete document. Markdown's optional `wrapAllowance` separates semantic reflow from the physical wrapped allocation.
- Transcript retirement strips only unstyled blank edges. Tinted blank rows and protocol-bearing rows remain visible.

---

## 4. Two-Channel Frame Contract: History vs. Viewport

The terminal display contract maintains two separate channels exposed via `TerminalFramePlan`:

```ts
export interface HistoryBatch {
  id: number;
  rows: readonly string[];
  kind?: "append" | "replay";
}

export interface TerminalFramePlan {
  history?: HistoryBatch;
  viewport: RichText;
}
```

### Distinction Between Channels

| Channel | Properties | Purpose |
|---|---|---|
| **History** | Append-only, monotonic, persistent in terminal scrollback. | Finalized chat turns, committed command outputs, settled tool results. |
| **Viewport** | Replaceable, mutable, differential cell-native screen image. | Active prompt editor, in-progress tool executions, live status lines, overlays. |

### Finality and Acknowledgement

- **Application-Driven Finality**: The renderer never inspects scroll positions or guesses finality based on rows crossing the top of the terminal screen. The application explicitly designates rows as finalized.
- **Monotonic Handshake**: A history batch carries a monotonic ID. The terminal driver appends an accepted batch exactly once, emits it to the terminal, and acknowledges the ID to the provider. The provider retains unacknowledged batches for safe retries and coalescing.

---

## 5. Transcript Architecture (`<transcript>` and `<transcript-block>`)

The product transcript is structured using dedicated host elements:

- **`<transcript>`**: The container managing retirement boundaries and viewport coordinates.
- **`<transcript-block mode="..." settled="...">`**: One semantic transcript block (e.g. user message, assistant turn, or tool execution).

### Block Modes

1. **`mode="mutable"`**: The block remains entirely inside the redrawable viewport. Any internal state change cleanly updates the viewport.
2. **`mode="appendOnly"`**: Used for streaming assistant turns and long-running shell outputs. The block publishes a monotonically extending prefix of stable semantic rows (`stableRows`). As rows stabilize, the compositor safely commits them to terminal scrollback without waiting for the entire block to settle.

### Erase-Before-Scroll and Replay Split

To prevent partial or uncommitted viewport rows from leaking into native scrollback during scrolling, the terminal driver employs an **erase-before-scroll** policy (`#emitPlanFrame` in `src/tui.ts`). Live viewport rows above the scroll line are explicitly erased before new history rows advance the physical terminal grid.

---

## 6. Layout Model and Flex Allocation

Layout is row-based. Width is allocated downwards; heights (row counts) are measured upwards.

- **`<row>` Allocation**: Inline children are allocated available horizontal width based on `grow`, `shrink`, `width`, and `minWidth` props.
- **Text Wrapping**: Handled by `<text wrap="word" | "none" | "clip">`. Unicode East Asian widths (UAX#11) and zero-width ANSI escapes are computed grapheme-safely without allocating intermediate strings.
- **Overflow Truncation**: `<text overflow="ellipsis">` appends a theme ellipsis; `<path overflow="middle">` preserves file names and directory roots by inserting an ellipsis in the middle of long paths.

---

## 7. Document System and Range Caching

Document-backed presentation (diffs, syntax-highlighted code, markdown, formatted JSON) is driven by `TextDocument` and `OutputDocument` (`packages/tui/src/document/`).

- **Offset-Based Changes**: Document modifications arrive as `DocumentChange` events (`append`, `replace`, `reset`) with exact UTF-16 code unit offsets.
- **Syntax Caching**: Parsing caches in `<code>`, `<markdown>`, and `<diff>` elements are keyed on `(doc.version(), invalidatedRange)`. When a tool streams output, only newly appended lines are tokenized; existing tokens are preserved.

---

## 8. Reset, Resize, and Terminal Capabilities

### Capability Negotiation

On startup, `ProcessTerminal` queries terminal capabilities (synchronized output, Kitty graphics protocol, OSC 8 hyperlinks, DECCARA). Features are capability-gated; fallback text renderings are used when advanced protocols are unsupported.

### Resize Recovery

When a terminal window resizes:
1. `Damage.Layout` is marked across the host root with a new width epoch.
2. The viewport re-lays out and repaints at the new dimensions.
3. For retained scrollback, `ResizeScrollbackMode` governs behavior:
   - `rebuild`: Synchronously clears terminal scrollback and replays the current-width transcript from history batches.
   - `append`: Appends a fresh current-width copy to history.
   - `preserve`: Repaints the mutable viewport only, leaving historical scrollback untouched.
4. CPR (CSI 6n) cursor position queries verify viewport baseline alignment across complex multiplexer boundaries (tmux, ConPTY, Ghostty).

### Inline Images and Memory Budgets

Kitty graphics protocol images are managed through a central image budget ledger. Images demoted out of the budget cache are evicted by ID and replaced with height-preserving text fallbacks to prevent runaway GPU/terminal memory consumption.

---

## 9. Testing Substrate (`@oh-my-pi/pi-tui/testing`)

Headless tests run against an in-memory retained host root:

```ts
import { mountForTest, type TestRoot } from "@oh-my-pi/pi-tui/testing";

const root: TestRoot = mountForTest(() => <App />, { width: 80 });

// Inspect rendered terminal rows (plain text or ANSI):
const textLines = root.text();
const ansiLines = root.rows();

// Flush queued effects and clock ticks:
root.flush();

// Inspect fine-grained performance counters:
const counters = root.counters();
console.log(`Paints: ${counters.paints}, Nodes Created: ${counters.nodesCreated}`);

root.dispose();
```

`Counters` verify that state changes re-render only the affected host nodes without triggering full-tree rebuilds or unnecessary paints.

---

## 10. Migration Reference

| Legacy Subsystem / API | Modern Core Renderer Replacement | Architectural Motivation |
|---|---|---|
| `class Mount` | Retained `HostNode` + universal Solid renderer | Replaces manual hook instance trees with direct reactive node binding. |
| `Component.paint(out, width)` | Intrinsic `ElementImpl.paint(node, out, width, ctx)` | Decouples application view authoring from internal frame painting. |
| `requestRender(force)` / `requestComponentRender()` | `markDamage(node, Damage)` | Fine-grained dirty flagging avoids coarse, redundant repaints. |
| Custom `Hasher` / `RenderCache` | Per-node `cache: RichText` keyed on width and epoch | Automatic run replay without ad-hoc hashing or string caches. |
| `sharedSpinnerTimer` / poll loops | Centralized `Clock` signal via `useClock()` | Eliminates hundreds of concurrent timers; unifies animations on one cadence. |
| Manual string width slicing | `<row>` flex allocation & `<text overflow="...">` | Layout intrinsics handle cell budgeting and UAX#11 measurement centrally. |
