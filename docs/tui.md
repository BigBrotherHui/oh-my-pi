# Modern Reactive TUI Authoring Model (`@oh-my-pi/pi-tui`)

`@oh-my-pi/pi-tui` is a fine-grained reactive terminal UI framework for Node.js and Bun. It couples the **SolidJS** reactive engine (`solid-js@1.9.15`) with a universal retained host tree renderer, a row-allocated layout system, cached cell-native frame painting, and differential synchronized terminal output.

Application and extension views are authored as declarative Solid JSX components. State changes update individual host nodes and text runs directly; the framework does not re-execute component functions on change or repaint clean subtrees.

---

## 1. Architecture Overview

The system is organized into distinct layers:

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ Solid Reactive Surface (signals, stores, memos, effects, context)       │
├─────────────────────────────────────────────────────────────────────────┤
│ Universal Host Tree (HostNode, element impls, damage classification)    │
├─────────────────────────────────────────────────────────────────────────┤
│ Text Layout & Cascade (row allocation, Style tokens, recipes, cache)   │
├─────────────────────────────────────────────────────────────────────────┤
│ Compositor & Transcript (TerminalFramePlan, append-only history, diff)  │
├─────────────────────────────────────────────────────────────────────────┤
│ Terminal Backend (synchronized output CSI 2026, CPR, raw mode, mouse)  │
└─────────────────────────────────────────────────────────────────────────┘
```

1. **Reactive Surface**: Standard Solid primitives (`createSignal`, `createMemo`, `createStore`, `Show`, `For`) coupled with TUI-specific lifecycle and environment hooks (`useClock`, `useTheme`, `useKeymap`, `useFocus`, `createLayoutEffect`, `createCommitEffect`).
2. **Universal Host Tree**: A retained DOM-like tree of `HostNode` instances operated by `@oh-my-pi/pi-tui/host/renderer` (via `solid-js/universal`). Each node tracks damage classes (`Paint`, `Text`, `Layout`, `Link`, `Interaction`) and caches painted `RichText` runs keyed by layout width.
3. **Compositor & Terminal**: The compositor walks damaged host subtrees during scheduled render flushes, paints dirty nodes into cell-native `RichText` buffers while replaying cached runs for clean nodes, and emits delta ANSI sequences inside synchronized-output frames (`CSI 2026`).

---

## 2. Render Root and Lifecycle

A reactive terminal application is mounted through `render()` from `@oh-my-pi/pi-tui/root`:

```ts
import { render, type RootOptions, type RootHandle } from "@oh-my-pi/pi-tui/root";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";

const terminal = new ProcessTerminal();
const theme = loadThemeSync("dark");

const handle: RootHandle = render(() => <App />, {
  terminal,
  theme,
});

// To unmount and restore the terminal:
handle.dispose();
```

### Root Options and Handle

```ts
export interface RootOptions {
  readonly terminal: Terminal;
  readonly theme: Theme;
  readonly keymap?: Keymap;
  readonly clock?: Clock;
  readonly capabilities?: TerminalCapabilities;
}

