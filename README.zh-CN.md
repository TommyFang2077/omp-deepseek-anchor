# OMP DeepSeek Anchor

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**在 OMP 中解锁 DeepSeek V4 的"we"轨迹** — 移植自 [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)，在工具调用后保持 Minimal persona。

## 🔥 为什么重要

DeepSeek V4 Pro 对首次请求**高度敏感**。标准 OMP prompt 产生"let me"风格；Minimal persona 产生协作式"we"风格。本插件将 V4 锚定到 Minimal 轨迹，同时保留完整 OMP 工具能力。

**实测效果**（相同复杂任务，DeepSeek V4 Pro，`thinking=max`）：

| 阶段 | 仅首次请求锚定 | **完整 DSH 对齐** | 提升 |
|------|---------------|------------------|------|
| **Bootstrap** `we` 频率 | 28.90 / 1k 词 | **37.74 / 1k 词** | **+30%** |
| **工具恢复后** `we` 频率 | 0.29 / 1k 词 | **2.77 / 1k 词** | **+855%** 🚀 |

不使用插件：Minimal persona 在首次工具调用后**消失**。  
使用插件：Minimal persona **持续保持**直到 `agent_end`。

## 安装

### 从 GitHub 安装

```bash
# 克隆并安装
git clone https://github.com/TommyFang2077/omp-deepseek-anchor
cd omp-deepseek-anchor
bun install
omp plugin install .
```

或直接安装：

```bash
omp plugin install https://github.com/TommyFang2077/omp-deepseek-anchor
```

### 启用 DSH 模式

添加到 `~/.bashrc` 或 shell 配置文件：

```bash
export OMP_DEEPSEEK_ANCHOR_MODE=dsh
```

重启 shell 或运行 `source ~/.bashrc`，然后使用 DeepSeek 启动 OMP：

```bash
omp --model ccs-codex-deepseek/deepseek-v4-pro --thinking max
```

首个 DeepSeek 会话将使用 Minimal persona 启动。非 DeepSeek 模型不受影响。

## 激活条件

插件**仅在**同时满足以下两个条件时激活：

1. ✓ 模型匹配 `/deepseek/i`（provider 或 id 包含"deepseek"，不区分大小写）
2. ✓ 会话**尚未有 assistant 消息**（仅限新会话）

### 何时生效

| 场景 | 是否激活？ |
|------|-----------|
| 使用 `--model ccs-codex-deepseek/...` 启动新会话 | ✓ 是 |
| 空会话 + `/model` 切换到 DeepSeek | ✓ 是 |
| 对话中途 `/model` 切换到 DeepSeek | ✗ 否 — 轨迹已锚定 |
| DeepSeek 会话切换到非 DeepSeek | 立即停用 |

**始终在会话启动时指定 DeepSeek**：

```bash
# ✓ 正确：启动时指定
omp --model ccs-codex-deepseek/deepseek-v4-pro --thinking max

# ✗ 错误：对话中途切换无法锚定
omp
> /model ccs-codex-deepseek/deepseek-v4-pro  # 如果已经对话则为时已晚
```

V4 Pro 的轨迹锚定发生在**首次模型请求**。对话中途切换模型意味着首次请求已使用不同的 prompt/工具目录完成，锚定无法生效。


## 工作原理

两阶段晋升：

1. **首次请求**：Minimal persona + 仅 `bash`/`read` + 1024 token 限制
2. **首次工具调用**：恢复完整工具目录，**保持 Minimal persona**
3. **Agent 回合结束**：恢复完整 OMP system prompt

DSH 兼容模式（`OMP_DEEPSEEK_ANCHOR_MODE=dsh`）：
- 紧凑工具 schema（wire 上无 `i` 参数）
- 自动修复 bootstrap 工具调用缺失的 `i`
- Minimal persona：`"You are a helpful software engineer assistant."`

安全模式（默认）：仅首次请求缩窄，不覆盖 persona。

## 验证

```bash
bun run check  # 13 个测试，33 个断言
```

真实 TUI 验证数据在 `.dsh-parity-verification.json`：
- 会话：7 条 assistant 消息，12 次工具调用
- Bootstrap：4 次 `we` / 0 次 `let me`（106 词）
- Promoted：24 次 `we` / 13 次 `let me`（8,654 词）

## 兼容性

## OMP vs DSH：轨迹纯度差异原因

DSH `anchored-standard` 在整个 98/99 分任务中实现了 **0-1 次 `let me`**。本 OMP 移植版本显示 **+855% 提升**，但保留了混合风格（promoted 阶段 24 次 `we` / 13 次 `let me`）。这一差距源于**架构约束**，而非实现 bug。

### DSH 能控制但 OMP 无法控制的内容

| 能力 | DSH (Cordis) | OMP (Extension API) |
|------|--------------|---------------------|
| 阻断所有 persona 后注入 | ✓ `complete: true` | ✗ Hook 在注入后运行 |
| 请求前剥离 workspace context | ✓ `suppressedContextSources` | ✗ 无 pre-step 访问权限 |
| 干净的工具 schema | ✓ 极简描述 | ✗ OMP 工具携带 `<instruction>` 块 + `i` 参数 |
| System prompt 主权 | ✓ Cordis waterfall | ✗ 仅 payload 级别替换 |

**OMP 在插件 hook 运行前就已注入**：
- 完整 OMP persona（Engineering/Personality/Tone 章节）
- Workspace 规则（AGENTS.md/CLAUDE.md 摘要）
- Skill catalog
- Memory context
- 工具 `i` 参数指导

插件可以**替换 `system` 字段**，但无法剥离已烘焙到 `messages[]` 或工具描述中的内容。这种"污染"稀释了 promoted 阶段的 Minimal 轨迹。

### 本实现的范围

本插件是 **OMP extension API 范围内可达到的最优解**：
- ✓ 状态机与 DSH 匹配（工具晋升 ≠ prompt 晋升）
- ✓ Minimal persona 在工具调用后持续到 `agent_end`
- ✓ 相比仅首次请求锚定，`we` 频率提升 +855%
- ✗ 在不修改 OMP 核心的情况下，无法达到 DSH 的 0-1 次 `let me` 纯度

要复现 DSH 的 **98/99 分数和轨迹纯度**，请使用原版 [`dsh-anchored-standard`](https://github.com/xiaobright/dsh-anchored-standard) preset 在 DeepSeek Harness 中运行。

- **OMP**：需要 `@oh-my-pi/pi-coding-agent` extension API
- **DeepSeek V4 Pro**：已在 `ccs-codex-deepseek/deepseek-v4-pro` 上测试
- **其他模型**：完全透明（no-op）

## 参考

基于 [xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) for DeepSeek Harness。另见：
- [Project2 评测](https://github.com/xiaobright/modeltest) 显示使用 Minimal 锚定获得 98/99 分
- [V4 触发机制实验](https://github.com/xiaobright/modeltest/blob/main/docs/v4.1/DEEPSEEK_V4_TRIGGER_MECHANISM_EXPERIMENTS_20260814.md)

## 许可证

MIT。衍生作品注明来源于 [DeepSeek Harness Standard preset](https://github.com/deepseek-ai/deepseek-harness)（MIT）。

---

**非 DeepSeek 官方或背书项目。** 社区实验。结果特定于测试任务；效果因情况而异。
