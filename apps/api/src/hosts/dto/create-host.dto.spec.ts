import { describe, expect, it } from "bun:test";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { CreateHostDto } from "./create-host.dto";
import { ReorderHostsDto } from "./reorder-hosts.dto";

function errorsFor(input: Record<string, unknown>): string[] {
  const dto = plainToInstance(CreateHostDto, input);
  return validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).map((e) => e.property);
}

describe("[TC-PDHOST-003] host label validation", () => {
  it("accepts a normal label and trims surrounding whitespace", () => {
    const dto = plainToInstance(CreateHostDto, { label: "  build-01  " });
    expect(validateSync(dto)).toHaveLength(0);
    expect(dto.label).toBe("build-01");
  });

  it("rejects an empty, whitespace-only or over-long label", () => {
    expect(errorsFor({ label: "" })).toContain("label");
    // Trimmed to "" — a label of spaces is invisible in the sidebar.
    expect(errorsFor({ label: "   " })).toContain("label");
    expect(errorsFor({ label: "x".repeat(65) })).toContain("label");
    expect(errorsFor({})).toContain("label");
  });

  it("rejects non-string labels and unknown fields", () => {
    expect(errorsFor({ label: 42 })).toContain("label");
    expect(errorsFor({ label: "ok", organizationId: "org-b" })).toContain("organizationId");
  });

  it("requires a non-empty uuid list to reorder", () => {
    const empty = plainToInstance(ReorderHostsDto, { ids: [] });
    expect(validateSync(empty).length).toBeGreaterThan(0);
    const bad = plainToInstance(ReorderHostsDto, { ids: ["not-a-uuid"] });
    expect(validateSync(bad).length).toBeGreaterThan(0);
  });
});
