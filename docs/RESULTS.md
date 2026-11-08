# Standalone validation results

Observed on **2026-11-08**, Windows, Node.js **v26.13.0**, npm **11.20.0**,
Dolt **2.7.2**, pinned `@bradygaster/squad-sdk` **0.13.1** plus the explicitly
documented experiment patch. These are functional test results, not a benchmark.

## Passing standalone suite

```powershell
npm run typecheck
npm test -- --reporter verbose
```

Typecheck passed against public-package imports; there are no monorepo aliases.
The suite passed **14/14 tests in 3 files**:

| Suite | Tests | Evidence |
| --- | ---: | --- |
| provider.test.ts | 7 | Real Dolt filesystem remote, two real clones, proposals/review, restart/retry/scope isolation, independent merge, stale-key writes and retirement convergence, SDK-local exclusions, explicit tool-derived context, and real conflicting payloads |
| command.test.ts | 2 | Missing executable fails and provider status is unavailable; exact scope/literal validation |
| memory-lifecycle-exclusion.test.ts | 5 | Backend-neutral SDK replica filtering, promotion semantics, tombstone/index persistence failure, audited provider failure, duplicate namespace rejection; deliberately stale synthetic provider |

The observed full run reported **130.58 seconds** end-to-end. This includes
engine startup, filesystem setup, all scenarios and cleanup; it is **not**
per-operation latency, throughput, or a comparison against another backend.
No Beads or baseline Squad performance measurement was run.

### Specific observations

* Approved exact payload fingerprints survive provider restart and sync.
  Changed payloads become proposals; stale approvals cannot accept them.
* Independent A/B proposals merge, remain unapproved until explicit acceptance,
  then converge in current provider retrieval.
* Offline B actually rewrites and accepts both an old deleted ID and an old
  superseded ID. After pull/merge, neither is retrievable; after push back and
  A's pull, neither resurrects. Original payload remains in Dolt history.
* SDK deletion/promotion exclusion is local-root-scoped and independent of
  provider retirement. A direct provider and unrelated local root are controls.
* After disk restart and actual stale-clone writes/sync, an intentionally
  historical-candidate wrapper still returns both retired `DECISION` markers.
  SDK search, actual `memory.search` LLM text, and an explicitly host-composed
  charter prompt exclude them; valid control/replacement markers remain.
* Divergent same-key edits produce an actual `dolt_conflicts_memories` row.
  The conflicted clone's status/read/write/push fail closed; no winner is picked.

## Negative checks

With Dolt absent from PATH and no `DOLT_BIN`, the suite exited **1** with:

```text
Real integration requires Dolt: set DOLT_BIN to an official portable dolt executable. No mock/skip fallback.
```

Vitest reported the seven integration tests as skipped because their suite's
setup failed; the suite itself **failed**. That run is not counted as proof.

```powershell
npm run test:mutation
```

The reproducible mutation check passed: it temporarily removes the installed SDK's exact
replica rejection, requires a nonzero assertion failure containing the leaked
old key, and restores the patched module byte-for-byte in `finally`. This uses
the **synthetic-provider lifecycle tests**, not another engine benchmark.
Separately appending a synthetic alteration to the patched SDK module made the
patch installer exit 1 with `Unexpected SDK preimage`; original bytes were
restored and successful reapplication/typecheck verified.

## Fresh-install reproduction

Validation was repeated from an allowlisted-file-only copy in a separate named
artifact checkout, with no original `node_modules`, SDK sources, aliases, or
existing database. `npm ci` installs from the normalized CFS lockfile and applies
the experiment patch automatically. A new checkout-local npm cache and
`--userconfig .npmrc` were used; no personal npm user config or shipped token
was needed. Installation completed in **18 seconds**; typecheck passed and all
**14/14 tests** passed again (**128.91 seconds** end-to-end). The mutation check,
idempotent patch reapplication, and publication audit also passed there.
These elapsed times are observations, not comparative performance evidence.
The commands were:

```powershell
npm ci --userconfig .npmrc
npm run typecheck
npm test -- --reporter verbose
npm run test:mutation
node scripts\apply-sdk-patch.mjs
node scripts\audit-publication.mjs
```

No public CI is represented as passing. Manual reproduction requires access to
the configured mirror and the separately obtained official Dolt executable.
Broader source-checkout regression counts are **not** standalone test counts.

## Decision

Continue only as an isolated experiment; park production adoption pending
cross-machine/authentication/policy/recovery/concurrency/performance gates.
See README for lifecycle boundaries and known limitations.

## Live follow-up and current regression suite

