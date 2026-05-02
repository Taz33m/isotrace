# IsoTrace

![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-blue)
![License: MIT](https://img.shields.io/badge/License-MIT-green)

Artifact paper: [paper/isotrace.pdf](paper/isotrace.pdf)

IsoTrace is a local transaction-history analyzer for explicit key-value and modeled predicate-read histories. It builds a dependency graph and explains serializability or strict-serializability failures as semantic verdicts with concrete cycle witnesses.

## Problem IsoTrace Solves

Given an explicit transaction history, IsoTrace answers whether isolation failed and which dependency cycle proves it.

Before IsoTrace, a trace may contain reads, writes, predicate rows, commit times, and realtime facts, but the actual cause of the isolation failure is hidden across those pieces of evidence. After IsoTrace, the same trace has a verdict, anomaly label, implicated transactions, proof edges, cycle witness, and row-level evidence that can be inspected in the CLI, JSON report, or browser workbench.

## Technical Seam

Transaction isolation failures are hard to inspect because the evidence is spread across reads, writes, version order, and realtime order. A history that looks harmless row-by-row can be impossible to serialize once read-write anti-dependencies are connected. IsoTrace focuses on that hard middle layer: turn an explicit history into graph edges that can be tested, rendered, and audited.

This is inspired by dependency-graph approaches used in database consistency work such as Adya-style serialization graphs and Jepsen/Elle-style anomaly checking. IsoTrace is much smaller: it does not run a database workload and does not certify database behavior. It analyzes local JSON histories where each point read already names the transaction version it observed, plus a narrow explicit predicate-read model where row membership evidence is supplied by the fixture.

## Why This Is Hard

The analyzer has to reconstruct several edge classes without inventing facts:

- `ww`: per-key write version order
- `wr`: a transaction reads a version written by another transaction
- `rw`: a transaction read an older version before another transaction overwrote that key
- `prw`: an explicit predicate read saw one row-membership set before another transaction changed a modeled row's membership
- `rt`: strict-serializability realtime order

A cycle in these edges is the proof of a violation. For clean evaluated graphs, IsoTrace reports a deterministic topological transaction order that satisfies the dependency edges.

IsoTrace also emits a conservative semantic verdict: serializable pass/fail, strict-serializable pass/fail/not-evaluated, anomaly label, implicated transactions, proof edge sequence, and bounded limitations. Supported labels are intentionally narrow: write skew, explicit predicate phantom, strict stale read, generic dependency cycle, valid serial history, and aborted write ignored. This is not full Elle compatibility or complete Adya anomaly coverage.

## Quick Start

```bash
npm ci
npm run check
npm run demo
npm run demo:sql
npm run demo:phantom
npm run demo:predicate2
npm run smoke:ui
```

## 90-Second Demo Loop

The clearest demo is the explicit predicate phantom fixture:

```bash
npm ci
npm run demo:phantom
```

Look for these lines in the output:

- `Result: VIOLATION`
- `Serializable: FAIL`
- `Anomaly: Explicit predicate phantom [predicate-dependency-cycle]`
- `Implicated transactions: T1, T2`
- `Proof edges: e3 -> e4 (prw -> prw)`
- `Cycle witnesses`
- `before:` and `after:` row evidence for each `prw` edge

Then open the workbench:

```bash
npm run dev
```

Visit `http://127.0.0.1:5173/`, select **Explicit predicate phantom**, click a `prw` proof edge, and inspect the predicate row evidence. The browser surface shows the same analyzer result as the CLI: verdict, graph, cycle proof, selected edge, and before/after row evidence.

Secondary proof commands:

```bash
npm run smoke:ui
npm run artifacts:check
```

## Demo

Hero trace:

```bash
npm run demo:phantom
```

That fixture models two predicate reads and two relational writes whose row-membership changes create a `prw` / `prw` cycle. The proof includes before/after row evidence from the supplied history. This is explicit predicate-read evidence, not SQL range inference.

Supporting demos:

```bash
npm run demo
npm run demo:strict
npm run demo:sql
npm run demo:predicate2
```

`npm run demo` shows write skew: two doctors both read that the other doctor is on call, then write disjoint keys to go off call. There is no write-write conflict between their writes, but IsoTrace finds the `rw` / `rw` dependency cycle.

`npm run demo:strict` shows a stale read that is serializable if realtime order is ignored, but fails strict serializability once the realtime edge is included.

`npm run demo:sql` parses a small subset of annotated SQL event syntax, materializes returned `SELECT` rows into explicit read-from operations, and finds the same write-skew shape. It does not connect to a database or infer phantoms from non-returned rows.

`npm run demo:predicate2` uses explicit `all` predicates plus modeled deletes. The proof records returned-row evidence before the delete and `null` after the delete. It still relies on supplied row evidence, not database snapshot inference.

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
- `src/sql/trace.ts`: constrained SQL trace importer for annotated local traces.
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

Each point read must name the transaction version it observed with `from`. The referenced writer must be committed and must have written the same key and value. For v1, a transaction may write a key at most once.

Predicate reads use an explicit operation, not SQL parsing:

```json
{
  "type": "predicate-read",
  "table": "doctors",
  "predicate": { "column": "on_call", "op": "=", "value": true },
  "returnedRows": [{ "id": "alice", "on_call": true }]
}
```

Predicates may be leaves (`column`, `op`, `value`) or explicit composites with `all`, `any`, and `not`. Writes may carry relational metadata (`table`, `rowId`, `fields`) plus optional `mutation`, `rowBefore`, and `rowAfter` so the analyzer can evaluate modeled insert/update/delete membership changes.

Version order is explicit rather than inferred from read values. `T0` is reserved for an initial seed transaction when present; its optional `commit` is allowed but does not force the rest of the fixture into timestamped ordering. For committed transactions other than `T0`, either every transaction supplies a numeric `commit` and IsoTrace orders versions by commit time, or every transaction omits `commit` and IsoTrace uses fixture order. Mixed explicit/missing commits among non-initial committed transactions are rejected because the version order would be ambiguous.

## SQL Trace Import

`--sql-trace` accepts a deliberately small local trace syntax:

```sql
BEGIN T1 AT 1 PROCESS worker-a
T1: SELECT id, on_call FROM doctors WHERE id = 'bob' AND on_call = true -> [{"id":"bob","on_call":true,"_from":"T0"}]
T1: UPDATE doctors SET on_call = false WHERE id = 'alice'
COMMIT T1 AT 2
```

Supported statements are `BEGIN`, `COMMIT`, `ROLLBACK`, `INSERT INTO ... VALUES ...`, single-column `UPDATE ... SET ... WHERE id = ...`, and `SELECT cols FROM table WHERE predicate -> JSON rows`. Each returned `SELECT` row must include `_from` provenance and `id` or `_id`. IsoTrace records predicate evidence on generated point reads and relational metadata on generated writes. This is annotated trace import, not general SQL parsing or phantom inference.

## Commands

```bash
npm install
npm run typecheck
npm test
npm run build
npm run demo
npm run demo:strict
npm run demo:sql
npm run demo:phantom
npm run demo:predicate2
npm run fixtures
npm run bench
npm run bench -- --json
npm run smoke:ui
npm run artifacts:check
npm run analyze -- --fixtures --json
npm run analyze -- examples/valid_history.json --validate
npm run analyze -- examples/write_skew_sql_trace.sql --sql-trace
npm run analyze -- fixtures/write_skew_doctors.json --json
npm run analyze -- fixtures/phantom_predicate_cycle.json --json
npm run analyze -- fixtures/composite_predicate_delete_cycle.json --json
```

`npm run check` runs typecheck, tests, production build, and the benchmark smoke. The `--json` CLI mode emits a report envelope with schema version, tool version, command, runtime, git state, input byte count, input SHA-256, and the full analysis result. That result includes the full input history, so do not use it for histories containing secrets unless printing those values is acceptable.

`--fixtures` lists checked-in demo histories, expected verdict contracts, and reproduction commands. `--fail-on-violation` exits with status `2` after printing the human proof or JSON report, which makes analyzer violations usable as a CI gate. `--validate` checks a history file against `schemas/history.schema.json` and IsoTrace's semantic constraints without running analysis. Analyzer JSON reports are shaped by `schemas/report.schema.json` and include structured predicate proof rows for `prw` edges. Benchmark JSON reports are shaped by `schemas/benchmark.schema.json`. `npm run artifacts:check` validates checked-in fixtures, fixture verdict contracts, portable examples, generated analyzer reports, CLI JSON reports, and the CLI fixture catalog.

`npm run smoke:ui` runs CLI proof checks first, then launches a local Vite workbench with Playwright when a headless browser is available. It verifies fixture selection, custom JSON import, custom validation errors, and a cycle witness without using the in-app browser.

## Test And Benchmark Proof

The test suite covers:

- write-skew `rw` cycle detection
- serial history acceptance
- serializable versus strict-serializable stale-read behavior
- aborted transaction exclusion
- malformed read provenance
- repeated same-key writes in one transaction
- explicit predicate evaluator and `prw` edge creation/exclusion
- predicate-dependency-cycle fixture and report schema validation
- invalid statuses, ambiguous commit order, and invalid timestamps
- graph SCC and cycle extraction

The benchmark uses generated serial histories to smoke-test graph construction and cycle search at increasing sizes. The reported wall-clock timings are local smoke measurements, not production performance claims.

`npm run bench -- --json` emits the same benchmark rows inside a provenance envelope with benchmark settings. The timing rows are still smoke measurements; the provenance exists so a run can be attributed and reproduced, not to imply hardware-independent performance.

## Limitations

- No live database adapter.
- No general SQL parser. The SQL importer is constrained trace syntax, not database SQL coverage.
- Explicit predicate-read phantom-style edges only. IsoTrace evaluates supplied predicate objects against supplied row fields and modeled insert/update/delete row evidence; it does not infer missing rows, ranges, joins, SQL expressions, or database snapshots.
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
- More precise missing-row evidence for predicates, if the input format grows enough to support it honestly.
- More stable benchmark methodology with warmups and repeated samples.
