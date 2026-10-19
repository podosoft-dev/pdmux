<script lang="ts">
  import { onMount } from "svelte";
  import { DEFAULT_TERMINAL_PREFERENCES, type TerminalPreferences } from "@pdmux/core";
  import { terminalPalette } from "@pdmux/ui";
  import { Button } from "#lib/components/ui/button/index.js";
  import { Input } from "#lib/components/ui/input/index.js";
  import * as Checkbox from "#lib/components/ui/checkbox/index.js";
  import { Label } from "#lib/components/ui/label/index.js";
  import * as Select from "#lib/components/ui/select/index.js";
  import * as Card from "#lib/components/ui/card/index.js";
  import InfoHint from "#lib/dashboard/components/info-hint.svelte";
  import { getI18n } from "#lib/i18n/index.js";
  import { terminalPreferences } from "./terminal-preferences.svelte.js";

  const i18n = getI18n();
  const text = $derived(i18n.t.desktop.preferences);
  const fonts = ["monospace", "Menlo", "Monaco", "SF Mono", "Cascadia Code", "Consolas", "JetBrains Mono", "Fira Code"];
  let draft = $state<TerminalPreferences>({ ...DEFAULT_TERMINAL_PREFERENCES });
  let ready = $state(false);
  let pending = $state(false);
  let error = $state("");
  let saved = $state(false);
  const palette = $derived(terminalPalette(draft.theme));
  const font = $derived(fonts.includes(draft.fontFamily) ? draft.fontFamily : "custom");
  const fontLabel = $derived(draft.fontFamily === "monospace" ? text.systemFont : draft.fontFamily);
  const fontFamily = $derived(draft.fontFamily === "monospace" ? "monospace" : `"${draft.fontFamily.replaceAll('"', '')}", monospace`);

  onMount(() => {
    void terminalPreferences.load().then(() => { draft = { ...terminalPreferences.value }; ready = true; }).catch(() => { error = text.loadFailed; });
  });

  async function save(): Promise<void> {
    pending = true; error = ""; saved = false;
    try { await terminalPreferences.save(draft); draft = { ...terminalPreferences.value }; saved = true; }
    catch { error = text.saveFailed; }
    finally { pending = false; }
  }
</script>

<form class="grid gap-4" oninput={() => (saved = false)} onchange={() => (saved = false)} onsubmit={event => { event.preventDefault(); void save(); }} data-testid="terminal-settings-form">
  <Card.Root>
    <Card.Header><Card.Title class="flex items-center gap-1">{text.terminal}<InfoHint label={text.terminal} text={text.scope} /></Card.Title></Card.Header>
    <Card.Content class="grid gap-5 sm:grid-cols-2">
      <div class="grid content-start gap-2">
        <div class="flex items-center gap-1"><Label for="terminal-font">{text.font}</Label><InfoHint label={text.font} text={text.fontHelp} /></div>
        <Select.Root type="single" value={font} onValueChange={value => { draft.fontFamily = value === "custom" ? "" : value; saved = false; }}>
          <Select.Trigger class="w-full min-w-0" id="terminal-font" disabled={!ready || pending} data-testid="terminal-font"><span class="truncate">{font === "custom" ? text.customFont : fontLabel}</span></Select.Trigger>
          <Select.Content>{#each fonts as family}<Select.Item value={family}>{family === "monospace" ? text.systemFont : family}</Select.Item>{/each}<Select.Item value="custom">{text.customFont}</Select.Item></Select.Content>
        </Select.Root>
        {#if font === "custom"}<Input aria-label={text.customFont} bind:value={draft.fontFamily} maxlength={120} disabled={!ready || pending} data-testid="terminal-custom-font" />{/if}
      </div>
      <div class="grid content-start gap-2"><Label for="terminal-size">{text.fontSize}</Label><Input id="terminal-size" type="number" min={8} max={32} step={1} bind:value={draft.fontSize} disabled={!ready || pending} data-testid="terminal-font-size" /></div>
      <div class="grid content-start gap-2">
        <Label for="terminal-theme">{text.theme}</Label>
        <Select.Root type="single" value={draft.theme} onValueChange={value => { if (value === "pdmux" || value === "dracula" || value === "light") { draft.theme = value; saved = false; } }}><Select.Trigger class="w-full min-w-0" id="terminal-theme" disabled={!ready || pending} data-testid="terminal-theme"><span class="truncate">{text.themes[draft.theme]}</span></Select.Trigger><Select.Content>{#each ["pdmux", "dracula", "light"] as theme}<Select.Item value={theme}>{text.themes[theme as TerminalPreferences["theme"]]}</Select.Item>{/each}</Select.Content></Select.Root>
      </div>
      <div class="grid content-start gap-2"><Label for="terminal-line-height">{text.lineHeight}</Label><Input id="terminal-line-height" type="number" min={1} max={2} step={0.1} bind:value={draft.lineHeight} disabled={!ready || pending} data-testid="terminal-line-height" /></div>
      <div class="grid content-start gap-2">
        <Label for="terminal-cursor">{text.cursor}</Label>
        <Select.Root type="single" value={draft.cursorStyle} onValueChange={value => { if (value === "block" || value === "bar" || value === "underline") { draft.cursorStyle = value; saved = false; } }}><Select.Trigger class="w-full min-w-0" id="terminal-cursor" disabled={!ready || pending} data-testid="terminal-cursor"><span class="truncate">{text.cursors[draft.cursorStyle]}</span></Select.Trigger><Select.Content>{#each ["auto", "block", "bar", "underline"] as style}<Select.Item value={style}>{text.cursors[style as TerminalPreferences["cursorStyle"]]}</Select.Item>{/each}</Select.Content></Select.Root>
      </div>
      <div class="flex items-center gap-2"><Checkbox.Root id="terminal-cursor-blink" checked={draft.cursorBlink} onCheckedChange={value => { draft.cursorBlink = value; saved = false; }} disabled={!ready || pending || draft.cursorStyle === "auto"} data-testid="terminal-cursor-blink" /><Label for="terminal-cursor-blink">{text.cursorBlink}</Label></div>
    </Card.Content>
  </Card.Root>
  <Card.Root><Card.Header><Card.Title>{text.preview}</Card.Title></Card.Header><Card.Content><pre class="overflow-x-auto rounded-md p-4" style:background={palette.background} style:color={palette.foreground} style:font-family={fontFamily} style:font-size={`${draft.fontSize}px`} style:line-height={draft.lineHeight} data-testid="terminal-preview"><span style:color={palette.green}>user@computer</span> <span style:color={palette.blue}>~/project</span> $ echo PDMux
{text.previewSample}
<span style:color={palette.red}>Red</span> <span style:color={palette.green}>Green</span> <span style:color={palette.yellow}>Yellow</span> <span style:color={palette.blue}>Blue</span> <span style:color={palette.magenta}>Magenta</span> <span style:color={palette.cyan}>Cyan</span></pre></Card.Content></Card.Root>
  {#if error}<p class="text-destructive text-sm" role="alert">{error}</p>{/if}
  {#if saved}<p class="text-muted-foreground text-sm" role="status">{text.saved}</p>{/if}
  <div class="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" disabled={!ready || pending} onclick={() => { draft = { ...DEFAULT_TERMINAL_PREFERENCES }; saved = false; }}>{text.reset}</Button><Button type="submit" disabled={!ready || pending} data-testid="terminal-settings-save">{text.save}</Button></div>
</form>
