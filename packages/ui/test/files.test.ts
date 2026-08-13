import { cleanup, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FileExplorer from '../src/components/FileExplorer.svelte';
import type { FsDirView } from '../src/types.js';

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
		expect(container.querySelector('[data-pdmux-files-list]')).toBeNull();
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
		const rows = container.querySelectorAll<HTMLButtonElement>('[data-pdmux-entry]');
		rows[0]?.click();
		// The path it reports is the FULL relative path, never the bare name: the
		// agent resolves against the home, not against wherever the panel happens to be.
		expect(onOpenDir).toHaveBeenCalledWith('Project/src');
		rows[1]?.click();
		expect(onSelect).toHaveBeenCalledWith('a.ts', 'single');
	});

	it('names the modifier rather than passing the event on', () => {
		const onSelect = vi.fn();
		const { container } = render(FileExplorer, {
			props: { dir: dirOf([entry('a.ts'), entry('b.ts')]), onSelect },
		});
		const row = container.querySelector<HTMLButtonElement>("[data-pdmux-entry='b.ts']");
		row?.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true }));
		expect(onSelect).toHaveBeenLastCalledWith('b.ts', 'toggle');
		row?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
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
