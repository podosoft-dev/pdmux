# `@pdmux/ui` component contract

The screen pieces of the pdmux dashboard ship as **a package another project can install**
(`@pdmux/ui`). The judgement logic lives in a framework-agnostic package (`@pdmux/core`) and the
components here draw its results.

## 0. Installing and the basic wiring

```bash
npm i @pdmux/ui @pdmux/core svelte
```

```svelte
<script lang="ts">
  import '@pdmux/ui/styles.css';                 // ⚠ structural CSS — import it exactly once
  import { HostSidebar, TerminalGrid, EchoTerminalAdapter } from '@pdmux/ui';
  import { buildDefaultSlots, defaultLayout, toggleZoom } from '@pdmux/core';

  const hosts = [{ id: 'h1', name: 'alpha', online: true, sessions: [{ name: 'main' }] }];
  let layout = $state({ ...defaultLayout(), slots: buildDefaultSlots(hosts, { pad: 2 }) });
  const adapter = new EchoTerminalAdapter();      // demo/test only; inject a WS adapter in reality
</script>

<div class="pdmux pdmux-shell" data-sidebar="open" style="--pdmux-left:300px">
  <HostSidebar cards={[{ host: { id: 'h1', name: 'alpha', state: 'online' } }]} />
  <div class="pdmux pdmux-panel">
    <TerminalGrid {layout} {hosts} {adapter} onZoom={(id) => (layout = toggleZoom(layout, id))} />
  </div>
</div>
```

### Four rules (enforced by tests — TC-PDUI-030/031)

1. **Data as props, behaviour as callbacks** (`onSelect`/`onAssign`/`onClose`/…). Components use no
   `fetch`, no WebSocket, no global store and no `localStorage`.
2. **The strings belong to the consumer.** Every component accepts
   `t?: (key, fallback) => string` and uses the English fallback when it is absent. Keys live in the
   `pdmux.*` namespace.
3. **`svelte` is a peer dependency.** Only the app's single Svelte 5 runtime is used.
4. **Styling**: structure and colour come from `@pdmux/ui/styles.css`, and colours read Tailwind v4
   semantic tokens (`--color-background`, `--color-foreground`, `--color-border`, `--color-card`,
   `--color-muted-foreground`, `--color-primary`) **with fallbacks** → they follow the app's theme
   when there is one and still resolve when there is not. To also generate Tailwind utilities, add
   `@source "../node_modules/@pdmux/ui/dist";` to the app's CSS.

> **⚠ Why structural CSS ships with the package**: a mount host once had no rules at all, and the
> flex chain broke there. Every box below then grew to its content height, the list never became a
> scroll container, and the detail panel was drawn off-screen (about 7,300 px down) — reported as
> "clicking does nothing", and DOM queries missed it all three times. So the viewport-binding rules
> are not left to the page; the package carries them (TC-PDUI-040–044 verify this in a real browser).

---

## 1. Shell classes (the part that is just markup)

