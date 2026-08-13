/**
 * What kind of thing a file name names — so a listing can be read by colour
 * instead of by spelling out every extension.
 *
 * ⚠ THE CATEGORIES ARE CHOSEN TO MATCH A PALETTE THAT ALREADY EXISTS. `styles.css`
 * carries six code-highlighting roles (`--pdmux-code-keyword` … `--pdmux-code-attr`)
 * with a light and a dark value each, because the blob view needed them. Inventing a
 * second set of colours for files would mean a second set to keep contrast-correct in
 * both schemes, and — measured on the git dock more than once — the second set is the
 * one that drifts. So this returns a role, and the stylesheet maps role → existing
 * token.
 *
 * It is a pure function of the NAME, never of the contents: the agent sends a listing,
 * not the files in it, and a directory of ten thousand entries must colour without a
 * single extra request.
 */

/** The roles a listing paints. `plain` is "no opinion", which most files are. */
export type FileKind =
	| 'dir'
	| 'code'
	| 'data'
	| 'doc'
	| 'image'
	| 'media'
	| 'archive'
	| 'binary'
	| 'plain';

/**
 * ⚠ EXTENSIONS ONLY — no name matching beyond the handful below. A rule like
 * "anything called `Makefile`" grows one entry per ecosystem forever, and the payoff
 * is a colour. The exceptions are the few whose whole identity IS the name.
 */
const BY_NAME: Readonly<Record<string, FileKind>> = {
	makefile: 'code',
	dockerfile: 'code',
	license: 'doc',
	readme: 'doc',
};

const BY_EXT: Readonly<Record<string, FileKind>> = {
	// code
	ts: 'code',
	tsx: 'code',
	js: 'code',
	jsx: 'code',
	mjs: 'code',
	cjs: 'code',
	svelte: 'code',
	vue: 'code',
	go: 'code',
	rs: 'code',
	py: 'code',
	rb: 'code',
	php: 'code',
	java: 'code',
	kt: 'code',
	swift: 'code',
	c: 'code',
	h: 'code',
	cc: 'code',
	cpp: 'code',
	hpp: 'code',
	cs: 'code',
	sh: 'code',
	bash: 'code',
	zsh: 'code',
	fish: 'code',
	sql: 'code',
	css: 'code',
	scss: 'code',
	html: 'code',
	// structured data and configuration
	json: 'data',
	jsonc: 'data',
	yaml: 'data',
	yml: 'data',
	toml: 'data',
	ini: 'data',
	conf: 'data',
	env: 'data',
	csv: 'data',
	tsv: 'data',
	xml: 'data',
	lock: 'data',
	// prose
	md: 'doc',
	mdx: 'doc',
	txt: 'doc',
	rst: 'doc',
	adoc: 'doc',
	pdf: 'doc',
	// images
	png: 'image',
	jpg: 'image',
	jpeg: 'image',
	gif: 'image',
	webp: 'image',
	svg: 'image',
	avif: 'image',
	bmp: 'image',
	ico: 'image',
	// sound and film
	mp3: 'media',
	wav: 'media',
	flac: 'media',
	ogg: 'media',
	mp4: 'media',
	mov: 'media',
	mkv: 'media',
	webm: 'media',
	// bundles
	zip: 'archive',
	tar: 'archive',
	gz: 'archive',
	tgz: 'archive',
	bz2: 'archive',
	xz: 'archive',
	zst: 'archive',
	rar: 'archive',
	'7z': 'archive',
	// things that are not read, only run
	exe: 'binary',
	dll: 'binary',
	so: 'binary',
	dylib: 'binary',
	bin: 'binary',
	o: 'binary',
	a: 'binary',
	wasm: 'binary',
};

/**
 * The extension, lowercased, or `''`.
 *
 * ⚠ A LEADING DOT IS A NAME, NOT AN EXTENSION. `.gitignore` has no extension —
 * reading one gives `gitignore`, which is in no table and would only ever produce a
 * wrong answer if somebody added it. Splitting on the LAST dot after the first
 * character is what makes `.env.local` → `local` and `.bashrc` → `''`.
 */
export function extensionOf(name: string): string {
	const dot = name.lastIndexOf('.');
	if (dot <= 0 || dot === name.length - 1) return '';
	return name.slice(dot + 1).toLowerCase();
}

export function fileKindOf(name: string, isDir = false): FileKind {
	if (isDir) return 'dir';
	const trimmed = name.trim();
	if (!trimmed) return 'plain';
	const lower = trimmed.toLowerCase();
	const ext = extensionOf(trimmed);
	// The extension wins when there is one (`README.md` is prose either way), and the
	// stem is the fallback so `Dockerfile.dev` is still a Dockerfile.
	if (ext) return BY_EXT[ext] ?? BY_NAME[lower.slice(0, lower.indexOf('.'))] ?? 'plain';
	return BY_NAME[lower] ?? 'plain';
}

/**
 * Can this be shown in the preview pane at the bottom?
 *
 * ⚠ IT ANSWERS FROM THE NAME, WHICH IS A GUESS, AND THE PREVIEW MUST SURVIVE IT
 * BEING WRONG. A `.txt` holding a binary comes back flagged binary by the agent (it
 * sniffs for NUL) and the blob view already has a state for that. What this decides
 * is only whether asking is worth a round trip.
 */
export function previewableAs(name: string): 'text' | 'image' | null {
	const kind = fileKindOf(name);
	if (kind === 'image') return extensionOf(name) === 'svg' ? 'text' : 'image';
	if (kind === 'code' || kind === 'data') return 'text';
	if (kind === 'doc') return extensionOf(name) === 'pdf' ? null : 'text';
	// An extensionless file is usually a script or a note; the agent's own binary
	// sniff is the backstop, so guessing "text" here costs at most one refusal.
	return kind === 'plain' && extensionOf(name) === '' ? 'text' : null;
}

/**
 * The media type a name implies, for a download and for an `<img>`.
 *
 * ⚠ IT IS A GUESS FROM THE NAME, AND THE SERVER TREATS IT AS ONE. Nothing here
 * decides what may be rendered — `INLINE_SAFE` does, and it is a short allowlist
 * rather than a rule about this map, because "not dangerous" is not a property
 * you can derive from a file extension.
 */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	bmp: 'image/bmp',
	ico: 'image/x-icon',
	svg: 'image/svg+xml',
	pdf: 'application/pdf',
	json: 'application/json',
	txt: 'text/plain',
	md: 'text/markdown',
	csv: 'text/csv',
	html: 'text/html',
	css: 'text/css',
	js: 'text/javascript',
	zip: 'application/zip',
	gz: 'application/gzip',
	tar: 'application/x-tar',
	mp3: 'audio/mpeg',
	wav: 'audio/wav',
	mp4: 'video/mp4',
	webm: 'video/webm',
};

export function mimeOf(name: string): string {
	return MIME_BY_EXT[extensionOf(name)] ?? 'application/octet-stream';
}

/**
 * Types a browser may be told to RENDER from this origin rather than download.
 *
 * ⚠ AN ALLOWLIST, AND DELIBERATELY NOT "ANY `image/*`". `image/svg+xml` is a
 * document: it can carry script, and served inline from the app's own origin that
 * is stored XSS with the file explorer as the upload path. HTML is the same
 * argument without the disguise. So the list is raster images, and everything
 * else — including anything added to the map above — is an attachment until
 * somebody adds it here on purpose.
 */
export const INLINE_SAFE: readonly string[] = [
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/webp',
	'image/avif',
	'image/bmp',
];

export function inlineSafe(mime: string): boolean {
	return INLINE_SAFE.includes(mime);
}
