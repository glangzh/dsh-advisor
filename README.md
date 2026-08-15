# dsh-advisor — DeepSeek Harness 顾问能力

给 DeepSeek Harness 的 Agent 增加一位"顾问"：日常任务照常用你的模型完成，遇到
**真正困难的决策**（复杂架构选择、模糊需求、安全敏感改动、拿不准的方案）时，Agent
会自动向一个更强的模型（默认 `deepseek-v4-pro`）咨询判断，再继续干活。

- **只在关键时刻用更强的模型**——常规工作不额外花钱，升级时才产生 pro 消耗。
- **决策留痕**——顾问调用记录在会话中，随时可回看。
- **不会层层升级**——子代理不会重复触发顾问，避免递归开销。

灵感来自 Anthropic《[The advisor strategy](https://claude.com/blog/the-advisor-strategy)》。

## 安装

先决条件：DSH 已配置 `deepseek-official` 模型服务（`DEEPSEEK_API_KEY` 可用）。

两种安装方式任选其一（**不要同时安装**，否则 `advisor` 工具会冲突）。

### Agent 预设安装（推荐）— 仅 Advisor 会话可用

顾问能力只在选择了 **顾问模式** 的会话里生效，其他会话不受影响。

```sh
git clone git@github.com:glangzh/dsh-advisor.git
cp -r dsh-advisor/preset ~/.dsh/.agent-presets/advisor
```

然后在 Web 界面 Agent 预设选择器（或 `settings.yaml` 的 `agent-presets.default: advisor`）
中选择 **顾问模式**，开一个新会话即可使用。

### 全局安装 — 所有会话可用

一条命令装完，之后所有会话都能使用顾问能力：

```sh
dsh plugin --profile web add github:glangzh/dsh-advisor
```

装好后开新会话即可。

## 使用

安装后**无需额外操作**——Agent 的系统提示中已内置升级准则，遇到下面几类情况会自动
调用 `advisor` 工具咨询：

- 影响多个文件/组件的架构决策；
- 有多种合理解释的模糊需求；
- 认证、授权、数据校验等安全敏感代码；
- 复杂问题中你自己不确定的方案。

如果你希望明确要求它咨询顾问，直接说即可，例如：

> 我们要给这个模块加 OAuth2，但代码里已有 3 种 session 方案。先请顾问评估哪种最合理，再动手。

## 配置

可在安装配置中调整以下项（默认值已够用，通常无需改动）：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `advisorModel` | `deepseek-v4-pro` | 顾问使用的模型 |
| `maxTokens` | `4096` | 顾问每次回复的输出上限 |
| `timeoutMs` | `180000` | 顾问调用超时时间 |

- Agent 预设安装：修改 `~/.dsh/.agent-presets/advisor/agent.cordis.yml` 中 advisor 行的 `config:`。
- 全局安装：修改 profile 的 `cordis.patch.yml` 中 advisor 行的 `config:`。

## 卸载

```sh
# Agent 预设安装
rm -rf ~/.dsh/.agent-presets/advisor

# 全局安装
dsh plugin --profile web remove dsh-advisor-plugin
```

## 常见问题

**Q：两种安装方式有什么区别？**
A：Agent 预设安装只影响选择了 Advisor Agent 预设的会话；全局安装让所有会话都能用顾问。
推荐 Agent 预设安装，把顾问能力限定在需要的场景。

**Q：顾问调用会花很多钱吗？**
A：只有升级时才用更强的模型，且每次回复有输出上限（默认 4096 tokens）。常规工作仍由
你的默认模型完成。

**Q：子代理会不会再次调用顾问？**
A：不会。子代理被禁止调用顾问工具，不会产生层层升级。

**Q：换默认模型会影响顾问吗？**
A：顾问固定使用 `advisorModel` 配置的模型（默认 `deepseek-v4-pro`），与执行者模型无关。
