# Live Squad / Copilot CLI validation

This document preserves the explicit bridge trial. A subsequent, separate
modified-local-build native discovery trial is documented in [NATIVE.md](NATIVE.md);
the bridge evidence below is not relabeled as native integration.

Observed on **2026-11-08**, Windows, Node v26.13.0, Dolt 2.7.2,
public Squad SDK 0.13.1 plus the documented experiment patch, and
**GitHub Copilot CLI 1.0.92-3**. This is genuine authenticated model execution,
not a simulated SDK session. No model or reasoning override was supplied.

## Reproduce

Install the prerequisites and run `npm ci` as described in the README.
Additionally, an already installed, naturally authenticated Copilot CLI must
support custom agents, additional MCP configuration, restricted tools, JSONL
output, and `assistant.message` events with `phase: final_answer`.
The runner probes `--version` and `--help`, then fails loudly for missing
capabilities. It does not install/update a CLI, open a login flow, read/copy
credentials, or change global customizations.

```powershell
$env:DOLT_BIN = (Resolve-Path '..\dolt-windows-amd64\bin\dolt.exe').Path
copilot --version
npm run live
```

Windows script launchers can fall back to an older bundled CLI when their home
is isolated. If needed, point `COPILOT_LIVE_CLI_BIN` to a **supported, already
installed** executable or package `index.js`; JavaScript entrypoints are run
with the current Node executable:

```powershell
# Use the actual installed entrypoint selected on your own machine.
$env:COPILOT_LIVE_CLI_BIN = (Resolve-Path $installedCliEntrypoint).Path
npm run live
Remove-Item Env:COPILOT_LIVE_CLI_BIN
```

The observed run used an existing package entrypoint directly. Older installed
1.0.59/1.0.72 launch paths and newer launcher-reported versions are not claimed
as the executed version. Unsupported flags were diagnosed before the successful
trial; no upgrade or credential workaround was performed.

Each invocation creates a uniquely named `.scratch/live/run-*` with two real
Dolt clones, a filesystem remote, separate durable local SDK roots A/B,
isolated CLI home, six synthetic workspaces, and six random session UUIDs.
CLI home isolation does not imply authentication, filesystem sandboxing, or
all operating-system settings are isolated. Authentication is naturally reused.
`COPILOT_ALLOW_ALL=true` is scoped to spawned trial processes; the CLI's
available-tool allowlist contains only this bridge's four tools. Built-in MCPs
and unrelated custom instructions are disabled; no shell/delegation tool is
exposed. The stock coordinator is invoked with `--agent Squad` in Direct Mode.
No actual private team, histories, decisions, or environment files are copied.

Each CLI process is bounded to three minutes; its stdio MCP server is attached
and terminates with the session. There are no persistent services or global
configuration writes. Raw stdout/log/configuration/failure traces remain
**private scratch artifacts**. Do not recursively publish them.
On success the runner overwrites `docs/LIVE-EVIDENCE.json` with only selected
synthetic evidence; review that diff before publication.

## Explicit bridge, not native provider loading

```text
public built-in Squad coordinator (--agent Squad)
    -> actual Copilot CLI model tool request
    -> sample stdio MCP bridge (memory_write/search/delete/promote)
    -> upstream real ToolRegistry handler
    -> patched LocalMemoryStore + real FSStorageProvider
    -> optional scoped Dolt provider -> clone A or B
```

The copied coordinator comes byte-for-byte from the pinned public npm package;
its SHA-256 is recorded in the evidence. The synthetic roster is only a
fixture. No specialist session or nested delegation is launched.

Installed Squad does not natively discover this provider from a project config.
The bridge registers it explicitly via the patch's seventh ToolRegistry
constructor argument. Upstream `memory.write` has no project metadata/stable ID
argument: the bridge adds a required synthetic `memoryId` and supplies the
configured exact project scope. Promotion receives a fresh synthetic provider
key. These are sample adapter decisions, not upstream supported configuration.
The bridge serializes MCP requests and calls the existing handlers rather than
implementing alternative governance.

