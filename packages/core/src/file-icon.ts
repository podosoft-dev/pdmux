/**
 * Which icon a listing row wears.
 *
 * ⚠ THIS RETURNS A NAME, NEVER AN IMAGE. The bytes live in `@pdmux/ui`
 * (`src/icons/vscode-icons/`, vendored verbatim under CC BY-SA — see that
 * directory's `LICENSE`), because this package has no idea what a DOM is and
 * because ~90 KB of SVG has no business in the module that also holds the layout
 * reducer. Splitting it this way is also what makes the mapping testable without a
 * browser, which is the whole reason `@pdmux/core` exists (ARCHITECTURE §5).
 *
 * ⚠ AND IT IS A SEPARATE QUESTION FROM `fileKindOf()`, WHICH IS WHY IT IS A
 * SEPARATE FILE. A kind is a ROLE — five colours over nine categories, chosen so
 * the stylesheet can reuse the code palette. An icon is an IDENTITY: `main.go`
 * and `main.rs` are both `code` and a person scanning a directory wants to see
 * which is which. Folding the two together would mean either nine icons or
 * ninety colours, and both are wrong.
 *
 * The order below is what makes that work: an exact name beats an extension
 * (`requirements.txt` is Python, not prose), an extension beats a category, and a
 * category is what an unknown extension falls back to so a row is never blank.
 */
import { extensionOf, fileKindOf, type FileKind } from './file-kind.js';

/**
 * Every icon this product ships, and therefore every name this module may return.
 *
 * ⚠ IT IS EXPORTED SO A TEST CAN PROVE THE ASSET EXISTS. A name with no file
 * behind it fails in the ugliest possible way — silently, as a missing icon that
 * looks like a styling bug — so `@pdmux/ui` asserts this list against the
 * generated string module rather than trusting that a download happened.
 */
const NAMES = [
	// Structural. `default_root_folder` marks the home the explorer is fenced to.
	'default_file',
	'default_folder',
	'default_folder_opened',
	'default_root_folder',
	// Category fallbacks, one per `FileKind` that has a better answer than a blank page.
	'file_type_binary',
	'file_type_config',
	'file_type_image',
	'file_type_text',
	'file_type_video',
	'file_type_zip',
	'file_type_audio',
	// Languages.
	'file_type_c',
	'file_type_cpp',
	'file_type_csharp',
	'file_type_css',
	'file_type_go',
	'file_type_html',
	'file_type_java',
	'file_type_js',
	'file_type_kotlin',
	'file_type_lua',
	'file_type_perl2',
	'file_type_php',
	'file_type_python',
	'file_type_reactjs',
	'file_type_reactts',
	'file_type_ruby',
	'file_type_rust',
	'file_type_scss',
	'file_type_shell',
	'file_type_sql',
	'file_type_svelte',
	'file_type_swift',
	'file_type_typescript',
	'file_type_typescriptdef',
	'file_type_vue',
	// Data, prose and documents.
	'file_type_ini',
	'file_type_json',
	'file_type_log',
	'file_type_markdown',
	'file_type_pdf2',
	'file_type_toml',
	'file_type_xml',
	'file_type_yaml',
	// Tools whose files a person recognises by the mark.
	'file_type_docker',
	'file_type_dotenv',
	'file_type_font',
	'file_type_git',
	'file_type_nginx',
	'file_type_npm',
	'file_type_pnpm',
	'file_type_terraform',
	'file_type_yarn',
] as const;

export type FileIconName = (typeof NAMES)[number];
export const FILE_ICON_NAMES: readonly FileIconName[] = NAMES;

/**
 * Icons whose upstream twin is meant for a LIGHT background.
 *
 * ⚠ THIS IS MEASURED, NOT A PREFERENCE. `file_type_yaml`'s only colour is
 * `#ffe885` — luminance 0.90, which on a light card is an icon nobody can see;
 * its `file_type_light_yaml` twin measures 0.76. Nine of the icons here have such
 * a twin and the other forty-odd are coloured marks that read on either
 * background, so this is a short list rather than a parallel set.
 *
 * The twin's name is always `file_type_light_<rest>`, so it is derived rather than
 * stored — a second table would be a second thing to keep in step.
 */
