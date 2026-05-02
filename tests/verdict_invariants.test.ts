import { describe, expect, it } from "vitest";
import { analyzeHistory } from "../src/core/analyzer";
import type { AnalysisResult, History, IsolationVerdict } from "../src/core/types";
import staleReadStrict from "../fixtures/stale_read_strict.json";
import writeSkewDoctors from "../fixtures/write_skew_doctors.json";

describe("verdict invariant families", () => {
  it("keeps write-skew verdicts stable across fixture transaction-order permutations", () => {
    const baseline = verdictProjection(analyzeHistory(writeSkewDoctors as History));
    expect(baseline.anomaly.label).toBe("write-skew");
    expect(baseline.evidence.edgeKinds).toEqual(["rw", "rw"]);

    for (const order of permutations(["T1", "T2"])) {
      const variant = orderTransactions(writeSkewDoctors as History, ["T0", ...order]);
      expect(verdictProjection(analyzeHistory(variant))).toEqual(baseline);
    }
  });

  it("keeps strict stale-read verdicts stable across fixture transaction-order permutations", () => {
    const baseline = verdictProjection(analyzeHistory(staleReadStrict as History, { strict: true }));
    expect(baseline.anomaly.label).toBe("strict-stale-read");
    expect(baseline.serializable.status).toBe("pass");
    expect(baseline.strictSerializable.status).toBe("fail");
    expect(baseline.evidence.edgeKinds).toEqual(["rt", "rw"]);

    for (const order of permutations(["T1", "T2"])) {
      const variant = orderTransactions(staleReadStrict as History, ["T0", ...order]);
      expect(verdictProjection(analyzeHistory(variant, { strict: true }))).toEqual(baseline);
    }
  });

  it("keeps write-skew proof shape canonical across transaction ID permutations", () => {
    const idMaps = [
      { T1: "T1", T2: "T2" },
      { T1: "T2", T2: "T1" },
      { T1: "doctor-b", T2: "doctor-a" },
    ];

    for (const idMap of idMaps) {
      const result = analyzeHistory(renameTransactions(writeSkewDoctors as History, idMap));
      const expectedIds = [idMap.T1, idMap.T2].sort((a, b) => a.localeCompare(b));
      expect(result.verdict.anomaly.label).toBe("write-skew");
      expect(result.verdict.implicatedTransactions).toEqual(expectedIds);
      expect(result.verdict.evidence.edgeKinds).toEqual(["rw", "rw"]);
      expect(proofEdgeShape(result)).toEqual([`rw:${expectedIds[0]}->${expectedIds[1]}`, `rw:${expectedIds[1]}->${expectedIds[0]}`]);
    }
  });

  it("keeps generic dependency-cycle verdicts stable across fixture transaction-order permutations", () => {
    const baselineHistory = genericDependencyCycleHistory();
    const baseline = verdictProjection(analyzeHistory(baselineHistory));
    expect(baseline.anomaly.label).toBe("dependency-cycle");
    expect(baseline.implicatedTransactions).toEqual(["T1", "T2", "T3"]);
    expect(baseline.evidence.edgeKinds).toEqual(["rw", "rw", "rw"]);

    for (const order of permutations(["T1", "T2", "T3"])) {
      const variant = orderTransactions(baselineHistory, ["T0", ...order]);
      expect(verdictProjection(analyzeHistory(variant))).toEqual(baseline);
    }
  });

  it("keeps generic dependency-cycle proof shape canonical across transaction ID permutations", () => {
    const result = analyzeHistory(
      renameTransactions(genericDependencyCycleHistory(), {
        T1: "tx-c",
        T2: "tx-a",
        T3: "tx-b",
      }),
    );

    expect(result.verdict.anomaly.label).toBe("dependency-cycle");
    expect(result.verdict.implicatedTransactions).toEqual(["tx-a", "tx-b", "tx-c"]);
    expect(result.verdict.evidence.edgeKinds).toEqual(["rw", "rw", "rw"]);
    expect(proofEdgeShape(result)).toEqual(["rw:tx-a->tx-b", "rw:tx-b->tx-c", "rw:tx-c->tx-a"]);
    expect(result.verdict.explanation).toContain("tx-a -> tx-b -> tx-c");
  });
});

function verdictProjection(result: AnalysisResult): Pick<
  IsolationVerdict,
  "serializable" | "strictSerializable" | "anomaly" | "implicatedTransactions" | "evidence" | "summary" | "explanation" | "inspectFirst"
> {
  return {
    serializable: result.verdict.serializable,
    strictSerializable: result.verdict.strictSerializable,
    anomaly: result.verdict.anomaly,
    implicatedTransactions: result.verdict.implicatedTransactions,
    evidence: result.verdict.evidence,
    summary: result.verdict.summary,
    explanation: result.verdict.explanation,
    inspectFirst: result.verdict.inspectFirst,
  };
}

function proofEdgeShape(result: AnalysisResult): string[] {
  return result.verdict.evidence.edgeIds.map((edgeId) => {
    const edge = result.edges.find((candidate) => candidate.id === edgeId);
    if (!edge) throw new Error(`missing proof edge ${edgeId}`);
    return `${edge.kind}:${edge.from}->${edge.to}`;
  });
}

function orderTransactions(history: History, orderedIds: string[]): History {
  const clone = cloneHistory(history);
  const byId = new Map(clone.transactions.map((tx) => [tx.id, tx]));
  if (orderedIds.length !== clone.transactions.length) {
    throw new Error("transaction order must include every transaction exactly once");
  }
  return {
    ...clone,
    transactions: orderedIds.map((id) => {
      const tx = byId.get(id);
      if (!tx) throw new Error(`unknown transaction id ${id}`);
      return tx;
    }),
  };
}

function renameTransactions(history: History, idMap: Record<string, string>): History {
  const clone = cloneHistory(history);
  return {
    ...clone,
    transactions: clone.transactions.map((tx) => ({
      ...tx,
      id: idMap[tx.id] ?? tx.id,
      ops: tx.ops.map((op) => (op.type === "read" ? { ...op, from: idMap[op.from] ?? op.from } : op)),
    })),
  };
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += 1) {
    const head = items[index];
    const tail = items.slice(0, index).concat(items.slice(index + 1));
    for (const rest of permutations(tail)) {
      result.push([head, ...rest]);
    }
  }
  return result;
}

function cloneHistory(history: History): History {
  return JSON.parse(JSON.stringify(history)) as History;
}

function genericDependencyCycleHistory(): History {
  return {
    name: "three-way-dependency-cycle",
    description: "Three transactions form an rw cycle that is not the two-transaction write-skew shape.",
    transactions: [
      {
        id: "T0",
        commit: 0,
        ops: [
          { type: "write", key: "a", value: 0 },
          { type: "write", key: "b", value: 0 },
          { type: "write", key: "c", value: 0 },
        ],
      },
      {
        id: "T1",
        begin: 1,
        commit: 2,
        ops: [
          { type: "read", key: "b", value: 0, from: "T0" },
          { type: "write", key: "a", value: 1 },
        ],
      },
      {
        id: "T2",
        begin: 1,
        commit: 3,
        ops: [
          { type: "read", key: "c", value: 0, from: "T0" },
          { type: "write", key: "b", value: 1 },
        ],
      },
      {
        id: "T3",
        begin: 1,
        commit: 4,
        ops: [
          { type: "read", key: "a", value: 0, from: "T0" },
          { type: "write", key: "c", value: 1 },
        ],
      },
    ],
  };
}
