import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeHistory } from "../src/core/analyzer";
import { validateAnalysisReportArtifact, validateHistoryArtifact } from "../src/core/artifacts";
import { evaluatePredicate } from "../src/core/predicate";
import { makeAnalysisReport } from "../src/core/report";
import type { History } from "../src/core/types";
import phantomPredicateCycle from "../fixtures/phantom_predicate_cycle.json";

describe("explicit predicate reads", () => {
  it("evaluates supported predicate objects deterministically", () => {
    expect(evaluatePredicate({ id: "alice", on_call: true, age: 41, name: "alice" }, { column: "on_call", op: "=", value: true })).toBe(true);
    expect(evaluatePredicate({ id: "alice", on_call: true }, { column: "on_call", op: "!=", value: false })).toBe(true);
    expect(evaluatePredicate({ id: "alice", age: 41 }, { column: "age", op: ">", value: 40 })).toBe(true);
    expect(evaluatePredicate({ id: "alice", age: 41 }, { column: "age", op: "<=", value: 41 })).toBe(true);
    expect(evaluatePredicate({ id: "alice", name: "alice" }, { column: "name", op: "<", value: "bob" })).toBe(true);
    expect(evaluatePredicate({ id: "alice", age: "41" }, { column: "age", op: ">", value: 40 })).toBe(false);
  });

  it("rejects unsupported predicate operators", () => {
    const history = predicateHistory({
      predicate: {
        type: "predicate-read",
        table: "doctors",
        predicate: { column: "on_call", op: "contains", value: true },
        returnedRows: [{ id: "alice", on_call: true }],
      } as unknown as History["transactions"][number]["ops"][number],
    });
    expect(() => validateHistoryArtifact(history)).toThrow("/transactions/1/ops/0/predicate/op must be one of =, !=, <, <=, >, >=");
  });

  it("rejects returned rows that do not satisfy the predicate", () => {
    const history = predicateHistory({
      predicate: {
        type: "predicate-read",
        table: "doctors",
        predicate: { column: "on_call", op: "=", value: true },
        returnedRows: [{ id: "alice", on_call: false }],
      },
    });
    expect(() => validateHistoryArtifact(history)).toThrow('T1 predicate-read doctors row "alice" does not satisfy predicate on_call = true');
  });

  it("creates a prw edge when an absent row later matches the predicate", () => {
    const result = analyzeHistory(predicateHistory());
    expect(result.edges.filter((edge) => edge.kind === "prw")).toMatchObject([
      {
        from: "T1",
        to: "T2",
        key: "doctors/bob",
        table: "doctors",
        rowId: "bob",
        predicate: { column: "on_call", op: "=", value: true },
        predicateChange: { beforeMatches: false, afterMatches: true },
      },
    ]);
  });

  it("does not create prw when row membership does not change", () => {
    const result = analyzeHistory(
      predicateHistory({
        writerFields: { on_call: false },
        writerValue: false,
      }),
    );
    expect(result.edges.some((edge) => edge.kind === "prw")).toBe(false);
  });

  it("does not create prw from writes committed before a timestamped predicate read begins", () => {
    const result = analyzeHistory(
      predicateHistory({
        writerBegin: 0.25,
        writerCommit: 0.5,
      }),
    );
    expect(result.edges.some((edge) => edge.kind === "prw")).toBe(false);
  });

  it("does not create prw from aborted transactions", () => {
    const history = predicateHistory({ writerStatus: "aborted" });
    const result = analyzeHistory(history);
    expect(result.ignoredTransactions).toEqual(["T2"]);
    expect(result.edges.some((edge) => edge.kind === "prw")).toBe(false);

    const abortedReader = analyzeHistory(predicateHistory({ readerStatus: "aborted" }));
    expect(abortedReader.ignoredTransactions).toEqual(["T1"]);
    expect(abortedReader.edges.some((edge) => edge.kind === "prw")).toBe(false);
  });

  it("does not duplicate prw when a point-read rw edge already captures the same row", () => {
    const history: History = {
      name: "predicate-point-read-overlap",
      description: "A point read already captures the row-level anti-dependency.",
      transactions: [
        {
          id: "T0",
          commit: 0,
          ops: [
            {
              type: "write",
              key: "doctors/alice/on_call",
              value: true,
              table: "doctors",
              rowId: "alice",
              fields: { on_call: true },
            },
          ],
        },
        {
          id: "T1",
          begin: 1,
          commit: 2,
          ops: [
            {
              type: "predicate-read",
              table: "doctors",
              predicate: { column: "on_call", op: "=", value: true },
              returnedRows: [{ id: "alice", on_call: true }],
            },
            { type: "read", key: "doctors/alice/on_call", value: true, from: "T0" },
          ],
        },
        {
          id: "T2",
          begin: 1.5,
          commit: 3,
          ops: [
            {
              type: "write",
              key: "doctors/alice/on_call",
              value: false,
              table: "doctors",
              rowId: "alice",
              fields: { on_call: false },
            },
          ],
        },
      ],
    };
    const result = analyzeHistory(history);
    expect(result.edges.filter((edge) => edge.kind === "rw")).toHaveLength(1);
    expect(result.edges.filter((edge) => edge.kind === "prw")).toHaveLength(0);
  });

  it("classifies the phantom fixture as a predicate dependency cycle", () => {
    const result = analyzeHistory(phantomPredicateCycle as History);
    expect(result.ok).toBe(false);
    expect(result.verdict.anomaly).toEqual({ label: "predicate-dependency-cycle", title: "Explicit predicate phantom" });
    expect(result.verdict.implicatedTransactions).toEqual(["T1", "T2"]);
    expect(result.verdict.evidence.edgeKinds).toEqual(["prw", "prw"]);
    expect(result.kindCounts.prw).toBe(2);
  });

  it("validates reports with prw proof facts", () => {
    const inputBytes = readFileSync("fixtures/phantom_predicate_cycle.json");
    const report = makeAnalysisReport({
      argv: ["fixtures/phantom_predicate_cycle.json", "--json"],
      cwd: process.cwd(),
      generatedAt: "2026-05-02T00:00:00.000Z",
      inputPath: join(process.cwd(), "fixtures/phantom_predicate_cycle.json"),
      inputBytes,
      result: analyzeHistory(phantomPredicateCycle as History),
    });
    const validated = validateAnalysisReportArtifact(report);
    expect(validated.result.verdict.evidence.proofEdges[0].summary).toContain("predicate-read/write anti-dependency");
  });

  it("prints predicate anomaly proof details in CLI output", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "fixtures/phantom_predicate_cycle.json"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(output).toContain("Anomaly: Explicit predicate phantom [predicate-dependency-cycle]");
    expect(output).toContain("Proof edges: e3 -> e4 (prw -> prw)");
    expect(output).toContain('predicate-read doctors where on_call = false returned row "bob"');
    expect(output).toContain("predicate-read/write anti-dependency");
  });
});

