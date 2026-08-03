import { describe, expect, it } from "@jest/globals";
import { stableTopoOrder } from "./commit-order";

/** `c("a", "b")` = commit a whose first parent is b. */
const c = (sha: string, ...parents: string[]): { sha: string; parents: string[] } => ({ sha, parents });
const shas = (rows: readonly { sha: string }[]): string[] => rows.map((row) => row.sha);

describe("stableTopoOrder", () => {
  it("[TC-PDGIT-012] leaves a window that is already in git order untouched", () => {
    // The `seq`-ordered case, which is every healthy repo: the pass must cost nothing
    // and change nothing, or it is not a safety net but a second opinion.
    const linear = [c("c1", "c2"), c("c2", "c3"), c("c3", "c4"), c("c4")];
    expect(shas(stableTopoOrder(linear))).toEqual(["c1", "c2", "c3", "c4"]);

    const merge = [c("m", "a2", "f1"), c("f1", "a1"), c("a2", "a1"), c("a1", "a0"), c("a0")];
    expect(shas(stableTopoOrder(merge))).toEqual(["m", "f1", "a2", "a1", "a0"]);
  });

  it("[TC-PDGIT-012] puts a parent handed over before its child back behind it", () => {
    // The measured defect: `seq` was NULL for every row of a repo the agent had stopped
    // reporting, so the read fell back to `date DESC` — and `1a0aad8`/`1d5a67e` share the
    // author second `2026-07-27 05:36:05`. The parent came back first and the graph drew
    // 48 of 54 rows on a phantom second lane.
    const transposed = [c("596195d", "1d5a67e"), c("1a0aad8", "dcaf8e3"), c("1d5a67e", "1a0aad8"), c("dcaf8e3")];
    expect(shas(stableTopoOrder(transposed))).toEqual(["596195d", "1d5a67e", "1a0aad8", "dcaf8e3"]);
  });

  it("[TC-PDGIT-012] does NOT flatten a genuine fork", () => {
    // The objection recorded against guarding inside `layoutGraph`, and the reason this
    // pass is safe where a naive re-sort is not: two tips of a fork are not
    // ancestor-related, so nothing orders them and their arrival order survives.
    const forkFirst = [c("x", "p"), c("y", "p"), c("p")];
    expect(shas(stableTopoOrder(forkFirst))).toEqual(["x", "y", "p"]);
    // Same fork, other tip first — the result must follow the input, not a canonical order.
    const forkOther = [c("y", "p"), c("x", "p"), c("p")];
    expect(shas(stableTopoOrder(forkOther))).toEqual(["y", "x", "p"]);
  });

  it("[TC-PDGIT-012] treats a parent outside the window as no constraint", () => {
    // History beyond the feed window is drawn as an `open` stub; it must not hold a row
    // back, or a truncated window would emit nothing at all.
    const truncated = [c("c1", "c2"), c("c2", "gone")];
    expect(shas(stableTopoOrder(truncated))).toEqual(["c1", "c2"]);
    expect(shas(stableTopoOrder([c("only", "gone")]))).toEqual(["only"]);
    expect(stableTopoOrder([])).toEqual([]);
  });

  it("[TC-PDGIT-012] returns every row it was given, even for impossible input", () => {
    // A cycle cannot come out of git, but dropping commits would be a worse failure than
    // an odd-looking graph — the unreachable remainder is appended in arrival order.
    const cycle = [c("a", "b"), c("b", "a"), c("z")];
    const out = stableTopoOrder(cycle);
    expect(out).toHaveLength(3);
    expect(shas(out).sort()).toEqual(["a", "b", "z"]);
    // A commit listing itself is absorbed rather than deadlocking on itself.
    expect(shas(stableTopoOrder([c("self", "self"), c("tail")]))).toEqual(["self", "tail"]);
  });

  it("[TC-PDGIT-012] does not mutate the array it was handed", () => {
    const input = [c("p", "q"), c("q")];
    const copy = [...input];
    stableTopoOrder(input);
    expect(input).toEqual(copy);
  });
});