| Class | Role |
|---|---|
| `.pdmux .pdmux-shell` | a 100dvh five-track grid (cards │ handle │ terminals │ handle │ dock). Controlled by `data-sidebar="open\|hidden"`, `data-dock="open"`, `--pdmux-left`/`--pdmux-right`. ⚠ The dock track **yields to the viewport** via `clamp()` — even if a stored `--pdmux-right` was chosen on a wide monitor, a narrow window protects the terminal area's 300 px floor first and shrinks the dock (the stored value is untouched, only the display; TC-PDUI-170) |
| `.pdmux-panel` | the terminal column wrapper (all remaining height) |
| `.pdmux-dock-column` | the LAST track: a flex column holding the commit graph and the file explorer, either or both. It wears `data-pdmux-region="dock"` (the shell places the track by that name, and a phone's `Git` tab shows it), plus `data-pdmux-split="both\|single"` |
| `.pdmux-dock-slot` | one panel inside that column. Its `flex-basis` is the stored share; both it and its child need `min-height: 0` so an inner scroll box can shrink |
| `.pdmux-graph` | the commit panel (graph + detail) |
| `.pdmux-files` | the file explorer panel (listing + preview) |
| `.pdmux-graph-body` | the row placing **refs panel │ graph** side by side, each scrolling itself |

### The style boundary — what is shadcn/Tailwind and what is this stylesheet

The two layers are not mixed. This boundary was settled during the shell geometry work.

| Layer | Approach | Why |
|---|---|---|
| pages, dialogs, buttons and forms in `apps/web` | **shadcn-svelte + Tailwind** | the widget vocabulary copied into the app. A control's shape, states and spacing all live here |
| the shell grid, terminal and git graph **geometry** in `@pdmux/ui` | **the package's own `styles.css`** | ① shadcn has no component for app shell geometry (it is a widget vocabulary) ② Tailwind utilities only work if the consumer's build scans the package's markup — this package has to work standalone without the consumer's Tailwind pipeline (the geometry specs run against the package alone), and adding it couples every consumer ③ the combination of state attributes × CSS variables × `clamp()` moved into Tailwind is the same CSS as a one-line arbitrary-value string |

Theming connects through tokens (`--pdmux-*`) only. Code in the app that breaks the shadcn vocabulary
is fixed with shadcn.

---

## 2. Components

Notation below: `prop: type (default)`; **callbacks** are `on*` props. Slots are Svelte 5 snippets.

### `HostSidebar`

The scrolling column of host cards.

| prop | type | description |
|---|---|---|
| `cards` | `Array<{ host, agents?, resources?, history?, services?, prefs? }>` | per-card data bundles |
| `now`, `windowSec` | `number` | the sparkline's reference time (epoch **seconds**) and window |
| `windowLabels` | `Record<string,string>` | gauge window labels (`{ session: '5h' }`) |
| `t` | `Translate` | i18n |
| `header`, `footer` | `Snippet` | inserted at top/bottom. `footer` is **pinned to the bottom** of the column (`.pdmux-sidebar-foot`: `margin-top:auto` + `sticky`), so cards scroll under it when the fleet overflows. App-specific things like an account block go here — the package supplies the slot and the geometry only |
| `onOpenService` | `(url, hostId) => void` | open a service |
| `onOpenSettings` | `(hostId, anchor: HTMLElement) => void` | the ⚙ click (passes the popover anchor) |

```svelte
<HostSidebar {cards} now={Date.now() / 1000} onOpenService={(url) => window.open(url, '_blank', 'noopener')} />
```

### `HostCard`

| prop | type | description |
|---|---|---|
| `host` | `{ id, name, state?: 'online'\|'offline'\|'unknown' }` | a badge appears only for `offline`/`unknown` |
| `agents` | `AgentRow[]` (core `agentRows()`) | the agent widget |
| `resources` | `{ cpuPct, memPct, diskPct, swapPct, memHint?, diskHint?, swapHint? }` | the four resource rows (swap sits under memory) |
| `history` | `HostSeries` (core `historySeries()`) | trends |
| `services` | `ServiceOption[]` (core `serviceOptions()`) | shortcuts |
| `prefs` | `CardPrefs` (core `cardPrefs()`) | which widgets are shown |
| **callbacks** | `onOpenService`, `onOpenSettings` | |

### `UsageGaugeRow` / `ResourceRow` / `MetricSparkline`

| Component | Key props | Rules |
|---|---|---|
| `UsageGaugeRow` | `row: AgentRow`, `windowLabels` | an unreported window is **not drawn**. ≤20% uses the danger colour; a snapshot older than two hours is dimmed |
| `ResourceRow` | `label`, `pct`, `samples`, `hint` | unmeasured is `—` (not red); ≥80% is red |
| `MetricSparkline` | `samples`, `now`, `windowSec` | x = timestamp (right = now), `null` breaks the line, and with no data **nothing is drawn at all** |

### `ServiceLauncher`

| prop | type | description |
|---|---|---|
| `options` | `ServiceOption[]` | the first `up` service is preselected |
| `disabled` | `boolean` | everything is disabled when the host is offline |
| `onOpen` | `(url) => void` | also fires on `Enter` |

### `CardSettingsPopover`

| prop | type | description |
|---|---|---|
| `hostName`, `prefs`, `details` | — | `details` = `{ key, label, value }[]` (address, SSH, …) |
| `anchor` | `{ x, y }` | the trigger's bottom-left viewport coordinates. The box is clamped on screen |
| `actions` | `Snippet?` | an app-owned slot rendered **below** the toggles (`data-pdmux-popover-acts`). The package supplies the separator above it and the padding around it. With nothing passed, nothing is drawn |
| `onToggle` / `onClose` | `(widget) => void` / `() => void` | |

> `actions` is **not** a callback like `onDelete`. What goes in there today is "delete this host", and
> an irreversible operation needs a confirmation dialog, a typing gate, an API call and wording saying
> the tokens disappear with it — none of which is the business of a package that only knows how to
> draw. The package supplies **the place**, the app supplies **the judgement** (`(shell)/+layout.svelte`
> in `apps/web`).
> ⚠ A button inside the slot still gets **its appearance from the app, but not its position** — the
> separator, the padding and the 44 px floor under `(pointer: coarse)` come from the package.
> Previously the consuming app reproduced that rhythm itself with `border-t mt-1 pt-2`, which meant a
> consumer recreating the spacing of a panel it could not even see.

> **The design vocabulary is shadcn's, the dependency is not.** This panel uses shadcn's popover and
> menu vocabulary verbatim (`--popover`/`--accent`/`--input`/`--ring` tokens, the `--radius` scale,
> 32 px menu rows, full-width separators, an `h-[1.15rem] w-8` switch) but **does not import**
> shadcn-svelte — that is not a library you install but code copied into an app's source, and bits-ui
> sits underneath it. A package whose only peer is `svelte` would break its own contract by pulling
> that in. So the switch is **a native checkbox** painted that way (`role="switch"`, with checked
> state, keyboard handling and label association left to the browser). Tokens fall back in three
> steps, `--color-popover` → `--popover` → a literal: Tailwind v4 emits only the `@theme inline`
> variables that are **actually used**, so reading just one side silently drops to a hardcoded grey
> even in a themed app (which is exactly what happened to `--color-accent` in this dashboard).

> **The ⚙ trigger has to be control-sized** — 36 px for a fine pointer (the registry's
> `size="icon-lg"`), 44 px for coarse. The size is absorbed into the card's padding with negative
> margins so the header stays 24 px (cards do not each grow by 13 px). The icon is an **inline SVG**:
> `⚙` is an emoji-presentation codepoint, so the platform picked the font — and therefore the weight
> and size. Contract = TC-PDUI-167.

> Opening and closing the popover (the document click handler) is the consumer's job. The component
> stops propagation of clicks inside it — if a re-render detaches the clicked node from the DOM, that
> is misread as an "outside click" and the panel closes mid-operation.

### `SplitHandle`

| prop | type | description |
|---|---|---|
| `axis` | `'x' \| 'y'` | a column boundary (default) or a row boundary — `y` measures `clientY` and sets `aria-orientation="horizontal"` |
| `invert` | `boolean` | `true` when the pane grows **against** the axis direction — the right-hand dock (dragging left widens it), a bottom panel (dragging up heightens it) |
| `onDrag` / `onCommit` | `(delta: number) => void` | during the drag / on release |

```svelte
<SplitHandle onCommit={(d) => (layout = setSidebarWidth(layout, layout.sidebarWidth + d))} />

<!-- bottom panel: the handle is above the panel, so invert -->
<SplitHandle axis="y" invert onCommit={(d) => (layout = setDockDetailHeight(layout, base + d))} />
```

⚠ The delta is **relative to where the gesture started**. Adding it to the current value accumulates
on every pointer move and the width runs away, so the caller captures the value at gesture start as a
baseline and adds to that (`dragSidebar`, `dragDock` and `dragDetail` all share this shape).
⚠ Internally it uses `setPointerCapture`. Built with document listeners, the drag **freezes** the
moment the pointer enters the terminal (measured).

### `TerminalGrid`

| prop | type | description |
|---|---|---|
| `layout` | `TerminalLayout` | the core reducer's result, unchanged |
| `hosts` | `GridHost[]` | labels and reachability |
| `adapter` | `TerminalAdapter` | **required**. See §3 |
| `createSurface` | `TerminalSurfaceFactory` | defaults to xterm. Injected in tests |
| `idleTtlMs` (600000), `maxPanes` (12), `sweepMs` (30000) | `number` | the hidden-pane reclamation policy. `sweepMs=0` means no timer |
| **callbacks** | `onAssign(index, anchor)` · `onClose(index)` · `onRemove(index)` · `onZoom(slotId)` · `onFocus(slotId)` · `onDetach(slot)` · `onSwap(from, to)` · `onExit(slotId, code)` | |

Behaviour: an off-page pane stays **mounted and `hidden`** (moving it reconnects the terminal), a pane
whose cell disappeared is released immediately, and hidden panes are reclaimed by TTL and count cap.

### `TerminalPane` / `EmptyCell`

The grid renders these for you. Only needed when using them directly:

| Component | Key props | Callbacks |
|---|---|---|
| `TerminalPane` | `slot`, `index`, `hostName`, `adapter`, `visible`, `onScreen`, `order`, `zoomed`, `focused`, `keyBar`, `solo`, `clickAction` | `onAssign` `onZoom` `onFocus` `onClose` `onDetach` `onDragStart/Move/End` `onExit` |
| `EmptyCell` | `index`, `kind: 'hole'\|'padding'`, `order`, `dropTarget` | `onAssign`, `onRemove` (disabled for padding) |

**`onClose` means "I would like to close", not "close"** — the component raises no confirmation of its
own. The ✕ sits one cell away from zoom and detach so misclicks are common, but putting a confirmation
dialog inside the component would drag in the consuming app's dialog system, wording and i18n, which
crosses the boundary. So the pdmux web app receives `onClose`, shows `confirm-dialog` (the two-button
form with no name-entry gate) and applies `clearSlot` after confirmation. The wording describes **what
does not happen** — the session stays on the host and reattaches when reopened (which is why no heavy
gate like retyping a name is used). Contract = TC-PDTERM-123.

### `ShellViewTabs` (phone-only navigation)

| prop | type | description |
|---|---|---|
| `tabs` | `ShellViewTab[]` | `{ id, label, icon?, hint? }` — labels arrive already translated |
| `active` | `string \| null` | the current region. `null` highlights no tab |
| `onSelect` | `(id: string) => void` | tab selection. **Pushing a history entry is the caller's responsibility** (Android Back) |

On desktop the stylesheet hides it with `display:none` — the component need not know about media
queries. Targets are 48 px plus `env(safe-area-inset-bottom)` (currently 0, which is correct — there is
no `viewport-fit=cover`).

### `TerminalComposer` (the phone's composition input line)

| prop | type | description |
|---|---|---|
| `onSubmit` | `(text: string, submit: boolean) => void` | a finished line. With `submit=true` the caller appends `\r` (`↦` passes false) |
| `t` | `Translate` | placeholder and labels |

A mobile IME cannot be trusted inside the terminal's hidden textarea — on a real device Korean arrived
as `ㅎ ㅏ ㄴ`. Composition is received where the platform designed it to be (a normal `input`) and only
the finished line is sent. ⚠ **The Enter that ends a composition belongs to the IME**, so
`isComposing`/`compositionend` are consulted and that Enter is not used as a submit (otherwise half a
word disappears). The font must be 16 px (below that, iOS zooms the entire shell). Support and limits:
[`IME_INPUT.md`](IME_INPUT.md).

⚠ **When it renders — nothing to do with focus.** `TerminalPane` draws the composer and the helper key
row when `keyBar && visible && onScreen && (active || solo)`: `keyBar` is the device gate (the app
passes `(pointer: coarse)` → desktop never gets it however visible), `visible && onScreen` means this
pane's box is on screen (a pane left mounted off-page does not create a second input field), and `solo`
means the grid is showing **one** cell (phone, `tab`, zoom). **Requiring `active` (focus) would be
wrong** — a phone focuses nothing until you tap, so the only path for entering composed characters
would hide behind a tap (reported from an iPhone; Chrome device emulation did not reproduce it because
the pane came up focused). Both rows send to **their own pane's `connection`**, so keyboard focus was
never needed anyway. In a split, several panes are visible at once and `active` is the right answer
there, so it remains as the other axis. Contract = TC-PDTERM-131.

### `TerminalKeyBar` (soft-keyboard helpers)

| prop | type | description |
|---|---|---|
| `keys` | `HelperKeyId[]` | defaults to `HELPER_KEYS` (esc, tab, ctrl, ←↓↑→, ⏎) |
| `ctrl` | `boolean` | the Ctrl latch indicator — the state belongs to the caller |
| `onKey` | `(id: HelperKeyId) => void` | the key pressed. Byte conversion is `pressHelperKey` in `@pdmux/core` |

⚠ **Every press is `pointerdown` + `preventDefault`, never `click`.** A button that takes focus steals
it from the terminal's hidden textarea, and at that moment a mobile browser closes the soft keyboard —
the row would be removing its own reason to exist. `TerminalPane` renders it via the `keyBar` prop, so
no wiring to `TerminalConnection.send` or `surface.focus()` is needed.

### Reaching earlier output — the gesture, the buttons and the sheet

**Everything that scrolls a pane is one path: it dispatches a WHEEL EVENT and lets xterm route it.**
A finger drag on the surface, the ⇞/⇟ buttons in the key row and `surface.scrollPages()` all end up in
the same call, because which of three answers is right is only knowable at that instant and only xterm
knows it (`@xterm/xterm` 5.5.0, `Terminal.ts`):

1. the program asked for wheel mouse reports → one report is encoded for it;
2. else the buffer keeps no scrollback → `ESC[A`/`ESC[B` for the program (this is a multiplexer pane);
3. else → xterm scrolls its own viewport (a `shell` pane's 5000 lines).

⚠ **A gesture must not carry a copy of that routing.** The drag used to hand-roll case 2 and stand down
whenever the program held the mouse — which is the case a coding agent's TUI creates, so a phone had no
gesture at all on the panes this product exists to watch while a desktop wheel worked. Notches, not one
large delta: a mouse report carries no magnitude, so the COUNT of events is the message (three lines per
notch, at most three notches per touch move).

Two things hold it together: `.pdmux-pane-surface` declares `touch-action: pan-x pinch-zoom` (the
engine must not claim the vertical axis and make `touchmove` uncancellable; pinch-zoom and the
browser's own back gesture stay), and `scrollback: 5000` must stay larger than a pane's rows — on the
normal buffer that is what keeps case 3 reachable instead of case 2 typing `ESC[A` at a shell prompt.

**The output sheet** (`TerminalHistory`, opened from the pane's ☰) shows the same output as selectable
text, and its job is to be honest about what it is holding:

| prop | meaning |
|---|---|
| `lines` | attributed lines, oldest first |
| `scrollback` | `false` = this is one screen, not a history (xterm's alternate buffer) |
| `screenOnly` | the MULTIPLEXER has nothing either: a full-screen program owns the pane |
| `pending` / `failed` | a fetch is in flight / could not be made |

`onReadHistory` (`TerminalGrid`, `TerminalPane`) is the consumer offering to ask the host; returning
`null` means **the ask failed**, and an empty result means the pane really is that short. Both used to
be the same silence, and a sheet showing one screen with a note about the multiplexer's history sent
people to another machine to look for output nobody had kept.

⚠ **A full-screen program's earlier output is not in the multiplexer.** It draws on the pane's
*alternate* screen and tmux keeps history for the normal one, so no capture can produce it — measured
across one fleet: 48 lines of history behind such a pane against 1991 behind a pane whose program prints
normally. The only thing that can show it is the program itself, which is why the gesture above matters
more than the sheet does.

### `TerminalTargetPicker`

| prop | type | description |
|---|---|---|
| `hosts` | `PickerHost[]` | chips for offline hosts are disabled |
| `index` | `number \| null` | the cell that opened it (the first empty cell if absent) |
| `hostId`, `taken`, `anchor`, `width` | — | `taken` = new session names already in use |
| `onApply` | `(target: PickerTarget, index) => void` | `{ hostId, kind: 'attach'\|'new'\|'shell', session }` |
| `onCancel` | `() => void` | |

> `PickerHost.multiplexer` is **optional and defaults to `true`**. `false` means "that host reported
> for itself that it has no multiplexer", and only then are the session list, `new session` and the
> name field locked while `shell` stays open (contract = TC-PDUI-018). A consumer that passes nothing
> behaves exactly as before — reading "unknown" as "absent" would make every older host that does not
> send this field lose its sessions.

### `GitGraph` / `GitRefPanel` / `CommitDetail` / `DiffView`

| Component | Key props | Callbacks |
|---|---|---|
| `GitGraph` | `commits`, `refs`, `uncommitted` (core `uncommittedSummary()`), `uncommittedLabel`, `head`, `selectedSha`, `formatDate` | `onSelect(sha)` — the uncommitted row is `sha === 'uncommitted'` |

> The `selectedSha` row gets `aria-current="true"` and is drawn with **a colour different from hover,
> a leading accent bar and a bold subject** (contract = TC-PDUI-149). At first selection and hover
> shared a colour and it became "I cannot tell which commit I am looking at" — the row whose detail is
> open is the source of that detail, so it has to be identifiable in the list.

| `GitRefPanel` | `head: RepoHead`, `refs: RefInput[]` | — (a read-only panel) |
| `CommitDetail` | `commit`, `detail`, `pending` (core `pendingNote()`), `loading`, `formatDate`, `height` | — |
| `DiffView` | `files`, `note` | — |

These are read-only — actions like checkout, merge and fetch are **absent, not disabled**.

**`CommitDetail.height`** — `null` (the default) means content height (giving a one-line commit message
a fixed frame leaves empty space below it). Dragging the row handle sets it to that pixel value and
adds `data-pdmux-sized="true"` — a marker so the stylesheet grants a larger share of the column (75%)
only to **a panel somebody deliberately grew**. The cap is not taste but an **invariant**: the graph
must not be crushed into uselessness and the page must not start scrolling
([`ARCHITECTURE.md`](ARCHITECTURE.md) §7). Persistence is the consumer's — the dashboard dock uses the
stored layout (`dockDetailHeight`), a detached window uses local state (so that window's proportions do
not follow into the dock).

**`GitRefPanel`** — if the graph answers "what happened", this panel answers "**where am I and what is
unpushed**", which is why a person opens the graph at all. Row chips cannot answer it — a diverged
branch may be nowhere near a visible row.

- `head: RepoHead` = `{ branch?, sha?, detached?, upstream?, ahead?, behind?, gone?, path? }`.
  **The panel does not guess what HEAD tracks** — the caller joins it and passes it in (in the app,
  `repoHead()` in `map.ts`).
- `refs: RefInput[]` are grouped into **local / remote / tags** by core's `groupRefs()`, with counts in
  the headings. Local puts **diverged branches first** (what needs attention rises).
- A row is name + `↑n ↓n` + a short sha. Colours match the row chips (local green, remote blue, tags
  amber).
- **`gone` is said loudly as a badge** — the branch is here but its upstream has disappeared, and no
  number expresses that. The HEAD box marks it too with `data-gone="true"`.
- Remote rows carry an "as of the last fetch" note — the collector **does not fetch** (that would be
  writing to somebody else's checkout).
- It is **its own scroll container** (`min-height:0; overflow:auto`). Hundreds of tags do not lengthen
  the page.
- Its width is `clamp(150px, 34%, 260px)` and it is **hidden below 640 px** (in a narrow column the
  graph comes first).

---

## 3. The terminal adapter (transport belongs to the app)

```ts
interface TerminalAdapter {
  open(target: { slotId; hostId; kind: 'session' | 'shell'; session?; cols; rows }):
    TerminalConnection | Promise<TerminalConnection>;
}
interface TerminalConnection {
  send(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): () => void;   // the return value unsubscribes
  onExit(cb: (code: number | null) => void): () => void;
  close(): void;
}
```

```ts
// the built-in adapter for demos and tests (panes work with no server)
import { EchoTerminalAdapter } from '@pdmux/ui';
const adapter = new EchoTerminalAdapter();
```

The app implements the WebSocket adapter. There is only one rule to respect — **buffer output that
arrives before `onData` is subscribed** (the built-in echo adapter does). Otherwise the connection
banner disappears.

---

## 4. Verification

```bash
npm test -w @pdmux/core     # pure logic
npm test -w @pdmux/ui       # components (jsdom)
npm run test:geometry -w @pdmux/ui                      # browser geometry (opt-in)
PDMUX_BROWSER_CHANNEL=chrome npm run test:geometry -w @pdmux/ui   # use an installed Chrome (no download)
```
