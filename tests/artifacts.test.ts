import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeHistory } from "../src/core/analyzer";
import { parseHistoryJson, validateAnalysisReportArtifact, validateBenchmarkReportArtifact, validateHistoryArtifact } from "../src/core/artifacts";
import { makeAnalysisReport } from "../src/core/report";
import type { History } from "../src/core/types";

describe("portable artifacts", () => {
  it("validates every checked-in fixture through the shared history schema path", () => {
    const fixtureFiles = historyFixtureFiles();
    expect(fixtureFiles.length).toBeGreaterThan(0);
    for (const file of fixtureFiles) {
      const { history, normalized } = parseHistoryJson(readFileSync(join("fixtures", file), "utf8"));
      expect(history.transactions.length).toBeGreaterThan(0);
      expect(normalized.committed.length).toBeGreaterThan(0);
    }
  });

  it("accepts the portable valid example", () => {
    const { history } = parseHistoryJson(readFileSync("examples/valid_history.json", "utf8"));
    expect(history.name).toBe("portable_valid_history");
    expect(analyzeHistory(history).ok).toBe(true);
  });

  it("reports deterministic schema errors for invalid history examples", () => {
    const text = readFileSync("examples/invalid_history_missing_from.json", "utf8");
    expect(() => parseHistoryJson(text)).toThrow("history schema violation: /transactions/1/ops/0 requires property from");
  });

  it("keeps semantic validation errors on the same path after schema validation", () => {
    const history: History = {
      name: "semantic-invalid",
      description: "shape is valid but read provenance points nowhere",
      transactions: [
        {
          id: "T1",
          ops: [{ type: "read", key: "x", value: 1, from: "missing" }],
        },
      ],
    };
    expect(() => validateHistoryArtifact(history)).toThrow("T1 reads x from unknown transaction missing");
  });

  it("enforces strict timestamp validation without running analysis", () => {
    const history: History = {
      name: "strict-invalid",
      description: "strict validation requires begin and commit timestamps",
      mode: "strict-serializable",
      transactions: [
        { id: "T0", commit: 0, ops: [{ type: "write", key: "x", value: 0 }] },
        { id: "T1", commit: 2, ops: [{ type: "read", key: "x", value: 0, from: "T0" }] },
      ],
    };
    expect(() => validateHistoryArtifact(history)).toThrow("T1 requires numeric begin and commit timestamps");
  });

  it("accepts strict timestamp validation through the CLI validate flag", () => {
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "examples/valid_history.json", "--validate", "--strict"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );
    expect(output).toContain("Valid history: portable_valid_history");
  });

  it("validates exported analyzer reports", () => {
    const inputBytes = readFileSync("examples/valid_history.json");
    const { history } = parseHistoryJson(inputBytes.toString("utf8"));
    const report = makeAnalysisReport({
      argv: ["examples/valid_history.json", "--json"],
      cwd: process.cwd(),
      generatedAt: "2026-05-02T00:00:00.000Z",
      inputPath: join(process.cwd(), "examples/valid_history.json"),
      inputBytes,
      result: analyzeHistory(history),
    });

    expect(validateAnalysisReportArtifact(report).report.schema).toBe("isotrace.report.v1");
  });

  it("validates CLI analyzer JSON reports", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "examples/valid_history.json", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const report = validateAnalysisReportArtifact(JSON.parse(output) as unknown);
    expect(report.input.path).toContain("examples/valid_history.json");
    expect(report.result.history.name).toBe("portable_valid_history");
  });

  it("reports deterministic schema errors for invalid analyzer reports", () => {
    const inputBytes = readFileSync("examples/valid_history.json");
    const { history } = parseHistoryJson(inputBytes.toString("utf8"));
    const report = makeAnalysisReport({
      argv: ["examples/valid_history.json", "--json"],
      cwd: process.cwd(),
      generatedAt: "2026-05-02T00:00:00.000Z",
      inputPath: join(process.cwd(), "examples/valid_history.json"),
      inputBytes,
      result: analyzeHistory(history),
    }) as unknown as { input: { sha256?: string } };
    delete report.input.sha256;

    expect(() => validateAnalysisReportArtifact(report)).toThrow("analysis report schema violation: /input requires property sha256");
  });

  it("validates CLI benchmark JSON reports", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "src/bench/bench.ts", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const report = validateBenchmarkReportArtifact(JSON.parse(output) as unknown);
    expect(report.benchmark.name).toBe("generated-serial-histories");
    expect(report.benchmark.rows.length).toBeGreaterThan(0);
  });

  it("exposes a CLI validate path for portable histories", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "examples/valid_history.json", "--validate"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(output).toContain("Valid history: portable_valid_history");
    expect(output).toContain("Schema: https://isotrace.dev/schemas/history.schema.json");
  });

  it("exposes a batch artifact check command", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "src/artifacts/check.ts"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(output).toContain("IsoTrace artifact check passed");
    expect(output).toContain("CLI JSON reports validated: 2");
    expect(output).toContain("CI workflow checked: 1");
    expect(output).toContain("fixture verdict contracts checked: 4");
  });
});

function historyFixtureFiles(): string[] {
  return readdirSync("fixtures")
    .filter((file) => file.endsWith(".json") && file !== "manifest.json")
    .sort();
}
