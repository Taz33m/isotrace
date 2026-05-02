import { performance } from "node:perf_hooks";
import { analyzeHistory } from "../core/analyzer";
import type { History, Transaction } from "../core/types";

interface BenchRow {
  transactions: number;
  keys: number;
  edges: number;
  cycles: number;
  durationMs: number;
}

const sizes = [
  { transactions: 25, keys: 5 },
  { transactions: 100, keys: 10 },
  { transactions: 250, keys: 25 },
  { transactions: 500, keys: 50 },
];

function generatedHistory(txCount: number, keyCount: number): History {
  const initialWrites = Array.from({ length: keyCount }, (_, index) => ({
    type: "write" as const,
    key: `k${index}`,
    value: 0,
  }));
  const transactions: Transaction[] = [{ id: "T0", label: "initial", commit: 0, ops: initialWrites }];
  const lastWriter = new Map<string, string>();
  const lastValue = new Map<string, number>();

  for (let key = 0; key < keyCount; key += 1) {
    lastWriter.set(`k${key}`, "T0");
    lastValue.set(`k${key}`, 0);
  }

  for (let index = 1; index <= txCount; index += 1) {
    const key = `k${index % keyCount}`;
    const previous = lastWriter.get(key) ?? "T0";
    const value = (lastValue.get(key) ?? 0) + 1;
    const id = `T${index}`;
    transactions.push({
      id,
      label: `generated tx ${index}`,
      process: `p${index % 8}`,
      begin: index * 2 - 1,
      commit: index * 2,
      ops: [
        { type: "read", key, value: value - 1, from: previous },
        { type: "write", key, value },
      ],
    });
    lastWriter.set(key, id);
    lastValue.set(key, value);
  }

  return {
    name: `generated_${txCount}_tx_${keyCount}_keys`,
    description: "Deterministic serial history used to benchmark graph construction and cycle search.",
    mode: "serializable",
    transactions,
  };
}

function runBench(): BenchRow[] {
  return sizes.map(({ transactions, keys }) => {
    const history = generatedHistory(transactions, keys);
    const started = performance.now();
    const result = analyzeHistory(history);
    const durationMs = performance.now() - started;
    return {
      transactions: result.nodes.length,
      keys,
      edges: result.edges.length,
      cycles: result.cycles.length,
      durationMs,
    };
  });
}

const rows = runBench();
console.log("IsoTrace benchmark: generated serial histories");
console.log("transactions\tkeys\tedges\tcycles\tduration_ms");
for (const row of rows) {
  console.log(`${row.transactions}\t${row.keys}\t${row.edges}\t${row.cycles}\t${row.durationMs.toFixed(3)}`);
}
