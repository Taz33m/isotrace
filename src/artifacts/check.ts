import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeHistory } from "../core/analyzer";
import { parseHistoryJson, validateAnalysisReportArtifact, validateBenchmarkReportArtifact } from "../core/artifacts";
import { makeAnalysisReport } from "../core/report";
import { HistoryValidationError } from "../core/validate";

interface CheckResult {
  label: string;
  count: number;
}

function main(): void {
  const results: CheckResult[] = [];
  results.push(validateFixtures());
  results.push(validateExamples());
  results.push(validateFixtureReports());
  results.push(validateCliReports());

  console.log("IsoTrace artifact check passed");
  for (const result of results) {
    console.log(`- ${result.label}: ${result.count}`);
  }
}

function validateFixtures(): CheckResult {
  const files = jsonFiles("fixtures");
  for (const file of files) {
    parseHistoryJson(readFileSync(join("fixtures", file), "utf8"));
  }
  return { label: "fixtures validated", count: files.length };
}

function validateExamples(): CheckResult {
  parseHistoryJson(readFileSync("examples/valid_history.json", "utf8"));
  expectInvalidHistoryExample(
    "examples/invalid_history_missing_from.json",
    "history schema violation: /transactions/1/ops/0 requires property from",
  );
  return { label: "examples checked", count: 2 };
}

function validateFixtureReports(): CheckResult {
  const files = jsonFiles("fixtures");
  for (const file of files) {
    const path = join("fixtures", file);
    const inputBytes = readFileSync(path);
    const { history } = parseHistoryJson(inputBytes.toString("utf8"));
    validateAnalysisReportArtifact(
      makeAnalysisReport({
        argv: [path, "--json"],
        cwd: process.cwd(),
        generatedAt: "2026-05-02T00:00:00.000Z",
        inputPath: join(process.cwd(), path),
        inputBytes,
        result: analyzeHistory(history),
      }),
    );
  }
  return { label: "generated fixture reports validated", count: files.length };
}

function validateCliReports(): CheckResult {
  const analysis = JSON.parse(runNode(["src/cli.ts", "examples/valid_history.json", "--json"])) as unknown;
  validateAnalysisReportArtifact(analysis);

  const benchmark = JSON.parse(runNode(["src/bench/bench.ts", "--json"])) as unknown;
  validateBenchmarkReportArtifact(benchmark);

  return { label: "CLI JSON reports validated", count: 2 };
}

function expectInvalidHistoryExample(path: string, expectedMessage: string): void {
  try {
    parseHistoryJson(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof HistoryValidationError && error.message === expectedMessage) return;
    throw error;
  }
  throw new Error(`${path} unexpectedly passed validation`);
}

function jsonFiles(directory: string): string[] {
  return readdirSync(directory).filter((file) => file.endsWith(".json")).sort();
}

function runNode(args: string[]): string {
  return execFileSync(process.execPath, ["--import", "tsx", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

main();
