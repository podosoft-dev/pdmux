import { randomUUID } from "node:crypto";
import { FindOperator, type Repository } from "typeorm";

/**
 * An in-memory stand-in for a TypeORM repository, for unit tests.
 *
 * WHY IT EXISTS: the rules worth testing here are about *rows* — org A must not
 * see org B's host, a re-sent commit detail must not be rewritten, a prune must
 * only take the old rows. Mocking `findOne` to return a canned object proves the
 * code called a mock; keeping real rows in a Map proves the behaviour. It
 * implements only the subset the services use, and throws on anything else so a
 * silently unsupported query cannot make a test pass.
 */

type Row = Record<string, unknown> & { id?: string };

function compareValues(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : -1;
  if (b === null || b === undefined) return 1;
  return String(a).localeCompare(String(b));
}

function equals(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

function matchOperator(operator: FindOperator<unknown>, value: unknown): boolean {
  const operand = operator.value as unknown;
  switch (operator.type) {
    case "in":
      return Array.isArray(operand) && operand.some((candidate) => equals(candidate, value));
    case "lessThan":
      return compareValues(value, operand) < 0;
    case "moreThan":
      return compareValues(value, operand) > 0;
    case "between": {
      const [from, to] = operator.value as [unknown, unknown];
      return compareValues(value, from) >= 0 && compareValues(value, to) <= 0;
    }
    case "not": {
      // ⚠ A COMPOSITE LIKE `Not(In([...]))` HAS TO BE READ FROM `child`. TypeORM's
      // `value` getter deliberately UNWRAPS a nested operator and returns the inner
      // operand, so `operator.value instanceof FindOperator` is never true and the
      // negation silently degraded to comparing an array against one row's scalar —
      // which is unequal for every row, i.e. a `NOT IN` that matched everything.
      const child = operator.child as FindOperator<unknown> | undefined;
      return child ? !matchOperator(child, value) : !equals(operand, value);
    }
    case "isNull":
      return value === null || value === undefined;
    default:
      throw new Error(`FakeRepository: unsupported find operator "${operator.type}"`);
  }
}

function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (condition === undefined) continue;
    const value = row[key];
    if (condition instanceof FindOperator) {
      if (!matchOperator(condition as FindOperator<unknown>, value)) return false;
    } else if (!equals(condition, value)) {
      return false;
    }
  }
  return true;
}

/**
 * `"ASC"` / `"DESC"`, or the object form when the query pins NULL placement.
 *
 * Postgres decides where NULLs go by direction (ASC = last, DESC = first) and this
 * class historically sorted them the other way round. Rather than change what every
 * existing order does, an EXPLICIT `nulls` is honoured exactly as SQL would place
 * it — so a query that cares says so, in the query, in both worlds.
 */
type OrderValue = "ASC" | "DESC" | { direction?: "ASC" | "DESC"; nulls?: "FIRST" | "LAST" };

interface FindArgs {
  where?: Record<string, unknown> | Record<string, unknown>[];
  order?: Record<string, OrderValue>;
  take?: number;
  select?: unknown;
}

function isNullish(value: unknown): boolean {
  return value === null || value === undefined;
}

export class FakeRepository<T extends object> {
  readonly rows: Row[] = [];

  /** `defaults` mirrors the column defaults the real schema applies on insert. */
  constructor(private readonly defaults: Partial<Row> = {}) {}

  create(input: Partial<T> | Partial<T>[]): T {
    // Nest services call create() with one object in this codebase.
    return { ...this.defaults, ...(input as Row) } as unknown as T;
  }

  async save<E extends Partial<T> | Partial<T>[]>(input: E): Promise<E> {
    const list = Array.isArray(input) ? input : [input];
    const saved = list.map((entity) => this.saveOne(entity as Row));
    return (Array.isArray(input) ? saved : saved[0]) as E;
  }

  private saveOne(entity: Row): Row {
    const withId = entity.id ? entity : Object.assign(entity, { id: randomUUID() });
    const existing = this.rows.find((row) => row.id === withId.id);
    if (existing) {
      Object.assign(existing, withId);
      return existing;
    }
    const row = { ...this.defaults, ...withId } as Row;
    this.rows.push(row);
    return row;
  }

  async find(args: FindArgs = {}): Promise<T[]> {
    let result = this.rows.filter((row) => this.whereMatches(row, args.where));
    if (args.order) result = this.sort(result, args.order);
    if (typeof args.take === "number") result = result.slice(0, args.take);
    return result as unknown as T[];
  }

  async findOne(args: FindArgs): Promise<T | null> {
    const found = await this.find(args);
    return found[0] ?? null;
  }

  async count(args: FindArgs = {}): Promise<number> {
    return (await this.find(args)).length;
  }

  async update(criteria: Record<string, unknown>, patch: Partial<T>): Promise<{ affected: number }> {
    const targets = this.rows.filter((row) => matches(row, criteria));
    for (const row of targets) Object.assign(row, patch);
    return { affected: targets.length };
  }

  async upsert(
    entity: Partial<T> | Partial<T>[],
    conflictPaths: string[],
  ): Promise<{ affected: number }> {
    const list = Array.isArray(entity) ? entity : [entity];
    for (const item of list) {
      const row = item as Row;
      const where: Record<string, unknown> = {};
      for (const path of conflictPaths) where[path] = row[path];
      const existing = this.rows.find((candidate) => matches(candidate, where));
      if (existing) Object.assign(existing, row);
      else this.rows.push({ ...this.defaults, id: randomUUID(), ...row });
    }
    return { affected: list.length };
  }

  async delete(criteria: Record<string, unknown>): Promise<{ affected: number }> {
    const keep = this.rows.filter((row) => !matches(row, criteria));
    const affected = this.rows.length - keep.length;
    this.rows.length = 0;
    this.rows.push(...keep);
    return { affected };
  }

  /** Hand to a service constructor: the shape is compatible for what it calls. */
  asRepository(): Repository<T> {
    return this as unknown as Repository<T>;
  }

  private whereMatches(row: Row, where: FindArgs["where"]): boolean {
    if (!where) return true;
    if (Array.isArray(where)) return where.some((clause) => matches(row, clause));
    return matches(row, where);
  }

  private sort(rows: Row[], order: Record<string, OrderValue>): Row[] {
    const entries = Object.entries(order);
    return [...rows].sort((left, right) => {
      for (const [key, value] of entries) {
        const spec = typeof value === "string" ? { direction: value } : value;
        const direction = spec.direction ?? "ASC";
        const nulls = spec.nulls;
        if (nulls) {
          const leftNull = isNullish(left[key]);
          const rightNull = isNullish(right[key]);
          if (leftNull !== rightNull) return (leftNull ? 1 : -1) * (nulls === "LAST" ? 1 : -1);
          if (leftNull) continue; // both null: this key decides nothing
        }
        const delta = compareValues(left[key], right[key]);
        if (delta !== 0) return direction === "DESC" ? -delta : delta;
      }
      return 0;
    });
  }
}
