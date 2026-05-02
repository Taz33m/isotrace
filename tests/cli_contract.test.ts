import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { validateAnalysisReportArtifact } from "../src/core/artifacts";

interface CliRun {
  status: number;
  stdout: string;
  stderr: string;
}

describe("CLI contract", () => {
  it("exits 2 after printing the proof when --fail-on-violation finds an anomaly", () => {
    const result = runCli(["fixtures/write_skew_doctors.json", "--fail-on-violation"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Result: VIOLATION");
    expect(result.stdout).toContain("Anomaly: Write skew [write-skew]");
    expect(result.stdout).toContain("Implicated transactions: T1, T2");
    expect(result.stdout).toContain("Proof edges: e5 -> e7");
  });

  it("keeps --fail-on-violation successful for clean histories", () => {
    const result = runCli(["fixtures/serial_stock_decrement.json", "--fail-on-violation"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Result: OK");
    expect(result.stdout).toContain("Anomaly: Valid serial history [valid-serial-history]");
    expect(result.stdout).toContain("Order witness: T0 -> T1 -> T2");
  });

  it("keeps JSON reports parseable even when --fail-on-violation exits 2", () => {
    const result = runCli(["fixtures/write_skew_doctors.json", "--json", "--fail-on-violation"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    const report = validateAnalysisReportArtifact(JSON.parse(result.stdout) as unknown);
    expect(report.result.ok).toBe(false);
    expect(report.result.verdict.anomaly.label).toBe("write-skew");
    expect(report.result.verdict.implicatedTransactions).toEqual(["T1", "T2"]);
  });

  it("reports fixture-catalog flag misuse with deterministic stderr and exit 1", () => {
    expect(runCli(["--fixtures", "--strict"])).toEqual({
      status: 1,
      stdout: "",
      stderr: "Invalid history: --fixtures only accepts --json, got --strict\n",
    });
    expect(runCli(["--fixtures", "fixtures/write_skew_doctors.json"])).toEqual({
      status: 1,
      stdout: "",
      stderr: "Invalid history: --fixtures does not accept a history file, got 1\n",
    });
  });
});

function runCli(args: string[]): CliRun {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
