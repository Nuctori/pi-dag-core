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

## 设计哲学（先读这里，判断要不要用）

**一句话**：这不是又一个"更聪明的 agent 框架"，而是一个**给已信任的 AI 加的可验证流程层**。它不提高 AI 的能力，它约束 AI 的执行秩序并让你看得见。

| 哲学支柱 | 含义 | 代价 |
| --- | --- | --- |
| **AI 提议，人定夺，机器忠实执行契约** | AI 生成 spec → 人批准 → 状态机强制按批准的执行。强制力来自"人批准的契约"，不是对 AI 的不信任 | 每次新流程都要先过一遍人批 |
| **轻量 = 不重写执行层** | 执行 100% 走内置 `subagent`（fleet/预算/resume 全继承），核心只写校验/调度/证据（~2700 行） | 没有引擎级并发调度，节点并行 = 内置 tasks[] 一层 |
| **信任有边界，且明说** | 机器防御"执行者篡改自己的状态文件"是做不到的（本地工具共同边界）——文档诚实声明，不假装防伪 | 产物证据只能证明"签发后出现过该文件"，不证明"subagent 所写" |
| **CI 式证据链** | 启动证明/退出码/产物全由核心**自己观察事件流**，不依赖 AI 自报 | 需要 pi 的 `tool_execution_start/end` 事件（已在真实会话验证） |
| **四象限边界** | 只读观察 · 只写工作流域 · 只注入工具义务 · 永不拦截 | 不做权限门、不做 prompt 魔法 |

### 什么时候用它

- **团队/合规场景**：流程必须被机器强制（跳步/提前收工/循环失控 = 卡死），且需要可审计的执行轨迹（events.jsonl + 产物 hash）
- **固定形态的多节点流水线**：并行调研 → verifier 扇入 → 循环修复 → 人工门，这种形状值得固化成 spec
- **AI 编排需要护栏**：让 AI 现场拼 DAG，但每个 spec 过 schema/拓扑/角色规则校验，坏图当场拒绝

### 什么时候**不要**用它

- **一次性小任务**：内置 `subagent` 的 chain/parallel/checkpoint 就够了，别上状态机
- **需要真·任意图 + 引擎级并发**：本工具是"线性 DAG + 一层并行 + 有界循环"；要运行时引擎自己 spawn 节点（还能断点续跑、真并发）用 [pi-dynamic-workflows](https://pi.dev/packages/@quintinshaw/pi-dynamic-workflows) 或外部 LangGraph
- **不能接受"每节点 = 一次 subagent 调用"的固定形状**：节点内自由、节点间受控是它的设计边界
- **不装 pi-subagents**：本工具依赖其 `subagent` 工具，没有它一切归因都是空的

### 与同类对比

| | 本工具 | pi-subagents（内置） | pi-dynamic-workflows |
| --- | --- | --- | --- |
| 编排模型 | 静态 DAG spec + 状态机 | chain/parallel/checkpoint | 模型现场写 JS 脚本 |
| 正确性 | **硬**（状态机 + 证据闸 + 卡死） | 软（AI 自觉） | 硬（引擎执行 + journal） |
| 轻量 | 最小核心（~2700 行，零重写） | 零安装 | 重（TUI/成本核算/journal） |
| 可视化 | 文本/mermaid 快照渲染 | 无 | TUI 进度面板 |

**取舍核心**：要"强制"就要接受"形状固定 + 人批一次"；要"自由"就用内置 subagent 或 pi-dynamic-workflows。

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
