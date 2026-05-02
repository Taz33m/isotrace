import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeHistory } from "../src/core/analyzer";
import { validateAnalysisReportArtifact } from "../src/core/artifacts";
import { explainResult, formatEdgeFacts } from "../src/core/explain";
import { makeAnalysisReport } from "../src/core/report";
import type { AnalysisResult, History, IsolationVerdict } from "../src/core/types";
import abortedWriteIgnored from "../fixtures/aborted_write_ignored.json";
import serialStockDecrement from "../fixtures/serial_stock_decrement.json";
import staleReadStrict from "../fixtures/stale_read_strict.json";
import writeSkewDoctors from "../fixtures/write_skew_doctors.json";

describe("semantic isolation verdicts", () => {
  it("emits a structured verdict object", () => {
    const result = analyzeHistory(writeSkewDoctors as History);
    expect(result.verdict).toMatchObject({
      serializable: { status: "fail" },
      strictSerializable: { status: "fail" },
      anomaly: { label: "write-skew", title: "Write skew" },
      evidence: { kind: "cycle", pattern: "rw/rw cycle between committed transactions" },
    });
    expect(result.verdict.summary).toContain("Not serializable");
    expect(result.verdict.inspectFirst).toContain("cycle");
  });

  it("classifies write skew conservatively from an rw/rw cycle", () => {
    const result = analyzeHistory(writeSkewDoctors as History);
    expect(result.verdict.anomaly.label).toBe("write-skew");
    expect(result.verdict.implicatedTransactions).toEqual(["T1", "T2"]);
    expect(result.verdict.evidence.edgeIds).toHaveLength(2);
    expect(result.verdict.evidence.edgeKinds).toEqual(["rw", "rw"]);
  });

  it("does not treat realtime-only order as a serializability anomaly", () => {
    const history: History = {
      name: "realtime-only-order",
      description: "Strict timestamps create realtime order, but no dependency cycle exists.",
      transactions: [
        { id: "T1", begin: 1, commit: 2, ops: [{ type: "write", key: "x", value: 1 }] },
        { id: "T2", begin: 3, commit: 4, ops: [{ type: "write", key: "y", value: 1 }] },
      ],
    };
    const result = analyzeHistory(history, { strict: true });
    expect(result.kindCounts.rt).toBe(1);
    expect(result.cycles).toHaveLength(0);
    expect(result.verdict.serializable.status).toBe("pass");
    expect(result.verdict.strictSerializable.status).toBe("pass");
    expect(result.verdict.anomaly.label).toBe("valid-serial-history");
    expect(result.verdict.evidence.edgeKinds).toEqual([]);
  });

  it("does not include realtime evidence when strict mode is not evaluated", () => {
    const serializableOnly: History = {
      ...(staleReadStrict as History),
      mode: "serializable",
    };
    const result = analyzeHistory(serializableOnly);
    expect(result.mode).toBe("serializable");
    expect(result.kindCounts.rt).toBe(0);
    expect(result.verdict.serializable.status).toBe("pass");
    expect(result.verdict.strictSerializable.status).toBe("not-evaluated");
    expect(result.verdict.anomaly.label).toBe("valid-serial-history");
    expect(result.verdict.evidence.edgeKinds).not.toContain("rt");
  });

  it("classifies strict stale reads when realtime order and read provenance conflict", () => {
    const result = analyzeHistory(staleReadStrict as History, { strict: true });
    expect(result.verdict.serializable.status).toBe("pass");
    expect(result.verdict.strictSerializable.status).toBe("fail");
    expect(result.verdict.anomaly.label).toBe("strict-stale-read");
    expect(result.verdict.evidence.edgeKinds).toContain("rt");
    expect(result.verdict.explanation).toContain("older version");
  });

  it("falls back to generic dependency-cycle for supported non-write-skew cycles", () => {
    const result = analyzeHistory(genericDependencyCycleHistory());
    expect(result.verdict.anomaly.label).toBe("dependency-cycle");
    expect(result.verdict.serializable.status).toBe("fail");
    expect(result.verdict.implicatedTransactions).toEqual(["T1", "T2", "T3"]);
  });

  it("classifies clean serial histories as valid", () => {
    const result = analyzeHistory(serialStockDecrement as History);
    expect(result.verdict.anomaly.label).toBe("valid-serial-history");
    expect(result.verdict.serializable.status).toBe("pass");
    expect(result.verdict.strictSerializable.status).toBe("not-evaluated");
  });

  it("classifies ignored aborted transactions without treating them as committed anomalies", () => {
    const result = analyzeHistory(abortedWriteIgnored as History);
    expect(result.verdict.anomaly.label).toBe("aborted-write-ignored");
    expect(result.verdict.serializable.status).toBe("pass");
    expect(result.verdict.implicatedTransactions).toEqual(["T1"]);
    expect(result.verdict.evidence.pattern).toContain("aborted transactions");
  });

  it("excludes aborted transactions that would form a false write-skew if committed", () => {
    const history: History = {
      name: "aborted-would-be-cycle",
      description: "The aborted transaction would close an rw/rw cycle if it participated.",
      transactions: [
        {
          id: "T0",
          commit: 0,
          ops: [
            { type: "write", key: "a", value: 0 },
            { type: "write", key: "b", value: 0 },
          ],
        },
        {
          id: "T1",
          status: "aborted",
          begin: 1,
          commit: 3,
          ops: [
            { type: "read", key: "b", value: 0, from: "T0" },
            { type: "write", key: "a", value: 1 },
          ],
        },
        {
          id: "T2",
          begin: 2,
          commit: 4,
          ops: [
            { type: "read", key: "a", value: 0, from: "T0" },
            { type: "write", key: "b", value: 1 },
          ],
        },
      ],
    };
    const result = analyzeHistory(history);
    expect(result.verdict.anomaly.label).toBe("aborted-write-ignored");
    expect(result.verdict.serializable.status).toBe("pass");
    expect(result.edges.every((edge) => edge.from !== "T1" && edge.to !== "T1")).toBe(true);
  });

  it("keeps write-skew proof edges and verdict text deterministic across repeated runs", () => {
    const first = stableVerdictProjection(analyzeHistory(writeSkewDoctors as History).verdict);
    expect(first.evidence.edgeKinds).toEqual(["rw", "rw"]);
    expect(first.evidence.edgeIds).toHaveLength(2);
    for (let index = 0; index < 8; index += 1) {
      const next = stableVerdictProjection(analyzeHistory(writeSkewDoctors as History).verdict);
      expect(next).toEqual(first);
    }
  });

  it("keeps structured proof-edge facts aligned with edge ids, kinds, and endpoints", () => {
    const result = analyzeHistory(writeSkewDoctors as History);
    expectProofEdgesMatchGraph(result);
    expect(result.verdict.evidence.proofEdges.map((proofEdge) => proofEdge.summary)).toEqual([
      "source fact: T1 read doctor/bob_on_call before T2's later write; target fact: T2 wrote doctor/bob_on_call=false",
      "source fact: T2 read doctor/alice_on_call before T1's later write; target fact: T1 wrote doctor/alice_on_call=false",
    ]);
  });

  it("keeps strict realtime proof-edge facts aligned with edge ids, kinds, and endpoints", () => {
    const result = analyzeHistory(staleReadStrict as History, { strict: true });
    expectProofEdgesMatchGraph(result);
    expect(result.verdict.evidence.proofEdges.map((proofEdge) => proofEdge.summary)).toEqual([
      "source fact: T1 committed before T2 began; target fact: T2 must be ordered after T1 by realtime",
      "source fact: T2 read flag/ready before T1's later write; target fact: T1 wrote flag/ready=true",
    ]);
  });

  it("keeps generic dependency-cycle implicated transaction ordering stable", () => {
    const history = genericDependencyCycleHistory();
    const first = analyzeHistory(history).verdict;
    expect(first.anomaly.label).toBe("dependency-cycle");
    expect(first.implicatedTransactions).toEqual(["T1", "T2", "T3"]);
    for (let index = 0; index < 8; index += 1) {
      expect(analyzeHistory(history).verdict.implicatedTransactions).toEqual(first.implicatedTransactions);
      expect(analyzeHistory(history).verdict.evidence.edgeIds).toEqual(first.evidence.edgeIds);
    }
  });

  it("includes a schema-valid verdict object in exported analyzer reports", () => {
    const inputBytes = readFileSync("fixtures/write_skew_doctors.json");
    const report = makeAnalysisReport({
      argv: ["fixtures/write_skew_doctors.json", "--json"],
      cwd: process.cwd(),
      generatedAt: "2026-05-02T00:00:00.000Z",
      inputPath: join(process.cwd(), "fixtures/write_skew_doctors.json"),
      inputBytes,
      result: analyzeHistory(writeSkewDoctors as History),
    });
    const validated = validateAnalysisReportArtifact(report);
    expect(validated.result.verdict.anomaly.label).toBe("write-skew");
    expect(validated.result.verdict.evidence.edgeKinds).toEqual(["rw", "rw"]);
    expectProofEdgesMatchGraph(validated.result);
  });

  it("keeps human CLI text semantically aligned with the JSON verdict", () => {
    const human = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "fixtures/write_skew_doctors.json"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const json = JSON.parse(
      execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "fixtures/write_skew_doctors.json", "--json"], {
        cwd: process.cwd(),
        encoding: "utf8",
      }),
    ) as { result: { verdict: IsolationVerdict } };
    const verdict = json.result.verdict;
    expect(human).toContain(`Anomaly: ${verdict.anomaly.title} [${verdict.anomaly.label}]`);
    expect(human).toContain(`Implicated transactions: ${verdict.implicatedTransactions.join(", ")}`);
    expect(human).toContain(`Proof edges: ${verdict.evidence.edgeIds.join(" -> ")}`);
    expect(human).toContain(verdict.explanation);
  });

  it("keeps direct explanation text semantically aligned with the verdict object", () => {
    const result = analyzeHistory(staleReadStrict as History, { strict: true });
    const human = explainResult(result);
    expect(human).toContain(`Anomaly: ${result.verdict.anomaly.title} [${result.verdict.anomaly.label}]`);
    expect(human).toContain(`Implicated transactions: ${result.verdict.implicatedTransactions.join(", ")}`);
    expect(human).toContain(`Proof edges: ${result.verdict.evidence.edgeIds.join(" -> ")}`);
  });

  it("prints source and target facts for proof edges in CLI output", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "fixtures/write_skew_doctors.json"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(output).toContain("facts: source fact: T2 read doctor/alice_on_call before T1's later write; target fact: T1 wrote doctor/alice_on_call=false");
    expect(output).toContain("facts: source fact: T1 read doctor/bob_on_call before T2's later write; target fact: T2 wrote doctor/bob_on_call=false");
  });

  it("prints anomaly label and implicated transactions in CLI output", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "fixtures/write_skew_doctors.json"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(output).toContain("Anomaly: Write skew [write-skew]");
    expect(output).toContain("Implicated transactions: T1, T2");
    expect(output).toContain("Proof edges:");
  });
});

