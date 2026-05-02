import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { analyzeHistory } from "./core/analyzer";
import { parseHistoryJson, validateHistoryArtifact } from "./core/artifacts";
import { explainResult } from "./core/explain";
import { makeAnalysisReport } from "./core/report";
import type { History } from "./core/types";
import type { NormalizedHistory } from "./core/validate";
import { HistoryValidationError } from "./core/validate";
import { makeFixtureCatalog } from "./fixtures/manifest";
import { parseSqlTrace } from "./sql/trace";

const MAX_HISTORY_BYTES = 512 * 1024;

interface CliArgs {
  command: "analyze" | "fixtures";
  file?: string;
  strict: boolean;
  json: boolean;
  failOnViolation: boolean;
  validate: boolean;
  sqlTrace: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }
  const allowedFlags = new Set(["--strict", "--json", "--fail-on-violation", "--validate", "--fixtures", "--sql-trace"]);
  const positional: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("-")) {
      if (!allowedFlags.has(arg)) {
        throw new HistoryValidationError(`unknown flag ${arg}`);
      }
    } else {
      positional.push(arg);
    }
  }
  const listFixtures = args.includes("--fixtures");
  if (listFixtures) {
    const incompatible = args.filter((arg) => arg.startsWith("-") && arg !== "--fixtures" && arg !== "--json");
    if (incompatible.length > 0) {
      throw new HistoryValidationError(`--fixtures only accepts --json, got ${incompatible.join(", ")}`);
    }
    if (positional.length !== 0) {
      throw new HistoryValidationError(`--fixtures does not accept a history file, got ${positional.length}`);
    }
    return {
      command: "fixtures",
      strict: false,
      json: args.includes("--json"),
      failOnViolation: false,
      validate: false,
      sqlTrace: false,
    };
  }

  if (positional.length !== 1) {
    throw new HistoryValidationError(`expected exactly one history file, got ${positional.length}`);
  }
  return {
    command: "analyze",
    file: positional[0] ?? "",
    strict: args.includes("--strict"),
    json: args.includes("--json"),
    failOnViolation: args.includes("--fail-on-violation"),
    validate: args.includes("--validate"),
    sqlTrace: args.includes("--sql-trace"),
  };
}

function printHelp(): void {
  console.log(`IsoTrace transaction-history analyzer

Usage:
  npm run analyze -- <history.json> [--strict] [--json] [--fail-on-violation] [--validate]
  npm run analyze -- <trace.sql> --sql-trace [--strict] [--json] [--fail-on-violation] [--validate]
  npm run analyze -- --fixtures [--json]

Examples:
  npm run demo
  npm run demo:strict
  npm run analyze -- --fixtures
  npm run analyze -- examples/valid_history.json --validate
  npm run analyze -- fixtures/write_skew_doctors.json --json
  npm run analyze -- examples/write_skew_sql_trace.sql --sql-trace

Notes:
  --fixtures lists the checked-in demo histories, expected verdict contracts, and reproduction commands.
  --validate checks schema shape and IsoTrace semantic constraints without running analysis.
  --sql-trace imports constrained SQL trace syntax before analysis.
  --json prints the full input history in the analysis result.
`);
}

function main(): void {
  try {
    const args = parseArgs(process.argv);
    if (args.command === "fixtures") {
      printFixtureCatalog(args.json);
      return;
    }
    const file = args.file ?? "";
    const filePath = resolve(process.cwd(), file);
    const stats = statSync(filePath);
    if (!stats.isFile()) {
      throw new HistoryValidationError(`${file} is not a file`);
    }
    if (stats.size > MAX_HISTORY_BYTES) {
      throw new HistoryValidationError(`${file} is ${stats.size} bytes; max supported history size is ${MAX_HISTORY_BYTES} bytes`);
    }

    const inputBytes = readFileSync(filePath);
    const inputText = inputBytes.toString("utf8");
    const { history, normalized } = args.sqlTrace
      ? validateHistoryArtifact(parseSqlTrace(inputText, basename(file)), { strict: args.strict })
      : parseHistoryJson(inputText, { strict: args.strict });
    if (args.validate) {
      printValidationResult(history, normalized, args.json);
      return;
    }

    const result = analyzeHistory(history, { strict: args.strict });
    if (args.json) {
      console.log(
        JSON.stringify(
          makeAnalysisReport({
            argv: process.argv.slice(2),
            cwd: process.cwd(),
            inputPath: filePath,
            inputBytes,
            result,
          }),
          null,
          2,
        ),
      );
    } else {
      console.log(explainResult(result));
    }
    if (!result.ok && args.failOnViolation) {
      process.exitCode = 2;
    }
  } catch (error) {
    if (error instanceof HistoryValidationError) {
      console.error(`Invalid history: ${error.message}`);
    } else if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error(String(error));
    }
    process.exitCode = 1;
  }
}

main();

function printFixtureCatalog(json: boolean): void {
  const catalog = makeFixtureCatalog();
  if (json) {
    console.log(JSON.stringify(catalog, null, 2));
    return;
  }

  console.log("IsoTrace fixture catalog");
  console.log(`Fixtures: ${catalog.count}`);
  for (const fixture of catalog.fixtures) {
    const implicated = fixture.implicatedTransactions.length > 0 ? fixture.implicatedTransactions.join(", ") : "none";
    const proofEdges = fixture.proof.edgeKinds.length > 0 ? fixture.proof.edgeKinds.join(" -> ") : "none";
    console.log(`- ${fixture.historyName}`);
    console.log(`  path: ${fixture.path}`);
    console.log(`  command: ${fixture.command}`);
    console.log(
      `  verdict: ${fixture.anomaly}; ok=${String(fixture.ok)}; serializable=${fixture.serializable}; strict=${fixture.strictSerializable}`,
    );
    console.log(`  implicated: ${implicated}`);
    console.log(`  proof: ${fixture.proof.evidenceKind}; edgeKinds=${proofEdges}; cycles=${fixture.proof.cycleCount}`);
  }
}

function printValidationResult(history: History, normalized: NormalizedHistory, json: boolean): void {
  const payload = {
    ok: true,
    schema: "https://isotrace.dev/schemas/history.schema.json",
    history: {
      name: history.name,
      transactions: history.transactions.length,
      committed: normalized.committed.length,
      ignored: normalized.ignored.length,
    },
    validationNotes: normalized.notes,
  };
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log(`Valid history: ${history.name}`);
  console.log(`Schema: ${payload.schema}`);
  console.log(`Transactions: ${payload.history.transactions} (${payload.history.committed} committed, ${payload.history.ignored} ignored)`);
  if (payload.validationNotes.length > 0) {
    console.log("Notes:");
    for (const note of payload.validationNotes) console.log(`- ${note}`);
  }
}
