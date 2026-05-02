import { describe, expect, it } from "vitest";
import { analyzeHistory } from "../src/core/analyzer";
import type { History } from "../src/core/types";
import { HistoryValidationError } from "../src/core/validate";
import writeSkewDoctors from "../fixtures/write_skew_doctors.json";
import serialStockDecrement from "../fixtures/serial_stock_decrement.json";
import staleReadStrict from "../fixtures/stale_read_strict.json";
import strictSerialHandoff from "../fixtures/strict_serial_handoff.json";
import abortedWriteIgnored from "../fixtures/aborted_write_ignored.json";

describe("IsoTrace analyzer", () => {
  it("detects write skew as an rw dependency cycle", () => {
    const result = analyzeHistory(writeSkewDoctors as History);
    expect(result.ok).toBe(false);
    expect(result.cycles).toHaveLength(1);
    expect(result.cycles[0].classification).toBe("serializability");
    expect(result.cycles[0].edges.map((edge) => `${edge.from}->${edge.to}:${edge.kind}`).sort()).toEqual(["T1->T2:rw", "T2->T1:rw"]);
  });

  it("accepts a serial stock decrement history", () => {
    const result = analyzeHistory(serialStockDecrement as History);
    expect(result.ok).toBe(true);
    expect(result.cycles).toHaveLength(0);
    expect(result.kindCounts.rw).toBeGreaterThan(0);
    expect(result.orderWitness?.transactions).toEqual(["T0", "T1", "T2"]);
    expect(result.orderWitness?.edgeIds).toHaveLength(result.edges.length);
    expectOrderSatisfiesEdges(result.orderWitness?.transactions ?? [], result.edges.map((edge) => [edge.from, edge.to]));
  });

  it("distinguishes serializable from strict-serializable stale reads", () => {
    const serializable = analyzeHistory(staleReadStrict as History);
    const strict = analyzeHistory(staleReadStrict as History, { strict: true });
    const explicitSerializable = analyzeHistory({ ...(staleReadStrict as History), mode: "serializable" });
    expect(serializable.ok).toBe(false);
    expect(explicitSerializable.ok).toBe(true);
    expect(strict.ok).toBe(false);
    expect(strict.cycles[0].classification).toBe("strict-serializability");
    expect(strict.cycles[0].edges.some((edge) => edge.kind === "rt")).toBe(true);
  });

  it("accepts a clean strict-serializable handoff with realtime edges", () => {
    const result = analyzeHistory(strictSerialHandoff as History, { strict: true });
    expect(result.ok).toBe(true);
    expect(result.kindCounts.rt).toBe(1);
    expect(result.verdict.strictSerializable.status).toBe("pass");
    expect(result.verdict.anomaly.label).toBe("valid-serial-history");
    expect(result.orderWitness?.mode).toBe("strict-serializable");
    expect(result.orderWitness?.transactions).toEqual(["T0", "T1", "T2"]);
    expectOrderSatisfiesEdges(result.orderWitness?.transactions ?? [], result.edges.map((edge) => [edge.from, edge.to]));
  });

  it("ignores aborted transactions when constructing committed-version order", () => {
    const result = analyzeHistory(abortedWriteIgnored as History);
    expect(result.ok).toBe(true);
    expect(result.ignoredTransactions).toEqual(["T1"]);
    expect(result.edges.some((edge) => edge.from === "T1" || edge.to === "T1")).toBe(false);
    expect(result.orderWitness?.transactions).toEqual(["T0", "T2"]);
  });

  it("rejects reads from writers that do not write the key", () => {
    const badHistory: History = {
      name: "bad",
      description: "bad",
      transactions: [
        { id: "T0", commit: 0, ops: [{ type: "write", key: "x", value: 1 }] },
        { id: "T1", begin: 1, commit: 2, ops: [{ type: "read", key: "y", value: 1, from: "T0" }] },
      ],
    };
    expect(() => analyzeHistory(badHistory)).toThrow(HistoryValidationError);
  });

  it("rejects reads whose value does not match the referenced version", () => {
    const badHistory: History = {
      name: "bad-read-value",
      description: "bad",
      transactions: [
        { id: "T0", commit: 0, ops: [{ type: "write", key: "x", value: 1 }] },
        { id: "T1", begin: 1, commit: 2, ops: [{ type: "read", key: "x", value: 99, from: "T0" }] },
      ],
    };
    expect(() => analyzeHistory(badHistory)).toThrow(/wrote 1/);
  });

  it("accepts structurally equal JSON object values regardless of key order", () => {
    const history: History = {
      name: "object-key-order",
      description: "object key order should not affect read provenance",
      transactions: [
        {
          id: "T0",
          commit: 0,
          ops: [{ type: "write", key: "doc", value: { a: 1, b: { c: true, d: [1, 2] } } }],
        },
        {
          id: "T1",
          begin: 1,
          commit: 2,
          ops: [{ type: "read", key: "doc", value: { b: { d: [1, 2], c: true }, a: 1 }, from: "T0" }],
        },
      ],
    };
    expect(analyzeHistory(history).ok).toBe(true);
  });

  it("accepts self-reads only after the referenced write appears in operation order", () => {
    const validSelfRead: History = {
      name: "valid-self-read",
      description: "a transaction can read its own earlier write",
      transactions: [
        {
          id: "T0",
          commit: 0,
          ops: [{ type: "write", key: "x", value: 0 }],
        },
        {
          id: "T1",
          begin: 1,
          commit: 2,
          ops: [
            { type: "write", key: "scratch", value: { ok: true } },
            { type: "read", key: "scratch", value: { ok: true }, from: "T1" },
          ],
        },
      ],
    };
    expect(analyzeHistory(validSelfRead).ok).toBe(true);

    const futureSelfRead: History = {
      name: "future-self-read",
      description: "a transaction cannot read its own future write",
      transactions: [
        {
          id: "T0",
          commit: 0,
          ops: [{ type: "write", key: "x", value: 0 }],
        },
        {
          id: "T1",
          begin: 1,
          commit: 2,
          ops: [
            { type: "read", key: "scratch", value: 1, from: "T1" },
            { type: "write", key: "scratch", value: 1 },
          ],
        },
      ],
    };
    expect(() => analyzeHistory(futureSelfRead)).toThrow(/reads scratch from its own write before that write appears/);
  });

  it("rejects repeated writes to the same key in one transaction", () => {
    const badHistory: History = {
      name: "bad-repeated-write",
      description: "bad",
      transactions: [
        {
          id: "T0",
          commit: 0,
          ops: [
            { type: "write", key: "x", value: 1 },
            { type: "write", key: "x", value: 2 },
          ],
        },
      ],
    };
    expect(() => analyzeHistory(badHistory)).toThrow(/writes x more than once/);
  });

  it("rejects malformed status and ambiguous commit order", () => {
    const badStatus = {
      name: "bad-status",
      description: "bad",
      transactions: [{ id: "T0", status: "rolled-back", commit: 0, ops: [{ type: "write", key: "x", value: 1 }] }],
    } as unknown as History;
    expect(() => analyzeHistory(badStatus)).toThrow(/status must be/);

    const ambiguousCommit: History = {
      name: "bad-commit",
      description: "bad",
      transactions: [
        { id: "T0", commit: 0, ops: [{ type: "write", key: "x", value: 0 }] },
        { id: "T1", begin: 1, commit: 2, ops: [{ type: "write", key: "x", value: 1 }] },
        { id: "T2", begin: 1, commit: 2, ops: [{ type: "write", key: "x", value: 2 }] },
      ],
    };
    expect(() => analyzeHistory(ambiguousCommit)).toThrow(/share commit time/);
  });

  it("allows a timestamped T0 seed with fixture-ordered non-initial transactions", () => {
    const seededFixtureOrder: History = {
      name: "seeded-fixture-order",
      description: "T0 may carry a seed timestamp while non-initial transactions use fixture order",
      transactions: [
        { id: "T0", commit: 99, ops: [{ type: "write", key: "x", value: 0 }] },
        { id: "T1", ops: [{ type: "write", key: "x", value: 1 }] },
        { id: "T2", ops: [{ type: "read", key: "x", value: 1, from: "T1" }] },
      ],
    };
    const result = analyzeHistory(seededFixtureOrder);
    expect(result.ok).toBe(true);
    expect(result.edges.some((edge) => edge.kind === "ww" && edge.from === "T0" && edge.to === "T1")).toBe(true);
    expect(result.validationNotes).toContain(
      "Version order uses fixture order for committed non-initial transactions; T0 is treated as the initial seed when present.",
    );
  });

  it("rejects mixed explicit and missing commits among non-initial transactions", () => {
    const mixedCommitOrder: History = {
      name: "mixed-commit-order",
      description: "partial non-initial commit timestamps make version order ambiguous",
      transactions: [
        { id: "T0", commit: 0, ops: [{ type: "write", key: "x", value: 0 }] },
        { id: "T1", ops: [{ type: "write", key: "x", value: 1 }] },
        { id: "T2", commit: 3, ops: [{ type: "write", key: "x", value: 2 }] },
      ],
    };
    expect(() => analyzeHistory(mixedCommitOrder)).toThrow(/non-initial transactions must either all include commit timestamps or all omit them/);
  });

  it("rejects strict analysis without complete timestamps", () => {
    const missingTimestamp: History = {
      name: "missing-strict-time",
      description: "bad",
      mode: "strict-serializable",
      transactions: [
        { id: "T0", commit: 0, ops: [{ type: "write", key: "x", value: 0 }] },
        { id: "T1", commit: 2, ops: [{ type: "read", key: "x", value: 0, from: "T0" }] },
      ],
    };
    expect(() => analyzeHistory(missingTimestamp)).toThrow(/requires numeric begin and commit/);
  });

  it("rejects transactions whose begin time is after commit time", () => {
    const badTime: History = {
      name: "bad-time",
      description: "bad",
      transactions: [{ id: "T0", begin: 3, commit: 1, ops: [{ type: "write", key: "x", value: 1 }] }],
    };
    expect(() => analyzeHistory(badTime)).toThrow(/begin 3 is after commit 1/);
  });
});

function expectOrderSatisfiesEdges(order: string[], edges: Array<[string, string]>): void {
  const positions = new Map(order.map((txId, index) => [txId, index]));
  for (const [from, to] of edges) {
    expect(positions.get(from)!).toBeLessThan(positions.get(to)!);
  }
}
