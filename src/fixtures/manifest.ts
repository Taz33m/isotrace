import rawFixtureManifest from "../../fixtures/manifest.json";
import type { AnomalyClass, EdgeKind, IsolationCheckStatus, IsolationMode, IsolationVerdictEvidence } from "../core/types";

export const FIXTURE_CATALOG_SCHEMA = "isotrace.fixture-catalog.v1";

export interface FixtureManifest {
  schema: "isotrace.fixture-manifest.v1";
  fixtures: FixtureContract[];
}

export interface FixtureContract {
  path: string;
  reproduce: string;
  argv: string[];
  expected: FixtureExpectation;
}

export interface FixtureExpectation {
  historyName: string;
  mode: IsolationMode;
  ok: boolean;
  anomaly: AnomalyClass;
  serializable: IsolationCheckStatus;
  strictSerializable: IsolationCheckStatus;
  implicatedTransactions: string[];
  evidenceKind: IsolationVerdictEvidence["kind"];
  edgeKinds: EdgeKind[];
  cycleCount: number;
  kindCounts: Record<EdgeKind, number>;
}

export interface FixtureCatalog {
  schema: typeof FIXTURE_CATALOG_SCHEMA;
  manifestSchema: FixtureManifest["schema"];
  count: number;
  fixtures: FixtureCatalogEntry[];
}

export interface FixtureCatalogEntry {
  path: string;
  command: string;
  historyName: string;
  mode: IsolationMode;
  ok: boolean;
  anomaly: AnomalyClass;
  serializable: IsolationCheckStatus;
  strictSerializable: IsolationCheckStatus;
  implicatedTransactions: string[];
  proof: {
    evidenceKind: IsolationVerdictEvidence["kind"];
    edgeKinds: EdgeKind[];
    cycleCount: number;
  };
  kindCounts: Record<EdgeKind, number>;
}

export function readFixtureManifest(): FixtureManifest {
  const manifest = rawFixtureManifest as FixtureManifest;
  if (manifest.schema !== "isotrace.fixture-manifest.v1") {
    throw new Error(`fixtures/manifest.json has unexpected schema ${String(manifest.schema)}`);
  }
  if (!Array.isArray(manifest.fixtures)) {
    throw new Error("fixtures/manifest.json must contain a fixtures array");
  }
  return manifest;
}

export function makeFixtureCatalog(manifest = readFixtureManifest()): FixtureCatalog {
  return {
    schema: FIXTURE_CATALOG_SCHEMA,
    manifestSchema: manifest.schema,
    count: manifest.fixtures.length,
    fixtures: manifest.fixtures.map((contract) => ({
      path: contract.path,
      command: contract.reproduce,
      historyName: contract.expected.historyName,
      mode: contract.expected.mode,
      ok: contract.expected.ok,
      anomaly: contract.expected.anomaly,
      serializable: contract.expected.serializable,
      strictSerializable: contract.expected.strictSerializable,
      implicatedTransactions: contract.expected.implicatedTransactions,
      proof: {
        evidenceKind: contract.expected.evidenceKind,
        edgeKinds: contract.expected.edgeKinds,
        cycleCount: contract.expected.cycleCount,
      },
      kindCounts: contract.expected.kindCounts,
    })),
  };
}
