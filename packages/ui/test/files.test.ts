import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FILE_ICON_NAMES, FS_CHECK_W, FS_ROW_CHROME, FS_ROW_GAP, hasLightTwin, lightTwinOf } from '@pdmux/core';
import FileExplorer from '../src/components/FileExplorer.svelte';
import { FILE_ICON_SVG } from '../src/icons/file-icons.gen.js';
import type { FsDirView } from '../src/types.js';

/** The control that opens or selects an entry — the row's button, not the row. */
const nameOf = (container: HTMLElement, name: string): HTMLButtonElement =>
	container.querySelector(`[data-pdmux-entry='${name}'] .pdmux-files-row`) as HTMLButtonElement;

const boxOf = (container: HTMLElement, name: string): HTMLInputElement =>
	container.querySelector(`[data-pdmux-check='${name}']`) as HTMLInputElement;

afterEach(cleanup);

const dirOf = (entries: FsDirView['entries'], extra: Partial<FsDirView> = {}): FsDirView => ({
	path: '',
	home: '/home/pdmux',
	entries,
	dropped: 0,
	truncated: false,
	error: null,
	...extra,
});

const entry = (name: string, over: Partial<FsDirView['entries'][number]> = {}) => ({
	name,
	dir: false,
	symlink: false,
	size: 12,
	modified: 0,
	mode: 0o644,
	...over,
});

describe('[TC-PDUI-219] the file explorer states what a host cannot do', () => {
	/**
	 * ⚠ THE SAME REQUIREMENT, AT ITS NEW ADDRESS. This used to be a per-pane control
	 * that was drawn only where it could act, and it was reported as "the explorer
	 * does not open" when it was drawn everywhere instead. The panel is now one dock
	 * with a host picker, so the pane control is gone — and the rule survives as a
	 * sentence: a host whose agent cannot browse says so, rather than showing an
	 * empty directory that reads as "your home is empty".
	 */
	it('says so instead of showing an empty directory', () => {
		const { container } = render(FileExplorer, { props: { unavailable: true } });
		expect(container.querySelector('[data-pdmux-files-note]')?.textContent).toContain('cannot browse');
		expect(container.querySelector('[data-pdmux-files-empty]')).toBeNull();
		// ⚠ THIS USED TO READ `[data-pdmux-files-list]`, AN ATTRIBUTE THAT EXISTS
		// NOWHERE IN THE REPOSITORY — so it could not fail, and the listing could have
		// been rendered right beside the "cannot browse" sentence without anything
		// noticing ("A test that cannot fail proves nothing").
		expect(container.querySelector('.pdmux-files-list')).toBeNull();
	});

	it('distinguishes "no host chosen" from "nothing here"', () => {
		const idle = render(FileExplorer, { props: { idle: true } });
		expect(idle.container.querySelector('[data-pdmux-files-note]')?.textContent).toContain('Choose a host');
		cleanup();
		const empty = render(FileExplorer, { props: { dir: dirOf([]) } });
		expect(empty.container.querySelector('[data-pdmux-files-empty]')).not.toBeNull();
	});

	it('shows a refusal in the words the host used', () => {
		const { container } = render(FileExplorer, {
			props: { dir: dirOf([], { error: 'permission denied' }) },
		});
		expect(container.querySelector('[data-pdmux-files-error]')?.textContent).toBe('permission denied');
	});
});

