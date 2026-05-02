import { Activity, AlertTriangle, CheckCircle2, Code2, GitBranch, Play, TerminalSquare } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { analyzeHistory, edgeKindLabel } from "./core/analyzer";
import { formatJsonValue } from "./core/format";
import type { AnalysisResult, DependencyEdge, EdgeKind, GraphNode, History, TxOp } from "./core/types";
import { fixtureCatalog } from "./fixtures";

const edgeColors: Record<EdgeKind, string> = {
  ww: "#2563eb",
  wr: "#0f766e",
  rw: "#b45309",
  rt: "#7c3aed",
};

export default function App() {
  const [selectedSlug, setSelectedSlug] = useState(fixtureCatalog[0].slug);
  const [customHistory, setCustomHistory] = useState<History | null>(null);
  const [customText, setCustomText] = useState(() => JSON.stringify(fixtureCatalog[0].history, null, 2));
  const [customError, setCustomError] = useState<string | null>(null);
  const selectedFixture = fixtureCatalog.find((entry) => entry.slug === selectedSlug) ?? fixtureCatalog[0];
  const selected =
    selectedSlug === "__custom__" && customHistory
      ? { slug: "__custom__", title: "Custom JSON", history: customHistory }
      : selectedFixture;
  const [strictMode, setStrictMode] = useState(selected.history.mode === "strict-serializable");

  useEffect(() => {
    setStrictMode(selected.history.mode === "strict-serializable");
  }, [selected.slug, selected.history.mode]);

  const result = useMemo(() => analyzeHistory(selected.history, { strict: strictMode }), [selected.history, strictMode]);
  const cycleEdgeIds = useMemo(() => new Set(result.cycles.flatMap((cycle) => cycle.edges.map((edge) => edge.id))), [result]);

  return (
    <main className="appShell" data-testid="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">Explicit-history isolation checker</div>
          <h1>IsoTrace</h1>
          <p>Turns key-value transaction histories into dependency graphs and concrete cycle witnesses.</p>
        </div>
        <div className={`verdict ${result.ok ? "verdictOk" : "verdictBad"}`}>
          {result.ok ? <CheckCircle2 size={22} /> : <AlertTriangle size={22} />}
          <div>
            <span>{result.ok ? "No cycle found" : "Violation found"}</span>
            <strong>{result.cycles.length} cycle(s), {result.edges.length} edge(s)</strong>
          </div>
        </div>
      </header>

      <section className="workbench">
        <aside className="scenarioRail" aria-label="Scenarios">
          <div className="railHeader">
            <GitBranch size={18} />
            <span>Scenarios</span>
          </div>
          {fixtureCatalog.map((entry) => (
            <button
              className={`scenarioButton ${entry.slug === selectedSlug ? "active" : ""}`}
              data-testid={`scenario-${entry.slug}`}
              key={entry.slug}
              onClick={() => {
                setSelectedSlug(entry.slug);
                setCustomError(null);
              }}
              type="button"
            >
              <span>{entry.title}</span>
              <small>{expectedVerdict(entry.history)}</small>
            </button>
          ))}
          {customHistory ? (
            <button
              className={`scenarioButton ${selectedSlug === "__custom__" ? "active" : ""}`}
              data-testid="scenario-custom"
              onClick={() => {
                setSelectedSlug("__custom__");
                setCustomError(null);
              }}
              type="button"
            >
              <span>Custom JSON</span>
              <small>{expectedVerdict(customHistory)}</small>
            </button>
          ) : null}

          <div className="importPanel">
            <div className="railHeader">
              <Code2 size={18} />
              <span>Custom History</span>
            </div>
            <textarea
              aria-label="Custom history JSON"
              data-testid="custom-history-input"
              onChange={(event) => setCustomText(event.target.value)}
              spellCheck={false}
              value={customText}
            />
            {customError ? <div className="errorBox" data-testid="custom-history-error">{customError}</div> : null}
            <div className="importActions">
              <button
                data-testid="analyze-custom-history"
                onClick={() => analyzeCustomHistory(customText, setCustomHistory, setSelectedSlug, setStrictMode, setCustomError)}
                type="button"
              >
                Analyze JSON
              </button>
              <button
                onClick={() => {
                  setCustomText(JSON.stringify(selected.history, null, 2));
                  setCustomError(null);
                }}
                type="button"
              >
                Copy Active
              </button>
            </div>
          </div>

          <div className="modePanel">
            <span>Graph mode</span>
            <div className="segmented">
              <button className={!strictMode ? "selected" : ""} onClick={() => setStrictMode(false)} type="button">
                Serializable
              </button>
              <button className={strictMode ? "selected" : ""} onClick={() => setStrictMode(true)} type="button">
                Strict
              </button>
            </div>
          </div>

          <div className="commandBox">
            <TerminalSquare size={17} />
            <code>
              {selected.slug === "__custom__"
                ? "browser custom JSON"
                : `npm run analyze -- fixtures/${selected.slug}.json${strictMode ? " --strict" : ""}`}
            </code>
          </div>
        </aside>

        <section className="mainGrid">
          <Panel title={selected.history.name} icon={<Activity size={18} />} className="historyPanel">
            <p className="scenarioDescription">{selected.history.description}</p>
            <HistoryTable history={selected.history} />
          </Panel>

          <Panel title="Dependency Graph" icon={<GitBranch size={18} />} className="graphPanel">
            <GraphLegend />
            <DependencyGraph nodes={result.nodes} edges={result.edges} cycleEdgeIds={cycleEdgeIds} />
          </Panel>

          <Panel title="Cycle Witness" icon={result.ok ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />} className="proofPanel">
            {result.validationNotes.length > 0 ? (
              <div className="notesBox">
                {result.validationNotes.map((note) => (
                  <span key={note}>{note}</span>
                ))}
              </div>
            ) : null}
            <CycleProof result={result} />
          </Panel>

          <Panel title="Dependency Edges" icon={<Play size={18} />} className="edgesPanel">
            <EdgeTable result={result} cycleEdgeIds={cycleEdgeIds} />
          </Panel>
        </section>
      </section>
    </main>
  );
}

