# Source provenance

`omp-deepseek-anchor` is an independent MIT implementation that ports the
*trajectory-anchoring* technique of DeepSeek Harness's `anchored-standard`
preset to the Oh My Pi (OMP) extension API. It does not distribute upstream
runtime source; the plugin is written from scratch against the OMP
`ExtensionAPI` surface.

## Reviewed projects

| Project | Repository | Reviewed revision | Use in the current package |
| --- | --- | --- | --- |
| dsh-anchored-standard | https://github.com/xiaobright/dsh-anchored-standard | `25f21aefaf8ddc414da54d2e581e43740d977c6e` | Source of the Minimal persona pair (`bash` + `str_replace_editor`), the `either` promotion signal, the zero-tool anchor text, and the post-promotion resident-catalog fix; behavior is reimplemented for OMP payloads |
| deepseek-harness | https://github.com/deepseek-ai/DeepSeek-Harness | `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca` | MIT-licensed upstream preset definitions that the port references for measurements and vocabulary |
| dsh-routing-suite | https://github.com/dragonbaba/dsh-routing-suite | upstream `main` as of 2026-08-17 | Design reference for this repository's engineering structure: pure router/anchor module, read-only status surface, env-config validation, exact-tarball package verification, and provenance documentation. No routing code is used |
| modeltest | https://github.com/xiaobright/modeltest | documents cited in README | Benchmark evidence for Minimal anchoring (98/99 scores; V4 trigger experiments) |

## Independent implementation boundary

The shipped implementation is limited to:

- a dependency-free payload/state transform module (`src/anchor.ts`);
- extension wiring that narrows to `bash`+`edit` on fresh DeepSeek sessions and restores the resident/full catalog on promotion (`src/index.ts`);
- a read-only `/deepseek-anchor-status` command for observing runtime state;
- env-var configuration with warn-and-fallback validation;
- exact-tarball package contract verification (`scripts/verify-package.mjs`).

It contains no subagents, extra LLM calls, filesystem or process management,
dynamic code execution, package installers, or lifecycle scripts. On
non-DeepSeek models and already-promoted sessions it is a complete no-op.

Published artifacts must be generated from this repository and pass the exact
tarball allowlist in `scripts/verify-package.mjs`. Current repository HEAD at
the time of writing: `f4ec019fe790cab2452a61200f3d52e6accd7e82`.