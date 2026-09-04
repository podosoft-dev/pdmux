import { Database } from "bun:sqlite";

const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error("Source and destination paths are required");

const database = new Database(source, { readonly: false, strict: true });
try {
  database.run("PRAGMA wal_checkpoint(TRUNCATE)");
  database.run(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
} finally {
  database.close();
}