function expectedVerdict(history: History): string {
  try {
    const result = analyzeHistory(history);
    return result.ok ? "passes" : "fails";
  } catch {
    return `${history.transactions.length} tx`;
  }
}

function analyzeCustomHistory(
  text: string,
  setCustomHistory: (history: History) => void,
  setSelectedSlug: (slug: string) => void,
  setStrictMode: (strict: boolean) => void,
  setCustomError: (error: string | null) => void,
): void {
  try {
    const parsed = JSON.parse(text) as History;
    const result = analyzeHistory(parsed);
    setCustomHistory(parsed);
    setSelectedSlug("__custom__");
    setStrictMode(result.mode === "strict-serializable");
    setCustomError(null);
  } catch (error) {
    setCustomError(error instanceof Error ? error.message : String(error));
  }
}

function Panel({
  title,
  icon,
  children,
  className = "",
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <h2>
        {icon}
        <span>{title}</span>
      </h2>
      {children}
    </section>
  );
}

function HistoryTable({ history }: { history: History }) {
  return (
    <div className="historyTable" role="table" aria-label="Transaction history">
      <div className="historyRow header" role="row">
        <span>Tx</span>
        <span>Time</span>
        <span>Operations</span>
      </div>
      {history.transactions.map((tx) => (
        <div className={`historyRow ${(tx.status ?? "committed") !== "committed" ? "ignored" : ""}`} key={tx.id} role="row">
          <span>
            <strong>{tx.id}</strong>
            <small>{tx.label ?? tx.id}</small>
          </span>
          <span>{typeof tx.begin === "number" ? `${tx.begin}-${tx.commit ?? "?"}` : tx.commit ?? "initial"}</span>
          <span className="opsList">{tx.ops.map(formatOp).join("; ")}</span>
        </div>
      ))}
    </div>
  );
}

function formatOp(op: TxOp): string {
  if (op.type === "read") return `read ${op.key}=${formatJsonValue(op.value)} from ${op.from}`;
  return `write ${op.key}=${formatJsonValue(op.value)}`;
}

