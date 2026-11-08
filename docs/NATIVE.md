# Native optional provider discovery: local-build validation

**Observed 2026-11-08. Experimental modified local Squad SDK, not a shipped
upstream feature.** The public npm pin and three-file patch still support the
explicit bridge; they do not implement native discovery. No native-source SDK
fork or unreleased package is bundled here.

## What changed in Squad

Ordinary `LocalMemoryStore` now discovers backend-neutral optional factories
from the resolved team's `.squad/config.json`. Its normal consumers include
stock Squad state-MCP memory tools and SDK `ToolRegistry`, without a seventh
constructor argument. Dolt stays exclusively in this optional sample factory.

```json
{
  "memory": {
    "providers": [{
      "module": ".squad/providers/live/native-factory.mjs",
      "trusted": true,
      "options": {
        "clone": "YOUR_SYNTHETIC_CLONE",
        "scope": "synthetic-live-project",
        "trace": "YOUR_PRIVATE_SYNTHETIC_TRACE"
      }
    }]
  }
}
```

These placeholders describe factory options, not secret credentials. The
runner creates real local paths in excluded scratch. Its factory receives
`{projectRoot, squadRoot, options}` and returns an ordinary `MemoryProvider`.
Native writes supply a persisted UUID as generic `sourceId`; the factory uses
`native-${sourceId}` and configured scope. Stock memory tool schemas do not
receive `memoryId` or Dolt-specific metadata.

`trusted: true` authorizes **privileged project JavaScript**, not sandboxed code.
Only compiled `.js`/`.mjs`/`.cjs` local modules contained under the parent of the
resolved `.squad` directory are allowed, including contained absolute paths.
Remote URLs, path/junction escapes, invalid factories/config, and duplicate or
built-in provider namespaces fail explicitly. Review transitive imports too.
Discovery is once per store; restart the process after changing configuration.
Missing/empty provider config keeps ordinary local behavior. Discovery is audited;
replication errors preserve local persistence but surface explicit partial failure.

## Reproduce against the modified local build

