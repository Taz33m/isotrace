# IsoTrace

![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-blue)
![License: MIT](https://img.shields.io/badge/License-MIT-green)

IsoTrace is a local transaction-history analyzer for explicit key-value histories. It builds a dependency graph and explains serializability or strict-serializability failures as semantic verdicts with concrete cycle witnesses.

## Technical Seam

Transaction isolation failures are hard to inspect because the evidence is spread across reads, writes, version order, and realtime order. A history that looks harmless row-by-row can be impossible to serialize once read-write anti-dependencies are connected. IsoTrace focuses on that hard middle layer: turn an explicit history into graph edges that can be tested, rendered, and audited.

This is inspired by dependency-graph approaches used in database consistency work such as Adya-style serialization graphs and Jepsen/Elle-style anomaly checking. IsoTrace is much smaller: it does not run a database workload and does not infer predicate reads. It analyzes local JSON histories where each read already names the transaction version it observed.

## Why This Is Hard

The analyzer has to reconstruct several edge classes without inventing facts:

- `ww`: per-key write version order
- `wr`: a transaction reads a version written by another transaction
- `rw`: a transaction read an older version before another transaction overwrote that key
- `rt`: strict-serializability realtime order

A cycle in these edges is the proof of a violation. For clean evaluated graphs, IsoTrace reports a deterministic topological transaction order that satisfies the dependency edges.

IsoTrace also emits a conservative semantic verdict: serializable pass/fail, strict-serializable pass/fail/not-evaluated, anomaly label, implicated transactions, proof edge sequence, and bounded limitations. Supported labels are intentionally narrow: write skew, strict stale read, generic dependency cycle, valid serial history, and aborted write ignored. This is not full Elle compatibility or complete Adya anomaly coverage.

## Quick Start

```bash
npm ci
npm run check
npm run demo
npm run smoke:ui
```

## Demo

Run the write-skew demo:

```bash
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

Version order is explicit rather than inferred from read values. `T0` is reserved for an initial seed transaction when present; its optional `commit` is allowed but does not force the rest of the fixture into timestamped ordering. For committed transactions other than `T0`, either every transaction supplies a numeric `commit` and IsoTrace orders versions by commit time, or every transaction omits `commit` and IsoTrace uses fixture order. Mixed explicit/missing commits among non-initial committed transactions are rejected because the version order would be ambiguous.

## Commands

```bash
npm install
npm run typecheck
npm test
npm run build
npm run demo
npm run demo:strict
npm run fixtures
npm run bench
npm run bench -- --json
npm run smoke:ui
npm run artifacts:check
npm run analyze -- --fixtures --json
npm run analyze -- examples/valid_history.json --validate
npm run analyze -- fixtures/write_skew_doctors.json --json
```

`npm run check` runs typecheck, tests, production build, and the benchmark smoke. The `--json` CLI mode emits a report envelope with schema version, tool version, command, runtime, git state, input byte count, input SHA-256, and the full analysis result. That result includes the full input history, so do not use it for histories containing secrets unless printing those values is acceptable.

`--fixtures` lists checked-in demo histories, expected verdict contracts, and reproduction commands. `--fail-on-violation` exits with status `2` after printing the human proof or JSON report, which makes analyzer violations usable as a CI gate. `--validate` checks a history file against `schemas/history.schema.json` and IsoTrace's semantic constraints without running analysis. Analyzer JSON reports are shaped by `schemas/report.schema.json`; benchmark JSON reports are shaped by `schemas/benchmark.schema.json`. `npm run artifacts:check` validates checked-in fixtures, fixture verdict contracts, portable examples, generated analyzer reports, CLI JSON reports, and the CLI fixture catalog.

`npm run smoke:ui` runs CLI proof checks first, then launches a local Vite workbench with Playwright when a headless browser is available. It verifies fixture selection, custom JSON import, custom validation errors, and a cycle witness without using the in-app browser.

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

`npm run bench -- --json` emits the same benchmark rows inside a provenance envelope with benchmark settings. The timing rows are still smoke measurements; the provenance exists so a run can be attributed and reproduced, not to imply hardware-independent performance.

## Limitations

- No live database adapter.
- No SQL parser.
- No predicate-read inference.
- No claim of full Elle compatibility.
- No certification of any database system.
- Equal non-initial commit timestamps are rejected because the v1 model needs unambiguous version order.
- Strict mode requires numeric `begin` and `commit` on non-initial committed transactions.
- Fixtures are synthetic, deterministic examples built to exercise the analyzer.

## What Makes It Technically Interesting

IsoTrace is not a dashboard around fake telemetry. The core artifact is a deterministic graph checker: explicit histories go in; dependency edges, SCCs, and cycle witnesses come out. The browser surface is there to make the proof legible, while tests and CLI output make the same proof reproducible from a terminal.

## Future Work

- Richer editor affordances around schema errors, without broadening the input model.
- More cycle witnesses per SCC when multiple independent causes exist.
- Predicate-read and range-read modeling, if the input format grows enough to support it honestly.
- More stable benchmark methodology with warmups and repeated samples.
