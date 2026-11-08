# Squad memory + Dolt: a reproducible experiment

An optional Dolt-backed implementation of Squad's `MemoryProvider` seam, with
synthetic tests for reviewed sharing, stale replicas, and retrieval lifecycle.
**Not a production integration, adoption announcement, or performance benchmark.**
No Beads adapter is implemented. No real agent/model session is run.

## Quick start

Prerequisites: Node.js >=22.5.0, npm, and an official Dolt executable. This
experiment was validated on Windows with **Dolt 2.7.2**; other engine versions and
platforms are not claimed as tested. Download the portable archive matching
your platform from the [official v2.7.2 release](https://github.com/dolthub/dolt/releases/tag/v2.7.2)
and extract it outside this repository. No Dolt binaries are bundled.

Windows PowerShell, from a fresh checkout:

```powershell
# Example: official portable archive extracted alongside this checkout.
$env:DOLT_BIN = (Resolve-Path (Join-Path $PWD '..\dolt-windows-amd64\bin\dolt.exe')).Path
& $env:DOLT_BIN version
npm ci
npm run typecheck
npm run demo
npm run test:mutation
```

On macOS/Linux, set `DOLT_BIN` to the extracted executable, or put `dolt` on
`PATH`; the npm commands are the same. Those platforms remain unvalidated here.
`npm test` and `npm run demo` run the same 14 assertions; demo prints more detail.
Missing Dolt causes the integration suite to **fail**, not pass through mocks or
intentional skips. A failed setup may be displayed as skipped individual tests
by Vitest, but the suite and process exit are failures.

`.npmrc` and the lockfile use Microsoft's CFS npm mirror. No token is shipped or
requested. Network access to that mirror is a prerequisite; anonymous access on
every external machine is not asserted. If it is blocked, resolve registry
access or intentionally regenerate the lockfile against an accessible public
registry, review the diff, and revalidate the SDK preimages. This sample omits
public CI rather than assuming mirror credentials/access exist.

`npm ci` runs the explicit, version- and SHA-256-checked experiment patch in
`scripts/apply-sdk-patch.mjs`. If using `--ignore-scripts`, run that script
manually before testing. It only changes three files in this repository's
installed `node_modules/@bradygaster/squad-sdk`, never a global install.
Unexpected SDK bytes fail closed; re-running checks the exact patched bytes.
See [provenance and patch boundaries](docs/PROVENANCE.md).

## What actually runs

```text
patched public LocalMemoryStore -> DoltMemoryProvider A -> clone-a
                                                            |
                                                separate file:// Dolt remote
                                                            |
independent DoltMemoryProvider B <----------------------- clone-b
```

A disposable seed creates three SQL tables, checkpoints them, and pushes to
a filesystem Dolt remote. The harness performs **two real Dolt clones**, then
deletes the seed. This is not a Git remote, cloud account, SQL server, shared
working database, or network-authentication test.

All database commands use `execFile` with argument arrays. Only isolated Dolt
databases get synthetic author configuration and Dolt commits. The harness
does not create Git commits or alter Git/global Dolt configuration.
Most local SDK tests use `InMemoryStorageProvider`; the context-boundary
experiment uses actual `FSStorageProvider` files and newly constructed stores
to demonstrate disk restart. SDK integration is exercised on clone A; clone B
performs independent direct-provider writes, retrieval, and synchronization.

Scratch defaults to `.scratch/run-*`. `DOLT_POC_SCRATCH` can select another
named artifact directory. The harness removes only its uniquely created run
directory. To inspect evidence:

```powershell
$env:DOLT_POC_KEEP = '1'
npm run demo
Remove-Item Env:DOLT_POC_KEEP
# Use the exact RETAINED run directory; the final clone-b is deliberately conflicted.
Push-Location (Join-Path $run 'clone-b')
& $env:DOLT_BIN status
& $env:DOLT_BIN sql -r json -q 'SELECT * FROM dolt_conflicts_memories'
Pop-Location
```

Never publish scratch databases, dependencies, or downloaded binaries.
The fixture values and reviewer identities are synthetic.

## Provider integration

```typescript
import { LocalMemoryStore } from '@bradygaster/squad-sdk/memory';
import { InMemoryStorageProvider } from '@bradygaster/squad-sdk/storage';
import { DoltCli, DoltMemoryProvider } from './provider.js';

// An initialized isolated Dolt checkout; projectDirectory is a local SDK state root.
const provider = new DoltMemoryProvider(new DoltCli(cloneDirectory), 'synthetic-project');
const store = new LocalMemoryStore(new InMemoryStorageProvider(), projectDirectory, {
  registeredProviders: [provider],
});
await store.write({
  content: 'Synthetic reviewed convention',
  requestedClass: 'LOCAL',
  metadata: { project: 'synthetic-project', memoryId: 'convention-1' },
});
const proposal = await provider.inspect('convention-1');
if (!proposal) throw new Error('Replication failed; inspect SDK audit');
await provider.accept(proposal.id, proposal.fingerprint, 'synthetic-reviewer');
await store.search('Synthetic reviewed convention');
```

`write` does not checkpoint/push/pull. Caller-controlled `accept`, `retire`,
checkpointing and synchronization are **sample-specific controls**, not new
methods in the upstream generic seam. `approved: true` in an SDK request does
not authorize external acceptance. SDK-local retrieval can still show an
ordinary local write before the Dolt proposal is reviewed.

### SQL review model

* `memories`: exact `(scope, id)`, canonical JSON payload, SHA-256 fingerprint.
* `approvals`: reviewed `(scope, id, fingerprint)` and synthetic actor.
* `retirements`: durable `(scope, id)` deleted/superseded intent, optional successor.

Only accepted current payloads are eligible for provider retrieval; archive and
never-load guidance are excluded. Changing a payload requires new acceptance.
Independent additions merge without implying review. Same-key divergent edits
produce real Dolt conflicts and block retrieval, writes, and pushes until
explicit resolution. The sample never automatically chooses a conflict winner.

## Comparison: three different layers

| Aspect | Existing Squad local store/provider seam | This Dolt experiment | Beads (research only) |
| --- | --- | --- | --- |
| Primary role | Governed local knowledge plus pluggable external retrieval | Optional reviewed knowledge replication through that seam | Dependency-aware agent issue/task graph and persistent project memory |
| Persistence | Local files/index/audit; injected storage abstraction | Versioned SQL, real local remote, two clones | Upstream describes a Dolt-powered graph tracker |
| Sharing | Depends on storage/provider; not a universal sync protocol | Explicit checkpoint/push/pull; demonstrated only on one machine | Upstream documents `bd dolt push/pull`; not tested here |
| Review | SDK classification/routing; seam has no approval protocol | Exact payload fingerprint acceptance; merge is not approval | No equivalence to this acceptance policy established |
| Retirement | Experiment patches exact acknowledged replica exclusion at local retrieval boundary | Separate durable SQL retirement survives demonstrated stale-key rewrites after sync | Deletion/revocation semantics not evaluated |
| Agent context | Host chooses how to consume tool results | Real `memory.search` output explicitly composed into real charter compiler | Upstream describes `bd prime` and remembered facts; no integration here |
| Cost/performance | Not benchmarked here | Not benchmarked here | Not installed or benchmarked here |

Beads and Dolt are not interchangeable alternatives: current Beads documentation
itself describes Dolt as its backing database. Beads offers an application-level
workflow/graph surface; this sample offers a narrow storage-provider experiment.
Its README was inspected on 2026-11-08; upstream marketing such as “zero
conflict” is **not** adopted as a measured guarantee here.
[Beads source](https://github.com/steveyegge/beads) /
[documentation](https://beads.gascity.com/) /
[Dolt source](https://github.com/dolthub/dolt).

## Measured evidence, not inferred guarantees

See [standalone validation results](docs/RESULTS.md) for actual commands,
environment, test counts, and the negative missing-engine and mutation checks.
The 14-test suite covers 7 real-engine scenarios, 2 command/input checks, and
5 backend-neutral SDK lifecycle cases (the latter use a deliberately stale
synthetic provider and are not additional Dolt integration tests).

### Lifecycle and context boundary

The experiment patch durably records each acknowledged `(provider id, memory
id)` against its local entry. Deleting/superseding the entry excludes those
replicas at SDK search after restart, even if an external provider still returns
historical candidates. Exact identities, not text matching, drive exclusion.
Unrelated IDs/providers/local roots are not blanket filtered.

The adversarial context scenario performs actual offline stale writes, Dolt
sync, disk restart, and deliberately exposes historical `DECISION` candidates.
It calls the real `ToolRegistry`'s `memory.search`, then explicitly supplies its
LLM text to `compileCharterFull` as host-provided decisions. The final compiled
prompt excludes retired markers while retaining a current control and reviewed
replacement. This is **explicit host composition**, NOT proof of automatic
runtime injection, model inference, or all possible context assembly paths.

Promotion copies content unchanged into a legitimate successor. Therefore the
obsolete-text scenario explicitly deletes that intermediate local successor
before creating a reviewed replacement with different text. Promotion alone
does not erase obsolete words or make content matching a lifecycle policy.

### Continue or park?

**Continue as a bounded experiment; park production adoption.** The seam and
post-sync lifecycle behavior justify targeted follow-up, not replacing Squad's
default storage. Next gates: authenticated remote policy, cross-machine sync,
crash/concurrency recovery, scoped identity migration, and representative
performance/operational measurements. Evaluate Beads separately only if task
graph/workflow features, rather than knowledge-provider storage, are needed.

## Known limitations

* Offline clones can read stale knowledge until synchronization. Local exclusion
  is not remote revocation or distributed policy propagation.
* Retired payloads remain in Dolt history and local files. No history purge,
  remote erasure, or backup sanitization is demonstrated.
* Preexisting entries without recorded replica identities are not protected by
  retroactive identity correlation. Failed identity persistence is audited, not
  a cross-store transactional guarantee.
* Raw SQL collaborators can change approvals/retirements. Actor strings are not
  authenticated reviewer credentials; this is trusted synthetic experimentation.
* One writer/provider instance per checkout; serialization is per instance.
  No inter-process lock, background sync, spanning SDK/Dolt transaction, server,
  malicious-merge handling, schema migration, or automated conflict resolution.
* Commands have 30-second timeouts and 2 MiB output limits; payload/query are
  limited to 16 KiB and provider retrieval to 100 records per scope. Timeout does
  not prove rollback; inspect state and retry stable keys/payloads.
* No hosted remote, cloud auth, network filesystem, cross-machine, backup/restore,
  scale/latency comparison, production policy integration, or model execution
  has been validated. Results are functional correctness evidence only.

## License

MIT; see [LICENSE](LICENSE) and [provenance](docs/PROVENANCE.md). Upstream Squad
is separately pinned and clearly distinguished from this experiment patch.
