# 与 Python 前身的功能差距

**结论**：内核骨架（相位机、事实面、四态契约、预算、intents、看板路由）已经成立，缺的不是"还能多写多少模块"，
而是**让结论可信的那一层**：判停的算法体、父代/前沿的决策权、门禁二的实体、指标契约的分辨率。
以及四处**已建好但没接上**的线（注入包、baseline 生产者、`retryable`、锚点）。

本文件只写"我们要什么、现在缺什么、缺了会怎样"；本仓库自身的实现盘点见 [ts-implemented.md](ts-implemented.md)。

---

## 0. 口径

parity = **能不能用它跑一次真实的结构探索，并让结论可信**。
所以判据不是"功能列表齐了"，而是三条：

1. 结论可信（判停/前沿/门禁的判定不能退化成单阈值、单指标或纯元数据检查）；
2. 工况覆盖（换真模型、真集群、真训练日志后还有路可走）；
3. 出事能查（人说得出"为什么停在这里"）。

前身（一个自研的 Python 单体，同一套循环的另一版实现）在本文件里只承担一种角色：**行为形态的参照**——
哪些行为要留、哪些明确不要，逐条写在下面。没有代码复用，也不复述它的规模。

---

## 1. 总表

| # | 缺口簇 | 档 | 本仓库现状 | 后果 |
|---|---|---|---|---|
| A | 判停只有 3 条阈值，且只看 primary | **P0** | `stop.js` 217 行，3 条数字规则 | 「无改进」在噪声里抖动；重启后同一候选按新策略重判 |
| B | 父代选择 / 前沿决策权 | **P0** | `parent_id` 恒 `null`；`best`/`stop`/`judge` 只认 primary | N 次独立实验，不是一场搜索；多目标退化成单目标 |
| C | 门禁二名不副实 + 质量准入缺失 | **P0** | L1 = 3 条元数据检查；无质量准入 | 「门禁错了还是候选不行」无法回答（用户故事 12 落空） |
| D | 指标契约分辨率（角色/阈值/口径/资格） | **P0** | `config.metrics{primary,objectives}` 三项 | 缺失 key 上 fail-open；窗口均值与末窗混用 |
| E | 确定性落地 + 精确去重门 | P1 | 只有"让 harness 自由改文件"一条路 | 同一改动反复提出；模型自述 `old_value` 过期 → 空 diff 死 |
| F | 采集层（可插 collector / 同窗对齐） | P1 | 只认 `metrics.json` 或日志里的一行 JSON | 真实训练的多路日志、时序指标无处安放 |
| G | 四处"建好但没接上"的线 | P1 | 见 §3 | 真实运行里注入恒空、baseline 无生产者、503 判死、锚点不生效 |
| H | 经验回写链 + 先验 fail-loud | P1 | promote 的**一半**（intent 写文件）有；草稿生成、阶段覆盖表态没有 | 跨轮学习靠人肉；先验缺口静默为空 |
| I | 观测面：多视图 vs 4 视图 | P2 | 4 视图 / 6 条 GET 路由 | 门禁链「缺席≠未通过」、阶段拓扑、成本审计、寻优进展都读不到 |

---

## 2. P0 四条，逐条说清差在哪

### A. 判停的算法体（最容易被"判停全在代码里"这句话骗过去）

前身的判停是一串**多级优先序**，不是一条阈值：

判停按优先序逐级判定：平台终态 → 墙钟超时 / 指标越过上限 / 末窗无有限数 → 回归覆盖层（**只收紧不放宽**，
候选自定的容差被抬到一个下限——跨硬件 common-mode offset 的唯一解药）→ 可注册的判停策略
→ 目标注册表收敛 → 单指标收敛兜底。另有两道 spec 未提的救命闸：一道在「排不到资源、进度恒为零」时
结束等待，一道是「跑满上限再判」的短路模式。

策略体本身分**三段**：早期只杀严重退化 → 中期按族投票并留若干条 kill 路径 → 后期按 `(canonical, family)`
分组看收敛，且明确"只在族×canonical 内投票，绝不跨 canonical 求均值"。
每候选还要冻结一份 策略快照（策略 id/version + 目标注册表的 provenance），重启后按快照 replay。

本仓库：`max_rounds` / `max_no_improvement_rounds` / `consecutive_empty_rounds`，后两条只看 primary。
→ 真实 AUC 那种 ±0.002 的抖动下，「无改进」既可能提前收工，也可能永远不收；
→ 重启后策略若有任何变化，同一候选会被按新策略重判，与"可恢复且可比"直接冲突。

