import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { arch, platform, release } from "node:os";
import packageJson from "../../package.json";
import type { AnalysisResult } from "./types";

export const REPORT_SCHEMA_VERSION = "isotrace.report.v1";

export interface ReportCommand {
  argv: string[];
  cwd: string;
}

export interface ReportRuntime {
  node: string;
  platform: string;
  arch: string;
  osRelease: string;
}

export interface ReportGit {
  commit: string | null;
  dirty: boolean | null;
}

export interface ReportEnvelope {
  schema: typeof REPORT_SCHEMA_VERSION;
  generatedAt: string;
  tool: {
    name: string;
    version: string;
  };
  command: ReportCommand;
  runtime: ReportRuntime;
  git: ReportGit;
}

export interface InputProvenance {
  path: string;
  bytes: number;
  sha256: string;
}

export interface AnalysisReport {
  report: ReportEnvelope;
  input: InputProvenance;
  result: AnalysisResult;
}

export interface BenchmarkReport<Row> {
  report: ReportEnvelope;
  benchmark: {
    name: string;
    description: string;
    settings: {
      sizes: Array<{ transactions: number; keys: number }>;
      iterations: number;
    };
    rows: Row[];
  };
}

export function makeAnalysisReport(options: {
  argv: string[];
  cwd: string;
  generatedAt?: string;
  inputPath: string;
  inputBytes: Buffer;
  result: AnalysisResult;
}): AnalysisReport {
  return {
    report: makeReportEnvelope({
      argv: options.argv,
      cwd: options.cwd,
      generatedAt: options.generatedAt,
    }),
    input: {
      path: options.inputPath,
      bytes: options.inputBytes.byteLength,
      sha256: sha256(options.inputBytes),
    },
    result: options.result,
  };
}

export function makeBenchmarkReport<Row>(options: {
  argv: string[];
  cwd: string;
  generatedAt?: string;
  sizes: Array<{ transactions: number; keys: number }>;
  rows: Row[];
  iterations?: number;
}): BenchmarkReport<Row> {
  return {
    report: makeReportEnvelope({
      argv: options.argv,
      cwd: options.cwd,
      generatedAt: options.generatedAt,
    }),
    benchmark: {
      name: "generated-serial-histories",
      description: "Deterministic graph-construction and cycle-search smoke benchmark.",
      settings: {
        sizes: options.sizes,
        iterations: options.iterations ?? 1,
      },
      rows: options.rows,
    },
  };
}

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeReportEnvelope(options: { argv: string[]; cwd: string; generatedAt?: string }): ReportEnvelope {
  return {
    schema: REPORT_SCHEMA_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    tool: {
      name: packageJson.name,
      version: packageJson.version,
    },
    command: {
      argv: options.argv,
      cwd: options.cwd,
    },
    runtime: {
      node: process.version,
      platform: platform(),
      arch: arch(),
      osRelease: release(),
    },
    git: gitMetadata(options.cwd),
  };
}

function gitMetadata(cwd: string): ReportGit {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().length > 0;
    return { commit, dirty };
  } catch {
    return { commit: null, dirty: null };
  }
}
