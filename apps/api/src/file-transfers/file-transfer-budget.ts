import type { RateLimitRoute } from "@podosoft/podokit-runtime";

/**
 * The request budget of every transfer route, under any host.
 *
 * An upload sends its requests one at a time: two per 1 MiB chunk (the chunk and
 * a progress read) and three more per file. Sharing the general budget (300 a
 * minute in production) refused a large upload partway through, so transfers get
 * 6,000 a minute per caller: about 50 MiB/s of large files, or 20 small files a
 * second. The client still waits out a 429 and resumes (docs/FILE-TRANSFERS.md).
 */
export const FILE_TRANSFER_BUDGET: RateLimitRoute = {
  pathPrefix: "/hosts/:hostId/file-transfers",
  profile: { name: "file-transfers", limit: 6_000, ttlSeconds: 60 },
};
