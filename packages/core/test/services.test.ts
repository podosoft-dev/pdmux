/**
 * Service launcher options and the open guard.
 */
import { describe, expect, it } from 'vitest';
import { defaultServiceSelection, openTarget, serviceLabel, serviceOptionText, serviceOptions } from '../src/index.js';

describe('[TC-PDCORE-050] open only ever hands over an http(s) URL', () => {
	it('refuses a disabled select, an empty value and a non-http scheme', () => {
		expect(openTarget({ disabled: false, value: 'https://example.test/admin' })).toBe('https://example.test/admin');
		expect(openTarget({ disabled: false, value: 'http://127.0.0.1:5001' })).toBe('http://127.0.0.1:5001');
		// A disabled select means the host is unreachable: every URL on it is dead.
		expect(openTarget({ disabled: true, value: 'https://example.test/admin' })).toBeNull();
		expect(openTarget({ disabled: false, value: '' })).toBeNull();
		expect(openTarget(null)).toBeNull();
		expect(openTarget({ disabled: false, value: 'javascript:alert(1)' })).toBeNull();
	});
});

describe('[TC-PDCORE-051] the liveness glyph is rewritten, never stacked', () => {
	it('strips before it prefixes, so repeated refreshes are idempotent', () => {
		expect(serviceOptionText('admin', 'up')).toBe('● admin');
		expect(serviceOptionText('admin', 'down')).toBe('○ admin');
		expect(serviceOptionText('admin', undefined)).toBe('admin'); // unprobed shows nothing
		let text = 'admin';
		for (const status of ['up', 'up', 'down', undefined, 'up'] as const) text = serviceOptionText(text, status);
		expect(text).toBe('● admin');
		expect(serviceLabel('○ web')).toBe('web');
		expect(serviceLabel('web')).toBe('web');
		expect(serviceLabel(null)).toBe('');
	});
});

describe('[TC-PDCORE-052] the first live service is preselected', () => {
	it('builds options in registration order and picks the first that is up', () => {
		const options = serviceOptions([
			{ id: 'a', label: 'api', url: 'https://a.test', status: 'down' },
			{ id: 'b', label: '● web', url: 'https://b.test', status: 'up' },
			{ id: 'c', label: 'term', url: 'https://c.test' },
			{ id: 'bad' } as never,
		]);
		expect(options.map((o) => o.text)).toEqual(['○ api', '● web', 'term']);
		expect(options.map((o) => o.status)).toEqual(['down', 'up', 'unknown']);
		expect(defaultServiceSelection(options)).toBe('https://b.test');
		// Nothing up: the first option still gives the operator somewhere to go.
		expect(defaultServiceSelection(options.filter((o) => o.status !== 'up'))).toBe('https://a.test');
		expect(defaultServiceSelection([])).toBeNull();
		expect(serviceOptions(null as never)).toEqual([]);
	});
});
