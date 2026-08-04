<script lang="ts">
	/**
	 * One file, as it stood at one commit.
	 *
	 * ⚠ THE MARKUP COMES FROM highlight.js AND NOWHERE ELSE. This is content out of
	 * somebody's repository, so it is never interpolated raw: `hljs.highlight` escapes
	 * the source it is given and returns spans, and that escaped result is the only
	 * thing that reaches `{@html}`. A file that fails to highlight falls back to plain
	 * text through the same escaping path.
	 *
	 * ⚠ THE LANGUAGE IS TAKEN FROM THE EXTENSION, NOT AUTO-DETECTED. `highlightAuto`
	 * guesses from content and guesses differently for two files in the same project —
	 * a short JSON file reads as anything with braces. A path is what the caller
	 * already knows for certain.
	 *
	 * ⚠ ONLY THE LANGUAGES THIS PRODUCT IS WRITTEN IN ARE REGISTERED. The full
	 * `highlight.js` bundle is every grammar it ships; naming them keeps what a
	 * consumer installs to the ones that will actually be asked for.
	 */
	import hljs from 'highlight.js/lib/core';
	import bash from 'highlight.js/lib/languages/bash';
	import css from 'highlight.js/lib/languages/css';
	import diff from 'highlight.js/lib/languages/diff';
	import go from 'highlight.js/lib/languages/go';
	import ini from 'highlight.js/lib/languages/ini';
	import javascript from 'highlight.js/lib/languages/javascript';
	import json from 'highlight.js/lib/languages/json';
	import markdown from 'highlight.js/lib/languages/markdown';
	import python from 'highlight.js/lib/languages/python';
	import shell from 'highlight.js/lib/languages/shell';
	import sql from 'highlight.js/lib/languages/sql';
	import typescript from 'highlight.js/lib/languages/typescript';
	import xml from 'highlight.js/lib/languages/xml';
	import yaml from 'highlight.js/lib/languages/yaml';
	import { type Translate, translator } from '../i18n.js';

	for (const [name, language] of [
		['bash', bash],
		['css', css],
		['diff', diff],
		['go', go],
		['ini', ini],
		['javascript', javascript],
		['json', json],
		['markdown', markdown],
		['python', python],
		['shell', shell],
		['sql', sql],
		['typescript', typescript],
		['xml', xml],
		['yaml', yaml],
	] as const) {
		if (!hljs.getLanguage(name)) hljs.registerLanguage(name, language);
	}

	/**
	 * Extension -> grammar.
	 *
	 * ⚠ `.svelte` AND `.vue` ARE MARKED UP AS `xml`, ON PURPOSE. Neither grammar
	 * ships with highlight.js, and `xml` gets the tags and attributes right, which is
	 * most of what a component file looks like. Claiming `javascript` would colour the
	 * markup as broken code, which is worse than not colouring it.
	 */
	const BY_EXTENSION: Record<string, string> = {
		ts: 'typescript',
		tsx: 'typescript',
		mts: 'typescript',
		cts: 'typescript',
		js: 'javascript',
		mjs: 'javascript',
		cjs: 'javascript',
		jsx: 'javascript',
		json: 'json',
		jsonc: 'json',
		go: 'go',
		py: 'python',
		sh: 'bash',
		bash: 'bash',
		zsh: 'shell',
		fish: 'shell',
		sql: 'sql',
		css: 'css',
		scss: 'css',
		html: 'xml',
		xml: 'xml',
		svg: 'xml',
		svelte: 'xml',
		vue: 'xml',
		md: 'markdown',
		markdown: 'markdown',
		yml: 'yaml',
		yaml: 'yaml',
		toml: 'ini',
		ini: 'ini',
		env: 'ini',
		diff: 'diff',
		patch: 'diff',
	};

	/** Files with no extension that are still worth colouring. */
	const BY_NAME: Record<string, string> = {
		dockerfile: 'bash',
		makefile: 'bash',
		'.gitignore': 'bash',
		'.dockerignore': 'bash',
	};

	function grammarFor(path: string): string | null {
		const name = (path.split('/').pop() ?? '').toLowerCase();
		if (BY_NAME[name]) return BY_NAME[name] as string;
		const dot = name.lastIndexOf('.');
		if (dot <= 0) return null;
		return BY_EXTENSION[name.slice(dot + 1)] ?? null;
	}

	interface BlobInput {
		path: string;
		lines?: readonly string[];
		binary?: boolean;
		truncated?: boolean;
		bytes?: number;
		error?: string | null;
	}

	interface Props {
		blob?: BlobInput | null;
		loading?: boolean;
		/** Set when the answer is not coming — an agent too old, or one not replying. */
		unavailable?: boolean;
		t?: Translate;
	}

	let { blob = null, loading = false, unavailable = false, t }: Props = $props();
	const tr = $derived(translator(t));

	const code = $derived((blob?.lines ?? []).join('\n'));
	const grammar = $derived(blob ? grammarFor(blob.path) : null);

	/**
	 * ⚠ THE WHOLE FILE IS HIGHLIGHTED AT ONCE, NOT LINE BY LINE. A block comment or a
	 * template literal spans lines, and highlighting each line on its own restarts the
	 * grammar at every newline — the second line of every `/* … *\/` comes back as
	 * code. The line numbers therefore live in their own column rather than being
	 * interleaved, which is also what keeps them out of a copy.
	 */
	const marked = $derived.by(() => {
		if (!blob || blob.binary) return '';
		if (!grammar) return escapeHtml(code);
		try {
			// `ignoreIllegals` because a truncated file ends mid-token by construction,
			// and "this file is cut off" must not read as "this file is broken".
			return hljs.highlight(code, { language: grammar, ignoreIllegals: true }).value;
		} catch {
			return escapeHtml(code);
		}
	});
	const lineNumbers = $derived((blob?.lines ?? []).map((_, index) => index + 1).join('\n'));

	/** The fallback path, and the reason `{@html}` below is safe on it too. */
	function escapeHtml(text: string): string {
		return text
			.replaceAll('&', '&amp;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;')
			.replaceAll('"', '&quot;');
	}