const LIGHT_TWINS: readonly FileIconName[] = [
	'file_type_config',
	'file_type_font',
	'file_type_ini',
	'file_type_js',
	'file_type_json',
	'file_type_pnpm',
	'file_type_rust',
	'file_type_toml',
	'file_type_yaml',
];

export function hasLightTwin(name: string): boolean {
	return (LIGHT_TWINS as readonly string[]).includes(name);
}

/** `file_type_yaml` → `file_type_light_yaml`. Only meaningful when `hasLightTwin`. */
export function lightTwinOf(name: string): string {
	return name.replace(/^file_type_/, 'file_type_light_');
}

/**
 * Names whose whole identity IS the name.
 *
 * ⚠ CHECKED BEFORE THE EXTENSION, which is the opposite of `fileKindOf()`. That
 * function wants the role and `requirements.txt` really is prose-shaped; this one
 * wants the identity, and the thing a person is looking for in a Python project
 * is the Python mark. Both orders are right for their own question.
 */
const BY_NAME: Readonly<Record<string, FileIconName>> = {
	// Upstream has no `Makefile`, `*.lock` or `*.csv` icon at the vendored tag, so
	// these land on a generic rather than on a mark that would be a lie.
	makefile: 'file_type_config',
	dockerfile: 'file_type_docker',
	containerfile: 'file_type_docker',
	'docker-compose.yml': 'file_type_docker',
	'docker-compose.yaml': 'file_type_docker',
	'compose.yml': 'file_type_docker',
	'compose.yaml': 'file_type_docker',
	license: 'file_type_text',
	readme: 'file_type_text',
	'package.json': 'file_type_npm',
	'package-lock.json': 'file_type_npm',
	'.npmrc': 'file_type_npm',
	'yarn.lock': 'file_type_yarn',
	'pnpm-lock.yaml': 'file_type_pnpm',
	'pnpm-workspace.yaml': 'file_type_pnpm',
	'go.mod': 'file_type_go',
	'go.sum': 'file_type_go',
	'cargo.toml': 'file_type_rust',
	'cargo.lock': 'file_type_rust',
	gemfile: 'file_type_ruby',
	'gemfile.lock': 'file_type_ruby',
	'requirements.txt': 'file_type_python',
	'pyproject.toml': 'file_type_python',
	'nginx.conf': 'file_type_nginx',
	'.gitignore': 'file_type_git',
	'.gitattributes': 'file_type_git',
	'.gitmodules': 'file_type_git',
	'.gitkeep': 'file_type_git',
	'.env': 'file_type_dotenv',
	'.bashrc': 'file_type_shell',
	'.bash_profile': 'file_type_shell',
	'.zshrc': 'file_type_shell',
	'.profile': 'file_type_shell',
};

