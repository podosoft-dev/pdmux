/**
 * How a listing prints the numbers a host reported.
 *
 * ⚠ THESE ARE FORMATS, NOT SENTENCES. `time.ts` explains the line: this package
 * never owns user-facing prose, because a consumer cannot translate it. A byte
 * count and a POSIX mode are not prose — `rw-r--r--` reads the same in every
 * language — so they belong here, while anything a person would translate stays a
 * prop (`GitGraph`'s `formatDate` is the pattern).
 *
 * ⚠ AND `0` IS NOT ALWAYS ZERO. `modified` and `mode` arrive as `0` when the host
 * did not say — a stat that failed, or an agent older than the field. The contract
 * defines that (`fsEntry` in `@pdmux/protocol`), and a column that drew it as
 * 1970 or as `---------` would state something nobody measured.
 */

/** What a column shows when the host reported nothing. */
export const UNKNOWN_VALUE = '—';

/**
 * Bytes as a person reads them.
 *
 * ⚠ ONE IMPLEMENTATION, DELIBERATELY. There were two — `FileExplorer` counted up
 * to TB and dropped the decimal past 10, `RepoTreeView` stopped at MB and always
 * kept one — so the same file read as `1.4 GB` in one panel and `1433.6 MB` in the
 * other. Two answers to one question is how a product gets caught disagreeing with
 * itself.
 */
export function humanSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return UNKNOWN_VALUE;
	if (bytes < 1024) return `${Math.round(bytes)} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Permission bits as `ls` writes them: `rwxr-xr-x`.
 *
 * ⚠ NINE CHARACTERS, NO TYPE PREFIX. `ls` puts a `d` or an `l` in front, and this
 * does not: the row already says whether the entry is a directory or a link, in
 * its own column and with its own icon, and repeating it here would spend a
 * character of a narrow column on a fact stated twice.
 *
 * Only the low nine bits are read. setuid/setgid/sticky are not carried by the
 * agent — see `agent/internal/fs/fs.go` for why — so nothing here invents them.
 */
export function modeLabel(mode: number): string {
	if (!Number.isInteger(mode) || mode <= 0) return UNKNOWN_VALUE;
	const bits = mode & 0o777;
	let out = '';
	for (let shift = 6; shift >= 0; shift -= 3) {
		const triad = (bits >> shift) & 0o7;
		out += triad & 0b100 ? 'r' : '-';
		out += triad & 0b010 ? 'w' : '-';
		out += triad & 0b001 ? 'x' : '-';
	}
	return out;
}
