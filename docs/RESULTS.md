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