Actual CLI tool execution receives actual MCP response text. The final-answer
checker reads only `assistant.message` final-answer content, never raw tool
echoes, prompts, or usage events. The evidence records full synthetic SDK
result text and separately records candidate rows before SDK lifecycle
filtering. It deliberately omits raw API/request/account/environment data.

## Completed six-session trial

| Fresh session | Root / clone | Genuine tool calls | Observed outcome |
| --- | --- | ---: | --- |
| writer | A / A | 3 writes | Real governed local writes replicate all three synthetic proposals |
| reader | B / B | 1 search | After explicit host acceptance and sync, independent model quotes routing, prior signing, and control values from the tool |
| forget-fresh | A restarted / A | 1 delete, 1 search | Pinned routing candidate reaches SDK boundary but is excluded from tool result and final answer; prior signing/control remain |
| supersede-fresh | A restarted / A | 1 promote, 1 delete, 1 write | Model promotes prior record, deletes legitimate unchanged successor, writes different replacement |
| supersede-check-fresh | A restarted / A | 1 search | After host acceptance, both pinned old candidates are excluded; model answers with reviewed replacement/control |
| final-independent-fresh | B restarted / B | 1 search | After actual offline stale rewrites and sync, independent new model answers only replacement/control |

Session UUIDs, prompts, actual tool arguments/results, candidate-versus-admitted
text, and final model answers are in [LIVE-EVIDENCE.json](LIVE-EVIDENCE.json).
Exclusion/retrieval prompts do **not** contain obsolete marker values. Delete
and promotion prompts use local IDs; the final independent reader gets only
the generic query. No session is resumed with a previous transcript.

The host—not the model—explicitly:

1. Accepts exact fingerprints of the three writer proposals, checkpoints,
   pushes clone A, and pulls B.
2. Retires the forgotten provider ID only **after** the core stale-candidate
   challenge, so local core exclusion is independently exercised.
3. Accepts the replacement before the new supersede-check reader; retires the
   prior provider ID only **after** that core challenge; checkpoints/pushes A.
4. Keeps B offline from both retirements, actually rewrites and accepts both
   old keys in B, confirms two stale rows are retrievable there, then
   checkpoints/pulls/merges/pushes B and pulls A. Zero stale rewrite rows are
   retrieved after merge. The final B CLI session is then started.

The pinned historical-candidate wrapper is an intentional adversarial fixture,
not a real offline network fetch. The separate B stale rewrites/merge use
actual Dolt, not fixtures. Both parts are necessary: observing no old marker
from an already-filtered provider alone would not prove the local core guard.

### What debugging revealed

An earlier live attempt correctly completed write/read/delete/promote calls,
but its search could not retrieve the **unreviewed** replacement text from the
provider. Upstream local search showed a short metadata-line snippet instead
of the full fact. This was not counted as a passing lifecycle trial. The final
runner explicitly separates proposal write, host acceptance, and a fresh
retrieval session; it does not silently auto-approve or broaden local search.

## Limits and decision

This is evidence that a real Squad custom agent can use this explicitly wired
provider through real CLI tools and answer from the admitted results. It is
**not native Squad adoption**, automatic prompt injection, proof that every
agent context path is guarded, or a formal stochastic-model safety guarantee.
Prior in-session cached knowledge is not invalidated; only newly started
sessions and governed retrieval were tested. Memory tools themselves still
return snippets/local metadata, not an unrestricted document reader.

Core replica exclusion is tied to acknowledged identities in a particular
durable local root. Unrelated/unbound roots do not inherit it. Provider
retirement converges only after sync; offline B can retrieve stale accepted
rows before then. Promotion alone preserves content. Dolt history and local
files are not erased. Actors are synthetic strings, not authenticated review
policy. CLI auth success does not validate a hosted Dolt remote or remote
revocation. No Beads implementation, benchmark, cross-machine trial, or
production policy integration is demonstrated.

**Continue the bridge as a bounded experiment; park production adoption.**
Native registration/write metadata, review authority, cross-machine sync,
crash/concurrency recovery, and representative operational measurements
remain follow-up gates.