describe('[TC-PDUI-220] a listing is read by colour and answers a click', () => {
	it('tags every row with the kind its name implies', () => {
		const { container } = render(FileExplorer, {
			props: {
				dir: dirOf([
					entry('src', { dir: true }),
					entry('main.go'),
					entry('package.json'),
					entry('shot.png'),
					entry('notes.txt'),
					entry('link', { symlink: true }),
				]),
			},
		});
		const kinds = [...container.querySelectorAll('[data-pdmux-entry]')].map(
			(row) => (row as HTMLElement).dataset.pdmuxFileKind,
		);
		// ⚠ THE ATTRIBUTE IS THE CONTRACT WITH THE STYLESHEET. Asserting a colour
		// would assert the palette, which is shadcn's and moves; asserting the role
		// is what stops a row from silently losing its colour.
		expect(kinds).toEqual(['dir', 'code', 'data', 'image', 'doc', 'plain']);
		expect(container.querySelectorAll('[data-pdmux-symlink]').length).toBe(1);
	});

	it('navigates on a directory and selects on a file', async () => {
		const onOpenDir = vi.fn();
		const onSelect = vi.fn();
		const { container } = render(FileExplorer, {
			props: { path: 'Project', dir: dirOf([entry('src', { dir: true }), entry('a.ts')]), onOpenDir, onSelect },
		});
		nameOf(container, 'src').click();
		// The path it reports is the FULL relative path, never the bare name: the
		// agent resolves against the home, not against wherever the panel happens to be.
		expect(onOpenDir).toHaveBeenCalledWith('Project/src');
		nameOf(container, 'a.ts').click();
		expect(onSelect).toHaveBeenCalledWith('a.ts', 'single');
	});

	it('names the modifier rather than passing the event on', () => {
		const onSelect = vi.fn();
		const { container } = render(FileExplorer, {
			props: { dir: dirOf([entry('a.ts'), entry('b.ts')]), onSelect },
		});
		const row = nameOf(container, 'b.ts');
		row.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
		expect(onSelect).toHaveBeenLastCalledWith('b.ts', 'toggle');
		row.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
		expect(onSelect).toHaveBeenLastCalledWith('b.ts', 'range');
	});

	it('draws an image as an image, and lets the browser fetch it', () => {
		const { container } = render(FileExplorer, {
			props: {
				dir: dirOf([entry('shot.png'), entry('a.ts')]),
				selected: ['shot.png'],
				image: { path: 'shots/shot.png', url: '/api/hosts/h1/files/download?path=shots%2Fshot.png&inline=1' },
			},
		});
		const img = container.querySelector<HTMLImageElement>('[data-pdmux-preview-image]');
		// ⚠ A `src`, NOT BYTES THROUGH THE PAGE. Routing the picture through the app
		// means holding it in memory to make a blob URL, which fails on exactly the
		// large images the preview is for.
		expect(img?.getAttribute('src')).toContain('inline=1');
		expect(img?.getAttribute('alt')).toBe('shot.png');
		expect(container.querySelector('[data-pdmux-preview-name]')?.textContent).toBe('shot.png');
		expect(container.querySelector('.pdmux-blob')).toBeNull();
	});

	it('marks the selection and opens a preview face for the file being read', () => {
		const { container } = render(FileExplorer, {
			props: {
				dir: dirOf([entry('a.ts'), entry('b.ts')]),
				selected: ['b.ts'],
				file: { path: 'b.ts', lines: ['const x = 1;'], binary: false, truncated: false, bytes: 12, error: null },
			},
		});
		expect(
			container.querySelector<HTMLElement>("[data-pdmux-entry='b.ts']")?.dataset.pdmuxSelected,
		).toBe('true');
		expect(container.querySelector<HTMLElement>("[data-pdmux-entry='a.ts']")?.dataset.pdmuxSelected).toBeUndefined();
		// The header says WHICH file; the body is the only part that scrolls.
		expect(container.querySelector('[data-pdmux-preview-name]')?.textContent).toBe('b.ts');
		expect(container.querySelector('[data-pdmux-files-preview]')).not.toBeNull();
	});
});

/** A pointer gesture jsdom will carry — `MouseEvent` has the coordinates we read. */
const pointer = (type: string, x: number): MouseEvent =>
	new MouseEvent(type, { clientX: x, clientY: 8, bubbles: true, cancelable: true });

