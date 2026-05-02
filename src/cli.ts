import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeHistory } from "./core/analyzer";
import { explainResult } from "./core/explain";
import type { History } from "./core/types";
import { HistoryValidationError } from "./core/validate";

const MAX_HISTORY_BYTES = 512 * 1024;

interface CliArgs {
  file: string;
  strict: boolean;
  json: boolean;
  failOnViolation: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }
  const allowedFlags = new Set(["--strict", "--json", "--fail-on-violation"]);
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
  };
}

function printHelp(): void {
  console.log(`IsoTrace transaction-history analyzer

Usage:
  npm run analyze -- <history.json> [--strict] [--json] [--fail-on-violation]

Examples:
  npm run demo
  npm run demo:strict
  npm run analyze -- fixtures/write_skew_doctors.json --json

Notes:
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

    const history = JSON.parse(readFileSync(filePath, "utf8")) as History;
    const result = analyzeHistory(history, { strict: args.strict });
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
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
