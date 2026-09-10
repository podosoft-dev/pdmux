/** Browser-safe transfer constants: importing limits must not construct agent schemas. */
export const FILE_TRANSFER_CAPABILITY = 'files-transfer-v1';
export const FILE_TRANSFER_CHUNK_BYTES = 1_048_576;
export const FILE_TRANSFER_MAX_ENTRIES = 10_000;
export const FILE_TRANSFER_MAX_BYTES = 10 * 1024 ** 3;
export const FILE_TRANSFER_TTL_MS = 24 * 60 * 60 * 1000;

export type { FileTransferEntryView, FileTransferManifestEntry, FileTransferState, FileTransferView } from './file-transfer.js';
