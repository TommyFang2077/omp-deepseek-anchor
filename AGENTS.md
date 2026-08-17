# Project Instructions

- Keep the plugin a lightweight, install-and-forget OMP extension; do not add installers, lifecycle scripts, or packaging mutations.
- Host runtime may only narrow/restore tool catalogs and swap system-prompt fields for fresh DeepSeek sessions, plus a read-only status command. Do not add filesystem scanning, dynamic code execution, extra LLM calls, subagents, or tool registrations.
- Fail open: never leave a session without its configured tools; non-DeepSeek sessions and already-promoted sessions are never touched.
- Keep the pure anchor logic in `src/anchor.ts` free of the `pi` runtime so it stays unit-testable; wire via `src/index.ts` only.
- Keep runtime, tests, package manifest, and README identity aligned; run `bun run verify` (tests + typecheck + exact-tarball contract) before release.
- Configuration comes from `OMP_DEEPSEEK_ANCHOR_*` env vars; invalid values must warn once and fall back to safe defaults, never fail silently.
- Runtime and package code are MIT. Preserve upstream attribution in `SOURCE_PROVENANCE.md` and the README; do not copy removed upstream implementations.
- Do not commit, push, tag, or publish without explicit user approval for the current task.