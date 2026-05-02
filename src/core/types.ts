export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type IsolationMode = "serializable" | "strict-serializable";

export type TransactionStatus = "committed" | "aborted";

export interface ReadOp {
  type: "read";
  key: string;
  value: JsonValue;
  from: string;
  predicate?: PredicateReadEvidence;
}

export interface WriteOp {
  type: "write";
  key: string;
  value: JsonValue;
}

export interface PredicateReadEvidence {
  table: string;
  where: string;
  rowId: JsonValue;
  sourceSql: string;
}

export type TxOp = ReadOp | WriteOp;

export interface Transaction {
  id: string;
  label?: string;
  process?: string;
  begin?: number;
  commit?: number;
  status?: TransactionStatus;
  ops: TxOp[];
}

export interface History {
  name: string;
  description: string;
  mode?: IsolationMode;
  transactions: Transaction[];
}

export type EdgeKind = "ww" | "wr" | "rw" | "rt";

export interface DependencyEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  key?: string;
  value?: JsonValue;
  reason: string;
}

export interface GraphNode {
  id: string;
  label: string;
  process?: string;
  begin?: number;
  commit?: number;
  opCount: number;
}

export interface CycleWitness {
  id: string;
  classification: "serializability" | "strict-serializability" | "dependency-cycle";
  summary: string;
  edges: DependencyEdge[];
  transactions: string[];
}

export interface OrderWitness {
  kind: "topological-order";
  mode: IsolationMode;
  transactions: string[];
  edgeIds: string[];
  summary: string;
}

export type IsolationCheckStatus = "pass" | "fail" | "not-evaluated";

export type AnomalyClass =
  | "write-skew"
  | "strict-stale-read"
  | "dependency-cycle"
  | "valid-serial-history"
  | "aborted-write-ignored";

export interface IsolationCheckVerdict {
  status: IsolationCheckStatus;
  reason: string;
}

export interface IsolationVerdictEvidence {
  kind: "cycle" | "edge-pattern" | "validation-note" | "none";
  cycleId?: string;
  edgeIds: string[];
  edgeKinds: EdgeKind[];
  proofEdges: ProofEdgeFact[];
  pattern: string;
}

export interface ProofEdgeFact {
  edgeId: string;
  edgeKind: EdgeKind;
  sourceTransaction: string;
  targetTransaction: string;
  sourceFact: string;
  targetFact: string;
  summary: string;
}

export interface IsolationVerdict {
  serializable: IsolationCheckVerdict;
  strictSerializable: IsolationCheckVerdict;
  anomaly: {
    label: AnomalyClass;
    title: string;
  };
  implicatedTransactions: string[];
  evidence: IsolationVerdictEvidence;
  summary: string;
  explanation: string;
  inspectFirst: string;
  limitations: string[];
}

export interface AnalysisResult {
  history: History;
  mode: IsolationMode;
  ok: boolean;
  verdict: IsolationVerdict;
  nodes: GraphNode[];
  edges: DependencyEdge[];
  cycles: CycleWitness[];
  orderWitness: OrderWitness | null;
  ignoredTransactions: string[];
  kindCounts: Record<EdgeKind, number>;
  validationNotes: string[];
}
