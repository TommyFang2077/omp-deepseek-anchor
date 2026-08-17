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

三阶段晋升（移植 dsh-anchored-standard，含晋升后 resident 目录修复）：

1. **首次请求**：Minimal persona + 仅 `bash`/`read` + 1024 token 限制
2. **首个持久信号**（首次工具调用 *或* 首条 assistant 消息 — DSH 的 `either` 晋升）：恢复 **resident 目录**，**保持 Minimal persona**。resident 集（`bash`、`read`、`edit`、`write`、`grep`、`glob`、`todo`、`ask`）刻意排除较重工具（`web_search`、`task`、`hub`、`browser`、`lsp`、`debug`、MCP 等）：晋升后一次性倾倒完整目录会把轨迹拉回 standard 风格（dsh-anchored-standard 实测的晋升后回退）。会话恢复/重载时对整个 DeepSeek 会话强制执行同一 resident 表面。
3. **Agent 回合结束**：恢复完整 OMP system prompt

DSH 兼容模式（`OMP_DEEPSEEK_ANCHOR_MODE=dsh`）：
- 紧凑工具 schema（wire 上无 `i` 参数）
- 自动修复 bootstrap 工具调用缺失的 `i`
- Minimal persona：`"You are a helpful software engineer assistant."`
- 晋升后使用 resident 目录而非完整工具集

可选 zero-tool 锚定（`OMP_DEEPSEEK_ANCHOR_ZERO_TOOLS=1`，仅 dsh 模式，实验性 — 移植自 `zero-anchored-standard`）：
- 首次请求携带**空工具目录**并前置一条锚定用户回合（`"This round is a test. Tools are not open yet; all tools will open next round."`），塑造零注入的 "we" 轨迹；下一请求/回合起开放工具。

安全模式（默认）：仅首次请求缩窄，不覆盖 persona，恢复完整目录。

## 配置

| 环境变量 | 默认 | 作用 |
|---------|------|------|
| `OMP_DEEPSEEK_ANCHOR_MODE` | `safe` | `dsh` 启用 Minimal persona 持续 + resident 目录 |
| `OMP_DEEPSEEK_ANCHOR_ZERO_TOOLS` | 未设置 | `1`（配合 `dsh`）清空首次请求工具目录并前置锚定回合 |
| `OMP_DEEPSEEK_ANCHOR_TEXT` | DSH 锚定文案 | 自定义 zero-tool 模式锚定提示 |
| `OMP_DEEPSEEK_ANCHOR_RESIDENT` | 内置日常工具集 | 逗号分隔的 resident 工具名（替换默认；如 `bash,read,edit,write,grep,glob,todo,ask,web_search`） |
| `OMP_DEEPSEEK_ANCHOR_MAX_TOKENS` | `1024` | 首次请求输出上限 |

## 验证

```bash
bun run check  # 23 个测试，46 个断言
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

本插件是 **OMP extension API 范围内可达到的最优解**，现含参考仓库的晋升后 resident 目录修复：
- ✓ 状态机与 DSH 匹配（工具晋升 ≠ prompt 晋升；`either` 晋升信号）
- ✓ Minimal persona 在工具调用后持续到 `agent_end`
- ✓ 晋升后使用 resident 目录而非倾泻完整目录（dsh-anchored-standard 的晋升后回退修复）
- ✓ 可选 zero-tool 锚定回合（实验性）
- ✓ 相比仅首次请求锚定，`we` 频率提升 +855%（resident 目录前的实测值）
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