### B. 父代与前沿的决策权

前身的形态：按每个 frontier-enabled 轴取 top_k 求并集，再按轮转序取父；无候选时回 `baseline`；
每轮冻结一份内容寻址的父代快照（events 前缀 + frontier + 轮转位置 + 目标注册表绑定）；
反思还有一条**第二条准入路径**——模糊候选被显式放行后可以当下一轮的父。

本仓库：`loop.js:308` `parentId = state.parent_id ?? ports.parentId ?? null`，而 `ports.js` 从不设 `parentId`，
harness 回传的 `parent_id` 默认 `null`。`frontier.js` 有 Pareto 支配，但 `best`、`stop.js`、`judge.compareMetric`
三处决策全只读 `contract.primary`。
→ "候选"实际是"N 个从同一 base ref 出发的独立实验"，谱系（`fold_state` + `anchor` + `parent_id`）整体缺失。

### C. 门禁二与质量准入

前身的门禁二是 **fail-closed 的证据汇总**：身份绑定、候选树与父树双向相等、结构 diff、成本证据、
可重跑且逐字节相等的 smoke、静态检查报告（`ready_to_submit` 且无失败项）、对抗性审查结论（`verdict == pass`），
且 gate 只能被写一次（write-once），之后任何重算不一致即拒。质量准入另有三道：护栏不得越过最小有效幅度、
所有 primary key 必须出现在 diff 里、目标向量 Pareto dominate 全零 baseline。

本仓库：`judge.js:105 defaultStaticChecks` 三条元数据检查（hypothesis 非空、round 正整数、parent_commit 形状），
注释自己写着"更深的检查属于有 worktree 的 phase worker"——**但那个 worker 不存在**。没有质量准入，
`fold_state` 从未被写入（`freezeBinding` 只写过 `parent_binding` 与 `verify_gate`），
`validateChain` 的唯一调用方是 contract 自己的测试。

### D. 指标契约的分辨率

前身的四角色（primary / guardrail / delay / calibration_only）编译成三段式 FQ key，另有"哪些 key 在本 profile 里
真的可测"的资格表、"task×metric 白名单"（防跨 task 名字碰撞时取字典序第一个）、目标注册表（quality + cost 两族，
记最小有效幅度与按 canonical 的覆盖）、以及"窗口均值 vs 末窗（含 all）"的口径选择。

本仓库：`config.metrics = { primary, objectives: {name: up|down} }`。没有最小有效幅度、没有角色、没有窗口口径、
没有指标资格。`config.js` 也不校验 `metrics`/`stop`/`budget`/`injection` 的形状（留到运行期由 frontier/warnings 报错）。

---

## 3. 四处"建好但没接上"的线（P1，成本最低收益最高）

| 线 | 事实 | 后果 |
|---|---|---|
| 注入包 | `judge.js:178` 收 `packet` 端口，`ports.js:309` 不传；core 不 import `@dsh-reprise/memory` | 真实运行里每个 prompt 都打 `(no injection packet was provided for this call)`——三层注入（护栏 / 单例 / 配方）在本仓库等于不存在 |
| baseline | `ports.js:270` 的 `baselinePort.read()` 只读 `<workspace>/baseline.json`；唯一真写它的是 `examples/feed-structure/init.mjs` | 换真实模型后 BASELINE 阶段无人产出；前身的 BASELINE 有两个模型产物（提交模板与指标策略）加一条持续刷新的基线时间线 |
| `retryable` | `exec/lib/harness.js:76` 定义 `RETRYABLE_CLASSES`，`landWithCli` 会返回 `retryable`；`grep -rn retryable packages/core` **为空** | 一次上游 503 直接判死候选（`loop.js:319` 拿到 `ok:false` 就 reject） |
| 锚点 | `intents.js:635` 写 `workspace.code_base_anchor`，`grep` 无第二个读者；`createWorktreeRunner` 的 `base_ref` 只来自 config | `anchor` intent 记录了但下一次 LAND 仍从原 base ref 分支——迭代代码基模式形同虚设 |

---

## 4. spec 从未提到的能力（Top 12，按"漏掉不报错、只是结论悄悄变错"排序）

