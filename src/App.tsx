import { Activity, AlertTriangle, CheckCircle2, Code2, GitBranch, Play, TerminalSquare } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { analyzeHistory, edgeKindLabel } from "./core/analyzer";
import { parseHistoryJson } from "./core/artifacts";
import { formatJsonValue } from "./core/format";
import { formatPredicate } from "./core/predicate";
import type { AnalysisResult, DependencyEdge, EdgeKind, GraphNode, History, IsolationVerdict, TxOp } from "./core/types";
import { fixtureCatalog } from "./fixtures";

const edgeColors: Record<EdgeKind, string> = {
  ww: "#2563eb",
  wr: "#0f766e",
  rw: "#b45309",
  prw: "#be123c",
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
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  useEffect(() => {
    setStrictMode(selected.history.mode === "strict-serializable");
  }, [selected.slug, selected.history.mode]);

  const result = useMemo(() => analyzeHistory(selected.history, { strict: strictMode }), [selected.history, strictMode]);
  const cycleEdgeIds = useMemo(() => new Set(result.cycles.flatMap((cycle) => cycle.edges.map((edge) => edge.id))), [result]);
  const selectedEdge = useMemo(() => result.edges.find((edge) => edge.id === selectedEdgeId) ?? null, [result.edges, selectedEdgeId]);
  const orderPositions = useMemo(() => orderPositionMap(result), [result]);

  useEffect(() => {
    const firstCycleEdge = result.cycles[0]?.edges[0]?.id ?? null;
    setSelectedEdgeId((current) => (current && result.edges.some((edge) => edge.id === current) ? current : firstCycleEdge));
  }, [result]);

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
            <span>{result.verdict.anomaly.title}</span>
            <strong>{result.verdict.summary}</strong>
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
          <Panel title="Isolation Diagnosis" icon={result.ok ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />} className="verdictPanel">
            <VerdictPanel onSelectEdge={setSelectedEdgeId} selectedEdgeId={selectedEdgeId} verdict={result.verdict} />
          </Panel>

          <Panel title={selected.history.name} icon={<Activity size={18} />} className="historyPanel">
            <p className="scenarioDescription">{selected.history.description}</p>
            <HistoryTable history={selected.history} orderPositions={orderPositions} selectedEdge={selectedEdge} />
          </Panel>

          <Panel title="Dependency Graph" icon={<GitBranch size={18} />} className="graphPanel">
            <GraphLegend />
            <DependencyGraph
              nodes={result.nodes}
              edges={result.edges}
              cycleEdgeIds={cycleEdgeIds}
              orderPositions={orderPositions}
              onSelectEdge={setSelectedEdgeId}
              selectedEdgeId={selectedEdgeId}
            />
            <SelectedEdge edge={selectedEdge} />
          </Panel>

          <Panel title="Cycle Witness" icon={result.ok ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />} className="proofPanel">
            {result.validationNotes.length > 0 ? (
              <div className="notesBox">
                {result.validationNotes.map((note) => (
                  <span key={note}>{note}</span>
                ))}
              </div>
            ) : null}
            <CycleProof onSelectEdge={setSelectedEdgeId} result={result} selectedEdgeId={selectedEdgeId} />
          </Panel>

          <Panel title="Dependency Edges" icon={<Play size={18} />} className="edgesPanel">
            <EdgeTable cycleEdgeIds={cycleEdgeIds} onSelectEdge={setSelectedEdgeId} result={result} selectedEdgeId={selectedEdgeId} />
          </Panel>
        </section>
      </section>
    </main>
  );
}

function expectedVerdict(history: History): string {
  try {
    const result = analyzeHistory(history);
    return result.verdict.anomaly.label === "valid-serial-history" ? "passes" : result.verdict.anomaly.title;
  } catch {
    return `${history.transactions.length} tx`;
  }
}

function orderPositionMap(result: AnalysisResult): Map<string, number> {
  return new Map(result.orderWitness?.transactions.map((txId, index) => [txId, index + 1]) ?? []);
}