describe('[TC-PDUI-222] a listing is read by its marks, and admits what the host did not say', () => {
	it('gives every row an icon that is decorative and out of the way', () => {
		const { container } = render(FileExplorer, {
			props: { dir: dirOf([entry('src', { dir: true }), entry('main.go'), entry('notes.rst')]) },
		});
		const icons = [...container.querySelectorAll('.pdmux-files-icon')];
		expect(icons).toHaveLength(3);
		for (const icon of icons) {
			// The file name is real text beside it, so the icon adds nothing to the
			// accessibility tree — and it must actually contain artwork, not an empty box.
			expect(icon.getAttribute('aria-hidden')).toBe('true');
			expect(icon.querySelector('svg')).not.toBeNull();
		}
		expect(icons.map((icon) => (icon as HTMLElement).dataset.pdmuxIcon)).toEqual([
			'default_folder',
			'file_type_go',
			'file_type_text',
		]);
	});

	it('swaps to the light twin when the app is painted light', () => {
		// ⚠ MEASURED, NOT A PREFERENCE: `file_type_yaml`'s only colour is `#ffe885`,
		// luminance 0.90 — invisible on a light card. Upstream ships the twin for it.
		const light = render(FileExplorer, { props: { dir: dirOf([entry('ci.yaml')]), scheme: 'light' } });
		expect(light.container.querySelector<HTMLElement>('.pdmux-files-icon')?.dataset.pdmuxIcon).toBe(
			'file_type_light_yaml',
		);
		cleanup();
		const dark = render(FileExplorer, { props: { dir: dirOf([entry('ci.yaml')]), scheme: 'dark' } });
		expect(dark.container.querySelector<HTMLElement>('.pdmux-files-icon')?.dataset.pdmuxIcon).toBe(
			'file_type_yaml',
		);
	});

	it('ships bytes for every name the mapping can produce', () => {
		// ⚠ THE FAILURE THIS GUARDS IS SILENT: a name with no asset renders an empty
		// span, which reads as a styling bug rather than as a missing download. `@pdmux/core`
		// owns the names; this package owns the files; nothing else connects the two.
		for (const name of FILE_ICON_NAMES) {
			expect(FILE_ICON_SVG[name], `${name} has no SVG`).toBeTruthy();
			if (hasLightTwin(name)) {
				expect(FILE_ICON_SVG[lightTwinOf(name)], `${lightTwinOf(name)} has no SVG`).toBeTruthy();
			}
		}
	});

	it('never lets two icons share an element id', () => {
		// ⚠ THIS IS A REAL BUG THE VENDORED SET ARRIVES WITH. Seven upstream icons
		// declare gradients as `id="a"` … `id="p"`; inlined into one document a browser
		// resolves `url(#a)` to the FIRST match, so a directory holding both a `.rb` and
		// a `.zip` paints one with the other's gradient. The generator prefixes every id
		// with its icon's name, and this is what keeps that true.
		const owners = new Map<string, string>();
		for (const [name, markup] of Object.entries(FILE_ICON_SVG)) {
			for (const match of markup.matchAll(/\bid="([^"]+)"/g)) {
				const id = match[1] as string;
				const previous = owners.get(id);
				expect(previous, `${name} and ${previous} both declare id="${id}"`).toBeUndefined();
				owners.set(id, name);
			}
		}
	});

	it('prints a size, a time and a mode, and an em dash for what was not reported', () => {
		const { container } = render(FileExplorer, {
			props: {
				dir: dirOf([
					entry('told.txt', { size: 2048, modified: 1_700_000_000, mode: 0o644 }),
					entry('quiet.txt', { size: 0, modified: 0, mode: 0 }),
				]),
				// A fixed formatter: the assertion is about the column, not about a locale.
				formatDate: (seconds: number) => `t${seconds}`,
			},
		});
		const cells = (name: string) => {
			const row = container.querySelector(`[data-pdmux-entry='${name}']`) as HTMLElement;
			return {
				size: row.querySelector('.pdmux-files-size')?.textContent,
				modified: row.querySelector('.pdmux-files-modified')?.textContent,
				mode: row.querySelector('.pdmux-files-mode')?.textContent,
			};
		};
		expect(cells('told.txt')).toEqual({ size: '2.0 KB', modified: 't1700000000', mode: 'rw-r--r--' });
		// ⚠ `0` MEANS "THE HOST DID NOT SAY" — an agent older than the field, or a stat
		// that failed. A date in 1970 and a `---------` are both claims nobody measured.
		// An empty file, though, really is 0 bytes.
		expect(cells('quiet.txt')).toEqual({ size: '0 B', modified: '—', mode: '—' });
	});
});

