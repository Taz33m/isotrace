export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type IsolationMode = "serializable" | "strict-serializable";

export type TransactionStatus = "committed" | "aborted";

export interface ReadOp {
  type: "read";
  key: string;
  value: JsonValue;
  from: string;
}

export interface WriteOp {
  type: "write";
  key: string;
  value: JsonValue;
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

export interface AnalysisResult {
  history: History;
  mode: IsolationMode;
  ok: boolean;
  nodes: GraphNode[];
  edges: DependencyEdge[];
  cycles: CycleWitness[];
  ignoredTransactions: string[];
  kindCounts: Record<EdgeKind, number>;
  validationNotes: string[];
}
