# IsoTrace

IsoTrace is a local transaction-history analyzer for explicit key-value histories. It builds a dependency graph and explains serializability or strict-serializability failures as concrete cycle witnesses.

## Technical Seam

Transaction isolation failures are hard to inspect because the evidence is spread across reads, writes, version order, and realtime order. A history that looks harmless row-by-row can be impossible to serialize once read-write anti-dependencies are connected. IsoTrace focuses on that hard middle layer: turn an explicit history into graph edges that can be tested, rendered, and audited.

This is inspired by dependency-graph approaches used in database consistency work such as Adya-style serialization graphs and Jepsen/Elle-style anomaly checking. IsoTrace is much smaller: it does not run a database workload and does not infer predicate reads. It analyzes local JSON histories where each read already names the transaction version it observed.

## Why This Is Hard

The analyzer has to reconstruct several edge classes without inventing facts:

- `ww`: per-key write version order
- `wr`: a transaction reads a version written by another transaction
- `rw`: a transaction read an older version before another transaction overwrote that key
- `rt`: strict-serializability realtime order

A cycle in these edges is the proof. The tool reports a representative cycle and the concrete read/write facts that created each edge.

## Demo

Run the write-skew demo:

```bash
npm install
npm run demo
```

The fixture models two doctors who both read that the other doctor is on call, then write disjoint keys to go off call. There is no write-write conflict between their writes, but IsoTrace finds the `rw` / `rw` dependency cycle.

Run the strict stale-read demo:

```bash
npm run demo:strict
```

That fixture is serializable if realtime order is ignored, but strict mode adds a realtime edge and exposes the stale read.

Open the workbench:

```bash
npm run dev
```

Then visit `http://127.0.0.1:5173/`. The first screen shows the fixture, graph, edge table, and cycle proof.

The workbench also accepts pasted history JSON in the `Custom History` editor. Paste a CLI-compatible history, click `Analyze JSON`, and the same graph, edge table, validation notes, and cycle witness update in place.

## Architecture

- `src/core/validate.ts`: runtime validation for history shape, timestamps, read provenance, and v1 modeling constraints.
- `src/core/analyzer.ts`: dependency graph construction and anomaly classification.
- `src/core/graph.ts`: Tarjan strongly connected components and cycle extraction.
- `src/core/explain.ts`: CLI proof formatting.
- `src/cli.ts`: local JSON analyzer.
- `src/bench/bench.ts`: deterministic synthetic-history benchmark smoke.
- `src/App.tsx`: browser workbench over the same analyzer.
- `fixtures/*.json`: deterministic synthetic examples.

## Input Model

IsoTrace expects JSON histories like:

```json
{
  "name": "example",
  "description": "short scenario",
  "mode": "serializable",
  "transactions": [
    {
      "id": "T0",
      "commit": 0,
      "ops": [{ "type": "write", "key": "x", "value": 0 }]
    },
    {
      "id": "T1",
      "begin": 1,
      "commit": 2,
      "ops": [{ "type": "read", "key": "x", "value": 0, "from": "T0" }]
    }
  ]
}
```

Each read must name the transaction version it observed with `from`. The referenced writer must be committed and must have written the same key and value. For v1, a transaction may write a key at most once.

## Commands

```bash
npm install
npm run typecheck
npm test
npm run build
npm run demo
npm run demo:strict
npm run bench
npm run analyze -- fixtures/write_skew_doctors.json --json
```

`npm run check` runs typecheck, tests, production build, and the benchmark smoke. The `--json` CLI mode echoes the full input history in its output, so do not use it for histories containing secrets unless printing those values is acceptable.

## Test And Benchmark Proof

The test suite covers:

- write-skew `rw` cycle detection
- serial history acceptance
- serializable versus strict-serializable stale-read behavior
- aborted transaction exclusion
- malformed read provenance
- repeated same-key writes in one transaction
- invalid statuses, ambiguous commit order, and invalid timestamps
- graph SCC and cycle extraction

The benchmark uses generated serial histories to smoke-test graph construction and cycle search at increasing sizes. The reported wall-clock timings are local smoke measurements, not production performance claims.

## Limitations

- No live database adapter.
- No SQL parser.
- No predicate-read inference.
- No claim of full Elle compatibility.
- No certification of any database system.
- Version order is commit-time order when timestamps exist; equal committed timestamps are rejected because the v1 model needs unambiguous order.
- Strict mode requires numeric `begin` and `commit` on non-initial committed transactions.
- Fixtures are synthetic, deterministic examples built to exercise the analyzer.

## What Makes It Technically Interesting

IsoTrace is not a dashboard around fake telemetry. The core artifact is a deterministic graph checker: explicit histories go in; dependency edges, SCCs, and cycle witnesses come out. The browser surface is there to make the proof legible, while tests and CLI output make the same proof reproducible from a terminal.

## Future Work

- JSON Schema for fixture validation and editor support.
- More cycle witnesses per SCC when multiple independent causes exist.
- Predicate-read and range-read modeling, if the input format grows enough to support it honestly.
- More stable benchmark methodology with warmups and environment provenance.
