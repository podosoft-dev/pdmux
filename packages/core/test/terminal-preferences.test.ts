import { describe, expect, it } from 'vitest';
import { DEFAULT_TERMINAL_PREFERENCES, parseTerminalPreferences } from '../src/terminal-preferences.js';

describe('[TC-PDDESKTOP-025] device terminal preferences', () => {
	it('preserves the existing terminal defaults and trims a custom font name', () => {
		expect(parseTerminalPreferences(DEFAULT_TERMINAL_PREFERENCES)).toEqual(DEFAULT_TERMINAL_PREFERENCES);
		expect(parseTerminalPreferences({ ...DEFAULT_TERMINAL_PREFERENCES, fontFamily: '  Menlo  ', fontSize: 18, lineHeight: 1.4, theme: 'light', cursorStyle: 'bar', cursorBlink: false })).toEqual({ fontFamily: 'Menlo', fontSize: 18, lineHeight: 1.4, theme: 'light', cursorStyle: 'bar', cursorBlink: false });
	});
	const invalid: Record<string, unknown>[] = [
		{ fontFamily: '' }, { fontFamily: 'a'.repeat(121) }, { fontFamily: 'Menlo\n' },
		{ fontSize: 0 }, { fontSize: 33 }, { fontSize: 14.5 }, { fontSize: '14' },
		{ lineHeight: NaN }, { lineHeight: 0.9 }, { lineHeight: 2.1 },
		{ theme: 'unknown' }, { cursorStyle: 'unknown' }, { cursorBlink: 'false' }, { toString: 'unknown' },
	];
	it.each(invalid)('rejects an invalid setting without normalizing it silently: %j', change => {
		expect(() => parseTerminalPreferences({ ...DEFAULT_TERMINAL_PREFERENCES, ...change })).toThrow();
	});
});
