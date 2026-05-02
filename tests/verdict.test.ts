import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { analyzeHistory } from "../src/core/analyzer";
import type { History } from "../src/core/types";
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
    expect(result.verdict.implicatedTransactions.sort()).toEqual(["T1", "T2"]);
    expect(result.verdict.evidence.edgeKinds).toEqual(["rw", "rw"]);
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
    const history: History = {
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
    const result = analyzeHistory(history);
    expect(result.verdict.anomaly.label).toBe("dependency-cycle");
    expect(result.verdict.serializable.status).toBe("fail");
    expect(result.verdict.implicatedTransactions.sort()).toEqual(["T1", "T2", "T3"]);
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
