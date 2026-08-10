# DESIGN.md — 设计契约

pi-dag-core 的完整设计依据。代码必须服从本契约；契约变更需同步更新代码与测试。

## 1. 定位

**AI 编排 → 人批准 → 按契约执行。** 本工具不替代 subagent，而是给 pi 一个"受控编排层"：

- 执行：走 `subagent` 工具（fleet/预算/resume/worktree 全部继承）；⚠️ subagent 非 pi 内置，需 pi-subagents（或等价）提供（H2）
- 核心：spec 校验 + 状态机调度 + CI 式证据闸
- 强制力：**卡死机制** —— 违反协议的节点无法 `passed`，依赖它的下游永远不签发

## 2. 四象限边界（不可逾越）

| 通道 | 允许 | 禁止 |
| --- | --- | --- |
| 读 | 会话记录（证据核查）、事件流（观察）、spec/产物文件 | 缓存敏感内容 |
| 写 | **仅**工作流定义（3 作用域）+ 运行态 | 其他一切；所有写集中在 `state.ts`，路径白名单 + 原子写 |
| 注入 | 工具使用 guidelines（协议 5 条） | `before_agent_start` / `context` / provider 一律不碰 |
| 拦截 | 无 | 永不 block / mutate `event.input` / 改写 `tool_result` |

订阅是只读观察通道；`events.jsonl` 是状态机的账本（私产），不是对 pi 行为的修改。

## 3. 正确性矩阵

| 威胁 | 防线 | 强度 |
| --- | --- | --- |
| 跳步/乱序/重复完成 | 状态机拒绝转移（`dag_complete` 只在 running 态接受） | 硬 |
| 提前 finish | `dag_finish` 全量校验必需节点 | 硬 |
| 循环无限 | `maxIterations` 状态机硬顶（第 N 次尝试失败即耗竭） | 硬 |
| 假装执行（没调 subagent 就 complete） | 无执行证据 → 拒绝（state 非 running） | 硬 |
| 改 payload 调 subagent | 参数与签发 payload 逐字比对（核心自己观察，非 AI 自报） | 硬（可检测） |
| 伪造产物 | 存在 / 非空 / mtime ≥ 就绪 / sha256 / grep / json / **realpath 不逃逸项目根** | 硬（可检测） |
| 并行节点产物串扰 | spec 校验拒绝重叠 `produces` | 硬 |
| 用旧产物交差 | mtime 早于就绪时间 → 拒绝 | 硬 |
| 盘符/符号链接逃逸（M5/M6） | spec 路径校验 + realpath 包含检查 | 硬 |
| 结果语义错误 | verifier 节点（`{artifacts}` 扇入）+ checkpoint 人工门 | 软（人/验证器） |
| spec 被 AI 自肥 | typebox 严格 schema + 拓扑/角色规则 + 运行中 spec 不可变 | 硬 |
| 崩溃/重启 | snapshot 原子写（fsync）+ events.jsonl 审计；resume 重置 running/**ready**→queued 后重签发（B3） | 硬 |
| 路径逃逸 | `safeName` 消毒 + `underRoot` 逃逸检查 | 硬 |
| 快照伪造（M8） | **信任模型：机器不防御执行者篡改自己的状态文件** —— 文档明确 | 说明 |

## 4. 状态机

节点状态：`queued → ready → running → passed | failed | blocked | awaiting_approval`

- `ready`：依赖满足，payload 已签发（`issuedTask` 记录注入后的 task，作为证据比对基准）
- `running`：核心观察到匹配的 subagent 调用（`ingestCalls` 归因）
- `failed`：证据闸不过 / subagent isError / 人工声明失败
- `blocked`：非 continueOnError 依赖失败，且未被 retry
- `awaiting_approval`：checkpoint 节点，仅 `/dag approve|reject`（命令）可解锁 —— **AI 无工具可自批**

循环：**loop 是节点属性**，静态图保持无环。`loop: { body, until: "passed", maxIterations }` —— body 反复执行直至产物过闸；owner 在 body 通过时置 `passed`。自由文本 `until`（LLM 判定）为 v1。

## 5. 证据链（CI 模型）

```text
启动证明（tool_execution_start, 参数逐字匹配 + 时序）→ 执行结束（tool_execution_end, isError）→ 产物（存在/mtime/hash/realpath）
```

- 归因不依赖 AI 自报 run-id：核心订阅 `tool_execution_start`（preflight，按源顺序先行发射）观察真实调用，按签发 payload 匹配
- **H1：未结束的调用（无 execution_end）不可归因** → dag_complete 被拒；禁止与 subagent 同消息批处理
- 并行 `tasks[]` 共享 toolCallId，去重键 = `toolCallId|agent|task`；归因要求 `ts ≥ issuedAt`（M4 防陈旧事件）
- verifier 节点：`{artifacts}` 占位符在签发时替换为依赖产物路径 + sha256

## 6. 三层级与写入域

| 作用域 | 定义（git） | 运行态（gitignore） |
| --- | --- | --- |
| 会话 | 内联 spec（不落盘） | `~/.pi/agent/workflows/runs/s-<sessionId>/` |
| 项目 | `.pi/workflows/*.json` | `.pi/workflows/runs/<runId>/` |
| 用户 | `~/.pi/agent/workflows/*.json` | `~/.pi/agent/workflows/runs/<runId>/` |

跨层唯一显式通道：`/dag save`（会话 → 项目，人确认）。运行态跟随定义作用域。

## 7. 协议（注入的 guidelines，仅此 5 条）

1. Use dag_start to begin a workflow. It returns a ready batch: call subagent exactly as specified (same agent and task, no edits).
2. After each node's subagent call — **wait for its result** — call dag_complete with the node name; a node becomes passed only through dag_complete. Never batch dag_complete with subagent in one message.
3. If dag_complete marks a node failed, re-run it with dag_retry; never treat a node as done by any other means.
4. For situations not covered by the workflow spec, follow the node's failure policy or call dag_abort to return to the human — do not improvise.
5. Call dag_finish only after all required nodes are passed.

## 8. 架构分层

```text
index.ts（pi 适配，唯一 pi 依赖）→ core.ts（RunManager 门面）→ { spec | scheduler | evidence | state | viz }
```

核心层零 pi 依赖 → 全部单测 + 适配层 E2E（Mock ExtensionAPI 驱动 index.ts：工具注册/事件捕获/缓冲 drain/H1 拒绝）。`state.ts` 是唯一 fs 写模块（原子写 + fsync）。

## 9. 分期

- **v0（已交付）**：状态机 + 证据闸（preflight 归因/执行结束/isError/产物）+ 三层级 + checkpoint + loop(passed) + 文本/mermaid + 串行化（M7）+ **43 测试**（40 单测/对抗 + 3 适配层 E2E）
- **v1（预留）**：gate 命令 transcript 交叉验证（v0 校验拒绝 gate 字段，M9）、自由文本 until、HTML 查看器、YAML spec、subagentRunId 佐证
