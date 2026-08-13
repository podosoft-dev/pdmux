import { describe, expect, it } from 'vitest';
import { extensionOf, fileKindOf, inlineSafe, mimeOf, previewableAs } from '../src/file-kind.js';

describe('[TC-PDCORE-098] file kinds are read from the name alone', () => {
	it('gives a directory its own role regardless of what it is called', () => {
		expect(fileKindOf('src', true)).toBe('dir');
		// A directory called `notes.md` is still a directory — the flag wins, because
		// the listing knows and the name only guesses.
		expect(fileKindOf('notes.md', true)).toBe('dir');
	});

	it('reads the extension, case-insensitively', () => {
		expect(fileKindOf('main.go')).toBe('code');
		expect(fileKindOf('Component.SVELTE')).toBe('code');
		expect(fileKindOf('package.json')).toBe('data');
		expect(fileKindOf('README.md')).toBe('doc');
		expect(fileKindOf('shot.PNG')).toBe('image');
		expect(fileKindOf('clip.mp4')).toBe('media');
		expect(fileKindOf('bundle.tar.gz')).toBe('archive');
		expect(fileKindOf('agent.wasm')).toBe('binary');
	});

	it('has no opinion about an unknown extension', () => {
		expect(fileKindOf('report.xyzzy')).toBe('plain');
	});

	describe('a leading dot is a name, not an extension', () => {
		it('treats a dotfile as having none', () => {
			expect(extensionOf('.gitignore')).toBe('');
			expect(extensionOf('.env.local')).toBe('local');
			expect(extensionOf('archive.')).toBe('');
			// ⚠ Reading `.gitignore`'s extension as `gitignore` is the failure this
			// guards: it is one table entry away from silently colouring every dotfile
			// as whatever that word happens to match.
			expect(fileKindOf('.gitignore')).toBe('plain');
		});
	});

	describe('the few names that ARE their identity', () => {
		it('recognises them, and their suffixed variants', () => {
			expect(fileKindOf('Makefile')).toBe('code');
			expect(fileKindOf('Dockerfile')).toBe('code');
			expect(fileKindOf('Dockerfile.dev')).toBe('code');
			expect(fileKindOf('LICENSE')).toBe('doc');
		});

		it('still lets a real extension win over the stem', () => {
			// `readme` is in the name table, but `.png` is not prose.
			expect(fileKindOf('readme.png')).toBe('image');
		});
	});

	describe('what a browser is told a file is', () => {
		it('reads a media type from the name, and admits when it cannot', () => {
			expect(mimeOf('shot.PNG')).toBe('image/png');
			expect(mimeOf('paper.pdf')).toBe('application/pdf');
			expect(mimeOf('archive.tar')).toBe('application/x-tar');
			expect(mimeOf('mystery.xyzzy')).toBe('application/octet-stream');
			expect(mimeOf('LICENSE')).toBe('application/octet-stream');
		});

		it('lets only raster images be rendered from this origin', () => {
			expect(inlineSafe(mimeOf('shot.png'))).toBe(true);
			expect(inlineSafe(mimeOf('photo.jpeg'))).toBe(true);
			// ⚠ SVG IS A DOCUMENT. It can carry script, and served inline from the
			// app's own origin — with the explorer as the way to put one there —
			// that is stored XSS. HTML is the same thing without the disguise.
			expect(inlineSafe(mimeOf('icon.svg'))).toBe(false);
			expect(inlineSafe(mimeOf('page.html'))).toBe(false);
			expect(inlineSafe(mimeOf('paper.pdf'))).toBe(false);
			expect(inlineSafe(mimeOf('anything.unknown'))).toBe(false);
		});
	});

	describe('what is worth asking the host for', () => {
		it('previews text and images, and refuses what cannot be shown', () => {
			expect(previewableAs('notes.txt')).toBe('text');
			expect(previewableAs('main.go')).toBe('text');
			expect(previewableAs('shot.png')).toBe('image');
			// SVG is markup: showing the source is honest and needs no byte transfer.
			expect(previewableAs('icon.svg')).toBe('text');
			expect(previewableAs('clip.mp4')).toBeNull();
			expect(previewableAs('bundle.zip')).toBeNull();
			expect(previewableAs('paper.pdf')).toBeNull();
		});

		it('gives an extensionless file the benefit of the doubt', () => {
			// The agent sniffs for NUL bytes and answers `binary`, so a wrong guess
			// here costs one round trip and shows a state the view already has.
			expect(previewableAs('.gitignore')).toBe('text');
			expect(previewableAs('LICENSE')).toBe('text');
		});
	});
});
