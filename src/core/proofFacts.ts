import { formatJsonValue } from "./format";
import { formatPredicate } from "./predicate";
import type { DependencyEdge, ProofEdgeFact } from "./types";

export function buildProofEdgeFact(edge: DependencyEdge): ProofEdgeFact {
  const key = edge.key ?? "transaction order";
  const base = {
    edgeId: edge.id,
    edgeKind: edge.kind,
    sourceTransaction: edge.from,
    targetTransaction: edge.to,
  };

  if (edge.kind === "ww") {
    return withSummary({
      ...base,
      sourceFact: `${edge.from} committed an earlier version of ${key}`,
      targetFact: `${edge.to} wrote ${formatKeyValue(key, edge)}`,
    });
  }
  if (edge.kind === "wr") {
    const value = formatKeyValue(key, edge);
    return withSummary({
      ...base,
      sourceFact: `${edge.from} wrote ${value}`,
      targetFact: `${edge.to} read ${value} from ${edge.from}`,
    });
  }
  if (edge.kind === "rw") {
    return withSummary({
      ...base,
      sourceFact: `${edge.from} read ${key} before ${edge.to}'s later write`,
      targetFact: `${edge.to} wrote ${formatKeyValue(key, edge)}`,
    });
  }
  if (edge.kind === "prw") {
    const predicate = edge.predicate ? formatPredicate(edge.predicate) : "unknown predicate";
    const row = edge.rowId !== undefined ? formatJsonValue(edge.rowId) : key;
    const before = edge.predicateChange?.beforeMatches ? "returned" : "did not return";
    const after = edge.predicateChange?.afterMatches ? "matched" : "did not match";
    return withSummary({
      ...base,
      sourceFact: `${edge.from} predicate-read ${edge.table ?? "table"} where ${predicate} ${before} row ${row}`,
      targetFact: `${edge.to} changed row ${row} so it ${after} the predicate, creating a predicate-read/write anti-dependency`,
    });
  }
  return withSummary({
    ...base,
    sourceFact: `${edge.from} committed before ${edge.to} began`,
    targetFact: `${edge.to} must be ordered after ${edge.from} by realtime`,
  });
}

export function formatEdgeFacts(edge: DependencyEdge): string {
  return formatProofEdgeFact(buildProofEdgeFact(edge));
}

export function formatProofEdgeFact(fact: Pick<ProofEdgeFact, "sourceFact" | "targetFact">): string {
  return `source fact: ${fact.sourceFact}; target fact: ${fact.targetFact}`;
}

function withSummary(fact: Omit<ProofEdgeFact, "summary">): ProofEdgeFact {
  return {
    ...fact,
    summary: formatProofEdgeFact(fact),
  };
}

function formatKeyValue(key: string, edge: DependencyEdge): string {
  if (edge.value === undefined) return key;
  return `${key}=${formatJsonValue(edge.value)}`;
}
