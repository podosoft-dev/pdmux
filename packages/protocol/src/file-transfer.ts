import { z } from 'zod';

export const FILE_TRANSFER_CAPABILITY = 'files-transfer-v1';
export const FILE_TRANSFER_CHUNK_BYTES = 1_048_576;
export const FILE_TRANSFER_MAX_ENTRIES = 10_000;
export const FILE_TRANSFER_MAX_BYTES = 10 * 1024 ** 3;
export const FILE_TRANSFER_TTL_MS = 24 * 60 * 60 * 1000;

export const fsTransferEntrySchema = z.object({
	path: z.string().max(1024),
	kind: z.enum(['file', 'directory', 'link', 'special', 'missing']),
	size: z.number().int().nonnegative().default(0),
	modified: z.string().max(64).default(''),
});

/** A bounded, correlated operation; paths are always relative to the agent home. */
export const fsTransferRequestSchema = z.object({
	requestId: z.string().uuid(),
	transferId: z.string().uuid(),
	entryId: z.string().uuid(),
	action: z.enum(['list', 'stat', 'mkdir', 'read', 'write', 'commit', 'discard', 'touch']),
	path: z.string().max(1024),
	offset: z.number().int().nonnegative().default(0),
	size: z.number().int().nonnegative().max(FILE_TRANSFER_MAX_BYTES).default(0),
	data: z.string().max(2 * FILE_TRANSFER_CHUNK_BYTES).default(''),
	digest: z.string().max(64).default(''),
	modified: z.string().max(64).default(''),
	replace: z.boolean().default(false),
});

export const fsTransferResultSchema = z.object({
	requestId: z.string().uuid(),
	transferId: z.string().uuid(),
	entryId: z.string().uuid(),
	entries: z.array(fsTransferEntrySchema).max(250).default([]),
	next: z.number().int().nonnegative().nullable().default(null),
	offset: z.number().int().nonnegative().default(0),
	committed: z.boolean().default(false),
	data: z.string().max(2 * FILE_TRANSFER_CHUNK_BYTES).default(''),
	digest: z.string().max(64).default(''),
	error: z.string().max(128).nullable().default(null),
});

export type FsTransferEntry = z.infer<typeof fsTransferEntrySchema>;
export type FsTransferRequest = z.infer<typeof fsTransferRequestSchema>;
export type FsTransferResult = z.infer<typeof fsTransferResultSchema>;

export type FileTransferState = 'draft' | 'queued' | 'running' | 'paused' | 'ready' | 'completed' | 'failed' | 'cancelled' | 'expired';
export interface FileTransferManifestEntry {
	id: string;
	path: string;
	kind: 'file' | 'directory';
	size: number;
	fingerprint: string;
	modified: string;
}
export interface FileTransferEntryView extends FileTransferManifestEntry {
	offset: number;
	state: 'pending' | 'committed' | 'skipped';
	replace: boolean;
}
export interface FileTransferView {
	id: string;
	hostId: string;
	direction: 'upload' | 'download';
	basePath: string;
	state: FileTransferState;
	bytes: number;
	totalBytes: number;
	completedEntries: number;
	totalEntries: number;
	currentPath: string;
	errorCode: string;
	exclusions: string[];
	archiveBytes: number;
	updated: number;
	created: number;
}
