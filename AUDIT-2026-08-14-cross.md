# 交叉审计报告：函数式专家 × Jeff Dean 系统视角

日期：2026-08-14｜对象：pi-dag-core（DESIGN.md 契约 + src/ 8 文件 + tests/）
方法：两份独立只读审计（fresh context），父会话抽查 4 条头号高危声明（file:line 逐行核对）——**全部属实**。

## 概况

| 视角 | 发现数 | 严重度分布 |
| --- | --- | --- |
| 函数式（FP） | 22 | 2 high / 8 medium / 12 low+info |
| 系统（Jeff Dean 式） | 18 | 3 high / 8 medium / 7 low |
| 去重后 | ~28 个独立缺口 | **0 critical** |

两审计对骨架无异议：状态机拒绝非法转移、归因不依赖 AI 自报、产物四重校验、M8 信任边界诚实声明。

## 1. 双视角一致命中的泄露（可信度最高）

| # | 泄露 | 双证据 |
| --- | --- | --- |
| L1 | **双重执行是最大泄露面（at-least-once 未声明）**：会话级 buffer 按 run 抽干，非本 run 的 finished 调用被永久丢弃 → 归因永失 → 强制重跑 subagent = 副作用加倍 | Jeff H1（index.ts:167-185 + evidence.ts:152-163）＋ FP F2 |
| L2 | **resume 非幂等**：`dag_start(resumeRunId)` 无条件 running/ready→queued 并清 issueTs，不先 drain buffer → 已完成调用成孤儿，消息重放即双重执行 | Jeff H2（core.ts:91-99）＋ FP F7 |
| L3 | **证据闸挂在墙钟上**：mtime ≥ issueTs 在粗粒度 FS/回拨钟下误杀合法产物 → 强制 retry；`autoAfterSec` 拨钟可提前过人工闸 | Jeff medium ＋ FP F8/F15 |
| L4 | **快照/账本耐久性打折**：rename 后父目录无 fsync；events.jsonl 非原子 append、无 fsync、与快照从不对账（resume 只重放快照） | 双方命中 |
| L5 | **跨会话并发无锁**：`serial()` 仅进程内互斥；两会话同 resume 同一 run = last-write-wins | Jeff medium ＋ FP F10 |
| L6 | **grep 检查的洞**：空/非法模式恒失败且诊断撒谎（"not found" 而非 "invalid pattern"——evidence.ts:265 空模式 falsy 守卫使匹配不执行、:266 非法正则 throw 被 :282 catch-all 吞掉）→ 节点 failed → 强制重跑；病态正则 ReDoS 挂起 dag_complete | 双方命中（机制经复核修正） |

## 2. 仅函数式视角抓到

- **F1 ★ M7 TOCTOU**：approve/reject/abort 在 `serial()` 队列外 load run（index.ts:717 vs 722）——M7 注释声称串行化原子性，实际只把 mutate 放队列、load 没放。人批与 dag_complete 竞争 → 旧快照回滚已 passed 节点。
- F4 `continueOnError` 依赖被硬失败依赖阻塞（软语义泄露）
- F5 全软 spec → required 集为空 → 零执行 finish（"硬"校验无下限）
- F6 resume 空批无 P1b finish 提示；F7 start 两次 persist 间崩溃 → 孤儿 running run
- F11 >64MB 产物静默跳过 sha256 但 gate 照过；F14 stat/读错误被吞成 missing（诊断撒谎）
- F18 `degraded`/`executedCount` 死契约面；F19 finish 可引用 loop body

## 3. 仅系统视角抓到

- **H3 grep 模式未校验**：空/非法正则恒失败误导诊断（F22 病态正则 ReDoS 挂起是真实 DoS）——与 F9 互补成 L6（机制经复核修正）
- **spec 校验 O(V³) Floyd–Warshall 无节点数上限**（spec 即 DoS 面；与 FP F22 ReDoS 互补：一个挂 dag_start，一个挂 dag_complete）
- 目录级 fsync 缺失；`dag_complete` 的 `result` 参数接受但不落账本
- 文档自相矛盾三处：README 用例数 43 vs 92、`.gitignore` 忽略 `.pi/` 使 DESIGN「定义（git）」落空、DESIGN.md:34 与 spec.ts 显式允许传递前驱重写者不符
- realpath 大小写敏感在 Windows 误杀合法产物（FP 补 F20 symlink 测试缺失 + F21 underRoot 非 realpath 守卫）

