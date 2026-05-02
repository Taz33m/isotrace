import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeHistory } from "../core/analyzer";
import { parseHistoryJson, validateAnalysisReportArtifact, validateBenchmarkReportArtifact } from "../core/artifacts";
import { makeAnalysisReport } from "../core/report";
import type { AnalysisResult } from "../core/types";
import { HistoryValidationError } from "../core/validate";
import { makeFixtureCatalog, readFixtureManifest, type FixtureContract, type FixtureExpectation } from "../fixtures/manifest";

interface CheckResult {
  label: string;
  count: number;
}

const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
const EXPECTED_CI_RUN_COMMANDS = ["npm ci", "npm run check", "npm run smoke:ui", "npm audit --audit-level=moderate"];

function main(): void {
  const results: CheckResult[] = [];
  results.push(validateFixtures());
  results.push(validateFixtureContracts());
  results.push(validateExamples());
  results.push(validateFixtureReports());
  results.push(validateCliReports());
  results.push(validateCliFixtureCatalog());
  results.push(validateCiWorkflow());

  console.log("IsoTrace artifact check passed");
  for (const result of results) {
    console.log(`- ${result.label}: ${result.count}`);
  }
}

function validateFixtures(): CheckResult {
  const files = historyFixtureFiles();
  for (const file of files) {
    parseHistoryJson(readFileSync(join("fixtures", file), "utf8"));
  }
  return { label: "fixtures validated", count: files.length };
}

function validateFixtureContracts(): CheckResult {
  const manifest = readFixtureManifest();
  const expectedFixturePaths = historyFixtureFiles().map((file) => join("fixtures", file));
  assertJsonEqual(
    manifest.fixtures.map((contract) => contract.path).sort(),
    expectedFixturePaths,
    "fixture manifest path coverage",
  );

  for (const contract of manifest.fixtures) {
    validateFixtureContract(contract);
  }
  return { label: "fixture verdict contracts checked", count: manifest.fixtures.length };
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
  const files = historyFixtureFiles();
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

function validateCliFixtureCatalog(): CheckResult {
  const catalog = JSON.parse(runNode(["src/cli.ts", "--fixtures", "--json"])) as unknown;
  assertJsonEqual(catalog, makeFixtureCatalog(), "CLI fixture catalog JSON");
  return { label: "CLI fixture catalog checked", count: makeFixtureCatalog().count };
}

function validateCiWorkflow(): CheckResult {
  const text = readFileSync(CI_WORKFLOW_PATH, "utf8");
  expectContains(text, "name: CI", "CI workflow name");
  expectContains(text, "pull_request:", "CI pull_request trigger");
  expectContains(text, "branches:\n      - main", "CI main-branch push trigger");
  expectContains(text, "uses: actions/checkout@v4", "CI checkout action");
  expectContains(text, "uses: actions/setup-node@v4", "CI setup-node action");
  expectContains(text, "node-version: 24", "CI Node version");
  expectContains(text, "cache: npm", "CI npm cache");

  const runCommands = text
    .split(/\r?\n/)
    .map((line) => line.match(/^\s+run:\s+(.+)$/)?.[1]?.trim())
    .filter((command): command is string => command !== undefined);
  if (JSON.stringify(runCommands) !== JSON.stringify(EXPECTED_CI_RUN_COMMANDS)) {
    throw new Error(
      `${CI_WORKFLOW_PATH} run commands drifted; expected ${EXPECTED_CI_RUN_COMMANDS.join(" -> ")}, got ${runCommands.join(" -> ")}`,
    );
  }
  return { label: "CI workflow checked", count: 1 };
}

function validateFixtureContract(contract: FixtureContract): void {
  const strict = contract.expected.mode === "strict-serializable";
  const expectedReproduce = `npm run --silent analyze -- ${contract.argv.join(" ")}`;
  if (contract.reproduce !== expectedReproduce) {
    throw new Error(`${contract.path} reproduce command drifted; expected ${expectedReproduce}`);
  }
  if (contract.argv[0] !== contract.path) {
    throw new Error(`${contract.path} argv must start with its fixture path`);
  }
  if (!contract.argv.includes("--json")) {
    throw new Error(`${contract.path} reproduction argv must include --json`);
  }
  if (strict !== contract.argv.includes("--strict")) {
    throw new Error(`${contract.path} strict mode expectation must match --strict argv`);
  }

  const inputBytes = readFileSync(contract.path);
  const { history } = parseHistoryJson(inputBytes.toString("utf8"), { strict });
  expectFixtureResult(analyzeHistory(history, { strict }), contract, "engine");

  const cliReport = validateAnalysisReportArtifact(JSON.parse(runNpmAnalyze(contract.argv)) as unknown);
  assertJsonEqual(cliReport.report.command.argv, contract.argv, `${contract.path} CLI report argv`);
  if (!cliReport.input.path.endsWith(contract.path)) {
    throw new Error(`${contract.path} CLI report input path drifted: ${cliReport.input.path}`);
  }
  expectFixtureResult(cliReport.result, contract, "CLI report");
}

function expectFixtureResult(result: AnalysisResult, contract: FixtureContract, source: string): void {
  const actual: FixtureExpectation = {
    historyName: result.history.name,
    mode: result.mode,
    ok: result.ok,
    anomaly: result.verdict.anomaly.label,
    serializable: result.verdict.serializable.status,
    strictSerializable: result.verdict.strictSerializable.status,
    implicatedTransactions: result.verdict.implicatedTransactions,
    evidenceKind: result.verdict.evidence.kind,
    edgeKinds: result.verdict.evidence.edgeKinds,
    cycleCount: result.cycles.length,
    orderWitness: result.orderWitness?.transactions ?? null,
    kindCounts: result.kindCounts,
  };
  assertJsonEqual(actual, contract.expected, `${contract.path} ${source} expected verdict`);
  expectOrderWitnessConsistent(result, contract, source);
}

function expectOrderWitnessConsistent(result: AnalysisResult, contract: FixtureContract, source: string): void {
  const witness = result.orderWitness;
  if (result.ok && witness === null) {
    throw new Error(`${contract.path} ${source} expected order witness for clean result`);
  }
  if (!result.ok && witness !== null) {
    throw new Error(`${contract.path} ${source} unexpected order witness for violating result`);
  }
  if (witness === null) return;

  assertJsonEqual(witness.edgeIds, result.edges.map((edge) => edge.id), `${contract.path} ${source} order witness edge ids`);
  const positions = new Map(witness.transactions.map((txId, index) => [txId, index]));
  for (const edge of result.edges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (from === undefined || to === undefined || from >= to) {
      throw new Error(`${contract.path} ${source} order witness violates ${edge.kind} edge ${edge.id}: ${edge.from} -> ${edge.to}`);
    }
  }
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

function historyFixtureFiles(): string[] {
  return jsonFiles("fixtures").filter((file) => file !== "manifest.json");
}

function jsonFiles(directory: string): string[] {
  return readdirSync(directory).filter((file) => file.endsWith(".json")).sort();
}

function expectContains(text: string, needle: string, label: string): void {
  if (!text.includes(needle)) {
    throw new Error(`${CI_WORKFLOW_PATH} missing ${label}: ${needle}`);
  }
}

function assertJsonEqual(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} drifted; expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function runNode(args: string[]): string {
  return execFileSync(process.execPath, ["--import", "tsx", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runNpmAnalyze(argv: string[]): string {
  return execFileSync("npm", ["run", "--silent", "analyze", "--", ...argv], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

main();
