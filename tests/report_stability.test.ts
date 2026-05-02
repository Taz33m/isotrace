import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { validateAnalysisReportArtifact } from "../src/core/artifacts";
import type { AnalysisReport } from "../src/core/report";

describe("CLI report stability", () => {
  it("emits a stable write-skew JSON report projection", () => {
    const first = stableReportProjection(runJsonReport(["fixtures/write_skew_doctors.json", "--json"]));
    const second = stableReportProjection(runJsonReport(["fixtures/write_skew_doctors.json", "--json"]));

    expect(second).toEqual(first);
    expect(first).toEqual({
      report: {
        schema: "isotrace.report.v1",
        toolName: "isotrace",
        argv: ["fixtures/write_skew_doctors.json", "--json"],
      },
      input: {
        pathSuffix: "fixtures/write_skew_doctors.json",
        bytes: 1312,
        sha256: "189bd0777b99abd7596fa45e34cd8407fb265ea73de639befe71a235a3d05caf",
      },
      result: {
        historyName: "write_skew_doctors",
        mode: "serializable",
        ok: false,
        kindCounts: { ww: 2, wr: 4, rw: 2, rt: 0 },
        cycleCount: 1,
        ignoredTransactions: [],
        validationNotes: [
          "Version order uses commit timestamps for committed non-initial transactions; T0 is treated as the initial seed when present.",
        ],
        verdict: {
          serializableStatus: "fail",
          strictSerializableStatus: "fail",
          anomalyLabel: "write-skew",
          anomalyTitle: "Write skew",
          implicatedTransactions: ["T1", "T2"],
          evidence: {
            kind: "cycle",
            cycleId: "cycle-1",
            edgeIds: ["e5", "e7"],
            edgeKinds: ["rw", "rw"],
            proofEdges: [
              {
                edgeId: "e5",
                edgeKind: "rw",
                sourceTransaction: "T1",
                targetTransaction: "T2",
                sourceFact: "T1 read doctor/bob_on_call before T2's later write",
                targetFact: "T2 wrote doctor/bob_on_call=false",
                summary: "source fact: T1 read doctor/bob_on_call before T2's later write; target fact: T2 wrote doctor/bob_on_call=false",
              },
              {
                edgeId: "e7",
                edgeKind: "rw",
                sourceTransaction: "T2",
                targetTransaction: "T1",
                sourceFact: "T2 read doctor/alice_on_call before T1's later write",
                targetFact: "T1 wrote doctor/alice_on_call=false",
                summary: "source fact: T2 read doctor/alice_on_call before T1's later write; target fact: T1 wrote doctor/alice_on_call=false",
              },
            ],
            pattern: "rw/rw cycle between committed transactions",
          },
          summary: "Not serializable: write-skew dependency cycle.",
          explanation: "T1 and T2 each read a version that the other transaction later invalidated, closing an rw/rw cycle.",
          inspectFirst: "Inspect cycle-1, especially proof edges e5, e7.",
        },
      },
    });
  });

  it("emits a stable strict stale-read JSON report projection", () => {
    const first = stableReportProjection(runJsonReport(["fixtures/stale_read_strict.json", "--strict", "--json"]));
    const second = stableReportProjection(runJsonReport(["fixtures/stale_read_strict.json", "--strict", "--json"]));

    expect(second).toEqual(first);
    expect(first).toEqual({
      report: {
        schema: "isotrace.report.v1",
        toolName: "isotrace",
        argv: ["fixtures/stale_read_strict.json", "--strict", "--json"],
      },
      input: {
        pathSuffix: "fixtures/stale_read_strict.json",
        bytes: 910,
        sha256: "39860ee4d78635a081bb577ef8cd1dcd94597a4d9e1974eae090e3b68895f821",
      },
      result: {
        historyName: "stale_read_strict",
        mode: "strict-serializable",
        ok: false,
        kindCounts: { ww: 1, wr: 1, rw: 1, rt: 1 },
        cycleCount: 1,
        ignoredTransactions: [],
        validationNotes: [
          "Version order uses commit timestamps for committed non-initial transactions; T0 is treated as the initial seed when present.",
        ],
        verdict: {
          serializableStatus: "pass",
          strictSerializableStatus: "fail",
          anomalyLabel: "strict-stale-read",
          anomalyTitle: "Strict stale read",
          implicatedTransactions: ["T1", "T2"],
          evidence: {
            kind: "cycle",
            cycleId: "cycle-1",
            edgeIds: ["e4", "e3"],
            edgeKinds: ["rt", "rw"],
            proofEdges: [
              {
                edgeId: "e4",
                edgeKind: "rt",
                sourceTransaction: "T1",
                targetTransaction: "T2",
                sourceFact: "T1 committed before T2 began",
                targetFact: "T2 must be ordered after T1 by realtime",
                summary: "source fact: T1 committed before T2 began; target fact: T2 must be ordered after T1 by realtime",
              },
              {
                edgeId: "e3",
                edgeKind: "rw",
                sourceTransaction: "T2",
                targetTransaction: "T1",
                sourceFact: "T2 read flag/ready before T1's later write",
                targetFact: "T1 wrote flag/ready=true",
                summary: "source fact: T2 read flag/ready before T1's later write; target fact: T1 wrote flag/ready=true",
              },
            ],
            pattern: "rt edge plus read provenance cycle",
          },
          summary: "Serializable, but not strict-serializable: stale read across realtime order.",
          explanation: "A transaction read an older version even though another transaction had already committed before it began.",
          inspectFirst: "Inspect the realtime edge in cycle-1, then the read/write edge that returns to the reader.",
        },
      },
    });
  });
});

function runJsonReport(args: string[]): AnalysisReport {
  const output = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  return validateAnalysisReportArtifact(JSON.parse(output) as unknown);
}

function stableReportProjection(report: AnalysisReport) {
  const verdict = report.result.verdict;
  return {
    report: {
      schema: report.report.schema,
      toolName: report.report.tool.name,
      argv: report.report.command.argv,
    },
    input: {
      pathSuffix: pathSuffix(report.input.path),
      bytes: report.input.bytes,
      sha256: report.input.sha256,
    },
    result: {
      historyName: report.result.history.name,
      mode: report.result.mode,
      ok: report.result.ok,
      kindCounts: report.result.kindCounts,
      cycleCount: report.result.cycles.length,
      ignoredTransactions: report.result.ignoredTransactions,
      validationNotes: report.result.validationNotes,
      verdict: {
        serializableStatus: verdict.serializable.status,
        strictSerializableStatus: verdict.strictSerializable.status,
        anomalyLabel: verdict.anomaly.label,
        anomalyTitle: verdict.anomaly.title,
        implicatedTransactions: verdict.implicatedTransactions,
        evidence: verdict.evidence,
        summary: verdict.summary,
        explanation: verdict.explanation,
        inspectFirst: verdict.inspectFirst,
      },
    },
  };
}

function pathSuffix(path: string): string {
  return path.split("/").slice(-2).join("/");
}