export interface RootHandle {
  readonly tui: TUI;
  dispose(): void;
}
```

`render()` creates the root Solid reactive context, mounts the retained host tree root, installs input and focus runtimes, instantiates the theme signal and root clock, and connects the compositor to `TUI` as its frame provider. Calling `handle.dispose()` cleans up all reactive owners, detaches input listeners, drains timers, and restores raw terminal mode.

---

## 3. Reactive Surface (`@oh-my-pi/pi-tui/reactive`)

Application and feature code imports reactive primitives exclusively from `@oh-my-pi/pi-tui/reactive`. Direct imports from `solid-js` are prohibited in product code.

### Primitives from Solid

- **Reactivity & Lifecycle**: `createSignal`, `createMemo`, `createEffect`, `createRoot`, `onMount`, `onCleanup`, `batch`, `untrack`.
- **Stores**: `createStore`, `produce`, `reconcile`, `unwrap` for nested or streaming structured state.
- **Control Flow**: `<Show when={...} fallback={...}>`, `<For each={...}>`, `<Index each={...}>`, `<Switch>`, `<Match>`, `<ErrorBoundary>`, `<Suspense>`.

### TUI-Specific Hooks and Lifecycle

```ts
import {
  useClock,
  useTheme,
  useKeymap,
  useFocus,
  createLayoutEffect,
  createCommitEffect,
} from "@oh-my-pi/pi-tui/reactive";
```

- **`useClock(cadence: "frame" | "spinner" | "second"): Accessor<number>`**: Subscribes to the shared root clock. Active subscriptions automatically unsubscribe when a component is unmounted, hidden, or frozen in transcript history. Views must **never** call `Date.now()` during rendering.
- **`useTheme(): ThemeAccess`**: Accesses reactive semantic color tokens and symbol glyphs from the current root or scoped `<ThemeScope>`. Views receive token names and resolve them dynamically, never hardcoding ANSI escape codes.
- **`useKeymap(): KeymapAccess`**: Queries active keybindings and resolves display hints:
  ```ts
  const keymap = useKeymap();
  const expandHint = () => keymap.hint("expand"); // e.g. "ctrl+o"
  ```
- **`useFocus(): FocusHandle`**: Bind the returned `tabIndex` to the element that owns the handle:
  ```tsx
  const focus = useFocus();
  onMount(() => focus.focus());
  return <box tabIndex={focus.tabIndex} onKey={handleKey}>{children}</box>;
  ```
  `<input>` and `<editor>` participate in focus by default. A newly mounted root or overlay initially focuses its first innermost focusable element. Set `tabIndex={-1}` to exclude a control. Keys bubble from the focused element; parent handlers should respect `event.defaultPrevented`.
- **`createLayoutEffect(fn: () => void)`**: Executes synchronously after the owning subtree's row layout and measurement pass completes.
- **`createCommitEffect(fn: () => void)`**: Executes after the terminal compositor commits frame output containing the owning subtree.

---

## 4. Element Vocabulary

JSX intrinsic elements are compiled by the Solid universal transform to host element factory calls. Every intrinsic accepts standard layout props (`grow`, `shrink`, `width`, `minWidth`, `maxWidth`, `padding`, `paddingX`, `paddingY`), style props (`color`, `background`, `bold`, `dim`, `recipe`), and event handlers (`onKey`, `onMouse`).

### 1. Generic Containers and Layout

| Element | Description | Key Props |
|---|---|---|
| `<stack>` | Vertical layout container; stacks child elements into consecutive rows. | `gap?: number`, `align?: "start" \| "center" \| "end"` |
| `<row>` | Horizontal row layout with flex allocation across children. | `gap?: number`, `wrap?: boolean` |
| `<box>` | Padded container with background styling. | `padding?: number`, `paddingX?: number`, `paddingY?: number`, `background?: ThemeBg` |
| `<sized>` | Fixed or bounded dimensional box. | `width?: number`, `height?: number`, `minWidth?: number`, `minHeight?: number` |
| `<frame>` | Bordered container with title and state tints. | `title?: string`, `borderStyle?: "round" \| "sharp" \| "double"`, `color?: ThemeColor` |
| `<hr>` | Horizontal divider line. | `character?: string`, `color?: ThemeColor` |
| `<rail>` | Vertical accent bar / guide line along content edges. | `color?: ThemeColor`, `position?: "left" \| "right"` |
| `<split>` | Resizable or ratio-based two-pane split container. | `direction?: "horizontal" \| "vertical"`, `ratio?: number` |
| `<scroll>` | Scrollable viewport with scrollbar indicator. | `scrollY?: number`, `followTail?: boolean` |

### 2. Text and Inline Elements

| Element | Description | Key Props |
|---|---|---|
| `<text>` | Multi-line text container with word wrapping and overflow policies. | `wrap?: "word" \| "none" \| "clip"`, `overflow?: "clip" \| "ellipsis" \| "middle"` |
| `<span>` | Inline text run inheriting parent text flow and styling. | `color?: ThemeColor`, `bold?: boolean`, `dim?: boolean`, `italic?: boolean`, `underline?: boolean` |
| `<br>` | Explicit line break within inline text flow. | — |
| `<path>` | Filesystem or selector path with middle-ellipsis truncation (usable inline inside `<text>`/labels or as a sized `<row>` child). | `value: string`, `target?: string`, `overflow?: "middle" \| "ellipsis"` |
| `<link>` | Terminal OSC 8 clickable hyperlink. | `href: string` |
| `<cursor>` | Explicit hardware cursor anchor within layout. | `shape?: "block" \| "bar" \| "underline"` |
| `<raw>` | Internal compositor bypass for pre-formatted runs. | `content: RichText` |

### 3. Presentation Tokens and Data Elements

| Element | Description | Key Props |
|---|---|---|
| `<icon>` | Semantic icon resolved from current theme symbol preset. | `name: string`, `color?: ThemeColor` |
| `<status>` | Semantic status badge with automatic spinner subscription. | `value: "running" \| "success" \| "error" \| "warning" \| "pending" \| "done" \| "aborted" \| "info"` |
| `<badge>` | Brackets or chip containing label text. | `color?: ThemeColor`, `background?: ThemeBg` |
| `<meta>` | Dot-separated list of child items (skips empty children). | `separator?: string` |
| `<preview>` | Head/tail truncated output preview with hidden row counter. | `edge?: "head" \| "tail"`, `rows?: number`, `items?: number` |
| `<code>` | Syntax-highlighted code block emitting style roles. | `text?: string`, `doc?: TextDocument`, `language?: string` |
| `<diff>` | Syntax-highlighted unified or side-by-side diff. | `diff?: string`, `doc?: TextDocument`, `view?: "unified" \| "split"` |
| `<markdown>` | Themed markdown renderer with soft-break safety. | `text?: string`, `doc?: TextDocument` |
| `<json>` | Interactive or expandable JSON tree view. | `data: unknown`, `depth?: number` |
| `<table>` | Tabular data formatter with column alignment. | `columns: TableColumn[]`, `data: unknown[]` |
| `<progress>` | Percentage or indeterminate progress bar. | `value?: number`, `max?: number`, `width?: number` |
| `<spinner>` | Animated theme-consistent spinner frame. | `color?: ThemeColor` |
| `<shimmer>` | Animated keyword shimmer effect. | `color?: ThemeColor` |
| `<duration>` | Human-readable millisecond duration formatter. | `ms: number` |
| `<timestamp>` | Formatted date/time stamp. | `at: number \| Date` |
| `<choice>` | Radio button or checkbox toggle. | `kind: "radio" \| "checkbox"`, `checked: boolean` |
| `<select>` | Interactive option selector list. | `options: string[]`, `selectedIndex: number` |
| `<tabs>` | Tab navigation bar. | `tabs: string[]`, `activeTab: string` |
| `<tree>` | Hierarchical guide tree. | `items: TreeItem[]` |

### 4. Interactive and Runtime Resources

| Element | Description | Key Props |
|---|---|---|
| `<input>` | Single-line interactive text input with cursor handling. | `value?: string`, `onChange?: (value: string) => void`, `onSubmit?: (value: string) => void`, `onEscape?: () => void` |
| `<editor>` | Host surface for an editor state machine; subscribes to draft and completion changes. | `editor: Editor` |
| `<terminal>` | Interactive headless PTY terminal surface. | `pty: ProcessTerminal`, `rows?: number`, `cols?: number` |
| `<image>` | Inline graphic rendered via Kitty or iTerm2 protocol. | `src: string`, `width?: number`, `height?: number` |
| `<qr>` | QR code generator rendered into terminal cells. | `data: string` |
| `<transcript>` | Transcript container with commit boundaries. | `children: JSX.Element` |
| `<transcript-block>` | One mutable or append-only transcript entry. | `mode?: "mutable" \| "appendOnly"`, `settled?: boolean` |

---

## 5. Shared Compositions

Common UI structures are plain TSX functions exported from `@oh-my-pi/pi-tui/view/*` (or the package root):

- **`ToolCard`**: Framed tool presentation with phase-driven tinting and collapse headers.
- **`ToolHeader`**: Standard tool title row with status icon, tool name, label, duration, and metadata.
- **`Card`**: Styled surface box with title and subtitle headers.
- **`Section`**: Grouping header with divider line.
- **`KeyValue`**: Label/value pairs with automatic column alignment.
- **`List` / `TreeList` / `FileList`**: Uniform item collections with selection highlights.
- **`AgentRow`**: Subagent status row with model badge, state icon, and task description.
- **`JsonTree`**: Interactive expandable JSON node explorer.
- **`Kbd`**: Keyboard shortcut pill badge (`<Kbd shortcut="ctrl+c" />`).
- **`Hints`**: Footer bar displaying key hints.
- **`Notice`**: Informational, warning, or error banner box.
- **`StatusIcon`**: Resolves tool/turn execution states to theme icons and colors.
- **`DiffStats`**: Displays `+added -removed` line statistics.
- **`TruncationNotice`**: Indicator showing hidden row/byte counts for truncated output.

---

## 6. Styling Tokens and Cascade

Styling is based on semantic tokens rather than hardcoded ANSI escape sequences.

### Token Types

- **`ThemeColor` (Foreground)**: `"text"`, `"muted"`, `"dim"`, `"accent"`, `"success"`, `"error"`, `"warning"`, `"info"`, `"border"`, etc.
- **`ThemeBg` (Background)**: `"surface"`, `"surface.tool"`, `"surface.muted"`, `"selected"`, `"toolPendingBg"`, etc.

### Cascade Precedence

When a host element paints, its style resolves through a strict hierarchy (from lowest to highest precedence):

1. **Element Defaults**: Hardcoded baseline values defined by the intrinsic element implementation.
2. **Inherited Text Properties**: Text attributes (`color`, `bold`, `dim`, `italic`, `underline`, `undercurl`, `strike`, `inverse`, `link`) flow down from ancestors. *Background, padding, and dimensional sizes never inherit.*
3. **Variant / State**: Element-specific state styling (e.g. active tab, checked radio, focused input).
4. **Recipe (`recipe="..."`)**: Pre-configured style bundles defined in `packages/tui/src/style/recipes.ts`.
5. **Local Style (`style={Style}`)**: Explicit `Style` instance provided to the element.
6. **Explicit Props**: Direct props set on the JSX tag (`color="accent"`, `bold={true}`).

### Accessing Theme in Views

Views do not inspect raw ANSI values. When a semantic token must be resolved imperatively, use `useTheme()`:

```tsx
import { useTheme } from "@oh-my-pi/pi-tui/reactive";

export function CustomLabel(props: { name: string }) {
  const theme = useTheme();
  
  // Resolve Color struct from token name:
  const accentColor = () => theme.token("accent");
  const checkGlyph = () => theme.symbol("check");

  return (
    <row gap={1}>
      <text color={accentColor()}>{checkGlyph()}</text>
      <text bold>{props.name}</text>
    </row>
  );
}
```

To scope an entire subtree under a different theme palette:

```tsx
<ThemeScope theme={customTheme}>
  <App />
</ThemeScope>
```

---

## 7. Documents and Streaming Output

Large texts (such as command output, diffs, source files, and assistant markdown) are managed by `TextDocument` and `OutputDocument` instances from `@oh-my-pi/pi-tui/document/document`.

```ts
export interface TextDocument {
  readonly version: Accessor<number>;
  text(): string;
  lineCount(): number;
  line(index: number): string;
  lineStart(index: number): number;
  apply(change: DocumentChange): void;
  subscribe(listener: (change: DocumentChange, version: number) => void): () => void;
}

export interface OutputDocument extends TextDocument {
  readonly capture: Accessor<"streaming" | "complete" | "truncated">;
  readonly notices: Accessor<readonly OutputNotice[]>;
}
```

### Ingestion Adapters

- **`createDocument(initial?: string): TextDocument`**: Creates an empty or pre-populated mutable document.
- **`createOutputDocument(initial?: string): OutputDocument`**: Creates an output document with streaming capture state and notice accessors.
- **`documentFromSnapshots()`**: An ingestion adapter for sources that provide full snapshot strings. It diffs consecutive snapshots and applies minimal `append` or `replace` changes without reallocating full document text.

Document-consuming elements (`<code>`, `<diff>`, `<markdown>`, `<preview>`) track `doc.version()` reactively and cache syntax parsing against invalidated offset ranges.

---

## 8. Tool Presentation (`ToolViewDefinition`)

Tools in the chat transcript are presented through reactive view definitions conforming to `ToolViewDefinition<TArgs, TDetails>` from `@oh-my-pi/pi-tui/tools/view`:

```ts
export interface ToolViewDefinition<TArgs, TDetails> {
  readonly view: (props: ToolViewProps<TArgs, TDetails>) => JSX.Element;
  readonly summary?: (props: ToolViewProps<TArgs, TDetails>) => ActivitySummary;
  readonly framed?: boolean;
}
```

### `ToolViewProps` Contract

`ToolViewProps` provides reactive properties for the tool execution:

```ts
export interface ToolViewProps<TArgs, TDetails> {
  readonly id: string;
  readonly toolName: string;
  readonly label: string;
  readonly args: DeepReadonly<DeepPartial<TArgs>>;  // Reactive store, streams while receiving
  readonly phase: "receiving" | "queued" | "running" | "settled";
  readonly outcome?: "success" | "failed" | "cancelled" | "timed_out" | "skipped";
  readonly details?: DeepReadonly<TDetails>;
  readonly output: OutputDocument;                    // Streaming output document
  readonly notices: readonly OutputNotice[];
  readonly images: readonly ImageBlock[];
  readonly ui: ToolUiState;                           // expanded, allocation, showImages, frozenAt
}
```

Tool views register with `registerToolView(name, definition)` from `@oh-my-pi/pi-tui/tools/registry`.

---

## 9. Overlays and Portals

Overlays (dialogs, autocomplete popups, command palettes, model pickers) are rendered via the `<Portal to="overlay">` component from `@oh-my-pi/pi-tui/overlay`:

```tsx
import { Portal } from "@oh-my-pi/pi-tui/overlay";

export function ConfirmationModal(props: { open: boolean; onConfirm: () => void }) {
  return (
    <Show when={props.open}>
      <Portal to="overlay" anchor="center" modal>
        <box padding={1} background="surface" color="text">
          <frame title="Confirm Action">
            <text>Are you sure you want to proceed?</text>
            <row gap={2}>
              <text color="accent">[Y] Yes</text>
              <text color="muted">[N] No</text>
            </row>
          </frame>
        </box>
      </Portal>
    </Show>
  );
}
```

Portals composite over the primary viewport inside the terminal frame without corrupting transcript history.

---

## 10. Testing Substrate (`@oh-my-pi/pi-tui/testing`)

Unit and integration tests inspect reactive components in memory without launching physical terminal emulators:

```ts
import { mountForTest, renderToRows, type TestRoot } from "@oh-my-pi/pi-tui/testing";

const root: TestRoot = mountForTest(() => <MyView value={signal()} />, { width: 80 });

// Access rendered rows:
expect(root.text()).toContain("Expected Text");

// Verify fine-grained update counts:
const initial = root.counters().nodesCreated;
setSignal("new-value");
root.flush();
expect(root.counters().nodesCreated).toBe(initial); // Zero DOM re-creations!

root.dispose();
```

`renderToRows(() => <MyView />, 80)` provides a one-shot helper returning emitted ANSI rows.

---

## 11. Realistic Authoring Examples

### Example 1: Interactive Key-Navigated Picker

```tsx
import { createSignal, onMount, For, useFocus } from "@oh-my-pi/pi-tui/reactive";
import type { HostKeyEvent } from "@oh-my-pi/pi-tui/host/input";

export interface Item {
  readonly id: string;
  readonly label: string;
}

export function ItemPicker(props: { items: Item[]; onSelect: (item: Item) => void }) {
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const focus = useFocus();

  onMount(() => focus.focus());

  const handleKey = (e: HostKeyEvent) => {
    if (e.defaultPrevented) return;
    if (e.key === "down" || e.key === "j") {
      setSelectedIndex((prev) => Math.max(0, Math.min(props.items.length - 1, prev + 1)));
    } else if (e.key === "up" || e.key === "k") {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (e.key === "enter") {
      const item = props.items[selectedIndex()];
      if (item) props.onSelect(item);
    } else {
      return;
    }
    e.preventDefault();
  };

  return (
    <box
      padding={1}
      tabIndex={focus.tabIndex}
      onKey={handleKey}
    >
      <frame title="Select Target">
        <stack gap={0}>
          <For each={props.items}>
            {(item, index) => {
              const isSelected = () => index() === selectedIndex();
              return (
                <row gap={1} background={isSelected() ? "selected" : undefined}>
                  <text color={isSelected() ? "accent" : "muted"}>
                    {isSelected() ? "❯" : " "}
                  </text>
                  <text bold={isSelected()} color={isSelected() ? "accent" : "text"}>
                    {item.label}
                  </text>
                </row>
              );
            }}
          </For>
        </stack>
      </frame>
    </box>
  );
}
```

### Example 2: Reactive Tool View with Streaming Document

```tsx
import type { ToolViewProps, ToolViewDefinition } from "@oh-my-pi/pi-tui/tools/view";
import { ToolCard } from "@oh-my-pi/pi-tui/view/tool-card";
import { ToolHeader } from "@oh-my-pi/pi-tui/view/tool-header";
import { registerToolView } from "@oh-my-pi/pi-tui/tools/registry";
import { Show } from "@oh-my-pi/pi-tui/reactive";

interface QueryArgs {
  readonly query: string;
}

interface QueryDetails {
  readonly executionMs?: number;
}

export const QueryToolView: ToolViewDefinition<QueryArgs, QueryDetails> = {
  view: (props: ToolViewProps<QueryArgs, QueryDetails>) => {
    return (
      <ToolCard phase={props.phase} outcome={props.outcome}>
        <ToolHeader
          toolName={props.toolName}
          label={props.label}
          phase={props.phase}
          outcome={props.outcome}
        />
        <box paddingX={1}>
          <stack gap={1}>
            <row gap={1}>
              <text color="muted">Query:</text>
              <text color="accent">{props.args.query ?? "..."}</text>
            </row>
            <Show when={props.output.lineCount() > 0}>
              <code doc={props.output} language="sql" />
            </Show>
          </stack>
        </box>
      </ToolCard>
    );
  },
  summary: (props) => ({
    label: props.label,
    detail: props.args.query,
    status: props.phase === "running" ? "running" : props.outcome === "success" ? "done" : "error",
  }),
};

registerToolView("database_query", QueryToolView);
```

---

## 12. Migration Reference

The table below summarizes the migration from the legacy imperative paint contract to the modern reactive Solid model:

| Legacy Subsystem / API | Modern Reactive Replacement | Why / Notes |
|---|---|---|
| `interface Component { paint(out, width); }` | Declarative Solid JSX function `(props) => JSX.Element` | Retained host tree manages paint passes and node damage automatically. |
| `class Mount` | Host root `render()` or JSX composition | Mount facade is obsolete; components render directly into the host tree. |
| `this.invalidate()` / `requestRender()` | Signal or store mutation (`setSignal(...)`) | Fine-grained reactive dependencies trigger dirty subtree repaints automatically. |
| `useState`, `useMemo`, `useEffect` (custom) | `createSignal`, `createMemo`, `createEffect`, `onCleanup` | Standard SolidJS reactive engine replaces custom hook reconciler. |
| `theme.fg("accent", text)` / `theme.bg(...)` | Semantic props `<text color="accent">`, `<box background="surface">` | Colors are resolved as tokens during paint; no intermediate ANSI string creation. |
| `truncateToWidth()` / `visibleWidth()` in views | Row flex layout `<row>` and `<text overflow="ellipsis">` | Width allocation is handled by layout intrinsics rather than manual string slicing. |
| `renderCall(args, opts, theme)` / `renderResult(...)` | `toolView: ToolViewDefinition<TArgs, TDetails>` | Replaces multi-pass component facades with a single reactive view over `ToolViewProps`. |
| `registerMessageRenderer(...)` returning `Component` | `registerMessageView(...)` returning `JSX.Element` | Message views render directly as reactive JSX components. |
| `TUI.setFocus(component)` | `const { focus } = useFocus(); focus();` | Native focus runtime integrated with host element hit-testing. |
| `sharedSpinnerTimer` / `#todoStrikeInterval` | `useClock("spinner")` / `useClock("frame")` | Shared root clocks drive animation without independent timer allocations. |
