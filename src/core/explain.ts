import type { AnalysisResult, CycleWitness, DependencyEdge } from "./types";
import { edgeKindLabel } from "./analyzer";
import { formatJsonValue, plural } from "./format";

export function explainResult(result: AnalysisResult): string {
  const lines: string[] = [];
  lines.push(`IsoTrace: ${result.history.name}`);
  lines.push(`Mode: ${result.mode}`);
  lines.push(`Result: ${result.ok ? "OK" : "VIOLATION"}`);
  lines.push("");
  lines.push("Verdict:");
  lines.push(`- Summary: ${result.verdict.summary}`);
  lines.push(`- Serializable: ${formatStatus(result.verdict.serializable.status)} (${result.verdict.serializable.reason})`);
  lines.push(`- Strict-serializable: ${formatStatus(result.verdict.strictSerializable.status)} (${result.verdict.strictSerializable.reason})`);
  lines.push(`- Anomaly: ${result.verdict.anomaly.title} [${result.verdict.anomaly.label}]`);
  lines.push(`- Implicated transactions: ${result.verdict.implicatedTransactions.length > 0 ? result.verdict.implicatedTransactions.join(", ") : "none"}`);
  lines.push(`- Proof pattern: ${result.verdict.evidence.pattern}`);
  if (result.verdict.evidence.edgeIds.length > 0) {
    lines.push(
      `- Proof edges: ${result.verdict.evidence.edgeIds.join(" -> ")} (${result.verdict.evidence.edgeKinds.join(" -> ")})`,
    );
  }
  lines.push(`- Inspect first: ${result.verdict.inspectFirst}`);
  lines.push(`- Explanation: ${result.verdict.explanation}`);
  lines.push("");
  lines.push(
    `Graph: ${plural(result.nodes.length, "transaction")}, ${plural(result.edges.length, "edge")}, ${plural(result.cycles.length, "cycle")}.`,
  );
  lines.push(`Edges: ww=${result.kindCounts.ww}, wr=${result.kindCounts.wr}, rw=${result.kindCounts.rw}, rt=${result.kindCounts.rt}.`);

  if (result.validationNotes.length > 0) {
    lines.push("");
    lines.push("Notes:");
    for (const note of result.validationNotes) lines.push(`- ${note}`);
  }

  if (result.verdict.limitations.length > 0) {
    lines.push("");
    lines.push("Bounded notes / limitations:");
    for (const limitation of result.verdict.limitations) lines.push(`- ${limitation}`);
  }

  if (result.cycles.length > 0) {
    lines.push("");
    lines.push("Cycle witnesses:");
    for (const cycle of result.cycles) {
      lines.push(formatCycle(cycle));
    }
  } else {
    lines.push("");
    lines.push("No dependency cycle was found in this explicit-history model.");
  }

  return lines.join("\n");
}

export function formatCycle(cycle: CycleWitness): string {
  const lines: string[] = [];
  lines.push(`- ${cycle.id}: ${cycle.summary}`);
  cycle.edges.forEach((edge, index) => {
    lines.push(`  ${index + 1}. ${formatEdge(edge)}`);
    lines.push(`     facts: ${formatEdgeFacts(edge)}`);
  });
  return lines.join("\n");
}

export function formatEdge(edge: DependencyEdge): string {
  const key = edge.key ? ` on ${edge.key}` : "";
  return `${edge.from} -> ${edge.to} [${edge.kind}/${edgeKindLabel(edge.kind)}${key}]: ${edge.reason}`;
}

export function formatEdgeFacts(edge: DependencyEdge): string {
  const key = edge.key ?? "transaction order";
  if (edge.kind === "ww") {
    return `source fact: ${edge.from} committed an earlier version of ${key}; target fact: ${edge.to} wrote ${formatKeyValue(key, edge)}`;
  }
  if (edge.kind === "wr") {
    return `source fact: ${edge.from} wrote ${formatKeyValue(key, edge)}; target fact: ${edge.to} read ${formatKeyValue(key, edge)} from ${edge.from}`;
  }
  if (edge.kind === "rw") {
    return `source fact: ${edge.from} read ${key} before ${edge.to}'s later write; target fact: ${edge.to} wrote ${formatKeyValue(key, edge)}`;
  }
  return `source fact: ${edge.from} committed before ${edge.to} began; target fact: ${edge.to} must be ordered after ${edge.from} by realtime`;
}

function formatStatus(status: string): string {
  if (status === "pass") return "PASS";
  if (status === "fail") return "FAIL";
  return "NOT EVALUATED";
}

function formatKeyValue(key: string, edge: DependencyEdge): string {
  if (edge.value === undefined) return key;
  return `${key}=${formatJsonValue(edge.value)}`;
}