function DependencyGraph({
  nodes,
  edges,
  cycleEdgeIds,
}: {
  nodes: GraphNode[];
  edges: DependencyEdge[];
  cycleEdgeIds: Set<string>;
}) {
  const positions = layoutNodes(nodes);
  return (
    <svg className="graphSvg" viewBox="0 0 780 390" role="img" aria-label="Dependency graph">
      <defs>
        {(["ww", "wr", "rw", "rt"] as EdgeKind[]).map((kind) => (
          <marker id={`arrow-${kind}`} key={kind} markerHeight="8" markerWidth="8" orient="auto" refX="7" refY="4">
            <path d="M 0 0 L 8 4 L 0 8 z" fill={edgeColors[kind]} />
          </marker>
        ))}
        <marker id="arrow-cycle" markerHeight="8" markerWidth="8" orient="auto" refX="7" refY="4">
          <path d="M 0 0 L 8 4 L 0 8 z" fill="#dc2626" />
        </marker>
      </defs>

      {edges.map((edge, index) => {
        const from = positions.get(edge.from);
        const to = positions.get(edge.to);
        if (!from || !to) return null;
        const isCycle = cycleEdgeIds.has(edge.id);
        const curve = curvePath(from.x, from.y, to.x, to.y, index);
        return (
          <g key={edge.id}>
            <path
              className={`graphEdge ${isCycle ? "cycle" : ""}`}
              d={curve.path}
              markerEnd={`url(#${isCycle ? "arrow-cycle" : `arrow-${edge.kind}`})`}
              stroke={isCycle ? "#dc2626" : edgeColors[edge.kind]}
            />
            <text className={`edgeLabel ${isCycle ? "cycleText" : ""}`} x={curve.labelX} y={curve.labelY}>
              {edge.kind}
            </text>
          </g>
        );
      })}

      {nodes.map((node) => {
        const position = positions.get(node.id);
        if (!position) return null;
        return (
          <g key={node.id} transform={`translate(${position.x - 45}, ${position.y - 24})`}>
            <rect className="graphNode" width="90" height="48" rx="8" />
            <text className="nodeId" x="45" y="21">
              {node.id}
            </text>
            <text className="nodeMeta" x="45" y="36">
              {node.begin ?? "init"}-{node.commit ?? "?"}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function GraphLegend() {
  const kinds: EdgeKind[] = ["ww", "wr", "rw", "rt"];
  return (
    <div className="graphLegend" aria-label="Graph edge legend">
      {kinds.map((kind) => (
        <span key={kind}>
          <i style={{ backgroundColor: edgeColors[kind] }} />
          <code>{kind}</code>
          {edgeKindLabel(kind)}
        </span>
      ))}
    </div>
  );
}

function layoutNodes(nodes: GraphNode[]): Map<string, { x: number; y: number }> {
  const centerX = 390;
  const centerY = 195;
  const radiusX = 270;
  const radiusY = 125;
  const positions = new Map<string, { x: number; y: number }>();
  nodes.forEach((node, index) => {
    if (node.id === "T0") {
      positions.set(node.id, { x: 110, y: 195 });
      return;
    }
    const nonInitial = nodes.filter((candidate) => candidate.id !== "T0");
    const nonInitialIndex = nonInitial.findIndex((candidate) => candidate.id === node.id);
    const angle = -Math.PI / 2 + (2 * Math.PI * nonInitialIndex) / Math.max(nonInitial.length, 1);
    positions.set(node.id, {
      x: centerX + radiusX * Math.cos(angle),
      y: centerY + radiusY * Math.sin(angle),
    });
    void index;
  });
  return positions;
}

function curvePath(x1: number, y1: number, x2: number, y2: number, index: number): { path: string; labelX: number; labelY: number } {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const midX = x1 + dx / 2;
  const midY = y1 + dy / 2;
  const distance = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
  const offset = ((index % 5) - 2) * 14;
  const controlX = midX - (dy / distance) * offset;
  const controlY = midY + (dx / distance) * offset;
  return {
    path: `M ${x1} ${y1} Q ${controlX} ${controlY} ${x2} ${y2}`,
    labelX: controlX,
    labelY: controlY - 6,
  };
}

function CycleProof({ result }: { result: AnalysisResult }) {
  if (result.ok) {
    return (
      <div className="proofEmpty">
        <CheckCircle2 size={26} />
        <p>No dependency cycle was found under {result.mode}. The graph still includes dependency edges so the absence of a cycle is inspectable.</p>
      </div>
    );
  }

  return (
    <div className="proofStack">
      {result.cycles.map((cycle) => (
        <article className="cycleCard" data-testid="cycle-card" key={cycle.id}>
          <strong>{cycle.summary}</strong>
          <ol>
            {cycle.edges.map((edge) => (
              <li key={edge.id}>
                <code>{edge.from} -&gt; {edge.to}</code>
                <span>{edge.reason}</span>
              </li>
            ))}
          </ol>
        </article>
      ))}
    </div>
  );
}

function EdgeTable({ result, cycleEdgeIds }: { result: AnalysisResult; cycleEdgeIds: Set<string> }) {
  return (
    <div className="edgeTable" role="table" aria-label="Dependency edges">
      <div className="edgeRow header" role="row">
        <span>Kind</span>
        <span>From</span>
        <span>To</span>
        <span>Reason</span>
      </div>
      {result.edges.map((edge) => (
        <div className={`edgeRow ${cycleEdgeIds.has(edge.id) ? "cycleEdgeRow" : ""}`} key={edge.id} role="row">
          <span className={`edgeKind ${edge.kind}`}>{edge.kind}</span>
          <span>{edge.from}</span>
          <span>{edge.to}</span>
          <span>{edgeKindLabel(edge.kind)}: {edge.reason}</span>
        </div>
      ))}
    </div>
  );
}