Obtain the experimental
[fork implementation branch](https://github.com/tamirdresher/squad/tree/feature/native-memory-provider-discovery).
This is **not a released upstream SDK**. Restore the exact checked-in dependency
versions; the base revision alone does not contain native discovery. Do not
globally install or replace your normal Squad/Copilot setup:

```powershell
git clone --branch feature/native-memory-provider-discovery https://github.com/tamirdresher/squad.git squad-native
Set-Location squad-native
# Restore already-declared dependencies from the lockfile; no manifest/lock rewrite.
npm ci --workspace packages/squad-cli --ignore-scripts --no-audit --no-fund --registry https://packagefeedproxy.microsoft.io/npm/
# Build both packages without root prebuild/version/template synchronization.
node node_modules\typescript\bin\tsc -p packages\squad-sdk\tsconfig.json
npm run build --workspace packages/squad-cli
npm run lint
node packages\squad-cli\dist\cli-entry.js --version
```

From this sample after `npm ci`, set official portable Dolt and the already
authenticated installed Copilot CLI entrypoint as described in [LIVE.md](LIVE.md):

```powershell
$env:DOLT_BIN = (Resolve-Path '..\dolt-windows-amd64\bin\dolt.exe').Path
$env:COPILOT_LIVE_CLI_BIN = 'YOUR_EXISTING_COPILOT_ENTRYPOINT'
Remove-Item Env:SQUAD_NATIVE_STATE_MCP_MODULE -ErrorAction SilentlyContinue
$env:SQUAD_NATIVE_CLI_ENTRYPOINT = 'YOUR_MODIFIED_SQUAD_CHECKOUT\packages\squad-cli\dist\cli-entry.js'
npm run live:native
```

The observed current run invokes **the ordinary full CLI entrypoint**
`cli-entry.js state-mcp`, not an exported-function shortcut. The runner first
checks actual launcher version and help for `memory` and `state-mcp`, then
records its emitted-file SHA-256. `nativeLaunch.mode` must be
`full-cli-entrypoint` and `directFunctionBypass` must be false. Every one of the
six raw MCP configurations was independently checked for exactly the full
entrypoint plus `state-mcp`; actual tool results and final assistant messages
were matched to the raw CLI events, not merely successful process exit.

The full entrypoint runs the genuine MCP SDK stdio server, normal state
resolution, ordinary ToolRegistry, and native LocalMemoryStore discovery.
It is **not** `live/mcp.ts`, `LiveBridge`, or a sample-specific MCP translation.
The freshly built launcher reports Squad **0.13.1**; this version label does
not imply the published upstream package includes the experimental native patch.

The earlier direct-stock-module trial remains separately preserved in
[NATIVE-MODULE-EVIDENCE.json](NATIVE-MODULE-EVIDENCE.json). It was used when
`jsonc-parser` and React types were missing from installation, despite already
being declared. A no-lockfile semver restore selected Copilot SDK 1.0.29 and
exposed unrelated reasoning-type drift; exact lockfile `npm ci` restored
**1.0.11**, `jsonc-parser` **3.3.1**, and `@types/react` **19.2.18** without
source/manifest/lockfile changes. Both full package builds and the complete
SDK/CLI no-emit checks now pass. The launcher failure was resolved by dependency
restoration, not a source workaround. ANSI-styled help initially tripped the
preflight assertion; its normalization now has a regression test.

`SQUAD_NATIVE_STATE_MCP_MODULE` remains a diagnostic option that takes precedence
if set. It was **unset** in the full-launch proof and must be unset to reproduce
that proof. A direct-module run is explicitly labeled as a bypass in new evidence.

Six actual fresh `--agent Squad` model sessions use isolated CLI home, only the
public built-in coordinator, and two synthetic persistent state roots. Each
native MCP registration points to the stock module/CLI, while provider discovery
uses only project config and the optional provider factory. Raw stdout, MCP
config, provider trace, and state audit remain excluded scratch. No global
customization or authentication file is read/copied, and no model override is used.

## Observed native trial

[NATIVE-EVIDENCE.json](NATIVE-EVIDENCE.json) preserves selected actual native tool
arguments, plain stock-MCP response text, factory-discovery/write/candidate
events, fresh session UUIDs, and final assistant answers. Its normalized
`textResultForLlm` field is the actual CLI tool completion content, not an
injected prompt or custom bridge return.

| Fresh session | Actual stock tool calls | Observation |
| --- | ---: | --- |
| writer | 3 | Model invokes `memory.write` for three synthetic facts; native factory receives persisted UUIDs and real Dolt acknowledges replicas |
| independent reader B | 1 | `memory.search` returns host-reviewed shared replicas; model uses all three facts |
| forget, restarted A | 2 | Model deletes local routing entry and searches; factory returns its historical candidate, core excludes it, valid control survives |
| supersede, restarted A | 3 | Model promotes signing entry, deletes unchanged intermediate successor, then writes replacement |
| replacement check, fresh A | 1 | After explicit host acceptance, both retired candidates are excluded; replacement/control reach tool output and answer |
| final independent, restarted B | 1 | After actual offline stale writes/acceptance and sync, obsolete routing/signing are absent; replacement/control remain |

Total current full-launch trial: **six real sessions, eleven tool calls**, Squad
launcher **0.13.1**, Copilot CLI **1.0.92-3**, Dolt **2.7.2**. Trial counts are
not deterministic unit-test counts. Failed setup
attempts are not counted as passing sessions: the isolated launcher selected
1.0.59 without Squad discovery, aggregate CLI initialization found the missing
dependency, and initial evidence parsing rejected the actual hyphen-normalized
MCP tool name. Those historical attempts are not the current full-launch proof.
The corrected complete full-entrypoint native trial above passed.

Exact-fingerprint approval, SQL retirement, and checkpoint/push/pull are
**explicit host-review controls**, not model authority. The historical-candidate
fixture deliberately supplies retired rows to core after process restart; it is
disclosed synthetic fault injection. Separately, clone B really rewrites and
accepts both stale keys offline: two stale records are readable before merge
and zero afterwards. Provider retirement is therefore distinguished from the
local root's exact bound-replica guard.

This does not erase Dolt history, revoke independent/offline readers, invalidate
cached transcripts, bind previously unacknowledged IDs, prove hosted networking,
or establish a stochastic safety guarantee. Continue the isolated experiment;
park production adoption pending policy, recovery, concurrency, authentication,
and performance validation. Beads remains researched only.

## Deterministic checks and registration mutation

The complete standalone suite passes **22/22**: original 14, prior five bridge
contracts, two native-factory/evidence contracts, and one ANSI-aware actual
launcher version/command-help contract. SDK tests are separate:
the modified Squad source passes **266 tests across ten relevant suites**,
including native discovery, lifecycle, provider/governance/tools/config,
stock state-MCP, and LocalMemoryStore characterization. The SDK build, full CLI
build, and `npm run lint` (both complete package no-emit typechecks) pass after
restoring locked dependencies. Earlier focused-only typecheck evidence is
historical and is no longer the limit of the current validation.

```powershell
npm run typecheck
npm test
npm run test:mutation
$env:SQUAD_NATIVE_REPO_ROOT = 'YOUR_MODIFIED_SQUAD_CHECKOUT'
npm run test:mutation:native
node scripts\audit-publication.mjs
```

The native mutation checks the **actual emitted SDK discovery module**:
bypass its returned provider registrations, require the stock MCP contract to
fail on missing `replicas.json`, restore exact original bytes in `finally`,
and require the same stock MCP contract to pass again. No model runs occur in
this mutation test; it is not another real-Dolt scenario.

## Precise native product changes for source review

Relative to the separate Squad checkout (not this sample's publication):

* `packages/squad-sdk/src/memory/discovery.ts` — trusted optional factory loader.
* `packages/squad-sdk/src/memory/index.ts` — ordinary-store discovery, stable
  identity, explicit replication errors; preserves existing lifecycle guard.
* `packages/squad-sdk/src/tools/index.ts` — partial-replication tool results;
  retains the explicit bridge's optional registration argument.
* `packages/squad-sdk/src/config/schema.ts`
* `packages/squad-sdk/src/runtime/config.ts` — typed optional provider config.
* `test/memory-provider-discovery.test.ts` — native configuration/runtime contracts.
* `docs/src/content/docs/features/memory.md` — native API/trust/lifecycle docs.
* `.changeset/native-memory-provider-discovery.md` — experimental SDK API change.

Stock `state-mcp.ts` and `squad.agent.md` are unchanged. Existing source-checkout
user changes are retained. No commit, push, PR, global settings change, or
production adoption is part of this validation.
