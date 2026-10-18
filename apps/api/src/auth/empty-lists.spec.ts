import { describe, expect, it } from "bun:test";
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from "kysely";
import type { DatabaseProviderName } from "@podosoft/podokit-runtime";
import { PROVIDERS } from "../config/providers";
import { postgresAuthQueries } from "./db";
import { EmptyListPlugin } from "./empty-lists";

function databaseProvider(): DatabaseProviderName {
  return PROVIDERS.database;
}

// A type alias, not an interface: withTables() needs an index signature.
type Tables = {
  user: { id: string; email: string };
};

const db = new Kysely<Tables>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (kysely) => new PostgresIntrospector(kysely),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
  plugins: [new EmptyListPlugin()],
});

describe("empty lists in authentication queries", () => {
  it("sends an empty in list as a condition that never holds", () => {
    const query = db.selectFrom("user").selectAll().where("id", "in", []).limit(0).compile();
    expect(query.sql).toBe('select * from "user" where 1 = 0 limit $1');
    expect(query.parameters).toEqual([0]);
  });

  it("sends an empty not in list as a condition that always holds", () => {
    const query = db
      .selectFrom("user")
      .select("id")
      .where("email", "=", "a@example.com")
      .where("id", "not in", [])
      .compile();
    expect(query.sql).toBe('select "id" from "user" where "email" = $1 and 1 = 1');
    expect(query.parameters).toEqual(["a@example.com"]);
  });

  it("leaves lists with values and other operators as they are", () => {
    const query = db
      .deleteFrom("user")
      .where((eb) => eb.or([eb("id", "in", ["a", "b"]), eb("email", "=", "c@example.com")]))
      .compile();
    expect(query.sql).toBe('delete from "user" where ("id" in ($1, $2) or "email" = $3)');
    expect(query.parameters).toEqual(["a", "b", "c@example.com"]);
  });

  it("applies to the queries Better Auth sends to PostgreSQL", () => {
    if (databaseProvider() !== "postgres") {
      expect(postgresAuthQueries).toBeNull();
      return;
    }
    const query = postgresAuthQueries
      ?.withTables<Tables>()
      .selectFrom("user")
      .selectAll()
      .where("id", "in", [])
      .compile();
    expect(query?.sql).toBe('select * from "user" where 1 = 0');
  });
});
