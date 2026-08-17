# OMP DeepSeek Anchor


[中文说明](./README.zh-CN.md)


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

### From GitHub

```bash
# Clone and install
git clone https://github.com/TommyFang2077/omp-deepseek-anchor
cd omp-deepseek-anchor
bun install
omp plugin install .
```

Or install directly:

```bash
omp plugin install https://github.com/TommyFang2077/omp-deepseek-anchor
```

### Enable DSH Mode

Add to `~/.bashrc` or shell config:

```bash
export OMP_DEEPSEEK_ANCHOR_MODE=dsh
```

Restart shell or run `source ~/.bashrc`, then start OMP with DeepSeek:

```bash
omp --model ccs-codex-deepseek/deepseek-v4-pro --thinking max
```

First DeepSeek session will bootstrap with Minimal persona. Non-DeepSeek models unaffected.

## Activation Requirements

The plugin activates **only** when both conditions are met:

1. ✓ Model matches `/deepseek/i` (provider or id contains "deepseek", case-insensitive)
2. ✓ Session has **no assistant messages yet** (fresh session only)

### When It Works

| Scenario | Activates? |
|----------|-----------|
| New session with `--model ccs-codex-deepseek/...` | ✓ Yes |
| Empty session + `/model` switch to DeepSeek | ✓ Yes |
| Mid-conversation `/model` switch to DeepSeek | ✗ No — trajectory already anchored |
| DeepSeek session switched to non-DeepSeek | Deactivates immediately |

**Always specify DeepSeek at session start**:

```bash
# ✓ Correct: specify on launch
omp --model ccs-codex-deepseek/deepseek-v4-pro --thinking max

# ✗ Wrong: switching mid-conversation won't anchor
omp
> /model ccs-codex-deepseek/deepseek-v4-pro  # Too late if you already chatted
```

V4 Pro's trajectory anchoring happens at the **first model request**. Switching models mid-conversation means the first request already happened with a different prompt/tool catalog, so anchoring cannot take effect.


## How It Works

Three-phase promotion (from dsh-anchored-standard, including the post-promotion resident-set fix):

1. **First request**: Minimal persona + `bash`/`edit` only (OMP analogue of DSH's `bash` + `str_replace_editor`). Output is **not** capped by default — set `OMP_DEEPSEEK_ANCHOR_MAX_TOKENS` to opt into the dual-anchor 1024 cap.
2. **First durable signal** (first tool call *or* first assistant message — DSH's `either` promotion): restore the **resident catalog**, **keep Minimal persona**. The resident set (`bash`, `read`, `edit`, `write`, `grep`, `glob`, `todo`, `ask`) deliberately excludes heavier tools (`web_search`, `task`, `hub`, `browser`, `lsp`, `debug`, MCP, …): dumping the full catalog after promotion pulls the trajectory back to standard-like behavior (measured post-promotion regression in dsh-anchored-standard). On session resume/reload the same resident surface is enforced for the whole DeepSeek session.
3. **Agent turn end**: Restore full OMP system prompt

DSH compatibility mode (`OMP_DEEPSEEK_ANCHOR_MODE=dsh`):
- Compact tool schemas (no `i` parameter on wire)
- Auto-repair missing `i` on bootstrap tool calls
- Minimal persona: `"You are a helpful software engineer assistant."`
- Post-promotion resident catalog instead of the full tool set

Optional zero-tool anchor (`OMP_DEEPSEEK_ANCHOR_ZERO_TOOLS=1`, dsh mode only, experimental — port of `zero-anchored-standard`):
- First request carries an **empty tool catalog** and a prepended anchor user turn (`"This round is a test. Tools are not open yet; all tools will open next round."`), conditioning the zero-injection "we" trajectory; tools open from the next request/turn.

Safe mode (default): First-request narrowing only, no persona override, full catalog restored after.

## Configuration

| Env var | Default | Effect |
|---------|---------|--------|
| `OMP_DEEPSEEK_ANCHOR_MODE` | `safe` | `dsh` enables Minimal persona persistence + resident catalog |
| `OMP_DEEPSEEK_ANCHOR_ZERO_TOOLS` | unset | `1` (with `dsh`) empties the first request's tool catalog and prepends the anchor turn |
| `OMP_DEEPSEEK_ANCHOR_TEXT` | DSH anchor text | Custom anchor notice for zero-tool mode |
| `OMP_DEEPSEEK_ANCHOR_RESIDENT` | built-in daily set | Comma-separated resident tool names (replaces the default; e.g. `bash,read,edit,write,grep,glob,todo,ask,web_search`) |
| `OMP_DEEPSEEK_ANCHOR_MAX_TOKENS` | unset | Optional first-request output cap (DSH `bootstrapMaxTokens`). A 1024 cap on OMP trips snapcompact via `stopReason: length`; leave unset unless you want dual-anchor. |

## Verification

```bash
bun run check  # 25 tests, 52 assertions
```

Real TUI verification in `.dsh-parity-verification.json`:
- Session: 7 assistant messages, 12 tool calls
- Bootstrap: 4 `we` / 0 `let me` (106 words)
- Promoted: 24 `we` / 13 `let me` (8,654 words)

## Compatibility

## OMP vs DSH: Why Trajectory Purity Differs

DSH `anchored-standard` achieves **0-1 `let me` across entire 98/99-score tasks**. This OMP port shows **+855% improvement** but retains mixed style (24 `we` / 13 `let me` in promoted phase). The gap comes from **architectural constraints**, not implementation bugs.

### What DSH Controls That OMP Cannot

| Capability | DSH (Cordis) | OMP (Extension API) |
|-----------|--------------|---------------------|
| Block all post-persona injections | ✓ `complete: true` | ✗ Hook runs after injections |
| Strip workspace context pre-request | ✓ `suppressedContextSources` | ✗ No pre-step access |
| Clean tool schemas | ✓ Minimal descriptions | ✗ OMP tools carry `<instruction>` blocks + `i` parameter |
| System prompt sovereignty | ✓ Cordis waterfall | ✗ Payload-level replacement only |

**OMP injects before the plugin hook runs**:
- Full OMP persona (Engineering/Personality/Tone sections)
- Workspace rules (AGENTS.md/CLAUDE.md digests)
- Skill catalog
- Memory context
- Tool `i` parameter guidance

The plugin can **replace the `system` field**, but cannot strip content already baked into `messages[]` or tool descriptions. This "contamination" dilutes the Minimal trajectory in the promoted phase.

### Scope of This Implementation

This plugin is **the maximum achievable within OMP's extension API**, now including the reference's post-promotion resident-catalog fix:
- ✓ State machine matches DSH (tool promotion ≠ prompt promotion; `either` promotion signal)
- ✓ Minimal persona persists across tool results until `agent_end`
- ✓ Resident catalog after promotion instead of a full-catalog dump (the dsh-anchored-standard post-promotion regression fix)
- ✓ Optional zero-tool anchor turn (experimental)
- ✓ +855% `we` frequency improvement over first-request-only anchoring (pre-resident-set measurement)
- ✗ Cannot reach DSH's 0-1 `let me` purity without OMP core changes

To replicate DSH's **98/99 scores and trajectory purity**, use the original [`dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard) preset in DeepSeek Harness.

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