Subsequent validation on **2026-11-08** used authenticated **GitHub Copilot CLI
1.0.92-3**, the public SDK's built-in `Squad` coordinator, and the explicit
sample MCP bridge. A completed trial has **six fresh real CLI sessions and
eleven genuine MCP tool calls**; neither value is an SDK test count.
Selected tool arguments/results, stale candidates versus admitted SDK text,
distinct session IDs, durable-root assignments, and actual final assistant
messages are preserved in [LIVE-EVIDENCE.json](LIVE-EVIDENCE.json).
See [LIVE.md](LIVE.md) for topology, host-controlled review/sync, the pending
replacement discovery, and limits on what this demonstrates.

After adding the bridge, the complete standalone suite was rerun:

```powershell
npm run typecheck
npm test -- live.test.ts
npm test -- --reporter verbose
```

Typecheck passed. The five targeted bridge checks passed. The full suite passed
**19/19 tests in four files**, including all original **14** tests and **5**
new bridge/schema/configuration/final-answer/stdio framing contracts.
The latter launch an actual MCP subprocess but **no model**, and are not
counted as additional live CLI sessions or Dolt integration scenarios.
The full run reported **137.59 seconds**, alongside an independent live trial;
this is not a comparable performance baseline. The earlier 14-test
fresh-install observations above remain historically accurate, not a claim
that the expanded 19-test/live trial was run by those earlier commands.

## Native optional-discovery follow-up

The subsequent native trial passed **six fresh real Squad custom-agent CLI
sessions and eleven stock MCP calls**, using Copilot CLI **1.0.92-3** and real
Dolt **2.7.2**. [NATIVE.md](NATIVE.md) explains the modified local SDK build,
normal discovery/configuration, direct stock state-MCP module entry, failed
setup attempts, and whole-CLI missing-dependency limitation.
[NATIVE-EVIDENCE.json](NATIVE-EVIDENCE.json) preserves the selected actual
native tool/factory/model observations independently of the earlier bridge
trial. Local exact-replica exclusion is challenged with historical candidates;
actual offline stale writes and merge test provider retirement separately.

The current standalone suite passed **21/21 tests in four files** in
**132.65 seconds**, with typecheck and the original lifecycle mutation passing.
Two added tests validate native factory identity rejection/discovery trace and
actual CLI-event evidence parsing; they do not start a model or count as live
proof. Original bridge tests remain passing.

Separate final modified-Squad validation passed **266/266 tests across ten suites**
in **64.51 seconds**, and SDK plus focused stock state-MCP source typechecks passed.
The native emitted-registration
mutation produced a real stock-MCP assertion failure on missing provider output,
then passed again after byte-exact restoration. Whole-CLI typecheck is not
reported as passing: unrelated `jsonc-parser` and React declaration packages
were absent in this checkout. No Beads comparison or performance benchmark
was run; elapsed suite times are observations, not comparative measurements.

## Current ordinary full CLI launch proof

On **2026-11-08**, exact locked dependencies were restored with:

```powershell
npm ci --workspace packages/squad-cli --ignore-scripts --no-audit --no-fund --registry https://packagefeedproxy.microsoft.io/npm/
node node_modules\typescript\bin\tsc -p packages\squad-sdk\tsconfig.json
npm run build --workspace packages/squad-cli
npm run lint
```

`jsonc-parser` was already declared, as were React types. No manifest or
lockfile rewrite or source workaround was needed. Both full package builds
and both full package no-emit typechecks passed.

With `SQUAD_NATIVE_STATE_MCP_MODULE` explicitly unset, the completed new trial
used the ordinary **Squad 0.13.1 `cli-entry.js state-mcp`** launcher for **all
six fresh real Squad sessions and eleven native MCP calls**, through Copilot
CLI **1.0.92-3** and Dolt **2.7.2**. Each raw server registration was checked
against the actual full entrypoint arguments, and selected calls/answers were
compared byte-for-byte with parsed raw CLI/provider events. Evidence includes
the launcher hash, actual help/version checks, no-direct-bypass flag, and six
durable SDK provider-discovery audit records. The reader, forget, supersession,
replacement/control, and actual offline stale-clone lifecycle assertions passed.

Current evidence is [NATIVE-EVIDENCE.json](NATIVE-EVIDENCE.json). The earlier
direct-module trial is [NATIVE-MODULE-EVIDENCE.json](NATIVE-MODULE-EVIDENCE.json);
the initial whole-CLI installation blockers above are historical, not current.
The sample remains an optional backend using the
[experimental native fork branch](https://github.com/tamirdresher/squad/tree/feature/native-memory-provider-discovery),
not an upstream release or production-adoption claim.

The complete standalone suite now passes **22/22 tests in four files**,
including ANSI-aware normal launcher help validation, in **125.82 seconds**.
Typecheck and the original lifecycle mutation pass. These are functional
regressions, not additional model sessions or a comparative benchmark.
After the exact lockfile restoration, the same ten production suites were
rerun: **266/266 passed in 63.17 seconds**. The emitted native-registration
mutation again made the stock MCP output contract fail as intended, restored
the original bytes, and passed again. No live trial was running during mutation.
