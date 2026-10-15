import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The dark palette is written twice — once for the app's `.dark` class, once for the OS
 * when no class says otherwise — because CSS cannot OR a media query with a selector.
 * Two copies of one palette drift the first time somebody edits one of them, and a dark
 * rule added under the OS query alone brings back the defect the class fixed: a dark app
 * on a light OS painted with the light palette.
 */
const css = readFileSync(join(import.meta.dirname, '../src/styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const declarations = (body: string): Map<string, string> =>
	new Map(
		body
			.split(';')
			.map((line) => line.trim())
			.filter(Boolean)
			.map((line) => {
				const at = line.indexOf(':');
				return [line.slice(0, at).trim(), line.slice(at + 1).trim()] as [string, string];
			}),
	);

describe('[TC-PDUI-233] one dark palette, asked for by the app class or by the OS', () => {
	const byClass = /\.pdmux:where\(\.dark, \.dark \*\)\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
	const media = [...css.matchAll(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{/g)];
	const byOs = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*\.pdmux:where\(:not\(\.light, \.light \*\)\)\s*\{([^}]*)\}\s*\}/.exec(css)?.[1] ?? '';

	it('declares the same tokens with the same values in both blocks', () => {
		const one = declarations(byClass);
		const two = declarations(byOs);
		expect(one.size, 'the class block').toBeGreaterThanOrEqual(20);
		expect(Object.fromEntries(two)).toEqual(Object.fromEntries(one));
	});

	it('puts nothing else behind the OS query alone', () => {
		// One `@media (prefers-color-scheme: dark)`, holding only the mirror of the class block.
		expect(media).toHaveLength(1);
		expect(css).not.toMatch(/prefers-color-scheme:\s*light/);
	});

	it('keeps the class block unconditional and after the light block it overrides', () => {
		// The OS block steps aside under `.light`; the class block has no media condition.
		expect(byOs).not.toBe('');
		expect(css).toMatch(/\.pdmux:where\(\.dark, \.dark \*\)\s*\{/);
		const classAt = css.indexOf('.pdmux:where(.dark, .dark *)');
		const lightAt = css.search(/\n\.pdmux\s*\{/);
		// Same specificity as the light block, so they must come after it.
		expect(lightAt).toBeGreaterThanOrEqual(0);
		expect(classAt).toBeGreaterThan(lightAt);
	});
});
