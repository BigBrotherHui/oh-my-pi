# @oh-my-pi/pi-tui

Fine-grained reactive terminal UI framework for Node.js and Bun, powered by **SolidJS** (`solid-js@1.9.15`), a retained universal host tree renderer, and differential synchronized terminal output.

## Features

- **Fine-Grained Reactivity**: State updates mutate only affected host nodes and text runs directly; component functions run once and never re-render.
- **Universal Retained Host Tree**: Solid universal renderer maintains a lightweight tree of `HostNode` objects with damage classification (`Paint`, `Text`, `Layout`, `Link`, `Interaction`).
- **Cached Run Painting**: Clean subtrees replay cached cell-native `RichText` runs; the compositor repaints only damaged nodes.
- **Row-Based Flex Layout**: `<row>` and `<stack>` containers allocate column widths across children with `grow`, `shrink`, `minWidth`, and `maxWidth`.
- **Semantic Theme Tokens**: No raw ANSI escape strings in views. Styles resolve through a cascading token hierarchy (`ThemeColor`, `ThemeBg`, recipes).
- **Streaming Document System**: `TextDocument` and `OutputDocument` stream code, diffs, and markdown with range-invalidated syntax token caches.
- **Synchronized Terminal Output**: Atomic screen updates via `CSI 2026` eliminate terminal tearing and flicker.
- **Headless Testing Substrate**: In-memory test root (`mountForTest`) with fine-grained performance counters and deterministic clocks.

---

## Quick Start

```tsx
import { render } from "@oh-my-pi/pi-tui/root";
import { createSignal, onMount, onCleanup } from "@oh-my-pi/pi-tui/reactive";
import { ProcessTerminal } from "@oh-my-pi/pi-tui/terminal";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";

function CounterApp() {
  const [count, setCount] = createSignal(0);

  const timer = setInterval(() => {
    setCount((c) => c + 1);
  }, 1000);

  onCleanup(() => clearInterval(timer));

  return (
    <box padding={1} background="surface">
      <frame title="Live Counter">
        <stack gap={1}>
          <row gap={1}>
            <text color="muted">Elapsed Seconds:</text>
            <text color="accent" bold>{count()}</text>
          </row>
          <status value="running" />
        </stack>
      </frame>
    </box>
  );
}

// Start reactive application
const handle = render(() => <CounterApp />, {
  terminal: new ProcessTerminal(),
  theme: loadThemeSync("dark"),
});

// Clean up and restore terminal on exit
process.on("SIGINT", () => {
  handle.dispose();
  process.exit(0);
});
```

---

## Core Authoring Model

### 1. Render Root (`@oh-my-pi/pi-tui/root`)

Terminal applications mount via `render(view, options)`:

