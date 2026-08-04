/**
 * What makes this package installable somewhere else.
 *
 * A UI package rots the moment one component reaches back into the application it
 * came from — an import of an app path, a global store, or a `fetch` of an endpoint
 * only that app serves. None of those show up in a rendering test, so they are
 * checked here against the sources.
 *
 * ⚠ THE BAN IS ON COUPLING, NOT ON DEPENDENCIES, and this file used to conflate the
 * two. The allowlist named four specifiers and refused everything else, which meant
 * an ordinary self-contained library was rejected for a reason that did not apply to
 * it — and the refusal read as principle because the rule was the only thing written
 * down. Measured cost: a syntax highlighter was argued about instead of installed.
 *
 * So the list below is explicit about the two things that ARE forbidden and why:
 *
 *  1. THE CONSUMING APPLICATION — `apps/*`, its stores, its routes. A component that
 *     imports one of those is this product's component, not a package.
 *  2. A DESIGN SYSTEM — shadcn/bits-ui/Tailwind plugins. This package is installed by
 *     projects that already have one; hard-coding ours would force every installer to
 *     adopt it. That is why the controls live in `apps/web` and this draws content.
 *
 * Anything else self-contained is allowed. The cost of a dependency is bundle size,
 * which is a judgement for the person adding it, not a structural violation.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src');

function walk(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) walk(full, out);
		else out.push(full);
	}
	return out;
}

const sources = walk(srcDir).filter((f) => f.endsWith('.svelte') || f.endsWith('.ts'));
const components = sources.filter((f) => f.endsWith('.svelte'));
const read = (file: string): string => readFileSync(file, 'utf8');
const rel = (file: string): string => file.slice(root.length + 1);

describe('[TC-PDUI-030] the package never reaches into an application', () => {
	it('imports neither the application nor a design system', () => {
		// The application, by any spelling. A relative path can climb out of the
		// package just as well as an alias can name it.
		const appCoupled = /^(apps\/|\$lib|\$app|@\/)/;
		// Design systems. Installing this package must not decide the installer's.
		const designSystems = /^(bits-ui|shadcn|@shadcn|tailwindcss|tailwind-|@tailwindcss)/;
		const offenders: string[] = [];
		for (const file of sources) {
			for (const match of read(file).matchAll(/from\s+['"]([^'"]+)['"]/g)) {
				const specifier = match[1] as string;
				if (specifier.startsWith('.')) {
					// ⚠ RELATIVE IS NOT AUTOMATICALLY SAFE. `../../../apps/web/...` resolves
					// out of this package entirely, which is the very thing being banned.
					if (specifier.includes('/apps/')) offenders.push(`${rel(file)} -> ${specifier}`);
					continue;
				}
				if (appCoupled.test(specifier)) offenders.push(`${rel(file)} -> ${specifier}`);
				if (designSystems.test(specifier)) offenders.push(`${rel(file)} -> ${specifier}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it('does not fetch, poll or read a global store', () => {
		const offenders: string[] = [];
		for (const file of sources) {
			const text = read(file);
			// Data arrives as props and actions leave as callbacks. A component that
			// fetched would tie the package to one server's routes.
			if (/\bfetch\s*\(/.test(text)) offenders.push(`${rel(file)}: fetch`);
			if (/\bXMLHttpRequest\b/.test(text)) offenders.push(`${rel(file)}: XMLHttpRequest`);
			if (/\bnew WebSocket\b/.test(text)) offenders.push(`${rel(file)}: WebSocket`);
			if (/from ['"]svelte\/store['"]/.test(text)) offenders.push(`${rel(file)}: svelte/store`);
			if (/\blocalStorage\b|\bsessionStorage\b/.test(text)) offenders.push(`${rel(file)}: web storage`);
		}
		expect(offenders).toEqual([]);
	});

	it('uses runes, never the legacy reactive label', () => {
		for (const file of components) {
			expect(read(file), rel(file)).not.toMatch(/^\s*\$:/m);
		}
	});

	it('exports every component from the entry point', () => {
		const index = read(join(srcDir, 'index.ts'));
		for (const file of components) {
			const name = file.split('/').pop() as string;
			expect(index, `${name} is not exported`).toContain(name);
		}
	});

	it('ships the structural stylesheet the components depend on', () => {
		// A mount host with no rule of its own broke a whole page once: the flex chain
		// stopped there and every box grew to its content height.
		const css = read(join(srcDir, 'styles.css'));
		for (const selector of ['.pdmux-shell', '.pdmux-grid', '.pdmux-graph-list', '.pdmux-detail', '.pdmux-sidebar']) {
			expect(css).toContain(selector);
		}
		expect(css).toMatch(/\.pdmux-graph-list\s*\{[^}]*overflow:\s*auto/s);
		expect(css).toMatch(/scrollbar-gutter:\s*stable/);
		const pkg = JSON.parse(read(join(root, 'package.json'))) as {
			exports: Record<string, unknown>;
			peerDependencies: Record<string, string>;
		};
		expect(pkg.exports['./styles.css']).toBe('./dist/styles.css');
		expect(pkg.peerDependencies.svelte).toBeDefined();
	});
});

describe('[TC-PDUI-171] the stylesheet and the code agree about the stack breakpoint', () => {
	/**
	 * `SHELL_STACK_MAX_WIDTH` decides in TypeScript when the app renders a single pane;
	 * the stylesheet stacks the shell and collapses the grid at the same width in CSS.
	 * The source comment has claimed for a while that "a package contract test compares
	 * the two" — this is that test, finally written, because one pixel of drift means
	 * the CSS shows a 3x3 grid the code believes is one cell.
	 */
	it('pins every media query to SHELL_STACK_MAX_WIDTH', async () => {
		const { SHELL_STACK_MAX_WIDTH } = await import('@pdmux/core');
		// Comments quote old rules as history ("this was a max-width: 640px rule…"),
		// so only the living declarations are measured.
		const css = read(join(srcDir, 'styles.css')).replace(/\/\*[\s\S]*?\*\//g, '');

		const wide = [...css.matchAll(/@media \(min-width: (\d+)px\)/g)].map((m) => Number(m[1]));
		const narrow = [...css.matchAll(/@media \(max-width: (\d+)px\)/g)].map((m) => Number(m[1]));

		expect(wide.length).toBeGreaterThan(0);
		for (const px of wide) expect(px).toBe(SHELL_STACK_MAX_WIDTH);
		// max-width queries sit on the other side of the same line.
		for (const px of narrow) expect(px).toBe(SHELL_STACK_MAX_WIDTH - 1);
	});
});
