import { describe, expect, it } from "vitest";
import { findCycleInComponent, tarjanScc } from "../src/core/graph";
import type { DependencyEdge } from "../src/core/types";

function edge(from: string, to: string, id: string): DependencyEdge {
  return { id, from, to, kind: "rw", reason: `${from} to ${to}` };
}

describe("graph utilities", () => {
  it("finds strongly connected components", () => {
    const edges = [edge("A", "B", "e1"), edge("B", "A", "e2"), edge("B", "C", "e3")];
    const components = tarjanScc({ nodes: ["A", "B", "C"], edges });
    expect(components.map((component) => component.sort()).sort()).toEqual([["A", "B"], ["C"]]);
  });

  it("extracts a concrete cycle from a component", () => {
    const edges = [edge("A", "B", "e1"), edge("B", "C", "e2"), edge("C", "A", "e3")];
    const cycle = findCycleInComponent(["A", "B", "C"], edges);
    expect(cycle?.map((candidate) => candidate.id)).toEqual(["e1", "e2", "e3"]);
  });
});
