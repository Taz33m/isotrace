import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeHistory } from "../src/core/analyzer";
import { validateAnalysisReportArtifact, validateHistoryArtifact } from "../src/core/artifacts";
import { parseSqlTrace } from "../src/sql/trace";

describe("constrained SQL trace importer", () => {
  it("imports returned predicate rows into explicit read-from operations", () => {
    const history = parseSqlTrace(readFileSync("examples/write_skew_sql_trace.sql", "utf8"), "write_skew_sql_trace.sql");
    const validated = validateHistoryArtifact(history);
    const result = analyzeHistory(validated.history);

    expect(validated.history.name).toBe("sql_trace_write_skew_doctors");
    expect(result.ok).toBe(false);
    expect(result.verdict.anomaly.label).toBe("write-skew");
    expect(result.verdict.implicatedTransactions).toEqual(["T1", "T2"]);
    expect(validated.history.transactions.find((tx) => tx.id === "T1")?.ops).toContainEqual({
      type: "read",
      key: "doctors/bob/on_call",
      value: true,
      from: "T0",
      predicate: {
        table: "doctors",
        where: "id = 'bob' AND on_call = true",
        rowId: "bob",
        sourceSql: "SELECT id, on_call FROM doctors WHERE id = 'bob' AND on_call = true",
      },
    });
  });

  it("runs SQL traces through the CLI and JSON report path", () => {
    const human = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "examples/write_skew_sql_trace.sql", "--sql-trace"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(human).toContain("IsoTrace: sql_trace_write_skew_doctors");
    expect(human).toContain("Anomaly: Write skew [write-skew]");

    const json = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "examples/write_skew_sql_trace.sql", "--sql-trace", "--json"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    const report = validateAnalysisReportArtifact(JSON.parse(json) as unknown);
    expect(report.result.history.transactions[1].ops[0]).toMatchObject({
      type: "read",
      predicate: { table: "doctors", rowId: "bob" },
    });
  });

  it("rejects SQL SELECT rows without provenance", () => {
    const dir = mkdtempSync(join(tmpdir(), "isotrace-sql-"));
    const path = join(dir, "bad.sql");
    writeFileSync(
      path,
      `BEGIN T1 AT 1
T1: SELECT id, on_call FROM doctors WHERE on_call = true -> [{"id":"bob","on_call":true}]
COMMIT T1 AT 2
`,
    );
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", path, "--sql-trace"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("Invalid history: SQL trace line 2 SELECT rows require string _from provenance\n");
  });

  it("reports deterministic importer errors", () => {
    expect(() =>
      parseSqlTrace(`
BEGIN T1 AT 1
T1: SELECT id, on_call FROM doctors WHERE on_call = true -> [{"id":"bob","on_call":true}]
COMMIT T1 AT 2
`),
    ).toThrow("SQL trace line 3 SELECT rows require string _from provenance");
  });
});
