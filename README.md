# omp-deepseek-anchor

Experimental OMP extension that gives fresh DeepSeek sessions a small first-request tool surface, then restores the complete configured tool catalog.

## Behavior

1. A fresh DeepSeek session starts with only `bash` and `read` active.
2. The first provider request is capped at 1024 output tokens.
3. The first tool call immediately restores the exact original tool catalog.
4. A text-only first reply restores the catalog when that agent turn ends.
5. Resumed sessions derive promotion from durable assistant messages and do not bootstrap again.

The extension only activates when the provider or model ID contains `deepseek`. Missing `bash` or `read` fails open: OMP keeps the full catalog and logs one warning.

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

This plugin keeps OMP's system prompt, `AGENTS.md` rules, and skill instructions intact. It narrows only the active tool catalog and the first request's output budget. It performs no network requests and adds no telemetry.

This is an experimental trajectory-control technique, not evidence of universal quality improvement. Evaluate it against your own models and workloads.

## Reference and attribution

Conceptually inspired by [xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard), which introduced and evaluated a two-phase "Anchored Standard" preset for DeepSeek Harness: a minimal first-request tool catalog followed by the full catalog.

This repository is an independent OMP implementation using OMP's extension and session APIs. It does not include the DeepSeek Harness Standard preset snapshot or copy the reference plugin source. Unlike the reference preset, it deliberately does not strip workspace instructions or skill catalogs.

## License

MIT