</script>

{#if loading}
	<p class="pdmux-meta" data-pdmux-blob-state="loading">{tr('pdmux.blob.loading', 'Reading the file…')}</p>
{:else if unavailable}
	<!-- ⚠ A SENTENCE, NOT A SPINNER. The commonest cause is an agent too old to know
	     the frame at all: it logs the message and keeps its socket, so waiting is
	     waiting for something that is never coming. -->
	<p class="pdmux-meta" data-pdmux-blob-state="unavailable">
		{tr('pdmux.blob.unavailable', 'This host’s agent cannot read file contents yet — update it to use this view')}
	</p>
{:else if !blob}
	<!-- ⚠ NOTHING, ON PURPOSE. An empty pane beside a list of files already reads as
	     "pick one"; a sentence saying so is a line of prose the reader has to
	     dismiss every time they open the face, and it was asked to go. -->
{:else if blob.error}
	<p class="pdmux-meta" data-pdmux-blob-state="error">{blob.error}</p>
{:else if blob.binary}
	<p class="pdmux-meta" data-pdmux-blob-state="binary">
		{tr('pdmux.blob.binary', 'Binary file — contents are not shown')}
	</p>
{:else}
	<div class="pdmux-blob" data-pdmux-blob={blob.path} data-pdmux-blob-lang={grammar ?? 'text'}>
		<!-- ⚠ TWO COLUMNS, NOT INTERLEAVED NUMBERS. The numbers cannot sit inside the
		     highlighted markup without splitting it per line, which breaks every
		     construct that spans lines. In their own column they also stay out of a
		     copied selection, and they do not scroll sideways with long code.
		     ⚠ NO WHITESPACE BETWEEN THESE TAGS: inside a `pre` every newline in the
		     markup is a newline on screen — one stray one doubled every file's line
		     spacing once already. -->
		<pre class="pdmux-blob-gutter" aria-hidden="true">{lineNumbers}</pre>
		<!-- ⚠ NOT `.pdmux-patch`. That class makes every child `span` a BLOCK, because a
		     diff renders one span per line — and the highlighter emits a span per TOKEN,
		     so `import`, `{`, `Type` and every comma each landed on a line of their own.
		     This column carries its own type and spacing instead. -->
		<pre class="pdmux-blob-code hljs">{@html marked}</pre>
		{#if blob.truncated}
			<p class="pdmux-meta" data-pdmux-blob-truncated>
				{tr('pdmux.blob.truncated', 'Shown up to the size cap — the rest is not included')}
			</p>
		{/if}
	</div>
{/if}
