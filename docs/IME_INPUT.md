# Composed input (Korean, Japanese, Chinese) — what works and what does not

This records how composed characters reach the terminal, and **what is not supported**.
It keeps the evidence (an event log from a real device), the alternatives that were
rejected, and why — so nobody re-derives the conclusion from the symptom.

Related: TC-PDTERM-127 and TC-PDTERM-128.

---

## 1. Support at a glance

| Situation | Composed characters | ASCII |
|---|---|---|
| Desktop, typing into the terminal | **Supported** — the browser announces composition and only finished characters are sent | Supported |
| Phone or tablet, the **composer** at the bottom | **Supported** — this is the intended path. A finished line is sent in one go | Supported |
| Phone or tablet, typing into the terminal | **Not supported** — the syllable comes apart into its letters (§3) | Supported |
| A full-screen TUI (vim, an agent's screen) needing **one composed character at a time** | **Not supported on a phone** — a line-based composer cannot feed composed text to a screen that reads every keystroke as it arrives | Supported (direct typing) |

So on a phone, **composed text is line-at-a-time**. Writing a command at a prompt or
sending a sentence to an agent works; putting Korean into a screen that consumes each
character immediately does not.

---

## 2. Why the composer is the intended path

The terminal receives keys through a **hidden textarea** (how xterm.js is built), and a
mobile IME cannot be trusted inside one. That is not a bug in this code — it is where
the platform and the terminal widget meet. So on a phone, composition happens in a
**normal input field**: candidate selection, letter joining, backspace mid-composition
and autocorrect all run as the OS intends, and **only the committed line** reaches the
PTY (`Send` includes the newline, `↦` omits it).

Contract: `TerminalComposer` in [`COMPONENTS.md`](COMPONENTS.md). Verified by
TC-PDTERM-128 — one line leaves as one frame, the field clears, and the text appears in
the shell's output unchanged.

---

## 3. The evidence — what a real device actually sends

Input events were recorded on an iPhone (iOS 26.5, `CriOS/151`) while typing
`한글 테스트`. The essential part:

```
keydown ㅎ → beforeinput insertText "ㅎ"                 value "ㅎ"
keydown ㅏ → deleteContentBackward → insertText "하"      value "하"
keydown ㄴ → deleteContentBackward → insertText "한"      value "한"
…
keydown ㅌ → deleteContentBackward → insertText "스트"    value "한글 에스트"   ← deletes 1, inserts 2
final value "한글 테스트"
```

**`compositionstart` / `compositionupdate` / `compositionend` never fired once, and every
event carried `isComposing: false`.** This platform expresses the preedit as *delete and
re-insert against the field's value*, and **gives no signal that a composition is in
progress at all**.

Two things follow:

1. A guard that filters events during composition has **nothing to listen for on this
   device**. (It is still kept, because it does work on engines that announce
   composition — desktop browsers, some Android keyboards. The reason it exists:
   xterm's `_inputEvent` does not consult `isComposing` and forwards mid-composition
   text verbatim. TC-PDTERM-127 locks that path.)
2. Conversely, **reading a field whose value has already been resolved matches this
   model exactly** — which is why the composer is the intended path.

The same diagnosis can be repeated at any time. The product deliberately ships no
diagnostic page, so paste this into an input on the page and watch the console (on a
remote device, render it to the screen from a scratch page instead):

```js
const el = document.querySelector("input, textarea");
for (const type of ["compositionstart", "compositionupdate", "compositionend", "beforeinput", "input", "keydown"])
  el.addEventListener(type, (e) =>
    console.log(type, { data: e.data, inputType: e.inputType, isComposing: e.isComposing, key: e.key, value: el.value }),
  );
```

---

## 4. Alternatives that were rejected, and why

| Alternative | Why not |
|---|---|
| **A value-diff bridge** — mirror the hidden textarea's value and translate each change into `n backspaces + an inserted string` | Possible in principle under this event model, but the backspaces do not behave as intended in **a shell without line editing** (`sh`, `dash`) or in **a full-screen TUI**, where they corrupt the display. It would also have to handle cases like "delete 1, insert 2" exactly, and its failure mode is silent. If it is ever needed, the premise is that it is enabled **only outside a TUI, or behind a user toggle** |
| **Implementing the Hangul automaton ourselves** — take letters and assemble syllables | Needs a separate implementation per language (Japanese kana→kanji conversion; Chinese pinyin candidates are not feasible at all), and on a platform with no composition signal there is no way to tell a letter the user meant from a preedit |
| **Waiting for an upstream xterm fix** | Adding `&& !e.isComposing` to `_inputEvent` only fixes browsers that announce composition. iOS sends no such signal, so it would not resolve this |
| **Swapping in a different terminal widget** | Receiving a mobile IME through a hidden textarea is common to web terminals. There is no evidence that swapping widgets solves this |

---

## 5. Wording for users (usable as-is)

> To type Korean, Japanese or Chinese on a phone, write into the **input line** below the
> terminal and press **Send**. The whole line runs at once. To send it without a newline,
> press `↦`. Esc, Tab, Ctrl and the arrows are on the key row beneath it. For letters and
> digits you can tap the terminal and type directly.

---

## 6. What would change this limitation

- If the platform starts reporting composition events (WebKit firing
  `compositionstart`/`compositionend`), **direct typing** on a phone starts working as-is
  — the guard is already in place, so no further work is needed. §3's snippet is how to
  check.
- If a real need appears to enter composed characters one at a time into a full-screen
  TUI, the next step is the **value-diff bridge** from §4, gated on TUI detection or a
  toggle. That work has to begin by pinning down backspace behaviour in `sh`, `vim` and
  an agent's screen as a reproduction procedure first.
