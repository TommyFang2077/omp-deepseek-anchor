# omp-deepseek-anchor

Experimental OMP extension that gives fresh DeepSeek sessions a small first-request tool surface, then restores the complete configured tool catalog.

## Behavior

1. A fresh DeepSeek session starts with only `bash` and `read` active.
2. The first provider request is capped at 1024 output tokens.
3. The first tool call immediately restores the exact original tool catalog.
4. A text-only first reply restores the catalog when that agent turn ends.
5. Resumed sessions derive promotion from durable assistant messages and do not bootstrap again.

The extension only activates when the provider or model ID contains `deepseek`. Missing `bash` or `read` fails open: OMP keeps the full catalog and logs one warning.

## Automatic DSH compatibility mode

DSH compatibility remains an explicit safety opt-in, but it can be configured once and then selected automatically for every DeepSeek provider/model. Add this to the environment used to launch OMP (for example, your shell profile):

```sh
export OMP_DEEPSEEK_ANCHOR_MODE=dsh
```

Then launch OMP normally:

```sh
omp --model ccs-codex-deepseek/deepseek-v4-pro \
  --thinking max \
  --approval-mode always-ask
```

The extension still checks the provider/model ID: DeepSeek sessions use `dsh`; non-DeepSeek sessions remain unchanged. Override one launch with `OMP_DEEPSEEK_ANCHOR_MODE=safe omp ...`.

`dsh` mode changes request one only: it uses the exact Minimal persona, exposes compact `bash`/`read` schemas, and repairs OMP's required `i` field before executing bootstrap tool calls. Start a blank session and make the real inspect-first engineering task the first message.

This mode intentionally removes OMP's system, workspace, skill, and memory instructions from request one. `bash` remains available, so use an isolated worktree and keep approvals enabled. Later requests restore the normal prompt and complete tool catalog.

## Install

```sh
omp plugin install github:TommyFang2077/omp-deepseek-anchor
```

Restart OMP and create a blank session. Do not switch an existing conversation into bootstrap mode.

For local development:

```sh
omp plugin link /path/to/omp-deepseek-anchor
bun run check
```

## Design and safety

Default `safe` mode keeps OMP's system prompt, `AGENTS.md` rules, skill instructions, and tool schemas intact. Both modes perform no network requests and add no telemetry.

This is an experimental trajectory-control technique, not evidence of universal quality improvement. Evaluate it against your own models and workloads.

## Reference and attribution

Conceptually inspired by [xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard), which introduced and evaluated a two-phase "Anchored Standard" preset for DeepSeek Harness: a minimal first-request tool catalog followed by the full catalog.

This repository is an independent OMP implementation using OMP's extension and session APIs. It does not include the DeepSeek Harness Standard preset snapshot or copy the reference plugin source. Default `safe` mode deliberately retains workspace instructions and skill catalogs; opt-in `dsh` mode replaces them on request one only.

## License

MIT