describe('[TC-PDUI-223] the column header sorts and resizes what is below it', () => {
	const three = () => dirOf([entry('a.ts'), entry('b.ts'), entry('c.ts')]);

	it('exists only when there are rows to head', () => {
		// The four states `[TC-PDUI-219]` locks must not gain a table header: a column
		// header over "this directory is empty" reads as a table that failed.
		for (const props of [
			{ unavailable: true },
			{ idle: true },
			{ loading: true },
			{ dir: dirOf([]) },
			{ dir: dirOf([], { error: 'permission denied' }) },
		]) {
			const { container } = render(FileExplorer, { props });
			expect(container.querySelector('[data-pdmux-files-head]'), JSON.stringify(props)).toBeNull();
			cleanup();
		}
		const { container } = render(FileExplorer, { props: { dir: three() } });
		expect(container.querySelector('[data-pdmux-files-head]')).not.toBeNull();
	});

	it('reports the column that was clicked and leaves the direction to the caller', () => {
		const onSort = vi.fn();
		const { container } = render(FileExplorer, { props: { dir: three(), onSort } });
		const headers = [...container.querySelectorAll<HTMLElement>('.pdmux-files-col')];
		expect(headers.map((head) => head.dataset.pdmuxCol)).toEqual(['name', 'size', 'modified', 'mode']);
		headers[2]?.click();
		// ⚠ THE KEY, NOT A DIRECTION. The toggle rule lives in `@pdmux/core` so this
		// panel and the admin console's tables cannot disagree about what a second
		// click does.
		expect(onSort).toHaveBeenCalledWith('modified');
	});

	it('marks the sorted column and says the ordering out loud', () => {
		const { container } = render(FileExplorer, {
			props: { dir: three(), sort: { key: 'size', dir: 'desc' } },
		});
		const head = (key: string) => container.querySelector<HTMLElement>(`.pdmux-files-col[data-pdmux-col='${key}']`);
		expect(head('size')?.dataset.pdmuxSort).toBe('desc');
		expect(head('name')?.dataset.pdmuxSort).toBeUndefined();
		// ⚠ NOT `aria-sort`: that attribute belongs to `columnheader`, and the listing is
		// deliberately a list of buttons rather than a grid. The state goes into the
		// control's own name, which every reader announces.
		expect(head('size')?.getAttribute('aria-label')).toContain('descending');
		expect(head('name')?.getAttribute('aria-label')).toContain('Sort by');
		expect(head('size')?.querySelector<HTMLElement>('.pdmux-files-arrow')?.dataset.pdmuxArrow).toBe('desc');
		// The inactive columns keep a dimmed arrow, or they read as plain labels and
		// nothing says the header is a control.
		expect(head('name')?.querySelector<HTMLElement>('.pdmux-files-arrow')?.dataset.pdmuxArrow).toBe('none');
	});

	it('reports a dragged edge as a delta from where the gesture started', () => {
		const onColumnResize = vi.fn();
		const { container } = render(FileExplorer, { props: { dir: three(), onColumnResize } });
		const cell = container.querySelector("[data-pdmux-cell='modified']") as HTMLElement;
		const grip = cell.querySelector('[data-pdmux-handle]') as HTMLElement;
		// ⚠ THE GRIP IS NOT INSIDE THE HEADER BUTTON. A pointerdown on a child of a
		// control is also a click on it, so a grip in there would re-sort on every drag.
		expect(grip.closest('.pdmux-files-col')).toBeNull();
		(grip as HTMLElement & { setPointerCapture: (id: number) => void }).setPointerCapture = () => undefined;
		(grip as HTMLElement & { releasePointerCapture: (id: number) => void }).releasePointerCapture = () => undefined;
		// ⚠ LEFT IS WIDER, AND THE SIGN IS THE POINT. The grip straddles the column's
		// LEADING edge, so dragging it left grows the column — against the axis
		// direction, which is what `invert` on the handle is for. Without it the column
		// shrank when it should have grown, and only the browser geometry spec noticed.
		grip.dispatchEvent(pointer('pointerdown', 400));
		grip.dispatchEvent(pointer('pointermove', 360));
		expect(onColumnResize).toHaveBeenCalledWith('modified', 40, false, expect.any(Number));
		grip.dispatchEvent(pointer('pointerup', 340));
		expect(onColumnResize).toHaveBeenLastCalledWith('modified', 60, true, expect.any(Number));
	});

	it('admits that a non-default sort only ordered what arrived', () => {
		// ⚠ THE HOST SORTS AND THEN TRUNCATES. So the largest file on the host may not be
		// in the array at all, and a `size` header that said nothing would be a wrong
		// answer rather than a different order.
		const dropped = dirOf([entry('a.ts')], { dropped: 40, truncated: true });
		const quiet = render(FileExplorer, { props: { dir: dropped, sort: { key: 'name', dir: 'asc' } } });
		expect(quiet.container.querySelector('[data-pdmux-files-dropped]')).not.toBeNull();
		expect(quiet.container.querySelector('[data-pdmux-files-sorted-subset]')).toBeNull();
		cleanup();
		const sorted = render(FileExplorer, { props: { dir: dropped, sort: { key: 'size', dir: 'desc' } } });
		expect(sorted.container.querySelector('[data-pdmux-files-sorted-subset]')?.textContent).toContain(
			'not the whole directory',
		);
	});

	it('spends in the stylesheet exactly what the reducer budgets', () => {
		// ⚠ CSS CANNOT READ A CONSTANT, so `FS_ROW_CHROME` and the row's own padding plus
		// icon are two numbers for one distance. Left unchecked they drift, and the name
		// column silently loses the floor that keeps a listing readable at a 260px dock.
		const css = readFileSync(join(import.meta.dirname, '../src/styles.css'), 'utf8');
		const row = css.match(/\.pdmux-files-row\s*\{[^}]*\}/s)?.[0] ?? '';
		expect(row).toContain('gap: var(--pdmux-files-gap, 8px)');
		const padding = Number(/padding:\s*\d+px\s+(\d+)px/.exec(row)?.[1]);
		const iconWidth = Number(
			/\.pdmux-files-icon,\s*\.pdmux-files-head-icon\s*\{[^}]*width:\s*(\d+)px/s.exec(css)?.[1],
		);
		expect(padding * 2 + iconWidth).toBe(FS_ROW_CHROME);
		// The header must spend the same, or it lines up with nothing.
		const head = css.match(/\.pdmux-files-head\s*\{[^}]*\}/s)?.[0] ?? '';
		expect(head).toContain('gap: var(--pdmux-files-gap, 8px)');
		expect(head).toContain(`padding: 3px ${padding}px`);
		expect(head).toContain('position: sticky');
	});
});

