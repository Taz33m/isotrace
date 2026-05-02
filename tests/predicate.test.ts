import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeHistory } from "../src/core/analyzer";
import { validateAnalysisReportArtifact, validateHistoryArtifact } from "../src/core/artifacts";
import { evaluatePredicate, evaluatePredicateTruth } from "../src/core/predicate";
import { makeAnalysisReport } from "../src/core/report";
import type { History, PredicateExpression } from "../src/core/types";
import phantomPredicateCycle from "../fixtures/phantom_predicate_cycle.json";
import compositePredicateDeleteCycle from "../fixtures/composite_predicate_delete_cycle.json";

describe("explicit predicate reads", () => {
  it("evaluates supported predicate objects deterministically", () => {
    expect(evaluatePredicate({ id: "alice", on_call: true, age: 41, name: "alice" }, { column: "on_call", op: "=", value: true })).toBe(true);
    expect(evaluatePredicate({ id: "alice", on_call: true }, { column: "on_call", op: "!=", value: false })).toBe(true);
    expect(evaluatePredicate({ id: "alice", age: 41 }, { column: "age", op: ">", value: 40 })).toBe(true);
    expect(evaluatePredicate({ id: "alice", age: 41 }, { column: "age", op: "<=", value: 41 })).toBe(true);
    expect(evaluatePredicate({ id: "alice", name: "alice" }, { column: "name", op: "<", value: "bob" })).toBe(true);
    expect(evaluatePredicate({ id: "alice", age: "41" }, { column: "age", op: ">", value: 40 })).toBe(false);
  });

  it("evaluates composite predicates and preserves unknown predicate truth", () => {
    const predicate: PredicateExpression = {
      all: [
        { column: "on_call", op: "=", value: true },
        { any: [{ column: "role", op: "=", value: "attending" }, { column: "role", op: "=", value: "resident" }] },
        { not: { column: "suspended", op: "=", value: true } },
      ],
    };
    expect(evaluatePredicate({ id: "alice", on_call: true, role: "attending", suspended: false }, predicate)).toBe(true);
    expect(evaluatePredicate({ id: "alice", on_call: true, role: "fellow", suspended: false }, predicate)).toBe(false);
    expect(evaluatePredicateTruth({ id: "alice", on_call: true, role: "attending" }, predicate)).toBe("unknown");
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

  it("rejects empty and mixed composite predicate forms", () => {
    expect(() =>
      analyzeHistory(
        predicateHistory({
          predicate: {
            type: "predicate-read",
            table: "doctors",
            predicate: { all: [] },
            returnedRows: [{ id: "alice", on_call: true }],
          } as unknown as History["transactions"][number]["ops"][number],
        }),
      ),
    ).toThrow("T1 predicate-read at op 0 requires non-empty predicate.all");

    expect(() =>
      analyzeHistory(
        predicateHistory({
          predicate: {
            type: "predicate-read",
            table: "doctors",
            predicate: { column: "on_call", op: "=", value: true, all: [{ column: "role", op: "=", value: "attending" }] },
            returnedRows: [{ id: "alice", on_call: true, role: "attending" }],
          } as unknown as History["transactions"][number]["ops"][number],
        }),
      ),
    ).toThrow("T1 predicate-read at op 0 must use exactly one predicate form");
  });

  it("rejects invalid mutation metadata", () => {
    expect(() =>
      analyzeHistory(
        predicateHistory({
          writerMutation: "merge" as unknown as "update",
        }),
      ),
    ).toThrow("T2 write doctors/bob/on_call relational metadata at op 0 has invalid mutation");

    expect(() =>
      analyzeHistory(
        predicateHistory({
          writerMutation: "delete",
          writerFields: null,
        }),
      ),
    ).toThrow("T2 write doctors/bob/on_call delete metadata at op 0 requires rowBefore");

    expect(() =>
      analyzeHistory(
        predicateHistory({
          writerMutation: "update",
          writerFields: { on_call: true },
          writerRowAfter: { on_call: false },
        }),
      ),
    ).toThrow("T2 write doctors/bob/on_call fields.on_call conflicts with rowAfter.on_call at op 0");
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
        predicateProof: {
          mutation: "insert",
          before: { matches: false, row: null, source: "none" },
          after: { matches: true, row: { id: "bob", on_call: true }, source: "fields" },
        },
      },
    ]);
  });

  it("attaches update proof rows to fixture prw edges", () => {
    const result = analyzeHistory(phantomPredicateCycle as History);
    const edge = result.edges.find((candidate) => candidate.kind === "prw" && candidate.rowId === "bob");
    expect(edge?.predicateProof).toMatchObject({
      table: "doctors",
      rowId: "bob",
      mutation: "update",
      before: { matches: true, row: { id: "bob", on_call: false }, source: "returnedRows" },
      after: { matches: false, row: { id: "bob", on_call: true }, source: "fields" },
    });
    expect(result.verdict.evidence.proofEdges.find((proofEdge) => proofEdge.edgeId === edge?.id)?.predicateProof).toEqual(edge?.predicateProof);
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

  it("does not create prw when predicate membership is unknown", () => {
    const result = analyzeHistory(
      predicateHistory({
        predicate: {
          type: "predicate-read",
          table: "doctors",
          predicate: { column: "specialty", op: "=", value: "cardiology" },
          returnedRows: [],
        },
        writerFields: { on_call: true },
      }),
    );
    expect(result.edges.some((edge) => edge.kind === "prw")).toBe(false);
    expect(result.verdict.evidence.proofEdges.some((proofEdge) => proofEdge.predicateProof)).toBe(false);
    expect(result.validationNotes).toContain('doctors/bob/on_call row evidence is missing columns for predicate specialty = "cardiology"; no prw edge inferred for doctors/"bob".');
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

  it("classifies the composite delete fixture as a predicate dependency cycle", () => {
    const result = analyzeHistory(compositePredicateDeleteCycle as History);
    expect(result.ok).toBe(false);
    expect(result.verdict.anomaly).toEqual({ label: "predicate-dependency-cycle", title: "Explicit predicate phantom" });
    expect(result.verdict.evidence.edgeKinds).toEqual(["prw", "prw"]);
    expect(result.edges.filter((edge) => edge.kind === "prw")).toMatchObject([
      {
        from: "T1",
        to: "T2",
        mutation: "delete",
        predicateChange: { beforeMatches: true, afterMatches: false, mutation: "delete" },
        predicateProof: {
          before: { matches: true, row: { id: "alice", on_call: true, role: "attending" }, source: "returnedRows" },
          after: { matches: false, row: null, source: "delete" },
        },
      },
      {
        from: "T2",
        to: "T1",
        mutation: "delete",
        predicateChange: { beforeMatches: true, afterMatches: false, mutation: "delete" },
        predicateProof: {
          before: { matches: true, row: { id: "bob", on_call: true, role: "resident" }, source: "returnedRows" },
          after: { matches: false, row: null, source: "delete" },
        },
      },
    ]);
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
    expect(validated.result.verdict.evidence.proofEdges[0].predicateProof?.before.source).toBe("returnedRows");
    expect(validated.result.verdict.evidence.proofEdges[0].predicateProof?.after.source).toBe("fields");

    const compositeReport = makeAnalysisReport({
      argv: ["fixtures/composite_predicate_delete_cycle.json", "--json"],
      cwd: process.cwd(),
      generatedAt: "2026-05-02T00:00:00.000Z",
      inputPath: join(process.cwd(), "fixtures/composite_predicate_delete_cycle.json"),
      inputBytes: readFileSync("fixtures/composite_predicate_delete_cycle.json"),
      result: analyzeHistory(compositePredicateDeleteCycle as History),
    });
    const validatedComposite = validateAnalysisReportArtifact(compositeReport);
    expect(validatedComposite.result.verdict.evidence.proofEdges[0].summary).toContain("delete changed row");
    expect(validatedComposite.result.verdict.evidence.proofEdges[0].predicateProof?.after).toEqual({
      matches: false,
      row: null,
      source: "delete",
    });
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
    expect(output).toContain('before: source=returnedRows; matches=true; row={"id":"bob","on_call":false}');
    expect(output).toContain('after: source=fields; matches=false; row={"on_call":true,"id":"bob"}');

    const composite = execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "fixtures/composite_predicate_delete_cycle.json"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(composite).toContain("Anomaly: Explicit predicate phantom [predicate-dependency-cycle]");
    expect(composite).toContain("Proof edges: e3 -> e4 (prw -> prw)");
    expect(composite).toContain('where (on_call = true AND role = "attending") returned row "alice"');
    expect(composite).toContain('delete changed row "alice"');
    expect(composite).toContain('after: source=delete; matches=false; row=null');
  });
});

function predicateHistory(options: {
  predicate?: History["transactions"][number]["ops"][number];
  readerStatus?: "committed" | "aborted";
  writerFields?: Record<string, boolean> | null;
  writerMutation?: "insert" | "update" | "delete";
  writerRowAfter?: Record<string, boolean>;
  writerRowBefore?: Record<string, boolean>;
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
            mutation: options.writerMutation,
            fields: options.writerFields === null ? undefined : options.writerFields ?? { on_call: true },
            rowBefore: options.writerRowBefore,
            rowAfter: options.writerRowAfter,
          },
        ],
      },
    ],
  };
}