function predicateHistory(options: {
  predicate?: History["transactions"][number]["ops"][number];
  readerStatus?: "committed" | "aborted";
  writerFields?: Record<string, boolean>;
  writerValue?: boolean;
  writerBegin?: number;
  writerCommit?: number;
  writerStatus?: "committed" | "aborted";
} = {}): History {
  return {
    name: "predicate-history",
    description: "small predicate-read history",
    transactions: [
      {
        id: "T0",
        commit: 0,
        ops: [
          {
            type: "write",
            key: "doctors/alice/on_call",
            value: true,
            table: "doctors",
            rowId: "alice",
            fields: { on_call: true },
          },
          {
            type: "write",
            key: "doctors/bob/on_call",
            value: false,
            table: "doctors",
            rowId: "bob",
            fields: { on_call: false },
          },
        ],
      },
      {
        id: "T1",
        begin: 1,
        commit: 2,
        status: options.readerStatus,
        ops: [
          options.predicate ?? {
            type: "predicate-read",
            table: "doctors",
            predicate: { column: "on_call", op: "=", value: true },
            returnedRows: [{ id: "alice", on_call: true }],
          },
        ],
      },
      {
        id: "T2",
        begin: options.writerBegin ?? 1.5,
        commit: options.writerCommit ?? 3,
        status: options.writerStatus,
        ops: [
          {
            type: "write",
            key: "doctors/bob/on_call",
            value: options.writerValue ?? true,
            table: "doctors",
            rowId: "bob",
            fields: options.writerFields ?? { on_call: true },
          },
        ],
      },
    ],
  };
}