| # | 能力 | 现在缺在哪 | 漏掉的后果 |
|---|---|---|---|
| 1 | 判停策略族 + 三段式 + 族投票 | 内核只有三条全局数字规则，没有可注册的策略体 | 判停被实现成一条阈值 |
| 2 | 每候选 策略快照 / 采集快照 冻结 | 没有任何快照对象 | 重启后同一候选按新策略重判 |
| 3 | 可插 collector（多路日志指标、两路按进度合并） | 只认一种指标来源 | 多路日志指标无处安放 |
| 4 | 回归覆盖层 + 跨硬件容差下限 | 只有候选自定的容差 | 候选自定容差在跨硬件 offset 下误杀健康候选 |
| 5 | 排不到资源时的独立出口 | 没有 | 排不到资源的候选 RUNNING 到墙钟超时，白占槽位数小时 |
| 6 | control 候选 + 图像效应（零 diff、pin 镜像、每集群一次、不进 frontier/配方） | 无 control 概念 | 所有候选 delta 静默混入"镜像差"公因子 |
| 7 | 滚动代码基锚点（双支配推进 + **分母永不滚** + reject 永久排除） | 只有 `parent_commit`（base ref）是真事实 | 照 spec 只有"代码基锚点"五个字，会漏掉"差分基准不随锚点滚动"这条因果不变量 |
| 8 | 反思的父代准入回流 | frontier 只剩"dominate baseline"一条准入路径 | 模糊但可归因的候选没有成为父的机会 |
| 9 | 确定性落地（可调面白名单 + 结构化 patch 原语 + `old_value` 从 `parent_commit` 回读） | 只剩"模型自由改文件"，另加一个模型自述过期的具体故障 | 同一改动反复提出；自述过期 → 空 diff 死 |
| 10 | 改动分级（按改动面大小裁剪 smoke 与门禁证据） | 没有分级，所有改动同一价 | 纯配置改也要付一次 smoke + 成本证据 |
| 11 | 指标资格 + task×metric 白名单 + 均值窗/末窗口径 | 只有 primary + objectives 两项 | 缺失 key 上 fail-open；窗口均值与末窗两个读者两个结论 |
| 12 | LLM 调用审计（prompt/输出落盘 + 保留轮次 + pruned marker） | 没有调用审计 | 用户故事 12 无法回答 |

另有一条口径纠正：spec 说"候选生命周期只有 5 处调用模型"，但一次可信的运行还缺 4 处——
BASELINE 阶段的两个模型产物、FINALIZE 的一次经验草稿、以及对抗性 gate 的独立进程。
本仓库 `judge.js` 严格 5 处，缺的正是这 4 处。

---

## 5. 反向：本仓库领先或新增的（不是缺口，别当差距补）

- **spend 账本**（预扣 / 结算 / 软硬限 / 人工 vs 自动暂停）：前身完全没有 GPU 小时记账，
  只有轮次预算和两道事实上死掉的闸（一道只写不读、一道只读不写）。这是新增能力。
- 三态幂等 + 只 INSERT 的绑定表 + 触发器强制、增量投影 + `DERIVED_VERSION` 失效、`dump` 自证、只读句柄的看板路由、
  `intents` 七种意图（receipt / deadline fallback / 审批优先序）、`platform` 一致性套件——这几处比前身干净。

---

## 6. 明确不属于 parity 目标（不必争取）

前身有形态、本仓库用另一层取代：多级目录锁与孤儿回收 / 伪暂停时间戳 / 自起 HTTP + launcher + 端口 /
看板写端点（前身也从没有）/ 工作区登记表 / 通知 sidecar / venv + docker 脚本族 / 内部 LLM CLI 适配 /
内部代码托管与共享存储适配 / 内部集群平台与镜像指纹 / 既有工作区数据迁移 / 多工作区并行 / 可配置 phase 图 / Rust。

---

## 7. 建议批次

| 批次 | 内容 | 为什么是这个顺序 |
|---|---|---|
| 一批（"结论可信"） | D 指标契约分辨率 → C 门禁二实体 + 质量准入 → A 判停两层语义（先只做回归覆盖层 + 目标注册表收敛，不搬三段式） | 这三条决定"结论算不算数"；且 A 依赖 D 的目标 registry |
| 二批（"接上线"） | G 四条线（注入包 / baseline 生产者 / retryable / anchor）→ B 父代选择 + 轮父快照 → H 经验回写链 | 都是已有零件的接线，成本最低；B 依赖 frontier 已有能力 |
| 三批（"工况覆盖"） | F 采集层 → E 确定性落地 + 去重门 → I 观测面（阶段拓扑 / 门禁链五态 / LLM 审计优先） | 真实集群与真实日志才需要；观测面直接决定"出事能不能查" |

判停的三段式策略体建议**最后搬**：先有回归覆盖层 + 目标注册表收敛就足以止住"运动员兼裁判"，
而三段式的族投票强依赖 D 的 canonical/family 映射。