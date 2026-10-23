/** Compatibility for C-quoted headers stored by older patch collectors. */
function quotedPath(input: string): { value: string; end: number } | null {
	if (!input.startsWith('"')) return null;
	const bytes: number[] = [];
	const encoder = new TextEncoder();
	const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
	for (let index = 1; index < input.length; index++) {
		const char = input[index]!;
		if (char === '"') {
			try { return { value: new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes)), end: index + 1 }; }
			catch { return null; }
		}
		if (char === '\\') {
			const escape = input[++index];
			if (escape === undefined) return null;
			if (/[0-7]/.test(escape)) {
				const octal = input.slice(index, index + 3);
				if (!/^[0-7]{3}$/.test(octal)) return null;
				const byte = Number.parseInt(octal, 8);
				if (byte === 0 || byte > 255) return null;
				bytes.push(byte); index += 2;
			} else {
				const byte = escapes[escape];
				if (byte === undefined) return null;
				bytes.push(byte);
			}
		} else {
			const point = input.codePointAt(index)!;
			bytes.push(...encoder.encode(String.fromCodePoint(point)));
			if (point > 0xffff) index++;
		}
	}
	return null;
}

function quotedHeader(body: string): { old: string; path: string } | null {
	const first = quotedPath(body);
	const delimiter = first ? first.end : body.indexOf(' "b/');
	if (delimiter < 0 || body[delimiter] !== ' ') return null;
	const old = first?.value ?? body.slice(0, delimiter);
	const rest = body.slice(delimiter + 1);
	const second = quotedPath(rest);
	if (rest.startsWith('"') && (!second || second.end !== rest.length)) return null;
	const path = second?.value ?? rest;
	if (!old.startsWith('a/') || !path.startsWith('b/')) return null;
	return { old: old.slice(2), path: path.slice(2) };
}

/**
 * Repair only the recognizable old collector format, not arbitrary filename escapes.
 * Valid names may contain literal backslashes and must never be decoded a second time.
 */
export function normalizeDiffFilePaths<T extends { path: string; oldPath?: string | null }>(file: T): T {
	if (file.path.startsWith('/') && file.path.includes(' "b/')) {
		const pair = quotedHeader('"a' + file.path);
		if (pair) return { ...file, path: pair.path, oldPath: pair.old === pair.path ? null : pair.old };
	}
	if (file.oldPath?.startsWith('/') && file.oldPath.endsWith('"')) {
		const old = quotedPath('"a' + file.oldPath);
		if (old && old.end === file.oldPath.length + 2 && old.value.startsWith('a/')) {
			return { ...file, oldPath: old.value.slice(2) };
		}
	}
	return file;
}
