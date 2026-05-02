import type {
  AnalysisResult,
  CycleWitness,
  DependencyEdge,
  EdgeKind,
  GraphNode,
  History,
  IsolationMode,
  ReadOp,
  Transaction,
  WriteOp,
} from "./types";
import { formatJsonValue } from "./format";
import { edgeSignature, findCycleInComponent, tarjanScc } from "./graph";
import { HistoryValidationError, normalizeHistory } from "./validate";
import { buildIsolationVerdict } from "./verdict";

export interface AnalyzeOptions {
  strict?: boolean;
}

interface VersionWrite {
  tx: Transaction;
  op: WriteOp;
  order: number;
}

const EDGE_KIND_LABEL: Record<EdgeKind, string> = {
  ww: "write-write",
  wr: "write-read",
  rw: "read-write anti-dependency",
  rt: "realtime",
};

export function analyzeHistory(history: History, options: AnalyzeOptions = {}): AnalysisResult {
  const normalized = normalizeHistory(history);
  const mode: IsolationMode = options.strict || history.mode === "strict-serializable" ? "strict-serializable" : "serializable";
  if (mode === "strict-serializable") {
    requireStrictTimestamps(normalized.committed);
  }
  const nodes = buildNodes(normalized.committed);
  const versions = buildVersionIndex(normalized.committed, normalized.order);
  const edges = buildEdges(normalized.committed, versions, mode);
  const cycles = findCycles(nodes.map((node) => node.id), edges);
  const serialCycles = findCycles(nodes.map((node) => node.id), edges.filter((edge) => edge.kind !== "rt"));
  const kindCounts = countKinds(edges);
  const ignoredTransactions = normalized.ignored.map((tx) => tx.id);
  const verdict = buildIsolationVerdict({
    mode,
    cycles,
    serialCycles,
    ignoredTransactions,
  });

  return {
    history,
    mode,
    ok: cycles.length === 0,
    verdict,
    nodes,
    edges,
    cycles,
    ignoredTransactions,
    kindCounts,
    validationNotes: normalized.notes,
  };
}

export function modeForHistory(history: History, options: AnalyzeOptions = {}): IsolationMode {
  return options.strict || history.mode === "strict-serializable" ? "strict-serializable" : "serializable";
}

export function edgeKindLabel(kind: EdgeKind): string {
  return EDGE_KIND_LABEL[kind];
}

function buildNodes(transactions: Transaction[]): GraphNode[] {
  return transactions.map((tx) => ({
    id: tx.id,
    label: tx.label ?? tx.id,
    process: tx.process,
    begin: tx.begin,
    commit: tx.commit,
    opCount: tx.ops.length,
  }));
}

function buildVersionIndex(transactions: Transaction[], order: Map<string, number>): Map<string, VersionWrite[]> {
  const versions = new Map<string, VersionWrite[]>();
  for (const tx of transactions) {
    for (const op of tx.ops) {
      if (op.type !== "write") continue;
      const bucket = versions.get(op.key) ?? [];
      bucket.push({ tx, op, order: order.get(tx.id) ?? 0 });
      versions.set(op.key, bucket);
    }
  }
  for (const bucket of versions.values()) {
    bucket.sort((a, b) => a.order - b.order || a.tx.id.localeCompare(b.tx.id));
  }
  return versions;
}

function buildEdges(transactions: Transaction[], versions: Map<string, VersionWrite[]>, mode: IsolationMode): DependencyEdge[] {
  const seen = new Set<string>();
  const edges: DependencyEdge[] = [];

  function add(edge: Omit<DependencyEdge, "id">): void {
    if (edge.from === edge.to && edge.kind !== "rt") return;
    const signature = edgeSignature(edge);
    if (seen.has(signature)) return;
    seen.add(signature);
    edges.push({ ...edge, id: `e${edges.length + 1}` });
  }

  for (const [key, writers] of versions) {
    for (let index = 1; index < writers.length; index += 1) {
      const previous = writers[index - 1];
      const next = writers[index];
      add({
        from: previous.tx.id,
        to: next.tx.id,
        kind: "ww",
        key,
        value: next.op.value,
        reason: `${previous.tx.id}'s version of ${key} precedes ${next.tx.id}'s write of ${formatJsonValue(next.op.value)}.`,
      });
    }
  }

  for (const tx of transactions) {
    for (const op of tx.ops) {
      if (op.type !== "read") continue;
      addReadDependencies(tx, op, versions, add);
    }
  }

  if (mode === "strict-serializable") {
    for (const before of transactions) {
      if (before.id === "T0") continue;
      for (const after of transactions) {
        if (before.id === after.id || after.id === "T0") continue;
        const beforeCommit = before.commit;
        const afterBegin = after.begin;
        if (typeof beforeCommit !== "number" || typeof afterBegin !== "number") continue;
        if (beforeCommit <= afterBegin) {
          add({
            from: before.id,
            to: after.id,
            kind: "rt",
            reason: `${before.id} committed at ${beforeCommit} before ${after.id} began at ${afterBegin}.`,
          });
        }
      }
    }
  }

  return edges.sort(compareEdges);
}

