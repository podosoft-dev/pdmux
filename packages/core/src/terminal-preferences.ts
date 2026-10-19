/** Device preferences, separate from host configuration and cloud synchronization. */
export interface TerminalPreferences {
	fontFamily: string;
	fontSize: number;
	lineHeight: number;
	theme: 'pdmux' | 'dracula' | 'light';
	cursorStyle: 'auto' | 'block' | 'bar' | 'underline';
	cursorBlink: boolean;
}

export const DEFAULT_TERMINAL_PREFERENCES: Readonly<TerminalPreferences> = {
	fontFamily: 'monospace', fontSize: 13, lineHeight: 1,
	theme: 'pdmux', cursorStyle: 'auto', cursorBlink: true,
};

export function parseTerminalPreferences(value: unknown): TerminalPreferences {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid terminal preferences');
	const row = value as Record<string, unknown>;
	if (Object.keys(row).some(key => !Object.hasOwn(DEFAULT_TERMINAL_PREFERENCES, key))) throw new Error('Unknown terminal preference');
	if (typeof row.fontFamily !== 'string' || !row.fontFamily.trim() || row.fontFamily.length > 120 || /[\x00-\x1f\x7f]/.test(row.fontFamily)) throw new Error('Invalid font family');
	if (typeof row.fontSize !== 'number' || !Number.isInteger(row.fontSize) || row.fontSize < 8 || row.fontSize > 32) throw new Error('Invalid font size');
	if (typeof row.lineHeight !== 'number' || !Number.isFinite(row.lineHeight) || row.lineHeight < 1 || row.lineHeight > 2) throw new Error('Invalid line height');
	if (row.theme !== 'pdmux' && row.theme !== 'dracula' && row.theme !== 'light') throw new Error('Invalid terminal theme');
	if (row.cursorStyle !== 'auto' && row.cursorStyle !== 'block' && row.cursorStyle !== 'bar' && row.cursorStyle !== 'underline') throw new Error('Invalid cursor style');
	if (typeof row.cursorBlink !== 'boolean') throw new Error('Invalid cursor blink');
	return { fontFamily: row.fontFamily.trim(), fontSize: row.fontSize, lineHeight: row.lineHeight, theme: row.theme, cursorStyle: row.cursorStyle, cursorBlink: row.cursorBlink };
}
