export * from "../../runtime/local-jobs";

// A desktop bundle cannot silently select an external queue backend.
export function superviseBullMqJobs(): never { throw new Error("The desktop runtime requires local jobs"); }