## 4. 合并修复优先级

**P0（执行语义层泄露，修完前双重执行/状态回滚可达）**

1. buffer 按 run 归属隔离（捕获时打 run 标记或按 pending 池过滤后再 drain）→ L1
2. resume 先 drain+归因当前 run 再决定重置，或加 force 标志 → L2
3. approve/reject/abort 的 loadRun 移入 `serial()` → F1
4. grep：spec 校验时编译正则 + 拒绝空/非法模式 + gate 处捕获非法抛错给真实诊断（防 ReDoS 用非回溯引擎或超时）→ L6
5. finish() 补 `run.status !== "running"` 守卫

**P1（防御硬化）**：✅ 快照 load typebox 校验（兼堵 F22 ReDoS）；✅ 目录 fsync；✅ spec 拒重复 agent+task；✅ spec 拒 finish 引 loop body；✅ DESIGN 声明 at-least-once。待做：events.jsonl 原子写/轮转/对账；mtime 容差或改锚 executedTs；快照 revision 戳拒陈旧 persist；maxIterations 改 run 级不随 retry 重置。F5（空 required 集）判定为 design-by-intent 不修（D-007）。

**P2（清理）**：死代码 3 处、F18 死字段、README 数字、DESIGN.md:34 补例外、补 symlink 逃逸真实测试。

## 附录 A：FP 视角 F1–F22

| id | severity | 标题 | 证据 |
| --- | --- | --- | --- |
| F1 | high | M7 串行化不完整：approve/reject/abort 在 serial 队列外 loadRun（TOCTOU 丢失更新） | index.ts:717-729, 614-616, 288-293 |
| F2 | high | 并行 tasks[] 重复 agent+task：去重键碰撞 → 第二个节点永久不可归因（死锁） | evidence.ts:149-161, spec.ts:132-363, DESIGN.md:69 |
| F3 | medium | loop retry 重置 maxIterations 计数（硬顶是 burst 级） | scheduler.ts:358-359, 300-310, DESIGN.md:30 |
| F4 | medium | continueOnError 依赖被硬失败依赖阻塞（软语义泄露） | scheduler.ts:328-336, 72-79 |
| F5 | medium | 全软 spec → required 集为空 → 零执行 finish（design-by-intent：I1 全软语义，D-007 决定不修，仅文档化） | scheduler.ts:94-101, 455-494 |
| F6 | medium | resume 可 finish 的 run 返回空批且无 P1b 引导 | core.ts:105-113 vs 157-175, index.ts:343-350 |
| F7 | medium | start 两次 persist 之间崩溃 → 孤儿 running run | core.ts:147, 176 |
| F8 | medium | 产物 mtime(粗) ≥ issueTs(ms) 边界：同 ms 放行、粗粒度 FS 误杀 | evidence.ts:254, 257, tests/evidence.test.ts:176 |
| F9 | medium | grep 模式未校验：空/非法模式恒失败 + 诊断撒谎（机制经复核：非"放行一切"） | evidence.ts:177-178, 265-268, 282-284, spec.ts:228-234 |
| F10 | medium | serial() 仅会话级；跨会话 resume 无同步 last-write-wins | index.ts:288-293, core.ts:79-114, state.ts:210-222 |
| F11 | low | >64MB 产物静默跳过 sha256 但 gate 照过 | evidence.ts:278-281, 259-263 |
| F12 | low | MAX_BUFFER=200 丢最旧在途调用 → H1 诊断丢失 | index.ts:40, 138 |
| F13 | low | events.jsonl 非原子 append 无 fsync（账本撕裂） | state.ts:200-204, DESIGN.md:22,39 |
| F14 | low | stat/读错误被吞成 missing（诊断误导） | evidence.ts:282-297 |
| F15 | low | scheduler 标"纯逻辑"却原地 mutate + 内嵌 Date.now() | README.md:174, scheduler.ts:1-16, 224, 286, 440 |
| F16 | low | resolveCheckpoint reject 分支重复赋值（死语句） | scheduler.ts:403-407 |
| F17 | low | dag_finish 处理器 return 后不可达重复 ok() | index.ts:586-591 |
| F18 | low | RunStatus 'degraded' 永不产生；executedCount 只写不读 | types.ts:23, 164, scheduler.ts:256 |
| F19 | low | finish 可引用 loop body（内部节点外泄到 required 集） | spec.ts:357-360, scheduler.ts:94-101 |
| F20 | info | symlink 逃逸防线无测试（测试名声称但无 fixture） | tests/evidence.test.ts:163-193, evidence.ts:221-235 |
| F21 | info | state.ts 写白名单 underRoot 非 realpath 守卫（M8 下 cosmetic） | state.ts:54-60, DESIGN.md:18,41 |
| F22 | info | grep 模式长度有界但复杂度无界 → 篡改快照可 ReDoS dag_complete | spec.ts:228-234, evidence.ts:265-268, state.ts:210-222 |

