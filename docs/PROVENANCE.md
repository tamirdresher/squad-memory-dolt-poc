# Provenance and experiment patch

## License verification

The public upstream is [bradygaster/squad](https://github.com/bradygaster/squad).
GitHub's public license endpoint was checked on 2026-11-08: **MIT**, file
`LICENSE`, blob `ae0b0bc0859d3f5076e2d3a8459a6b0ac09dbc05`,
[public license](https://github.com/bradygaster/squad/blob/dev/LICENSE).
The included LICENSE preserves its copyright and permission notice:
Copyright (c) 2026 Brady Gaster and contributors.

The published package `@bradygaster/squad-sdk@0.13.1` also declares MIT in its
registry metadata and package manifest. Its npm tarball is pinned by the
lockfile's integrity value. No SDK tree, binary, or dependency directory is
vendored into the publication.

## Sources

The synthetic Dolt sample was adapted from the `samples/memory-provider-dolt`
experiment in the [public Squad fork](https://github.com/tamirdresher/squad).
The provider, command tests, real-engine tests, and lifecycle regression tests
are MIT-licensed Squad-derived work. Imports and compiler configuration were
changed to use the pinned public npm package instead of monorepo source paths.
This repository's README, results, and patch installer describe the standalone
experiment; they are not copied private project/team records.

The original source checkout was based on revision
`5b1cdd21abc43cc06f813fd52aa7a91bdcba15bc`, with experimental uncommitted lifecycle
and tool-registration changes. **That revision alone does not contain or
reproduce this experiment patch.** The self-contained reviewed patch fixture is
`scripts/apply-sdk-patch.mjs`; reproducibility does not require that checkout,
its history, or its local state.

## Precisely what changes in the pinned SDK

The installer contains small before/after replacement fixtures, not an SDK fork:

1. `dist/memory/index.js`: reject duplicate provider IDs, persist acknowledged
   replica identities in local index entries, consult retired entries/tombstone
   intent after restart, and reject exact retired replicas in federated search.
2. `dist/tools/index.js`: add an optional seventh constructor argument carrying
   registered providers into the existing `LocalMemoryStore`.
3. `dist/tools/index.d.ts`: expose that argument using upstream `MemoryProvider`.

The SDK's exported storage providers, compiler, tool handler, governance rules,
and generic provider interface otherwise remain upstream implementations.
No production upstream release is claimed to contain this behavior.
Source maps remain upstream and do not describe inserted runtime lines.

Every preimage is checked against SHA-256 of the published package file:

| File | SHA-256 before patch |
| --- | --- |
| memory/index.js | `29601b2bf051bbc341a42bcb7ab832c4c01e4404e320aa6b19e57cf6efb8d12d` |
| tools/index.js | `00c4ef2d8f0f97554703d5acdef9a30ae11083031427b360812a9dae132921d6` |
| tools/index.d.ts | `804930cbb501b6a26672773b3810d61abad1450c0e40f4c525db27dba5e80d7c` |

The installer validates all three preimages before any write. Exact patched
content is also checked on reapplication. It never downloads source, changes
Git state, modifies another checkout, or applies silently to another SDK version.

## Publication boundary

Only the explicit file allowlist in `PUBLICATION.json` belongs in publication.
Do not recursively upload the working folder: `node_modules` and `.scratch`
may exist after validation. No team state, credentials, chat, machine paths,
dependency tarballs, downloaded Dolt binaries, scratch databases, or original
Git metadata are publication artifacts.
