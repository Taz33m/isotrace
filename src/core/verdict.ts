import type { CycleWitness, IsolationMode, IsolationVerdict } from "./types";

export function buildIsolationVerdict(options: {
  mode: IsolationMode;
  cycles: CycleWitness[];
  serialCycles: CycleWitness[];
  ignoredTransactions: string[];
}): IsolationVerdict {
  const serialCycle = options.serialCycles[0] ?? null;
  const writeSkewCycle = options.serialCycles.find(isWriteSkewCycle) ?? null;
  const strictCycle = options.cycles.find((cycle) => cycle.edges.some((edge) => edge.kind === "rt")) ?? null;

  if (writeSkewCycle) {
    return writeSkewVerdict(writeSkewCycle, options.mode);
  }
  if (serialCycle) {
    return dependencyCycleVerdict(serialCycle, options.mode);
  }
  if (strictCycle && options.mode === "strict-serializable") {
    return strictRealtimeVerdict(strictCycle);
  }
  if (options.ignoredTransactions.length > 0) {
    return abortedIgnoredVerdict(options.mode, options.ignoredTransactions);
  }
  return validVerdict(options.mode);
}

function writeSkewVerdict(cycle: CycleWitness, mode: IsolationMode): IsolationVerdict {
  const txs = uniqueCycleTransactions(cycle);
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
    evidence: evidenceFromCycle(cycle, "rw/rw cycle between committed transactions"),
    summary: "Not serializable: write-skew dependency cycle.",
    explanation: `${txs.join(" and ")} each read a version that the other transaction later invalidated, closing an rw/rw cycle.`,
    inspectFirst: `Inspect ${cycle.id}, especially proof edges ${cycle.edges.map((edge) => edge.id).join(", ")}.`,
    limitations: baseLimitations(mode),
  };
}

function dependencyCycleVerdict(cycle: CycleWitness, mode: IsolationMode): IsolationVerdict {
  const txs = uniqueCycleTransactions(cycle);
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
    evidence: evidenceFromCycle(cycle, "committed dependency cycle"),
    summary: "Not serializable: dependency cycle.",
    explanation: `No serial order can satisfy the dependency sequence ${txs.join(" -> ")}.`,
    inspectFirst: `Inspect ${cycle.id} and its edge sequence ${cycle.edges.map((edge) => edge.id).join(", ")}.`,
    limitations: baseLimitations(mode),
  };
}

function strictRealtimeVerdict(cycle: CycleWitness): IsolationVerdict {
  const txs = uniqueCycleTransactions(cycle);
  const hasReadEvidence = cycle.edges.some((edge) => edge.kind === "rw" || edge.kind === "wr");
  const label = hasReadEvidence ? "strict-stale-read" : "dependency-cycle";
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
    evidence: evidenceFromCycle(cycle, hasReadEvidence ? "rt edge plus read provenance cycle" : "rt edge cycle"),
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
  return {
    kind: "cycle",
    cycleId: cycle.id,
    edgeIds: cycle.edges.map((edge) => edge.id),
    edgeKinds: cycle.edges.map((edge) => edge.kind),
    pattern,
  };
}

function uniqueCycleTransactions(cycle: CycleWitness): string[] {
  return Array.from(new Set(cycle.transactions)).sort((a, b) => a.localeCompare(b));
}

function baseLimitations(mode: IsolationMode): string[] {
  const limitations = ["Explicit read-from histories only; no SQL parsing, live database adapter, or predicate-read inference."];
  if (mode !== "strict-serializable") {
    limitations.push("Strict realtime order was not evaluated in this run.");
  }
  limitations.push("Anomaly labels are conservative and do not claim full Elle or Adya coverage.");
  return limitations;
}