## 附录 B：系统视角 18 条（结构化重排版）

| severity | 标题 | 证据 |
| --- | --- | --- |
| high | 会话级 buffer 按 run 抽干；不匹配调用永弃 → 并发 run 归因丢失 → 强制双重执行 | index.ts:167-185, evidence.ts:152-163 |
| high | 重复 dag_start(resumeRunId) 重排队已签发节点且不 drain → 重执行已完成调用 | core.ts:91-99 |
| high | grep 模式未校验：空/非法正则恒失败误导诊断；病态正则 ReDoS 挂起（机制经复核：非"楔死"） | spec.ts:228-234, evidence.ts:265-268, 282-284 |
| medium | finish() 无 run.status 守卫（complete/retry/fail/abort 都有）→ aborted run 可翻 completed | core.ts:438-458 |
| medium | atomicWrite 无目录 fsync → 掉电静默回滚最后一次转移 | state.ts:96-109 |
| medium | events.jsonl 非原子、无 fsync、无轮转、resume 不对账 | state.ts:200-204 |
| medium | 墙钟 auto-approve/stall：拨钟可提前过人工闸 | scheduler.ts:440, 523-544 |
| medium | mtime ≥ issueTs 在粗粒度 FS/回拨钟下误杀 → retry 双重执行 | evidence.ts:254, 257 |
| medium | 快照加载零校验；解析失败静默"run not found"，手改快照可走私 spec | state.ts:210-222 |
| medium | 仅进程内互斥；无跨实例锁 | index.ts:288-293 |
| medium | at-least-once 语义未文档化；retry/resume/崩溃副作用无去重 | core.ts:91-99, scheduler.ts:341-378, evidence.ts:241-244 |
| low | O(V³) Floyd–Warshall 无节点数上限（spec 即 DoS 面） | spec.ts:323-332 |
| low | realpath 包含检查大小写敏感（Windows 误杀）；realpath→readFile TOCTOU 窗口 | evidence.ts:225 |
| low | loop body 带 verifier 角色或 {artifacts} 时静默跳过注入 | scheduler.ts:117-135, spec.ts:247-257 |
| low | 文档矛盾：DESIGN.md:34 vs spec.ts:303-354；.gitignore:16 vs DESIGN.md:76；README 43 vs 92 | — |
| low | dag_complete 的 result 参数从不落 events.jsonl；死代码；重复赋值 | index.ts:374-382, 589-591, scheduler.ts:406-407 |
| low | H1 只挡慢调用：同消息内先完成的快速 subagent 通过批处理 | index.ts:148-155 |
| low | MAX_BUFFER=200 丢最旧在途调用，execution_end 成孤儿 | index.ts:138-139 |

## 附录 C：第二轮泄露审计（FP × Jeff Dean，2026-08-14 续）

上一轮 P0/P1 全部修复并落盘后（102/102 绿）的第二轮独立审查，聚焦**泄露**：信息、资源、语义、契约面。9 项全部修复 + 4 个新测试（106/106 绿，v0.1.7）。