function analyzeCustomHistory(
  text: string,
  setCustomHistory: (history: History) => void,
  setSelectedSlug: (slug: string) => void,
  setStrictMode: (strict: boolean) => void,
  setCustomError: (error: string | null) => void,
): void {
  try {
    const { history } = parseHistoryJson(text);
    const result = analyzeHistory(history);
    setCustomHistory(history);
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

function VerdictPanel({
  verdict,
  selectedEdgeId,
  onSelectEdge,
}: {
  verdict: IsolationVerdict;
  selectedEdgeId: string | null;
  onSelectEdge: (edgeId: string) => void;
}) {
  return (
    <div className="diagnosis" data-testid="verdict-panel">
      <div className="diagnosisGrid">
        <StatusPill label="Serializable" status={verdict.serializable.status} />
        <StatusPill label="Strict" status={verdict.strictSerializable.status} />
      </div>
      <div className="diagnosisAnomaly">
        <span>Anomaly</span>
        <strong>{verdict.anomaly.title}</strong>
        <code>{verdict.anomaly.label}</code>
      </div>
      <p>{verdict.explanation}</p>
      <div className="diagnosisMeta">
        <span>Implicated</span>
        <strong>{verdict.implicatedTransactions.length > 0 ? verdict.implicatedTransactions.join(", ") : "none"}</strong>
      </div>
      <div className="diagnosisMeta">
        <span>Inspect first</span>
        <strong>{verdict.inspectFirst}</strong>
      </div>
      {verdict.evidence.proofEdges.length > 0 ? (
        <div className="proofEdgeList" aria-label="Verdict proof edge sequence">
          {verdict.evidence.proofEdges.map((proofEdge) => (
            <button
              className={selectedEdgeId === proofEdge.edgeId ? "selected" : ""}
              data-testid={`verdict-edge-${proofEdge.edgeId}`}
              key={proofEdge.edgeId}
              onClick={() => onSelectEdge(proofEdge.edgeId)}
              type="button"
            >
              <span className="proofEdgeHead">
                <code>{proofEdge.edgeId}</code>
                <span>{proofEdge.edgeKind}</span>
              </span>
              <span className="proofEdgeFacts">
                <span>{proofEdge.sourceFact}</span>
                <span>{proofEdge.targetFact}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="diagnosisLimitations">
        {verdict.limitations.map((limitation) => (
          <span key={limitation}>{limitation}</span>
        ))}
      </div>
    </div>
  );
}

function StatusPill({ label, status }: { label: string; status: IsolationVerdict["serializable"]["status"] }) {
  return (
    <div className={`statusPill ${status}`}>
      <span>{label}</span>
      <strong>{statusLabel(status)}</strong>
    </div>
  );
}

function statusLabel(status: IsolationVerdict["serializable"]["status"]): string {
  if (status === "pass") return "Pass";
  if (status === "fail") return "Fail";
  return "Not evaluated";
}

function HistoryTable({
  history,
  selectedEdge,
  orderPositions,
}: {
  history: History;
  selectedEdge: DependencyEdge | null;
  orderPositions: Map<string, number>;
}) {
  return (
    <div className="historyTable" role="table" aria-label="Transaction history">
      <div className="historyRow header" role="row">
        <span>Tx</span>
        <span>Time</span>
        <span>Operations</span>
      </div>
      {history.transactions.map((tx) => (
        <div
          className={`historyRow ${(tx.status ?? "committed") !== "committed" ? "ignored" : ""} ${isEdgeEndpoint(tx.id, selectedEdge) ? "selectedTxRow" : ""}`}
          data-testid={`history-row-${tx.id}`}
          key={tx.id}
          role="row"
        >
          <span>
            <strong>{tx.id}</strong>
            <small>{tx.label ?? tx.id}</small>
            {orderPositions.has(tx.id) ? (
              <small className="orderRank" data-testid={`history-order-rank-${tx.id}`}>
                #{orderPositions.get(tx.id)} witness
              </small>
            ) : null}
          </span>
          <span>{typeof tx.begin === "number" ? `${tx.begin}-${tx.commit ?? "?"}` : tx.commit ?? "initial"}</span>
          <span className="opsList">
            {tx.ops.map((op, index) => {
              const role = operationEdgeRole(tx.id, op, selectedEdge);
              return (
                <span
                  className={`opChip ${role ? `selectedOp ${role}` : ""}`}
                  data-testid={`history-op-${tx.id}-${index}`}
                  key={`${tx.id}-${index}`}
                >
                  {formatOp(op)}
                </span>
              );
            })}
          </span>
        </div>
      ))}
    </div>
  );
}

function formatOp(op: TxOp): string {
  if (op.type === "read") return `read ${op.key}=${formatJsonValue(op.value)} from ${op.from}`;
  if (op.type === "predicate-read") {
    const sql = op.sourceSql ? ` sql=${op.sourceSql}` : "";
    const note = op.note ? ` note=${op.note}` : "";
    return `predicate-read ${op.table} where ${formatPredicate(op.predicate)} rows=${op.returnedRows.length}${sql}${note}`;
  }
  return `write ${op.key}=${formatJsonValue(op.value)}`;
}

function isEdgeEndpoint(txId: string, edge: DependencyEdge | null): boolean {
  return edge?.from === txId || edge?.to === txId;
}

function operationEdgeRole(txId: string, op: TxOp, edge: DependencyEdge | null): "edgeSourceOp" | "edgeTargetOp" | null {
  if (!edge?.key) return null;
  if (edge.kind === "ww" && op.type === "write" && op.key === edge.key) {
    if (txId === edge.from) return "edgeSourceOp";
    if (txId === edge.to) return "edgeTargetOp";
  }
  if (edge.kind === "wr") {
    if (txId === edge.from && op.type === "write" && op.key === edge.key) return "edgeSourceOp";
    if (txId === edge.to && op.type === "read" && op.key === edge.key && op.from === edge.from) return "edgeTargetOp";
  }
  if (edge.kind === "rw") {
    if (txId === edge.from && op.type === "read" && op.key === edge.key) return "edgeSourceOp";
    if (txId === edge.to && op.type === "write" && op.key === edge.key) return "edgeTargetOp";
  }
  if (edge.kind === "prw") {
    if (txId === edge.from && op.type === "predicate-read" && op.table === edge.table) return "edgeSourceOp";
    if (txId === edge.to && op.type === "write" && op.table === edge.table && rowIdsEqual(op.rowId, edge.rowId)) return "edgeTargetOp";
  }
  return null;
}

function rowIdsEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function DependencyGraph({
  nodes,
  edges,
  cycleEdgeIds,
  orderPositions,
  selectedEdgeId,
  onSelectEdge,
}: {
  nodes: GraphNode[];
  edges: DependencyEdge[];
  cycleEdgeIds: Set<string>;
  orderPositions: Map<string, number>;
  selectedEdgeId: string | null;
  onSelectEdge: (edgeId: string) => void;
}) {
  const positions = layoutNodes(nodes);
  return (
    <svg className="graphSvg" viewBox="0 0 780 390" role="img" aria-label="Dependency graph">
      <defs>
        {(["ww", "wr", "rw", "prw", "rt"] as EdgeKind[]).map((kind) => (
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
        const isSelected = selectedEdgeId === edge.id;
        const curve = curvePath(from.x, from.y, to.x, to.y, index);
        return (
          <g key={edge.id}>
            <path
              aria-label={`${edge.kind} edge ${edge.from} to ${edge.to}`}
              className={`graphEdge ${isCycle ? "cycle" : ""} ${isSelected ? "selected" : ""}`}
              data-testid={`graph-edge-${edge.id}`}
              d={curve.path}
              markerEnd={`url(#${isCycle ? "arrow-cycle" : `arrow-${edge.kind}`})`}
              onClick={() => onSelectEdge(edge.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectEdge(edge.id);
                }
              }}
              role="button"
              stroke={isCycle ? "#dc2626" : edgeColors[edge.kind]}
              tabIndex={0}
            />
            <text className={`edgeLabel ${isCycle ? "cycleText" : ""} ${isSelected ? "selectedText" : ""}`} x={curve.labelX} y={curve.labelY}>
              {edge.kind}
            </text>
          </g>
        );
      })}

      {nodes.map((node) => {
        const position = positions.get(node.id);
        const orderPosition = orderPositions.get(node.id);
        if (!position) return null;
        return (
          <g key={node.id} transform={`translate(${position.x - 45}, ${position.y - 24})`}>
            <rect className="graphNode" width="90" height="48" rx="8" />
            {orderPosition ? (
              <text className="nodeRank" data-testid={`graph-order-rank-${node.id}`} x="74" y="15">
                #{orderPosition}
              </text>
            ) : null}
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

function SelectedEdge({ edge }: { edge: DependencyEdge | null }) {
  if (!edge) {
    return (
      <div className="selectedEdge empty" data-testid="selected-edge">
        No edge selected
      </div>
    );
  }
  return (
    <div className="selectedEdge" data-testid="selected-edge">
      <span className={`edgeKind ${edge.kind}`}>{edge.kind}</span>
      <code>{edge.id}: {edge.from} -&gt; {edge.to}</code>
      <span>{edge.reason}</span>
    </div>
  );
}

function GraphLegend() {
  const kinds: EdgeKind[] = ["ww", "wr", "rw", "prw", "rt"];
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

function CycleProof({
  result,
  selectedEdgeId,
  onSelectEdge,
}: {
  result: AnalysisResult;
  selectedEdgeId: string | null;
  onSelectEdge: (edgeId: string) => void;
}) {
  if (result.ok) {
    return (
      <div className="proofEmpty">
        <CheckCircle2 size={26} />
        <p>No dependency cycle was found under {result.mode}. The graph still includes dependency edges so the absence of a cycle is inspectable.</p>
        {result.orderWitness ? (
          <div className="orderWitness" data-testid="order-witness">
            <span>Order witness</span>
            <code>{result.orderWitness.transactions.join(" -> ")}</code>
            <div className="orderWitnessSteps" aria-label="Order witness transaction ranks">
              {result.orderWitness.transactions.map((txId, index) => (
                <span data-testid={`order-witness-step-${txId}`} key={txId}>
                  #{index + 1} {txId}
                </span>
              ))}
            </div>
            <small>{result.orderWitness.summary}</small>
          </div>
        ) : null}
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
                <button
                  className={`proofEdgeButton ${selectedEdgeId === edge.id ? "selected" : ""}`}
                  data-testid={`cycle-edge-${edge.id}`}
                  onClick={() => onSelectEdge(edge.id)}
                  type="button"
                >
                  <code>{edge.id}: {edge.from} -&gt; {edge.to}</code>
                </button>
                <span>{edge.reason}</span>
              </li>
            ))}
          </ol>
        </article>
      ))}
    </div>
  );
}

function EdgeTable({
  result,
  cycleEdgeIds,
  selectedEdgeId,
  onSelectEdge,
}: {
  result: AnalysisResult;
  cycleEdgeIds: Set<string>;
  selectedEdgeId: string | null;
  onSelectEdge: (edgeId: string) => void;
}) {
  return (
    <div className="edgeTable" role="table" aria-label="Dependency edges">
      <div className="edgeRow header" role="row">
        <span>ID</span>
        <span>Kind</span>
        <span>From</span>
        <span>To</span>
        <span>Reason</span>
      </div>
      {result.edges.map((edge) => (
        <button
          className={`edgeRow edgeButton ${cycleEdgeIds.has(edge.id) ? "cycleEdgeRow" : ""} ${selectedEdgeId === edge.id ? "selectedEdgeRow" : ""}`}
          data-testid={`edge-row-${edge.id}`}
          key={edge.id}
          onClick={() => onSelectEdge(edge.id)}
          role="row"
          type="button"
        >
          <span>{edge.id}</span>
          <span className={`edgeKind ${edge.kind}`}>{edge.kind}</span>
          <span>{edge.from}</span>
          <span>{edge.to}</span>
          <span>{edgeKindLabel(edge.kind)}: {edge.reason}</span>
        </button>
      ))}
    </div>
  );
}
