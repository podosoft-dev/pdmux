/**
 * @pdmux/ui — Svelte 5 components for a host/terminal dashboard.
 *
 * EXTERNAL-CONSUMPTION RULES (enforced by a test):
 *  - no import reaches into an application; the package only depends on
 *    `@pdmux/core` and svelte;
 *  - data arrives as props and actions leave as callbacks — no component fetches,
 *    reads a global store or writes to one;
 *  - every user-facing string is a prop or goes through the optional `t(key,
 *    fallback)` translator, so the consumer's i18n stays in charge;
 *  - structural CSS ships in `@pdmux/ui/styles.css`, because a mount host with no
 *    rule of its own once broke an entire page.
 */
export { default as HostCard } from './components/HostCard.svelte';
export { default as HostSidebar } from './components/HostSidebar.svelte';
export { default as UsageGaugeRow } from './components/UsageGaugeRow.svelte';
export { default as ResourceRow } from './components/ResourceRow.svelte';
export { default as MetricSparkline } from './components/MetricSparkline.svelte';
export { default as ServiceLauncher } from './components/ServiceLauncher.svelte';
export { default as CardSettingsPopover } from './components/CardSettingsPopover.svelte';
export { default as SplitHandle } from './components/SplitHandle.svelte';
export { default as ShellViewTabs } from './components/ShellViewTabs.svelte';
export { default as TerminalGrid } from './components/TerminalGrid.svelte';
export { default as TerminalPane } from './components/TerminalPane.svelte';
export { default as TerminalKeyBar } from './components/TerminalKeyBar.svelte';
export { default as TerminalHistory } from './components/TerminalHistory.svelte';
export { default as TerminalComposer } from './components/TerminalComposer.svelte';
export { default as TerminalTargetPicker } from './components/TerminalTargetPicker.svelte';
export { default as EmptyCell } from './components/EmptyCell.svelte';
export { default as GitGraph } from './components/GitGraph.svelte';
export { default as GitRefPanel } from './components/GitRefPanel.svelte';
export { default as CommitDetail } from './components/CommitDetail.svelte';
export { default as DiffView } from './components/DiffView.svelte';
export { default as FileTree } from './components/FileTree.svelte';

export { EchoTerminalAdapter } from './adapters/terminal-adapter.js';
export type { TerminalAdapter, TerminalConnection, TerminalOpenTarget } from './adapters/terminal-adapter.js';
export { createXtermSurface } from './adapters/terminal-surface.js';
/**
 * Exported for every "copy this" button in the product, not just the terminal's.
 *
 * `navigator.clipboard` is undefined on a plain-http origin, which is exactly the
 * self-hosted deployment where a one-shot secret has to be copied — so the raw API
 * fails silently on the one screen that cannot afford it. This wrapper falls back
 * to a hidden textarea, so the caller gets one function that works in both places.
 */
export { writeClipboard } from './adapters/terminal-surface.js';
export type { TerminalSurface, TerminalSurfaceFactory } from './adapters/terminal-surface.js';
export { identityTranslate, translator } from './i18n.js';
export type { Translate } from './i18n.js';
export type { ShellViewTab } from './components/ShellViewTabs.svelte';
export type {
	HostDetail,
	HostResources,
	HostState,
	HostSummary,
	HostUpdateKind,
	HostUpdateMark,
	PickerHost,
	PickerTarget,
	RepoHead,
} from './types.js';