| id | 类别 | 泄露 | 修复 |
| --- | --- | --- | --- |
| L-A1 | 信息 | snapshot/events/定义 644 权限，含完整 task 文本（可含密钥/专有指令）同机可读 | `atomicWrite` open 0o600 + `appendEvent` writeFile mode 0o600；POSIX 权限测试 |
| L-A2 | 信息 | 无条件捕获全部 subagent 调用（无 dag 会话也滞留 ≤200 条敏感参数全文；M4 使 dag_start 前的调用永不可归因 = 纯滞留） | 捕获 gate：仅 dag_start 成功后捕获，session_shutdown 复位；E2E 测试 |
| L-A3 | 审计 | dag_complete 的 result 参数接受但不落账——AI 的完成声明缺账本一环 | `complete` 事件入 events.jsonl（含 result + passed 裁决）；E2E 测试 |
| L-R1 | 资源 | 每次转移 2×persistRun = 4×fsync（中间写无读者，崩溃窗口只留更旧更安全状态） | 合并为转移链末尾单次 persist（complete/fail/retry/resolveCheckpoint） |
| L-R2 | 资源 | events.jsonl 无轮转无限增长 | >2MB 轮转 events.1.jsonl；测试 |
| L-S1 | 语义 | scheduler 头注释自称 "Pure logic" 而所有转移原地 mutate 入参（F15 遗留，文档说谎） | 注释如实：无 I/O、原地转移；README 同步 |
| L-S2/3 | 契约面 | 死代码：dag_finish 不可达 return（F17）、resolveCheckpoint 重复赋值（F16）、executedCount 只写不读（F18） | 全部删除 |
| L-D1 | 契约面 | .gitignore `.pi/` 粗粒度：定义（DESIGN 声明 git 管理）无法入库 | unignore 模式：`.pi/*` + `!.pi/workflows/` + `!.pi/workflows/*.json`；runs/决策链/用户决策仍忽略（git check-ignore 验证） |
| L-D2 | 文档 | README 用例数矛盾（43 vs 92） | 对齐 106（含 4 个新测试） |

**未修（记录在案，勿重开）**：跨会话并发无锁（F10/L5，架构外）；spec O(V³) 上限（节点数小）；F8 容差正向测试（F8 机制已实现，仅缺正向用例）；跨 run 诊断串扰（agent 过滤已限缩，加 runId 标记收益不抵复杂度）。

## 附录 D：v0.1.8 复核修复轮（2026-08-14，双路独立复核后）

v0.1.7 发布后，fresh-context 独立复核（9/9 声称 verified）与后台安全审查/决策审计（run-48700）一致重报上轮 blocker + 新发现。全部修复，110/110 绿（+4 测试）。

| id | 严重度 | 发现 | 修复 |
| --- | --- | --- | --- |
| P1-豁免 | HIGH（上轮 blocker 原样进 v0.1.7） | 重复 agent+task 校验无条件拒绝拓扑有序节点（误拒合法 spec）；loadRun validateSpec 使含此类 spec 的旧 run 升级后失联 | 校验移到 reach 闭包之后，仅拒无序对（D-011，supersede D-007）；spec/state 测试各 1（ordered 放行 + 旧快照可 load） |
| M7b | MEDIUM | `dag_start(resumeRunId)` 先 drain 归因后查 status——死 run（aborted/completed）被污染：节点置 running、executedTs/事件落盘，违反冻结不变量 | 适配层先查 `status === "running"` 再 drain；E2E 测试（abort 后 replay resume → 快照冻结、账本无 executed） |
| ReDoS-注释 | MEDIUM | evidence.ts/spec.ts 注释声称"load 重校验堵死篡改快照 ReDoS"——编译校验不防病态正则执行期挂起（探针实测 `(a+)+$` 挂 >15s） | 注释如实：编译校验仅防"撒谎诊断"；执行期 ReDoS 由 220 字符上限有界，恶意 spec 属 M8 信任边界（spec 作者即会话主体） |
| L-A2-补 | LOW | captureActive 只在 shutdown 复位——abort/finish 后会话无活动 workflow 仍继续捕获滞留 | dag_abort/dag_finish 成功路径复位；合并重复的 session_shutdown handler |
| L-A1-迁移 | INFO | 旧 0644 文件（v0.1.6 及更早）不重写则永远 0644 | loadRun 读路径 best-effort chmod 0o600；L-A1 测试加迁移断言 |

**未修（记录在案）**：listRuns/loadRun 校验口径不一致（被拒快照仍列于 /dag list——保留：列表是目录扫描，隐藏损坏快照更糟）；F8 正向测试；P0-1 孤儿调用进 observed 诊断（agent 过滤已限缩）。
