import { describe, expect, it } from 'vitest';
import { FILE_ICON_NAMES, fileIconOf, hasLightTwin, lightTwinOf } from '../src/file-icon.js';

describe('[TC-PDCORE-100] a listing row knows which icon it wears', () => {
	it('answers with a name this product actually ships', () => {
		// ⚠ THE REAL FAILURE MODE IS A NAME WITH NO FILE BEHIND IT — a blank cell that
		// reads as a styling bug. This keeps the tables honest here; `@pdmux/ui`
		// asserts the other half, that every shipped name has bytes.
		const names = new Set<string>(FILE_ICON_NAMES);
		for (const probe of [
			'main.go',
			'App.tsx',
			'x.unknown-extension',
			'',
			'Dockerfile',
			'.gitignore',
			'clip.mp4',
			'song.mp3',
		]) {
			expect(names.has(fileIconOf(probe)), `${probe} → ${fileIconOf(probe)}`).toBe(true);
		}
		expect(names.has(fileIconOf('anything', true))).toBe(true);
	});

	describe('a directory is a directory whatever it is called', () => {
		it('ignores the name and answers to open/root instead', () => {
			expect(fileIconOf('src', true)).toBe('default_folder');
			expect(fileIconOf('src', true, { open: true })).toBe('default_folder_opened');
			expect(fileIconOf('', true, { root: true })).toBe('default_root_folder');
			// A folder called `notes.md` must not wear the markdown mark.
			expect(fileIconOf('notes.md', true)).toBe('default_folder');
		});
	});

	describe('the order of the tables', () => {
		it('lets an exact name beat its own extension', () => {
			// ⚠ THIS IS THE OPPOSITE OF `fileKindOf`, WHICH READS THIS AS PROSE. What a
			// person scans a Python project for is the Python mark.
			expect(fileIconOf('requirements.txt')).toBe('file_type_python');
			expect(fileIconOf('package.json')).toBe('file_type_npm');
			expect(fileIconOf('pnpm-lock.yaml')).toBe('file_type_pnpm');
			expect(fileIconOf('docker-compose.yml')).toBe('file_type_docker');
		});

		it('reads the extension when no name matched, case-insensitively', () => {
			expect(fileIconOf('main.GO')).toBe('file_type_go');
			expect(fileIconOf('Component.svelte')).toBe('file_type_svelte');
			expect(fileIconOf('lib.rs')).toBe('file_type_rust');
			expect(fileIconOf('schema.sql')).toBe('file_type_sql');
		});

		it('falls back to the stem for a suffixed name', () => {
			expect(fileIconOf('Dockerfile.dev')).toBe('file_type_docker');
			expect(fileIconOf('Makefile.local')).toBe('file_type_config');
			// ⚠ THE STEM IS LOOKED UP WHOLE, and `nginx` alone is not a key — only
			// `nginx.conf` is. So a backup of a config file lands on the generic rather
			// than on a mark derived from the middle of the name. Reading the
			// second-to-last extension would be one more rule for one more guess.
			expect(fileIconOf('nginx.conf.bak')).toBe('default_file');
		});

		it('falls back to the category so a row is never blank', () => {
			expect(fileIconOf('report.xyzzy')).toBe('default_file');
			expect(fileIconOf('shot.png')).toBe('file_type_image');
			expect(fileIconOf('bundle.tar.gz')).toBe('file_type_zip');
			expect(fileIconOf('agent.wasm')).toBe('file_type_binary');
			expect(fileIconOf('notes.rst')).toBe('file_type_text');
		});
	});

	describe('the suffixes that are not extensions', () => {
		it('tells a declaration file from the source beside it', () => {
			// A directory holding both `api.ts` and `api.d.ts` is the case: `extensionOf`
			// says `ts` for both, correctly, and that is not what a reader is looking for.
			expect(fileIconOf('api.ts')).toBe('file_type_typescript');
			expect(fileIconOf('api.d.ts')).toBe('file_type_typescriptdef');
		});

		it('keeps every dotenv variant on the dotenv mark', () => {
			expect(fileIconOf('.env')).toBe('file_type_dotenv');
			expect(fileIconOf('.env.local')).toBe('file_type_dotenv');
			expect(fileIconOf('.env.production')).toBe('file_type_dotenv');
		});

		it('splits sound from film, which the category folds together', () => {
			expect(fileIconOf('clip.mp4')).toBe('file_type_video');
			expect(fileIconOf('song.mp3')).toBe('file_type_audio');
			expect(fileIconOf('take.flac')).toBe('file_type_audio');
		});
	});

	describe('the light-theme twins', () => {
		it('names them by derivation, not by a second table', () => {
			expect(hasLightTwin('file_type_yaml')).toBe(true);
			expect(lightTwinOf('file_type_yaml')).toBe('file_type_light_yaml');
			// A coloured mark that reads on either background has no twin, and asking
			// for one must not invent a file name.
			expect(hasLightTwin('file_type_go')).toBe(false);
			expect(hasLightTwin('default_folder')).toBe(false);
		});
	});
});