function expectProofEdgesMatchGraph(result: AnalysisResult): void {
  const { evidence } = result.verdict;
  expect(evidence.proofEdges.map((proofEdge) => proofEdge.edgeId)).toEqual(evidence.edgeIds);
  expect(evidence.proofEdges.map((proofEdge) => proofEdge.edgeKind)).toEqual(evidence.edgeKinds);
  for (const proofEdge of evidence.proofEdges) {
    const edge = result.edges.find((candidate) => candidate.id === proofEdge.edgeId);
    expect(edge).toBeDefined();
    expect(proofEdge.edgeKind).toBe(edge?.kind);
    expect(proofEdge.sourceTransaction).toBe(edge?.from);
    expect(proofEdge.targetTransaction).toBe(edge?.to);
    expect(formatEdgeFacts(edge!)).toBe(proofEdge.summary);
  }
}

describe("edge fact formatting", () => {
  it("formats all edge kinds as source and target facts", () => {
    expect(
      formatEdgeFacts({
        id: "e1",
        from: "T0",
        to: "T1",
        kind: "ww",
        key: "x",
        value: 1,
        reason: "fixture",
      }),
    ).toBe("source fact: T0 committed an earlier version of x; target fact: T1 wrote x=1");
    expect(
      formatEdgeFacts({
        id: "e2",
        from: "T0",
        to: "T1",
        kind: "wr",
        key: "x",
        value: 1,
        reason: "fixture",
      }),
    ).toBe("source fact: T0 wrote x=1; target fact: T1 read x=1 from T0");
    expect(
      formatEdgeFacts({
        id: "e3",
        from: "T1",
        to: "T2",
        kind: "rw",
        key: "x",
        value: 2,
        reason: "fixture",
      }),
    ).toBe("source fact: T1 read x before T2's later write; target fact: T2 wrote x=2");
    expect(
      formatEdgeFacts({
        id: "e4",
        from: "T1",
        to: "T2",
        kind: "rt",
        reason: "fixture",
      }),
    ).toBe("source fact: T1 committed before T2 began; target fact: T2 must be ordered after T1 by realtime");
  });
});

function stableVerdictProjection(verdict: IsolationVerdict): Pick<
  IsolationVerdict,
  "serializable" | "strictSerializable" | "anomaly" | "implicatedTransactions" | "evidence" | "summary" | "explanation" | "inspectFirst"
> {
  return {
    serializable: verdict.serializable,
    strictSerializable: verdict.strictSerializable,
    anomaly: verdict.anomaly,
    implicatedTransactions: verdict.implicatedTransactions,
    evidence: verdict.evidence,
    summary: verdict.summary,
    explanation: verdict.explanation,
    inspectFirst: verdict.inspectFirst,
  };
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
