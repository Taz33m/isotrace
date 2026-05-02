import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeHistory } from "./core/analyzer";
import { parseHistoryJson } from "./core/artifacts";
import { explainResult } from "./core/explain";
import { makeAnalysisReport } from "./core/report";
import type { History } from "./core/types";
import type { NormalizedHistory } from "./core/validate";
import { HistoryValidationError } from "./core/validate";

const MAX_HISTORY_BYTES = 512 * 1024;

interface CliArgs {
  file: string;
  strict: boolean;
  json: boolean;
  failOnViolation: boolean;
  validate: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }
  const allowedFlags = new Set(["--strict", "--json", "--fail-on-violation", "--validate"]);
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
  if (positional.length !== 1) {
    throw new HistoryValidationError(`expected exactly one history file, got ${positional.length}`);
  }
  return {
    file: positional[0] ?? "",
    strict: args.includes("--strict"),
    json: args.includes("--json"),
    failOnViolation: args.includes("--fail-on-violation"),
    validate: args.includes("--validate"),
  };
}

function printHelp(): void {
  console.log(`IsoTrace transaction-history analyzer

Usage:
  npm run analyze -- <history.json> [--strict] [--json] [--fail-on-violation] [--validate]

Examples:
  npm run demo
  npm run demo:strict
  npm run analyze -- examples/valid_history.json --validate
  npm run analyze -- fixtures/write_skew_doctors.json --json

Notes:
  --validate checks schema shape and IsoTrace semantic constraints without running analysis.
  --json prints the full input history in the analysis result.
`);
}

function main(): void {
  try {
    const args = parseArgs(process.argv);
    const filePath = resolve(process.cwd(), args.file);
    const stats = statSync(filePath);
    if (!stats.isFile()) {
      throw new HistoryValidationError(`${args.file} is not a file`);
    }
    if (stats.size > MAX_HISTORY_BYTES) {
      throw new HistoryValidationError(`${args.file} is ${stats.size} bytes; max supported history size is ${MAX_HISTORY_BYTES} bytes`);
    }

    const inputBytes = readFileSync(filePath);
    const { history, normalized } = parseHistoryJson(inputBytes.toString("utf8"), { strict: args.strict });
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
