# OMP DeepSeek Anchor

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Unlock DeepSeek V4's "we" trajectory in OMP** — port of [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) for Oh My Poof, maintaining Minimal persona across tool results.

## 🔥 Why This Matters

DeepSeek V4 Pro conditions **heavily** on the first request. Standard OMP prompt produces "let me" style; Minimal persona produces collaborative "we" style. This plugin anchors V4 onto the Minimal trajectory while keeping full OMP tooling.

**Measured impact** (same complex task, DeepSeek V4 Pro, `thinking=max`):

| Phase | First-request-only anchor | **Full DSH parity** | Improvement |
|-------|---------------------------|---------------------|-------------|
| **Bootstrap** `we` frequency | 28.90 / 1k words | **37.74 / 1k words** | **+30%** |
| **After tool restore** `we` frequency | 0.29 / 1k words | **2.77 / 1k words** | **+855%** 🚀 |

Without this plugin: Minimal persona **vanishes** after the first tool call.  
With this plugin: Minimal persona **persists** across tool results until `agent_end`.

## Installation

```bash
git clone https://github.com/yourusername/omp-deepseek-anchor
cd omp-deepseek-anchor
bun install
omp plugin install .
```

Add to `~/.bashrc` or shell config:

```bash
export OMP_DEEPSEEK_ANCHOR_MODE=dsh
```

Restart shell, then start OMP with DeepSeek:

```bash
omp --model ccs-codex-deepseek/deepseek-v4-pro --thinking max
```

## How It Works

Two-phase promotion:

1. **First request**: Minimal persona + `bash`/`read` only + 1024 token cap
2. **First tool call**: Restore full tool catalog, **keep Minimal persona**
3. **Agent turn end**: Restore full OMP system prompt

DSH compatibility mode (`OMP_DEEPSEEK_ANCHOR_MODE=dsh`):
- Compact tool schemas (no `i` parameter on wire)
- Auto-repair missing `i` on bootstrap tool calls
- Minimal persona: `"You are a helpful software engineer assistant."`

Safe mode (default): First-request narrowing only, no persona override.

## Verification

```bash
bun run check  # 13 tests, 33 assertions
```

Real TUI verification in `.dsh-parity-verification.json`:
- Session: 7 assistant messages, 12 tool calls
- Bootstrap: 4 `we` / 0 `let me` (106 words)
- Promoted: 24 `we` / 13 `let me` (8,654 words)

## Compatibility

- **OMP**: Requires `@oh-my-pi/pi-coding-agent` extension API
- **DeepSeek V4 Pro**: Tested on `ccs-codex-deepseek/deepseek-v4-pro`
- **Other models**: Completely transparent (no-op)

## Reference

Based on [xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) for DeepSeek Harness. See also:
- [Project2 evaluation](https://github.com/xiaobright/modeltest) showing 98/99 scores with Minimal anchoring
- [V4 trigger mechanism experiments](https://github.com/xiaobright/modeltest/blob/main/docs/v4.1/DEEPSEEK_V4_TRIGGER_MECHANISM_EXPERIMENTS_20260814.md)

## License

MIT. Derived work acknowledges original [DeepSeek Harness Standard preset](https://github.com/deepseek-ai/deepseek-harness) (MIT).

---

**Not affiliated with or endorsed by DeepSeek.** Community experiment. Results specific to tested tasks; YMMV.
