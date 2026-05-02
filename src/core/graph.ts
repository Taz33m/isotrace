import type { DependencyEdge } from "./types";

export interface DirectedGraph {
  nodes: string[];
  edges: DependencyEdge[];
}

export function tarjanScc(graph: DirectedGraph): string[][] {
  let index = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const components: string[][] = [];
  const outgoing = adjacency(graph.edges);

  function strongConnect(node: string): void {
    indices.set(node, index);
    lowlink.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);

    for (const edge of outgoing.get(node) ?? []) {
      const next = edge.to;
      if (!indices.has(next)) {
        strongConnect(next);
        lowlink.set(node, Math.min(lowlink.get(node) ?? 0, lowlink.get(next) ?? 0));
      } else if (onStack.has(next)) {
        lowlink.set(node, Math.min(lowlink.get(node) ?? 0, indices.get(next) ?? 0));
      }
    }

    if (lowlink.get(node) === indices.get(node)) {
      const component: string[] = [];
      let current: string | undefined;
      do {
        current = stack.pop();
        if (!current) break;
        onStack.delete(current);
        component.push(current);
      } while (current !== node);
      components.push(component);
    }
  }

  for (const node of graph.nodes) {
    if (!indices.has(node)) strongConnect(node);
  }

  return components;
}

export function findCycleInComponent(component: string[], edges: DependencyEdge[]): DependencyEdge[] | null {
  const allowed = new Set(component);
  const outgoing = adjacency(edges.filter((edge) => allowed.has(edge.from) && allowed.has(edge.to)));

  if (component.length === 1) {
    const self = (outgoing.get(component[0]) ?? []).find((edge) => edge.to === component[0]);
    return self ? [self] : null;
  }

  for (const start of component) {
    const visited = new Set<string>();
    const stackNodes: string[] = [];
    const stackIndex = new Map<string, number>();
    const pathEdges: DependencyEdge[] = [];
    const found = dfs(start, visited, stackNodes, stackIndex, pathEdges, outgoing);
    if (found) return found;
  }

  return null;
}

export function edgeSignature(edge: Omit<DependencyEdge, "id">): string {
  return [edge.kind, edge.from, edge.to, edge.key ?? "", edge.reason].join("|");
}

function dfs(
  node: string,
  visited: Set<string>,
  stackNodes: string[],
  stackIndex: Map<string, number>,
  pathEdges: DependencyEdge[],
  outgoing: Map<string, DependencyEdge[]>,
): DependencyEdge[] | null {
  visited.add(node);
  stackIndex.set(node, stackNodes.length);
  stackNodes.push(node);

  for (const edge of outgoing.get(node) ?? []) {
    if (!visited.has(edge.to)) {
      pathEdges.push(edge);
      const found = dfs(edge.to, visited, stackNodes, stackIndex, pathEdges, outgoing);
      if (found) return found;
      pathEdges.pop();
    } else if (stackIndex.has(edge.to)) {
      const startIndex = stackIndex.get(edge.to) ?? 0;
      return pathEdges.slice(startIndex).concat(edge);
    }
  }

  stackNodes.pop();
  stackIndex.delete(node);
  return null;
}

function adjacency(edges: DependencyEdge[]): Map<string, DependencyEdge[]> {
  const out = new Map<string, DependencyEdge[]>();
  for (const edge of edges) {
    const bucket = out.get(edge.from) ?? [];
    bucket.push(edge);
    out.set(edge.from, bucket);
  }
  for (const bucket of out.values()) {
    bucket.sort((a, b) => a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind) || (a.key ?? "").localeCompare(b.key ?? ""));
  }
  return out;
}