function requireStrictTimestamps(transactions: Transaction[]): void {
  for (const tx of transactions) {
    if (tx.id === "T0") continue;
    if (typeof tx.begin !== "number" || typeof tx.commit !== "number") {
      throw new HistoryValidationError(`${tx.id} requires numeric begin and commit timestamps for strict-serializable analysis`);
    }
  }
}

function addReadDependencies(
  reader: Transaction,
  op: ReadOp,
  versions: Map<string, VersionWrite[]>,
  add: (edge: Omit<DependencyEdge, "id">) => void,
): void {
  const keyVersions = versions.get(op.key) ?? [];
  const readFromIndex = keyVersions.findIndex((version) => version.tx.id === op.from);

  if (op.from !== reader.id) {
    add({
      from: op.from,
      to: reader.id,
      kind: "wr",
      key: op.key,
      value: op.value,
      reason: `${reader.id} read ${op.key}=${formatJsonValue(op.value)} from ${op.from}.`,
    });
  }

  if (readFromIndex < 0) return;
  for (let index = readFromIndex + 1; index < keyVersions.length; index += 1) {
    const later = keyVersions[index];
    if (later.tx.id === reader.id) continue;
    add({
      from: reader.id,
      to: later.tx.id,
      kind: "rw",
      key: op.key,
      value: later.op.value,
      reason: `${reader.id} read ${op.key} from ${op.from}, before ${later.tx.id} later wrote ${formatJsonValue(later.op.value)} to ${op.key}.`,
    });
  }
}

function findCycles(nodeIds: string[], edges: DependencyEdge[]): CycleWitness[] {
  const components = tarjanScc({ nodes: nodeIds, edges });
  const cycles: CycleWitness[] = [];

  for (const component of components) {
    if (component.length === 1 && !edges.some((edge) => edge.from === component[0] && edge.to === component[0])) {
      continue;
    }
    const cycleEdges = findCycleInComponent(component, edges);
    if (!cycleEdges) continue;
    const classification = classifyCycle(cycleEdges);
    const txs = cycleTransactions(cycleEdges);
    cycles.push({
      id: `cycle-${cycles.length + 1}`,
      classification,
      transactions: txs,
      edges: cycleEdges,
      summary: summarizeCycle(classification, cycleEdges, txs),
    });
  }

  return cycles.sort((a, b) => a.id.localeCompare(b.id));
}

function classifyCycle(edges: DependencyEdge[]): CycleWitness["classification"] {
  if (edges.some((edge) => edge.kind === "rt")) return "strict-serializability";
  if (edges.some((edge) => edge.kind === "rw")) return "serializability";
  return "dependency-cycle";
}

function summarizeCycle(classification: CycleWitness["classification"], edges: DependencyEdge[], transactions: string[]): string {
  const kinds = Array.from(new Set(edges.map((edge) => edge.kind))).join(", ");
  if (classification === "strict-serializability") {
    return `Strict serializability is violated: ${transactions.join(" -> ")} closes a cycle containing realtime order and ${kinds} dependencies.`;
  }
  if (classification === "serializability") {
    return `Serializable order is impossible: ${transactions.join(" -> ")} closes a dependency cycle containing ${kinds}.`;
  }
  return `The dependency graph contains a cycle: ${transactions.join(" -> ")} using ${kinds} dependencies.`;
}

function cycleTransactions(edges: DependencyEdge[]): string[] {
  if (edges.length === 0) return [];
  const txs = edges.map((edge) => edge.from);
  txs.push(edges[edges.length - 1].to);
  return txs;
}

function countKinds(edges: DependencyEdge[]): Record<EdgeKind, number> {
  return edges.reduce<Record<EdgeKind, number>>(
    (counts, edge) => {
      counts[edge.kind] += 1;
      return counts;
    },
    { ww: 0, wr: 0, rw: 0, rt: 0 },
  );
}

function compareEdges(a: DependencyEdge, b: DependencyEdge): number {
  return a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind) || (a.key ?? "").localeCompare(b.key ?? "");
}
