import type { AnalysisResult, CycleWitness, DependencyEdge } from "./types";
import { edgeKindLabel } from "./analyzer";
import { plural } from "./format";

export function explainResult(result: AnalysisResult): string {
  const lines: string[] = [];
  lines.push(`IsoTrace: ${result.history.name}`);
  lines.push(`Mode: ${result.mode}`);
  lines.push(`Result: ${result.ok ? "OK" : "VIOLATION"}`);
  lines.push(
    `Graph: ${plural(result.nodes.length, "transaction")}, ${plural(result.edges.length, "edge")}, ${plural(result.cycles.length, "cycle")}.`,
  );
  lines.push(`Edges: ww=${result.kindCounts.ww}, wr=${result.kindCounts.wr}, rw=${result.kindCounts.rw}, rt=${result.kindCounts.rt}.`);

  if (result.validationNotes.length > 0) {
    lines.push("");
    lines.push("Notes:");
    for (const note of result.validationNotes) lines.push(`- ${note}`);
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
  });
  return lines.join("\n");
}

export function formatEdge(edge: DependencyEdge): string {
  const key = edge.key ? ` on ${edge.key}` : "";
  return `${edge.from} -> ${edge.to} [${edge.kind}/${edgeKindLabel(edge.kind)}${key}]: ${edge.reason}`;
}
