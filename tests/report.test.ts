import { describe, expect, it } from "vitest";
import { analyzeHistory } from "../src/core/analyzer";
import { makeAnalysisReport, makeBenchmarkReport, REPORT_SCHEMA_VERSION, sha256 } from "../src/core/report";
import type { History } from "../src/core/types";

describe("report envelopes", () => {
  it("hashes inputs with sha256", () => {
    expect(sha256("isotrace")).toBe("82a1fc06fc88c53240da4af86f8bdfb2ca277a11686f522f1035160c81dca26b");
  });

  it("wraps analysis output with reproducibility provenance", () => {
    const history: History = {
      name: "report-fixture",
      description: "small report fixture",
      transactions: [{ id: "T0", commit: 0, ops: [{ type: "write", key: "x", value: 1 }] }],
    };
    const inputBytes = Buffer.from(JSON.stringify(history));
    const result = analyzeHistory(history);
    const report = makeAnalysisReport({
      argv: ["fixtures/report.json", "--json"],
      cwd: "/tmp/isotrace",
      generatedAt: "2026-05-02T00:00:00.000Z",
      inputPath: "/tmp/isotrace/fixtures/report.json",
      inputBytes,
      result,
    });

    expect(report.report.schema).toBe(REPORT_SCHEMA_VERSION);
    expect(report.report.tool.name).toBe("isotrace");
    expect(report.report.command.argv).toEqual(["fixtures/report.json", "--json"]);
    expect(report.input.bytes).toBe(inputBytes.byteLength);
    expect(report.input.sha256).toBe(sha256(inputBytes));
    expect(report.result.ok).toBe(true);
  });

  it("wraps benchmark rows with benchmark settings", () => {
    const report = makeBenchmarkReport({
      argv: ["--json"],
      cwd: "/tmp/isotrace",
      generatedAt: "2026-05-02T00:00:00.000Z",
      sizes: [{ transactions: 25, keys: 5 }],
      rows: [{ transactions: 26, keys: 5, edges: 100, cycles: 0, durationMs: 1.25 }],
    });

    expect(report.report.schema).toBe(REPORT_SCHEMA_VERSION);
    expect(report.benchmark.settings.iterations).toBe(1);
    expect(report.benchmark.rows).toHaveLength(1);
  });
});
