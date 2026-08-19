<script lang="ts">
	/**
	 * The mark in front of a file name.
	 *
	 * ⚠ THE ARTWORK IS vscode-icons, VENDORED UNCHANGED UNDER CC BY-SA 4.0. The
	 * attribution and the terms are in `../icons/vscode-icons/LICENSE`; the tag and a
	 * digest per file are in `SOURCE.md` beside it. Two consequences bind this file:
	 *
	 * 1. **Nothing here may colour an icon.** `styles.css` paints the row's NAME from
	 *    `data-pdmux-file-kind`, and doing the same to the icon would make it Adapted
	 *    Material — CC BY-SA's ShareAlike term would then reach this repository, which
	 *    is Apache-2.0. So the icon carries its own colours and the palette rule stops
	 *    at the text.
	 * 2. **Light and dark are chosen by SWAPPING FILES, not by filtering one.**
	 *    Upstream ships a light-theme twin for the nine icons that need one, and the
	 *    reason is measurable: `file_type_yaml`'s only colour is `#ffe885`, luminance
	 *    0.90, invisible on a light card, while its twin measures 0.76.
	 *
	 * ⚠ WHICH MEANS THE SCHEME ARRIVES AS A PROP. The package cannot read it: the
	 * app switches theme with `mode-watcher`, whose signal is a class on the document,
	 * and `prefers-color-scheme` disagrees with it the moment somebody picks a theme
	 * their OS does not use. Asking is both correct and the package's own convention —
	 * which face to draw is a prop (`docs/COMPONENTS.md`).
	 *
	 * ⚠ AND IT IS DECORATIVE. The file name sits right beside it as real text, so the
	 * icon is `aria-hidden` and adds nothing to the accessibility tree. `pointer-events`
	 * is off in the stylesheet for the same reason — the vendored files carry a
	 * `<title>`, which a browser would otherwise show as a tooltip reading
	 * `file_type_go`.
	 */
	import { fileIconOf, hasLightTwin, lightTwinOf } from '@pdmux/core';
	import { FILE_ICON_SVG } from '../icons/file-icons.gen.js';

	interface Props {
		/** The entry's name. The icon is derived from it — see `fileIconOf`. */
		name: string;
		dir?: boolean;
		/** A directory the explorer currently has open. */
		open?: boolean;
		/** The fenced home directory itself. */
		root?: boolean;
		/** The scheme the consumer is painted in. See the note above. */
		scheme?: 'light' | 'dark';
	}

	let { name, dir = false, open = false, root = false, scheme = 'light' }: Props = $props();

	const icon = $derived(fileIconOf(name, dir, { open, root }));
	const key = $derived(scheme === 'light' && hasLightTwin(icon) ? lightTwinOf(icon) : icon);
	/**
	 * ⚠ FALLS BACK TWICE RATHER THAN RENDERING AN EMPTY SPAN. A missing key would
	 * otherwise collapse the icon column to zero width for that one row, which reads
	 * as a layout bug rather than as a missing asset.
	 */
	const markup = $derived(FILE_ICON_SVG[key] ?? FILE_ICON_SVG[icon] ?? FILE_ICON_SVG['default_file'] ?? '');
</script>

<span class="pdmux-files-icon" data-pdmux-icon={key} aria-hidden="true">{@html markup}</span>