const BY_EXT: Readonly<Record<string, FileIconName>> = {
	// Languages.
	ts: 'file_type_typescript',
	mts: 'file_type_typescript',
	cts: 'file_type_typescript',
	tsx: 'file_type_reactts',
	js: 'file_type_js',
	mjs: 'file_type_js',
	cjs: 'file_type_js',
	jsx: 'file_type_reactjs',
	svelte: 'file_type_svelte',
	vue: 'file_type_vue',
	go: 'file_type_go',
	py: 'file_type_python',
	pyi: 'file_type_python',
	rs: 'file_type_rust',
	rb: 'file_type_ruby',
	php: 'file_type_php',
	java: 'file_type_java',
	kt: 'file_type_kotlin',
	kts: 'file_type_kotlin',
	swift: 'file_type_swift',
	c: 'file_type_c',
	h: 'file_type_c',
	cc: 'file_type_cpp',
	cpp: 'file_type_cpp',
	cxx: 'file_type_cpp',
	hpp: 'file_type_cpp',
	hh: 'file_type_cpp',
	cs: 'file_type_csharp',
	sh: 'file_type_shell',
	bash: 'file_type_shell',
	zsh: 'file_type_shell',
	fish: 'file_type_shell',
	lua: 'file_type_lua',
	pl: 'file_type_perl2',
	pm: 'file_type_perl2',
	sql: 'file_type_sql',
	css: 'file_type_css',
	scss: 'file_type_scss',
	sass: 'file_type_scss',
	html: 'file_type_html',
	htm: 'file_type_html',
	// Data, prose, documents.
	json: 'file_type_json',
	jsonc: 'file_type_json',
	yaml: 'file_type_yaml',
	yml: 'file_type_yaml',
	toml: 'file_type_toml',
	ini: 'file_type_ini',
	cfg: 'file_type_ini',
	conf: 'file_type_ini',
	xml: 'file_type_xml',
	md: 'file_type_markdown',
	mdx: 'file_type_markdown',
	pdf: 'file_type_pdf2',
	log: 'file_type_log',
	env: 'file_type_dotenv',
	lock: 'file_type_config',
	// Tools.
	tf: 'file_type_terraform',
	tfvars: 'file_type_terraform',
	// Fonts, pictures, sound, film, bundles, binaries. These agree with the
	// category fallback below; they are listed so a new category never silently
	// changes what a `.png` looks like.
	ttf: 'file_type_font',
	otf: 'file_type_font',
	woff: 'file_type_font',
	woff2: 'file_type_font',
};

/** What a `FileKind` looks like when nothing more specific matched. */
const BY_KIND: Readonly<Record<FileKind, FileIconName>> = {
	dir: 'default_folder',
	// A code file with an unknown extension is still a file; a generic "code"
	// mark would claim a language nobody identified.
	code: 'default_file',
	data: 'file_type_config',
	doc: 'file_type_text',
	image: 'file_type_image',
	media: 'file_type_video',
	archive: 'file_type_zip',
	binary: 'file_type_binary',
	plain: 'default_file',
};

/** Sound gets its own mark; `fileKindOf` folds it into `media` with film. */
const AUDIO_EXT: readonly string[] = ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'];

export interface FileIconOptions {
	/** A directory the explorer has open. Ignored for files. */
	open?: boolean;
	/** The fenced home directory itself, which is drawn differently. */
	root?: boolean;
}

export function fileIconOf(name: string, isDir = false, options: FileIconOptions = {}): FileIconName {
	if (isDir) {
		if (options.root) return 'default_root_folder';
		return options.open ? 'default_folder_opened' : 'default_folder';
	}
	const trimmed = name.trim();
	if (!trimmed) return 'default_file';
	const lower = trimmed.toLowerCase();

	const byName = BY_NAME[lower];
	if (byName) return byName;

	// ⚠ `.d.ts` IS NOT AN EXTENSION, IT IS A SUFFIX. `extensionOf` says `ts` for
	// it — correct, and not what a reader is looking for in a directory holding
	// both `api.ts` and `api.d.ts`.
	if (lower.endsWith('.d.ts')) return 'file_type_typescriptdef';
	// `.env.local`, `.env.production`: the identity is the stem, not the tail.
	if (lower === '.env' || lower.startsWith('.env.')) return 'file_type_dotenv';

	const ext = extensionOf(trimmed);
	if (ext && AUDIO_EXT.includes(ext)) return 'file_type_audio';
	const byExt = ext ? BY_EXT[ext] : undefined;
	if (byExt) return byExt;

	// A dotted name whose tail means nothing may still have a meaningful stem —
	// `Dockerfile.dev`, `nginx.conf.bak`.
	if (ext) {
		const stem = lower.slice(0, lower.indexOf('.'));
		const byStem = BY_NAME[stem];
		if (byStem) return byStem;
	}

	return BY_KIND[fileKindOf(trimmed)];
}
