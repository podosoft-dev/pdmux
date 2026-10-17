import { createRawSnippet } from "svelte";
import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import DataTable, { type DataTableColumn, type DataTableRowContext } from "./data-table.svelte";

type Row = { name: string };

const row = createRawSnippet<[Row, DataTableRowContext]>((item) => ({
  render: () => `<td>${item().name}</td><td></td>`,
}));

describe("DataTable", () => {
  it("renders a column's header snippet in place of its label and sort button", () => {
    const head = createRawSnippet(() => ({ render: () => '<input type="checkbox" aria-label="Select all rows">' }));
    const columns: DataTableColumn<Row>[] = [
      { key: "name", label: "Name", sortable: true },
      { key: "selected", label: "Selected", head, sortable: true },
    ];

    const { body } = render(DataTable<Row>, { props: { columns, rows: [{ name: "Ada" }], row, perPage: 0 } });

    const headers = body.match(/<th\b[\s\S]*?<\/th>/g) ?? [];
    expect(headers).toHaveLength(2);
    expect(headers[0]).toContain("Name");
    expect(headers[0]).toContain("<button");
    expect(headers[1]).toContain('aria-label="Select all rows"');
    expect(headers[1]).not.toContain("Selected");
    expect(headers[1]).not.toContain("<button");
  });
});
