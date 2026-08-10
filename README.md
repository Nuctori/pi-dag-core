# pi-dag-core

生产就绪的 DAG 工作流状态机 —— 给 pi 用的极简编排核心。

**定位**：AI 编排 → 人批准 → 按契约执行。执行走 `subagent` 工具（fleet/预算/resume 全继承）；核心只做三件事：**校验 spec、状态机调度、CI 式证据闸**。

> ⚠️ **依赖声明（H2）**：`subagent` 工具**不是 pi 内置的**，由 [pi-subagents](https://pi.dev/packages/pi-subagents) 扩展（或等价实现）提供。未安装时本扩展会在会话启动时响亮告警，且所有 `dag_complete` 都会被拒（无执行证据可观察）。安装：`pi install pi-subagents`（或确认你的 pi 发行版已带 subagent 工具）。

```text
AI 生成 spec ──► dag_start 校验+签发就绪批 ──► AI 逐字调 subagent
   ▲                                              │
   └── dag_complete 过证据闸 ◄── 上报执行结果 ──────┘
          │ passed → 签发下一批 / failed → 卡死，只能 dag_retry 或回人
```

## 安装

```bash
# 方式一：作为 pi 扩展加载（开发）
git clone https://github.com/your-org/pi-dag-core ~/pi-dag-core
pi -e ~/pi-dag-core/src/index.ts

# 方式二：放到扩展目录（常驻）
#   ~/.pi/agent/extensions/pi-dag-core/   （用户级）
#   .pi/extensions/pi-dag-core/           （项目级，需信任项目）
```

依赖：`typebox`（运行时唯一依赖）+ `@earendil-works/pi-coding-agent`（peer）+ **`subagent` 工具提供者（pi-subagents）**。零编译，jiti 直接加载 TS。

## 三个作用域

| 作用域 | 定义 | 运行态 |
| --- | --- | --- |
| 会话 | `dag_start({spec})` 内联 JSON | 用户级 `runs/s-<sessionId>/` |
| 项目 | `.pi/workflows/*.json`（`/dag save`） | `.pi/workflows/runs/`（gitignore） |
| 用户 | `~/.pi/agent/workflows/*.json` | `~/.pi/agent/workflows/runs/` |

`dag_start({specName})` 按 **项目 → 用户** 顺序解析；`/dag save <name>` 把最近的内联 spec 固化到项目级（人确认）。

## 协议（AI 侧义务）

1. `dag_start` 返回就绪批 —— 用返回的 **agent 和 task 逐字**调用 `subagent`，不得改写/增删/调序
2. 每个节点：调 `subagent`（同层可 `tasks[]` 并行）→ **等待其结果** → `dag_complete(runId, node)`（禁止与 subagent 同消息批处理）
3. `dag_complete` 过证据闸（见下）；失败 → `dag_retry` 重跑
4. spec 未覆盖的情况（subagent 报错/产物缺失/需求变化）→ 走节点失败策略或 `dag_abort` 回人，**禁止自行发挥**
5. `dag_finish` 前所有必需节点 passed

## 证据闸（CI 式，dag_complete 内）

1. **启动证明**：核心订阅 `tool_execution_start`（preflight，按源顺序先行发射）观察 subagent 调用（参数与签发 payload 逐字一致、时间晚于就绪）——**不依赖 AI 自报**
2. **退出码**：订阅 `tool_execution_end`（执行结束、携带 isError）；**未结束的调用不可归因** → `dag_complete` 被拒（H1 防并行批竞态）
3. **产物**：`produces` 声明的文件存在、非空、mtime ≥ 就绪时间、记录 sha256、**realpath 不逃逸项目根**；支持 `exists` / `nonEmpty` / `grep:<re>` / `json` 检查
4. verifier 节点自动注入依赖产物引用（`{artifacts}` → 路径 + sha256）

任一不过 → 节点 `failed` → 依赖它的下游永远不签发（**卡死机制**）→ 只能 `dag_retry` 或 `dag_abort`。

> **信任模型（M8，诚实声明）**：状态机约束的是**协议行为**（AI 的工具调用序列）。AI 持有文件写工具，可以自己写产物文件或直接改写 `runs/` 下的快照——这是本地工具共同的信任边界，机器无法防御"执行者篡改自己的状态文件"。产物证据证明"签发后出现过该文件"，不证明"subagent 所写"；语义正确性靠 verifier + 人工门。

## 工具与命令

| 工具（AI 可调） | 命令（仅人） |
| --- | --- |
| `dag_start` `dag_complete` `dag_fail` `dag_retry` | `/dag status [runId]` `/dag graph [runId]` |
| `dag_finish` `dag_abort` | `/dag list` `/dag save <name>` `/dag new` `/dag help` |
| | `/dag approve\|reject <runId> <node>`（checkpoint 唯一解锁路径） |

**checkpoint 只能人解锁**：`checkpoint: true` 的节点停在 `awaiting_approval`，AI 没有工具能批准自己——命令不向 AI 暴露。

## 边界（设计契约）

| 通道 | 允许 | 禁止 |
| --- | --- | --- |
| 读 | 会话记录、事件流、spec/产物文件 | — |
| 写 | **仅**工作流定义（3 作用域）+ 运行态（`state.ts` 白名单，原子写） | 其他一切 |
| 注入 | 工具使用 guidelines（协议 5 条） | 行为引导/哲学/流程建议 |
| 拦截 | 无 | 永不 block / mutate / 改写结果 |

## 循环与失败语义

- **loop 是节点属性**：静态图保持无环；`loop: { body, until: "passed", maxIterations }`，body 反复执行直到产物过闸，第 N 次尝试失败即耗竭（`maxIterations` 硬顶，不靠 AI 数数）
- `continueOnError: true` 的节点失败不阻塞下游；`failFast`（默认）在首个失败后冻结新签发
- `maxAgents` 策略：卡**签发数**（= 本 run 最多消耗的 subagent 调用数），超限的节点不签发

## 架构

```text
src/
├── index.ts      pi 适配层（工具/命令/订阅/注入）—— 唯一碰 pi 运行时的文件
├── core.ts       RunManager 门面（调度 + 证据 + 状态的编排）
├── spec.ts       校验（typebox + 拓扑：环/缺依赖/重名/角色规则/产物重叠）
├── scheduler.ts  状态机（queued→ready→running→passed|failed|blocked，纯逻辑）
├── evidence.ts   证据链（payload 匹配 / isError / 产物闸）
├── state.ts      唯一写模块（路径白名单 + 原子写 + events.jsonl 审计 + 快照恢复）
├── viz.ts        从快照渲染（文本 + mermaid）
└── types.ts
```

核心层不依赖 pi 运行时 → 全部可单测（43 个用例，含全部对抗场景 + 适配层 E2E）。

## v0 → v1 分期

| v0（已实现） | v1（已预留） |
| --- | --- |
| 状态机 + 证据闸（payload/isError/产物） | gate 命令的 transcript 交叉验证 |
| 三层级定义 + checkpoint + loop(passed) | loop 自由文本 until（LLM 判定+证据要求） |
| 文本/mermaid 渲染 | 静态 HTML 查看器（orca-viz 模式） |
| JSON spec | YAML spec |
| — | `subagentRunId` 佐证 + 跨会话恢复提示 |

## 测试

```bash
npm run check   # tsc --noEmit + node --test（43 个用例：40 单元/对抗 + 3 适配层 E2E）
```

npm run check   # tsc --noEmit + node --test（28 个用例）

```

对抗场景覆盖：跳步（无执行即 complete）、改 payload、假产物、过期产物、提前 finish、循环耗竭、maxAgents 超限、并行 `tasks[]` 归因、continueOnError、subagent isError、路径逃逸。
