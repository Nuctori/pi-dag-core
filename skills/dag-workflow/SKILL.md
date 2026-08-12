---
name: dag-workflow
description: >-
  Use dag_start (pi-dag-core) when a task decomposes into MULTIPLE DEPENDENT
  STAGES that need verification or approval — parallel research streams
  feeding a synthesis, a review→fix loop, a pipeline with human gates, or any
  flow where order, re-runs and auditability matter. For a single focused task
  use subagent directly; for independent parallel tasks use subagent tasks[]
  without dag. When a user asks for a "workflow", "pipeline", "staged",
  "enforced", "auditable" or "gated" execution, dag-core is the tool.
---

# DAG Workflow (pi-dag-core)

把一个多阶段任务变成**受状态机强制、带证据验证**的 DAG 工作流：
AI 编排 → 人批准 → 按契约执行。执行走内置 `subagent`，核心只做
校验 / 调度 / CI 式证据闸。

## 何时用它（触发判断）

**用 dag**，当任务形态是：

- **并行调研 → 汇合**：多个独立调研流（web / repo / docs）各跑各的，最后
  一个 verifier 节点交叉验证并汇总（`role: verifier` 自动收依赖产物）
- **审查 → 修复循环**：reviewer 挑问题 → worker 修 → 直到通过
  （`loop: { body, until: "passed", maxIterations }`）
- **带人工门**：关键节点需要人批准（`checkpoint: true`，只能 `/dag approve`）
- **需要可审计轨迹**：谁执行了什么、产物 hash、顺序强制（events.jsonl + 快照）
- **需要重跑护栏**：失败节点只能 `dag_retry`，不能跳过（卡死机制）

**不用 dag**：

- 单任务 → 直接 `subagent`
- 无依赖的纯并行扇出 → `subagent({ tasks: [...] })`
- 简单顺序 2-3 步 → `subagent({ chain: [...] })`
- 需要引擎级并发/断点续跑 → pi-dynamic-workflows 或 LangGraph

## 快速上手

```json
{
  "name": "research-review",
  "policy": { "failFast": true, "maxAgents": 20 },
  "nodes": {
    "web":   { "agent": "scout", "task": "调研 X 的 web 资料，写 web.md", "produces": [{ "path": "web.md", "check": "nonEmpty" }] },
    "repo":  { "agent": "scout", "task": "调研代码库的 X 现状，写 repo.md", "produces": [{ "path": "repo.md", "check": "nonEmpty" }] },
    "synth": { "agent": "reviewer", "role": "verifier", "needs": ["web", "repo"],
               "task": "基于 {artifacts} 交叉验证，写 final.md", "produces": [{ "path": "final.md", "check": "nonEmpty" }] },
    "approve": { "checkpoint": true, "needs": ["synth"] },
    "done":  { "agent": "worker", "task": "总结到 summary.md", "needs": ["approve"] }
  }
}
```

## 协议（执行义务）

1. `dag_start` 返回就绪批 → 用返回的 **agent 和 task 逐字**调 `subagent`，不改写
2. 每个节点：调 `subagent` → **等其结果** → `dag_complete(runId, node)`
   （禁止与 subagent 同消息批处理）
3. 失败节点：`dag_retry` 重跑；无法继续 → `dag_abort` 回人，禁止自行发挥
4. checkpoint 由人 `/dag approve|reject` 解锁
5. `dag_finish` 前所有必需节点 passed

## 沙盒规则

- 写入只落在 `.pi/workflows/`（定义）+ `runs/`（运行态），不碰其他文件
- **`produces` 路径相对 run 项目根（= pi 会话的 `ctx.cwd`）解析**，如 `critiques/infotheory.md` → `<项目根>/critiques/infotheory.md`；绝不用绝对路径（`D:/...` 会被拒）——这是真实使用中 AI 反复犯的错误
- **跨目录陷阱**：task 文本若声明在其他目录操作（如 `cwd=J:/.../InitDeity`），worker 会把产物写进那个目录，而证据闸只查 run 项目根 → MISSING（重试也救不了）。修法：task 里把产物目标写成项目根下的绝对路径，或要求 worker 写完把产物复制回项目根
- **目录也是合法产物**：`produces: [{ path: "src/", check: "nonEmpty" }]` 表示目录内有内容
- 产物证据 = 文件/目录存在、签发后有写入、sha256；机器不防"执行者篡改自己状态文件"
- **run 已激活时不要重复 dag_start**：返回空批 = run 在途（用 dag_complete/dag_retry 继续）或已完结（dag_finish/dag_abort）
- 模板示例：`examples/code-review.json`（并行审查→verifier→修复循环→人工门）
