import type { CycleWitness, IsolationMode, IsolationVerdict } from "./types";
import { buildProofEdgeFact } from "./proofFacts";

export function buildIsolationVerdict(options: {
  mode: IsolationMode;
  cycles: CycleWitness[];
  serialCycles: CycleWitness[];
  ignoredTransactions: string[];
}): IsolationVerdict {
  const allCycles = stableCycles(options.cycles);
  const serialCycles = stableCycles(options.serialCycles);
  const ignoredTransactions = stableTransactionIds(options.ignoredTransactions);
  const serialCycle = serialCycles[0] ?? null;
  const writeSkewCycle = serialCycles.find(isWriteSkewCycle) ?? null;
  const strictCycle = allCycles.find((cycle) => cycle.edges.some((edge) => edge.kind === "rt")) ?? null;

  if (writeSkewCycle) {
    return writeSkewVerdict(writeSkewCycle, options.mode);
  }
  if (serialCycle) {
    return dependencyCycleVerdict(serialCycle, options.mode);
  }
  if (strictCycle && options.mode === "strict-serializable") {
    return strictRealtimeVerdict(strictCycle);
  }
  if (ignoredTransactions.length > 0) {
    return abortedIgnoredVerdict(options.mode, ignoredTransactions);
  }
  return validVerdict(options.mode);
}

function writeSkewVerdict(cycle: CycleWitness, mode: IsolationMode): IsolationVerdict {
  const txs = uniqueCycleTransactions(cycle);
  const evidence = evidenceFromCycle(cycle, "rw/rw cycle between committed transactions");
  return {
    serializable: {
      status: "fail",
      reason: "A dependency cycle exists using two read-write anti-dependencies.",
    },
    strictSerializable: {
      status: "fail",
      reason: "Strict serializability implies serializability, so a serializability failure also fails strict serializability.",
    },
    anomaly: {
      label: "write-skew",
      title: "Write skew",
    },
    implicatedTransactions: txs,
    evidence,
    summary: "Not serializable: write-skew dependency cycle.",
    explanation: `${txs.join(" and ")} each read a version that the other transaction later invalidated, closing an rw/rw cycle.`,
    inspectFirst: `Inspect ${cycle.id}, especially proof edges ${evidence.edgeIds.join(", ")}.`,
    limitations: baseLimitations(mode),
  };
}

function dependencyCycleVerdict(cycle: CycleWitness, mode: IsolationMode): IsolationVerdict {
  const txs = uniqueCycleTransactions(cycle);
  const evidence = evidenceFromCycle(cycle, "committed dependency cycle");
  return {
    serializable: {
      status: "fail",
      reason: "The dependency graph contains a committed-transaction cycle without realtime edges.",
    },
    strictSerializable: {
      status: "fail",
      reason: "Strict serializability implies serializability, so a serializability failure also fails strict serializability.",
    },
    anomaly: {
      label: "dependency-cycle",
      title: "Dependency cycle",
    },
    implicatedTransactions: txs,
    evidence,
    summary: "Not serializable: dependency cycle.",
    explanation: `No serial order can satisfy the dependency sequence ${txs.join(" -> ")}.`,
    inspectFirst: `Inspect ${cycle.id} and its edge sequence ${evidence.edgeIds.join(", ")}.`,
    limitations: baseLimitations(mode),
  };
}

function strictRealtimeVerdict(cycle: CycleWitness): IsolationVerdict {
  const txs = uniqueCycleTransactions(cycle);
  const hasReadEvidence = cycle.edges.some((edge) => edge.kind === "rw" || edge.kind === "wr");
  const label = hasReadEvidence ? "strict-stale-read" : "dependency-cycle";
  const evidence = evidenceFromCycle(cycle, hasReadEvidence ? "rt edge plus read provenance cycle" : "rt edge cycle");
  return {
    serializable: {
      status: "pass",
      reason: "No committed dependency cycle was found when realtime edges are ignored.",
    },
    strictSerializable: {
      status: "fail",
      reason: "Realtime order plus read/write dependencies forms a cycle.",
    },
    anomaly: {
      label,
      title: hasReadEvidence ? "Strict stale read" : "Strict realtime dependency cycle",
    },
    implicatedTransactions: txs,
    evidence,
    summary: hasReadEvidence ? "Serializable, but not strict-serializable: stale read across realtime order." : "Not strict-serializable: realtime cycle.",
    explanation: hasReadEvidence
      ? "A transaction read an older version even though another transaction had already committed before it began."
      : "Realtime order makes the dependency graph cyclic under strict-serializable analysis.",
    inspectFirst: `Inspect the realtime edge in ${cycle.id}, then the read/write edge that returns to the reader.`,
    limitations: baseLimitations("strict-serializable"),
  };
}

