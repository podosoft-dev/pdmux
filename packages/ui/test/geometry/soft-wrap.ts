/**
 * A real xterm.js fed one frame of a native session, exactly as the engine drew it
 * (`agent/internal/session/testdata/soft-wrap-frame.txt`, kept equal to the renderer by
 * `TestNativeSoftWrapGolden`). The size matches the view the frame was drawn for, and the
 * Unicode 11 widths match the product's terminal, so what this terminal records about soft
 * wraps is what a viewer's terminal records.
 */
import { Terminal } from '@xterm/xterm';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import frame from '../../../../agent/internal/session/testdata/soft-wrap-frame.txt?raw';

const term = new Terminal({ cols: 40, rows: 6, allowProposedApi: true });
term.loadAddon(new Unicode11Addon());
term.unicode.activeVersion = '11';
term.open(document.getElementById('term') as HTMLElement);
term.write(frame, () => {
	const buffer = term.buffer.active;
	const rows = Array.from({ length: term.rows }, (_, y) => {
		const line = buffer.getLine(y);
		return { text: line?.translateToString(true) ?? '', wrapped: line?.isWrapped ?? false };
	});
	Object.assign(window, {
		softWrap: {
			rows,
			buffer: buffer.type,
			baseY: buffer.baseY,
			selectRows: (from: number, to: number): string => {
				term.selectLines(from, to);
				return term.getSelection();
			},
			selection: (): string => term.getSelection(),
		},
	});
});
