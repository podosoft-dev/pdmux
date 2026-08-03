import type { APIRequestContext } from "@playwright/test";

/**
 * Reading and restoring the dashboard layout a spec is about to rearrange.
 *
 * WHY A HELPER: which cell holds which session IS the behaviour several pdmux specs test, so
 * they have to write this document — and it is the same document the account's other devices
 * read ("my 4-split became a 9-split", reported twice). Every such spec therefore has to save
 * and put back, and two of them had grown their own copy of these four calls.
 *
 * ⚠ `writeLayout(request, saved)` with the value from `readLayout` is the restore step; call
 * it in a `finally`, so a failing assertion still hands the layout back.
 */
export interface SavedLayout {
	name: string;
	payload: Record<string, unknown>;
	isDefault: boolean;
}

export async function readLayout(request: APIRequestContext): Promise<SavedLayout | null> {
	const response = await request.get("/api/prefs");
	if (!response.ok()) return null;
	const prefs = (await response.json()) as { layouts?: SavedLayout[] };
	const layout = prefs.layouts?.find((entry) => entry.isDefault) ?? prefs.layouts?.[0];
	return layout ? { name: layout.name, payload: layout.payload, isDefault: layout.isDefault ?? true } : null;
}

export async function writeLayout(request: APIRequestContext, saved: SavedLayout | null): Promise<void> {
	if (!saved) return;
	await request.put(`/api/prefs/layouts/${encodeURIComponent(saved.name)}`, {
		data: { payload: saved.payload, isDefault: saved.isDefault },
	});
}

/** One slot in the grid, as the layout document stores it. */
export interface SeedSlot {
	id: string;
	hostId: string;
	kind: "attach" | "new" | "shell";
	session: string | null;
}

/**
 * Put exactly one pane on screen, focused, and keep the name of the layout it replaced.
 *
 * FOCUSED ON PURPOSE: an unfocused pane wears the click guard, which is a button covering the
 * whole surface — a spec that means to touch the TERMINAL would be touching that instead. The
 * guard's own behaviour is TC-PDTERM-126's subject, not every caller's.
 */
export async function seedSoloPane(
	request: APIRequestContext,
	saved: SavedLayout | null,
	slot: SeedSlot,
): Promise<void> {
	await writeLayout(request, {
		name: saved?.name ?? "default",
		payload: { mode: "split4", page: 0, slots: [slot], focusId: slot.id, zoomId: null },
		isDefault: true,
	});
}