function abortedIgnoredVerdict(mode: IsolationMode, ignoredTransactions: string[]): IsolationVerdict {
  return {
    serializable: {
      status: "pass",
      reason: "No committed dependency cycle was found.",
    },
    strictSerializable: strictStatusForCleanHistory(mode),
    anomaly: {
      label: "aborted-write-ignored",
      title: "Aborted write ignored",
    },
    implicatedTransactions: ignoredTransactions,
    evidence: {
      kind: "validation-note",
      edgeIds: [],
      edgeKinds: [],
      proofEdges: [],
      pattern: "aborted transactions are excluded from committed-version order",
    },
    summary: "Valid committed history; aborted transaction did not participate in the graph.",
    explanation: `${ignoredTransactions.join(", ")} was marked aborted and excluded from committed dependency edges.`,
    inspectFirst: "Inspect validation notes and ignoredTransactions before reading committed dependency edges.",
    limitations: baseLimitations(mode),
  };
}

function validVerdict(mode: IsolationMode): IsolationVerdict {
  return {
    serializable: {
      status: "pass",
      reason: "No committed dependency cycle was found.",
    },
    strictSerializable: strictStatusForCleanHistory(mode),
    anomaly: {
      label: "valid-serial-history",
      title: "Valid serial history",
    },
    implicatedTransactions: [],
    evidence: {
      kind: "none",
      edgeIds: [],
      edgeKinds: [],
      proofEdges: [],
      pattern: "no dependency cycle found",
    },
    summary: mode === "strict-serializable" ? "No serializability or strict-serializability violation found." : "No serializability violation found.",
    explanation: "The dependency graph is acyclic for the evaluated model.",
    inspectFirst: "Inspect dependency edges to confirm the acyclic order.",
    limitations: baseLimitations(mode),
  };
}

function strictStatusForCleanHistory(mode: IsolationMode): IsolationVerdict["strictSerializable"] {
  if (mode === "strict-serializable") {
    return {
      status: "pass",
      reason: "Strict mode was evaluated and no cycle containing realtime order was found.",
    };
  }
  return {
    status: "not-evaluated",
    reason: "Run with --strict or set mode to strict-serializable to evaluate realtime order.",
  };
}

function isWriteSkewCycle(cycle: CycleWitness): boolean {
  const txs = uniqueCycleTransactions(cycle);
  return cycle.edges.length === 2 && txs.length === 2 && cycle.edges.every((edge) => edge.kind === "rw");
}

function evidenceFromCycle(cycle: CycleWitness, pattern: string): IsolationVerdict["evidence"] {
  const proofEdges = stableCycleEdgeSequence(cycle);
  return {
    kind: "cycle",
    cycleId: cycle.id,
    edgeIds: proofEdges.map((edge) => edge.id),
    edgeKinds: proofEdges.map((edge) => edge.kind),
    proofEdges: proofEdges.map(buildProofEdgeFact),
    pattern,
  };
}

function uniqueCycleTransactions(cycle: CycleWitness): string[] {
  return stableTransactionIds(cycle.transactions);
}

function stableCycles(cycles: CycleWitness[]): CycleWitness[] {
  return cycles.slice().sort(compareCycles);
}

function compareCycles(left: CycleWitness, right: CycleWitness): number {
  return (
    left.edges.length - right.edges.length ||
    stableTransactionIds(left.transactions).join("\u0000").localeCompare(stableTransactionIds(right.transactions).join("\u0000")) ||
    stableCycleSignature(left).localeCompare(stableCycleSignature(right)) ||
    left.id.localeCompare(right.id)
  );
}

function stableCycleSignature(cycle: CycleWitness): string {
  return stableCycleEdgeSequence(cycle).map(edgeStableKey).join("\u0000");
}

function stableCycleEdgeSequence(cycle: CycleWitness): CycleWitness["edges"] {
  if (cycle.edges.length <= 1) return cycle.edges.slice();
  let bestIndex = 0;
  for (let index = 1; index < cycle.edges.length; index += 1) {
    const current = rotatedEdgeSignature(cycle.edges, index);
    const best = rotatedEdgeSignature(cycle.edges, bestIndex);
    if (current < best) bestIndex = index;
  }
  return cycle.edges.slice(bestIndex).concat(cycle.edges.slice(0, bestIndex));
}

function rotatedEdgeSignature(edges: CycleWitness["edges"], startIndex: number): string {
  return edges
    .slice(startIndex)
    .concat(edges.slice(0, startIndex))
    .map(edgeStableKey)
    .join("\u0000");
}

function edgeStableKey(edge: CycleWitness["edges"][number]): string {
  return [edge.kind, edge.from, edge.to, edge.key ?? "", edge.id].join("\u0001");
}

function stableTransactionIds(ids: string[]): string[] {
  return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
}

function baseLimitations(mode: IsolationMode): string[] {
  const limitations = ["Explicit read-from histories only; no SQL parsing, live database adapter, or predicate-read inference."];
  if (mode !== "strict-serializable") {
    limitations.push("Strict realtime order was not evaluated in this run.");
  }
  limitations.push("Anomaly labels are conservative and do not claim full Elle or Adya coverage.");
  return limitations;
}