describe('[TC-PDUI-230] a checkbox column selects without navigating', () => {
	const mixed = () => dirOf([entry('src', { dir: true }), entry('a.ts'), entry('b.ts'), entry('c.ts')]);
	/** The component re-reads `selected` one tick after a click; wait for that turn. */
	const settle = async (): Promise<void> => {
		await tick();
		await tick();
	};

	it('is not drawn unless the consumer asks for it', () => {
		// A consumer that only browses keeps today's listing — and today's name width.
		const { container } = render(FileExplorer, { props: { dir: mixed() } });
		expect(container.querySelector('input[type=checkbox]')).toBeNull();
		expect(container.querySelector('.pdmux-files-check')).toBeNull();
		expect(container.querySelector('.pdmux-files-head-check')).toBeNull();
	});

	it('toggles a folder or a file with the box, and never opens either', () => {
		const onOpenDir = vi.fn();
		const onSelect = vi.fn();
		const onCheck = vi.fn();
		const { container } = render(FileExplorer, {
			props: { dir: mixed(), selectable: true, onOpenDir, onSelect, onCheck },
		});
		boxOf(container, 'src').click();
		boxOf(container, 'a.ts').click();
		// ⚠ THE WHOLE POINT. Before this, a folder could only be chosen by switching the
		// panel into a mode where a click on it did not open it.
		expect(onCheck.mock.calls).toEqual([
			['src', 'toggle'],
			['a.ts', 'toggle'],
		]);
		expect(onOpenDir).not.toHaveBeenCalled();
		expect(onSelect).not.toHaveBeenCalled();
		// Each box is named for its entry, so a screen reader hears what it would select.
		expect(boxOf(container, 'src').getAttribute('aria-label')).toBe('Select src');
		expect(boxOf(container, 'src').closest('.pdmux-files-row')).toBeNull();
	});

	it('reports a Shift-click on a box as a range', () => {
		const onCheck = vi.fn();
		const { container } = render(FileExplorer, { props: { dir: mixed(), selectable: true, onCheck } });
		boxOf(container, 'c.ts').dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
		expect(onCheck).toHaveBeenLastCalledWith('c.ts', 'range');
	});

	it('keeps the name doing what it did: a folder opens, a file selects', () => {
		const onOpenDir = vi.fn();
		const onSelect = vi.fn();
		const onCheck = vi.fn();
		const { container } = render(FileExplorer, {
			props: { path: 'Project', dir: mixed(), selectable: true, onOpenDir, onSelect, onCheck },
		});
		nameOf(container, 'src').click();
		expect(onOpenDir).toHaveBeenCalledWith('Project/src');
		nameOf(container, 'b.ts').dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
		expect(onSelect).toHaveBeenLastCalledWith('b.ts', 'toggle');
		expect(onCheck).not.toHaveBeenCalled();
	});

	it('draws the box from `selected`, and puts it back when the caller declines', async () => {
		const { container, rerender } = render(FileExplorer, {
			props: { dir: mixed(), selectable: true, selected: ['a.ts'], onCheck: vi.fn() },
		});
		expect(boxOf(container, 'a.ts').checked).toBe(true);
		expect(container.querySelector<HTMLElement>("[data-pdmux-entry='a.ts']")?.dataset.pdmuxSelected).toBe('true');
		// ⚠ THE BROWSER FLIPS THE BOX BEFORE ANY HANDLER RUNS. A caller that did not take
		// the toggle leaves `selected` as it was, and Svelte only writes `checked` when the
		// prop changes — so without the re-read, `b.ts` stays drawn checked over an entry
		// that is not selected.
		boxOf(container, 'b.ts').click();
		await settle();
		expect(boxOf(container, 'b.ts').checked).toBe(false);
		await rerender({ selected: ['a.ts', 'b.ts'] });
		expect(boxOf(container, 'b.ts').checked).toBe(true);
	});

	it('says none, some or all in the header, and asks for all or none', async () => {
		const onCheckAll = vi.fn();
		const { container, rerender } = render(FileExplorer, {
			props: { dir: mixed(), selectable: true, selected: [], onCheckAll },
		});
		const all = container.querySelector<HTMLInputElement>('[data-pdmux-check-all]') as HTMLInputElement;
		expect(all.getAttribute('aria-label')).toBe('Select all');
		expect([all.checked, all.indeterminate]).toEqual([false, false]);

		await rerender({ selected: ['a.ts'] });
		expect([all.checked, all.indeterminate]).toEqual([false, true]);
		all.click();
		// From "some", the box asks for every entry, in the order on screen.
		expect(onCheckAll).toHaveBeenLastCalledWith(['src', 'a.ts', 'b.ts', 'c.ts']);
		await settle();
		// The caller has not answered yet, so the box is still "some", not the browser's guess.
		expect([all.checked, all.indeterminate]).toEqual([false, true]);

		await rerender({ selected: ['src', 'a.ts', 'b.ts', 'c.ts'] });
		expect([all.checked, all.indeterminate]).toEqual([true, false]);
		all.click();
		expect(onCheckAll).toHaveBeenLastCalledWith([]);
	});

	it('disables a box the caller cannot act on, says why, and leaves it out of select-all', async () => {
		const reason = 'Update the host agent to transfer folders.';
		const onCheck = vi.fn();
		const onCheckAll = vi.fn();
		const { container, rerender } = render(FileExplorer, {
			props: {
				dir: mixed(),
				selectable: true,
				selected: [],
				checkDisabledReason: (item: FsDirView['entries'][number]) => (item.dir ? reason : null),
				onCheck,
				onCheckAll,
			},
		});
		const folder = boxOf(container, 'src');
		expect(folder.disabled).toBe(true);
		// On the box for its accessible description, and on the cell for the tooltip — a
		// disabled control does not reliably show its own.
		expect(folder.title).toBe(reason);
		expect(folder.closest('label')?.title).toBe(reason);
		expect(boxOf(container, 'a.ts').disabled).toBe(false);
		expect(boxOf(container, 'a.ts').title).toBe('');

		const all = container.querySelector<HTMLInputElement>('[data-pdmux-check-all]') as HTMLInputElement;
		all.click();
		expect(onCheckAll).toHaveBeenLastCalledWith(['a.ts', 'b.ts', 'c.ts']);
		// Every box that CAN be checked is checked: that is "all", whatever the folder says.
		await rerender({ selected: ['a.ts', 'b.ts', 'c.ts'] });
		expect([all.checked, all.indeterminate]).toEqual([true, false]);

		// A directory of nothing but folders leaves select-all with nothing to do.
		await rerender({ dir: dirOf([entry('src', { dir: true }), entry('lib', { dir: true })]), selected: [] });
		expect(all.disabled).toBe(true);
	});

	it('spends in the stylesheet exactly what the reducer charges for the column', () => {
		// ⚠ `fsColumnRoom()` takes `FS_CHECK_W` plus one gap off the width the columns may
		// spend. The row cell, the header cell and the box are three rules that must agree
		// with that one number, and CSS cannot read it.
		const css = readFileSync(join(import.meta.dirname, '../src/styles.css'), 'utf8');
		const rule = (selector: string): string =>
			css.match(new RegExp(`\\n${selector.replace(/[.*]/g, '\\$&')}\\s*\\{[^}]*\\}`, 's'))?.[0] ?? '';
		expect(rule('.pdmux-files-checkbox')).toContain(`inline-size: ${FS_CHECK_W}px`);
		const row = rule('.pdmux-files-row');
		const padding = Number(/padding:\s*\d+px\s+(\d+)px/.exec(row)?.[1]);
		// The row cell is the button's padding, the box, and the rest of the gap.
		expect(rule('.pdmux-files-check')).toContain(
			`padding-inline: ${padding}px calc(var(--pdmux-files-gap, ${FS_ROW_GAP}px) - ${padding}px)`,
		);
		// The header cell is the box alone: its padding is handed back by its margins.
		const head = rule('.pdmux-files-head-check');
		expect(head).toContain(`margin-inline: -${padding}px -4px`);
		expect(head).toContain(`padding-inline: ${padding}px 4px`);
	});
});