```ts
import { render, type RootOptions, type RootHandle } from "@oh-my-pi/pi-tui/root";

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

`render()` initializes the Solid root, mounts the retained host tree, wires keyboard/mouse listeners, and connects the compositor to `TUI`. Calling `handle.dispose()` unmounts the host tree, runs all reactive cleanup handlers, and restores the terminal.

### 2. Reactive Surface (`@oh-my-pi/pi-tui/reactive`)

Feature code imports reactive primitives exclusively from `@oh-my-pi/pi-tui/reactive` (never directly from `solid-js`):

- **Solid Primitives**: `createSignal`, `createMemo`, `createEffect`, `createRoot`, `createStore`, `produce`, `reconcile`, `onMount`, `onCleanup`, `batch`, `untrack`.
- **Control Flow**: `<Show>`, `<For>`, `<Index>`, `<Switch>`, `<Match>`, `<ErrorBoundary>`, `<Suspense>`.
- **TUI Hooks**:
  - `useClock(cadence)`: Subscribes to the root clock (`"frame"`, `"spinner"`, or `"second"`). Automatically unregisters when the component unmounts or freezes.
  - `useTheme()`: Accesses reactive semantic color tokens (`theme.token("accent")`) and symbols (`theme.symbol("check")`).
  - `useKeymap()`: Resolves keybinding display hints (`keymap.hint("expand")`).
  - `useFocus()`: Bind its `tabIndex` to a host element before calling `focus()`. Native `<input>` and `<editor>` controls are focusable by default; new roots and overlays initially focus the first innermost control.
  - `createLayoutEffect(fn)`: Executes synchronously after subtree measurement/layout.
  - `createCommitEffect(fn)`: Executes after terminal frame output has been emitted.

### 3. Element Vocabulary

The JSX namespace declares intrinsics compiled by the Solid universal transform:

| Category | Elements | Description |
|---|---|---|
| **Layout & Containers** | `<stack>`, `<row>`, `<box>`, `<sized>`, `<rail>`, `<scroll>`, `<split>`, `<frame>`, `<hr>` | Row allocation with `grow`/`shrink`, padding, borders, dividers, scrollable viewports. |
| **Text & Inline** | `<text>`, `<span>`, `<br>`, `<cursor>`, `<raw>`, `<path>`, `<link>` | Word-wrapping text, middle-ellipsis file paths (`<path>`), OSC 8 hyperlinks, cursor anchors. |
| **Presentation & Tokens** | `<icon>`, `<status>`, `<badge>`, `<meta>`, `<preview>`, `<code>`, `<pre>`, `<diff>`, `<markdown>`, `<json>`, `<table>`, `<progress>`, `<spinner>`, `<shimmer>`, `<duration>`, `<timestamp>`, `<choice>`, `<select>`, `<tabs>`, `<tree>` | Semantic status indicators, syntax highlighting, diffs, tables, animated spinners. |
| **Interactive & Resources** | `<input>`, `<editor>`, `<terminal>`, `<image>`, `<qr>` | Text input, multi-line editor, headless PTY terminal, Kitty/iTerm2 images, QR codes. |
| **Transcript Structure** | `<transcript>`, `<transcript-block>` | Transcript container with append-only streaming and retirement boundaries. |

Transcript entries become `settled` when their displayed operation returns, independently of background execution tracking. Completed read groups remain appendable until retired; adding a pending read reactivates the group. Following prose closes the run, and reads arriving after retirement start a new group.

Tool entries may supply a lazy, one-row `compactView`, used only while that tool is active and its own output exceeds the transcript viewport. Completed tools and fitting active tools are never compacted to make room for prose. Scrollback always uses the full `view`; explicit replay refreshes retired document caches for later background results.

Streaming assistant entries use `createStreamingAssistantMessageView`: construct its state outside rendering, then pass its lazy `view`, `stableView`, and `onResetStableRows` to an `appendOnly` transcript entry. Forward `onStableRows` publications through `store.replace`. Both view factories mount beneath the TUI owner; parser-frozen Markdown prefixes retire during streaming, and finalization retires the remaining text or images without duplicating earlier rows.

### 4. Shared UI Compositions

High-level function components are provided in `@oh-my-pi/pi-tui/view/*`:

- `ToolCard`: Framed tool presentation with phase-driven tinting and collapse headers.
- `ToolHeader`: Standard tool title row with status icon, duration, and labels.
- `Card`, `Section`: Grouping and surface containers.
- `KeyValue`: Label-value grid with automatic column alignment.
- `List`, `TreeList`, `FileList`: Uniform item list presentations.
- `DiagnosticTree`: File-grouped diagnostics with severity ordering, preserved multiline indentation, and a shared collapsed-item budget.
- `JsonTree`: Interactive expandable JSON explorer.
- `Kbd`, `Hints`: Keyboard shortcut badges and hint bars.
- `StatusIcon`: Resolves execution states to theme icons and colors.
- `DiffStats`: Displays line modification counts (`+12 -3`).
- `TruncationNotice`: Summary indicator for truncated outputs.

### 5. Styling Tokens and Cascade

Styling is based on semantic tokens:
- **Foreground tokens (`ThemeColor`)**: `"text"`, `"muted"`, `"dim"`, `"accent"`, `"success"`, `"error"`, `"warning"`, `"info"`, etc.
- **Background tokens (`ThemeBg`)**: `"surface"`, `"surface.tool"`, `"surface.muted"`, `"selected"`, `"toolPendingBg"`, etc.

**Cascade Precedence (lowest to highest):**
1. Element Defaults
2. Inherited Text Properties (`color`, `bold`, `dim`, `italic`, `underline`, `strike`, `link`)
3. Element Variant / State
4. Named Recipe (`recipe="..."`)
5. Local Style (`style={Style}`)
6. Explicit Props (`color="accent"`, `bold={true}`)

Use `<ThemeScope theme={customTheme}>` to re-theme a nested subtree.

### 6. Streaming Documents

Large texts (diffs, markdown, code, command output) use `TextDocument` or `OutputDocument`:

```ts
import { createDocument, createOutputDocument } from "@oh-my-pi/pi-tui/document/document";

const doc = createOutputDocument("Initial content\n");
doc.apply({ kind: "append", text: "New streaming line\n" });
```

Document-aware elements (`<code>`, `<diff>`, `<markdown>`, `<preview>`) bind to documents via `doc={doc}` and invalidate syntax-highlighting caches incrementally.

### 7. Tool Presentation (`ToolViewDefinition`)

Tool views implement `ToolViewDefinition<TArgs, TDetails>` from `@oh-my-pi/pi-tui/tools/view`:

```tsx
import type { ToolViewDefinition, ToolViewProps } from "@oh-my-pi/pi-tui/tools/view";
import { ToolCard } from "@oh-my-pi/pi-tui/view/tool-card";
import { ToolHeader } from "@oh-my-pi/pi-tui/view/tool-header";
import { registerToolView } from "@oh-my-pi/pi-tui/tools/registry";

export const MyToolView: ToolViewDefinition<{ query: string }, { count: number }> = {
  view: (props: ToolViewProps<{ query: string }, { count: number }>) => (
    <ToolCard phase={props.phase} outcome={props.outcome}>
      <ToolHeader toolName={props.toolName} label={props.label} phase={props.phase} outcome={props.outcome} />
      <box paddingX={1}>
        <text color="accent">Query: {props.args.query}</text>
      </box>
    </ToolCard>
  ),
  summary: (props) => ({
    label: props.label,
    detail: props.args.query,
    status: props.phase === "running" ? "running" : props.outcome === "success" ? "done" : "error",
  }),
};

registerToolView("my_tool", MyToolView);
```

### 8. Testing Substrate (`@oh-my-pi/pi-tui/testing`)

Inspect and assert components in headless unit tests:

```ts
import { mountForTest, renderToRows, type TestRoot } from "@oh-my-pi/pi-tui/testing";

const root: TestRoot = mountForTest(() => <MyView value={signal()} />, { width: 80 });

// Assert visible row text:
expect(root.text()).toContain("Expected Row");

// Check fine-grained performance counters:
const initial = root.counters().nodesCreated;
setSignal("updated");
root.flush();
expect(root.counters().nodesCreated).toBe(initial); // Zero DOM re-creations!

root.dispose();
```

---

## Migration Reference

| Legacy API (Removed) | Modern Reactive Replacement | Motivation |
|---|---|---|
| `interface Component { paint(out, width); }` | Declarative Solid JSX function `(props) => JSX.Element` | Retained host tree eliminates manual paint loops and whole-tree repaints. |
| `class Mount` | `render()` or nested JSX components | Views connect directly to the universal host tree without facade wrappers. |
| `this.invalidate()` / `requestRender()` | Solid signal / store mutation (`setSignal(...)`) | Fine-grained dependency tracking updates only damaged subtrees. |
| `useState`, `useMemo`, `useEffect` (custom) | `createSignal`, `createMemo`, `createEffect`, `onCleanup` | Standard SolidJS reactive engine. |
| `theme.fg(...)` / `theme.bg(...)` string escapes | `<text color="accent">`, `<box background="surface">` | Semantic token cascade resolved at paint time; no ANSI strings in views. |
| `truncateToWidth()` / `visibleWidth()` in views | `<row>` flex allocation & `<text overflow="ellipsis">` | Layout engine handles cell width budgeting and Unicode widths automatically. |
| `renderCall` / `renderResult` returning `Component` | `toolView: ToolViewDefinition` | Unifies call and result presentation into one reactive lifecycle view. |
| `registerMessageRenderer` returning `Component` | `registerMessageView` returning `JSX.Element` | Custom messages are declarative reactive views. |
| `TUI.setFocus(component)` | `const { focus } = useFocus(); focus();` | Focus runtime integrated with host element tree. |
