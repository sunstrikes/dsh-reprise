# TS 仓库（dsh-reprise）已实现能力清单

盘点对象：`packages/` 六个包 + `skills/` + `examples/feed-structure`，共 42 个测试文件
（`find packages -name '*.test.js' | wc -l` = 42）。所有路径与测试文件名均在本仓库中存在。

口径（实现深度）：

- **真实现**：有完整分支、错误路径、状态写入，且被测试或端到端路径钉住。
- **骨架-只处理一种情况**：接口齐全，但只有一条策略/一个目标/一种介质。
- **桩/占位**：只有一个名字、一行导出或一段回退文案，调用它不产生真实效果。
- **空目录**：只有 `package.json`。

判定依据是打开文件读实现 + `grep` 导入/调用图，**不按文件名推断**。几个关键导入事实：

- `packages/core/lib/ports.js` 只被 `workspace.js` 与 `cli/run.js` 导入，**没有任何测试文件直接导入它**。
- `packages/core/lib/workspace.js`、`cli/run.js` 同样无单测，只被 `five-minute-path.test.js` 以子进程方式端到端跑。
- `packages/core/lib/status-tool.js`、`packages/core/client/index.js`、`packages/core/locale/*.json` 是未提交的新文件（`git status` 可见），且仓库内零测试引用。

---

## 0. 包级结论速览

| 包 | 规模 | 结论 | 一句话 |
|---|---|---|---|
| `packages/contract` | 6 文件 / ~545 行 | 真实现 | 四态 + 相位边界 + 身份链 + 3 个内置 artifact kind 的校验器（core 再注册 2 个），依赖为零，最扎实的一层 |
| `packages/core` | 28 文件 / ~6700 行（`lib/` 25 个文件 6218 行 + `client/` 457 + `locale/` 10） | 真实现（含 4 处未接线） | 相位机、事实库、轮次工作流、停止规则、意图、CLI 都能跑通；真实端口装配层无单测 |
| `packages/exec` | 7 文件 / 2567 行 | 真实现（外部世界未验证） | 两种平台（local 真子进程 / ray 对注入 fetch）+ 两种 harness 适配器 + 公开一致性套件 |
| `packages/exec-python` | 1 文件 / 7 行 | 空目录 | 只有 `package.json`，无 `lib/`、无测试、无导出 |
| `packages/memory` | 7 文件 / ~1360 行 | 真实现但未接入主循环 | 注入包（packet/source/strategy/render）完整，但 core 不 import 它 |
| `packages/ui` | 5 文件 / ~1100 行（3 个 `lib/` + `client/` 832 行 JS + 266 行 HTML） | 真实现 | 4 条只读视图路由 + 静态页 + 浏览器模块，全部 GET |
| `skills/` | 5 个 SKILL.md / 246 行 | 真实现 | 5 个模型调用点的 prompt 指令层，热读、不缓存 |
| `examples/feed-structure` | 13 文件 / ~880 行 | 真实现（示例级） | 端到端可跑的可复制场景，含真实子进程 baseline |

---

## 1. `packages/contract`

| 模块 | 能力 | 深度 | 钉住它的测试 | 缺口 |
|---|---|---|---|---|
| `lib/status.js` | 四态 `ok/missing/conflict/invalid`、`BLOCKING`、`fromFindings` 的 missing→invalid→conflict 优先级 | 真实现 | `test/identity.test.js`（precedence 一例）间接 | 没有独立 `status.test.js`；四态本身只被间接断言 |
| `lib/order.js` | 8 个候选相位 + `REJECTED`、4 个工作区相位、`isPast`/`isBeyond` 严格区分、`requirementsAt` 由相位图推导 | 真实现 | `test/order.test.js`（5 例） | 相位集合是硬编码常量，加相位要改包 |
| `lib/identity.js` | `validateCandidate`（按相位查 binding + job 行）、`validateChain`（三环齐全 + 交叉核对 parent/gate/fold） | 真实现（校验逻辑） | `test/identity.test.js`（8 例） | **`validateChain` 在生产代码里没有调用方**；`fold_state` 无生产者（见 §8.1） |
| `lib/artifact.js` | 注册表 `defineArtifact`/`validateArtifact`、按 kind 的 `schema_version`、`checkField`、`isMilliseconds`（≥1e12 才合法） | 真实现 | `test/artifacts.test.js`（5 例） | 无 JSON-Schema 生成；版本只有 1 |
| `lib/kinds.js` | 3 个内置 kind：`verify_verdict`、`candidate_plan`、`analyze_report`，含"通过却与失败 check/拒绝 review 矛盾"的 conflict 判定 | 真实现 | `test/artifacts.test.js` + `fixtures/{verify_verdict,candidate_plan,analyze_report}/cases.json` | **只有 3 个 kind**；没有 structural_diff / quality_gate / snapshot / metric_contract / baseline / search_space 这些文档对象 |
| `lib/index.js` | 汇总导出 + 副作用注册 kinds | 真实现 | 全部 contract 测试经它导入 | — |

> 注：`artifacts.test.js` 的"every registered artifact kind has fixtures"只在 contract 包自身进程内成立；
> core 注册的 `round_reflect` / `land_hypothesis`（`artifact-kinds.js`）没有 `fixtures/` 目录，靠单测内联断言。

## 2. `packages/core/lib` — 事实层与驱动

| 模块 | 能力 | 深度 | 钉住它的测试 | 缺口 |
|---|---|---|---|---|
| `store.js`（486） | SQLite 事实平面：`events` 主键 `(candidate_id, local_seq)`、三态幂等 insert、`candidate_state`/`workspace_state` KV、`candidate_bindings` 由触发器禁 UPDATE/DELETE、`jobs` 台账、`ledger` reserve/settle、`ops_log`、单事件 ≤64KB、只读句柄、`user_version` 迁移 | 真实现 | `test/store.test.js`（13 例） | 只有 1 个迁移版本；无按时间窗查询（仅 `events_by_time` 索引）；无归档 |
| `tick.js`（77） | cordis 半：`inject:['timer']`，先 `reconcileNow()` 再 `mountTick`，dispose 关库；开库失败只写日志 | 真实现 | `test/host-plugin.test.js`（经 `lib/index.js`） | 单工作区、固定 interval |
| `host.js`（96） | 单飞 tick（`inFlight` 跳帧计数）、异常吞掉并计 `failures`、dispose 幂等 | 真实现 | `test/host-tick.test.js`（4 例） | 无退避/自适应的调度策略 |
| `boot.js`（97） | `logFor`（onLog→host logger→静默）、`resolveForHost` 配置不合法就不 tick | 真实现 | `test/host-plugin.test.js` 间接 | — |
| `index.js`（50，**未提交修改**） | 组合 boot + tick + dashboard + statusTool，任何一半都不许把 host 拖崩 | 真实现 | `test/host-plugin.test.js` | `statusTool` 的挂载无测试 |
| `loop.js`（683） | 候选相位机 8 相位 + 契约闸门、事件先于状态（`applied_seq`）、`foldEvents`/`reconcile`（adopt/correct/grace）、超时判定后 cancel、提交退避、预算闸门、只读一次 `crashAt` 注入 | 真实现 | `test/loop.test.js`（17）、`model-numbers.test.js`、`workspace-tick.test.js` | `BUILD` 恒为 `noop -> verify`；**无父代选择**（`parent_id` 恒 `null`）；harness 的 `retryable` 从不消费；无并发上限 |
| `rounds.js`（466） | 工作区相位 `INIT→BASELINE→ROUND_PLAN→FINALIZE`、plan/reflect 两次模型调用、`candidates_per_round` 上限、拒绝退避 + 3 次后暂停、metric 在 INIT 冻结 | 真实现 | `test/rounds.test.js`（23）、`workspace-tick.test.js` | 基线只能"等"（`baselineEvidence` 读端口/config），无生成器；reflection 只留最近一次；无 plan 失败换 prompt |
| `stop.js`（217） | 3 条规则 `max_rounds` / `max_no_improvement_rounds` / `consecutive_empty_rounds`；飞行中不 stop；记录即吸收；`describeRules` 逐规则状态 | 真实现 | `test/stop.test.js`（13）、`model-numbers.test.js` | **只有 3 条数字阈值规则**，且后两条只看 primary metric；无成本/预算规则、无 token 规则、无策略插件机制 |
| `budget.js`（129） | `gpu_hours_limit`/`soft_ratio`/`candidate_gpu_hours`/`max_runtime_hours`；verdict `ok/soft/hard/runtime`；pause 分自动/人工；`autoResumeIfClear` | 真实现 | `test/budget.test.js`（11） | 成本模型是"每候选固定小时数"；无成本估算/证据/分项；tokens 只记账 |
| `frontier.js`（357） | metric contract 归一、物化行 + `DERIVED_VERSION` 失效、增量折叠 vs `rebuildFrontier` 全量校验、Pareto 支配、`best` 按 primary 且 round→id 破平、`roundHistory` | 真实现 | `test/frontier.test.js`（15）、`model-numbers.test.js` | 多目标只用于"支配/是否在前沿"展示；`best`、停止、judge 判决**都只认 primary**；无超体积/连续前沿 |
| `projection.js`（322） | 4 个只读投影 `overview`/`rounds`/`candidateDetail`/`conclusion`；`summariseEvent`；warnings 由投影携带 | 真实现 | `test/projection.test.js`（9）、`dump-views.test.js`、`warnings.test.js`、`packages/ui/test/dump-agreement.test.js` | 无趋势/时序、无成本分项、无跨运行对比 |
| `intents.js`（777） | 7 种意图 `proposal/grant/anchor/pause/resume/approval/experience`；文件即事实、`wx` 不覆盖、receipt 一次性、deadline fallback、审批优先排序、promotion 落成文件 | 真实现（最完整的一块） | `test/intents.test.js`（21） | `anchor` 只写 `workspace.code_base_anchor`，**无人消费**（§8.3）；无撤销/重放 |
| `judge.js`（423） | 5 个模型调用点（land/verify/cand_analyze/round_plan/round_reflect）、`parseAnswer` 容忍 fenced/prose、3 条 L1 静态检查、`pickMetric`/`compareMetric`、artifact 落盘、模型端口失败 fail-closed | 真实现 | `test/judge.test.js`（25）、`skills.test.js`、`model-numbers.test.js`、`workspace-tick.test.js` | L1 只有 `hypothesis_recorded`/`round_recorded`/`parent_binding_frozen` 三条元数据检查，**不跑编译/导入/测试**；单一 metric 契约；`packet` 端口无人提供（§8.4） |
| `skills.js`（175） | 5 个 call site → `skills/<dir>/SKILL.md`，每次热读、frontmatter 拆分、`renderPrompt`（skill→packet→facts→answer shape） | 真实现 | `test/skills.test.js`（6） | 只认 `name`/`description` 两个 frontmatter 字段 |
| `artifacts.js`（81） | `fileArtifacts` 原子写（tmp+rename）+ sha256；`memoryArtifacts` | 真实现 | 经 `workspace-tick.test.js`/`judge.test.js` 间接 | 无独立测试文件；无内容寻址/去重 |
| `ports.js`（322） | 真实端口装配：clock、platform(local/ray)、harness(command/claude/dsh)、judge、baseline 文件端口、artifacts、worktree runner（`git worktree add --detach`）、`createCommandModel`（stdin/stdout JSON）、`absoluteise` 路径改写 | 真实现（代码完整） | **无测试文件直接导入**，只有 `five-minute-path.test.js` 端到端覆盖 | 不传 `packet`；不设 `parentId`；runner 的 `base_ref` 只来自 config；平台只 2 种 |
| `workspace.js`（96） | 开库→解析端口→`tickOnce`/`reconcileNow`/`isFinished`/`close` | 真实现 | 经 `five-minute-path.test.js`、`host-plugin.test.js` 间接 | 无单测 |
| `config.js`（122） | 校验 workspace/executor/candidate/runner/model/rounds/interval；`EXECUTOR_KINDS` 2、`CANDIDATE_KINDS` 3；默认 5s | 真实现 | `test/config.test.js`（11） | **不校验 `metrics`/`stop`/`budget`/`injection` 的形状**（留到运行期由 frontier/warnings 报错）；无配置热加载 |
| `warnings.js`（155） | 4 个 code：`no_gpu_hours_limit`、`round_metric_not_an_objective`、`metric_direction_mismatch`、`no_model_port` | 真实现 | `test/warnings.test.js`（8） | 全是"配置自洽"层警告，无运行期健康告警（卡住、落后、漂移） |
| `status-tool.js`（122，**未提交**） | `ctx.tools.register('reprise_status')`，复用 `@dsh-reprise/ui` 的 views，只读、可裁剪事件数 | 真实现代码 | **零测试、不在 `package.json` exports** | 见 §8.6 |
| `artifact-kinds.js`（101） | 经 `defineArtifact` 注册 `round_reflect`/`land_hypothesis`，幂等 | 真实现 | `test/rounds.test.js` 第一条 + `judge/workspace-tick` 间接 | 两个 kind 无 fixture 目录 |

### 2.1 `packages/core/lib/cli/`

| 模块 | 能力 | 深度 | 钉住它的测试 | 缺口 |
|---|---|---|---|---|
| `cli/run.js`（199） | 循环 `tickOnce` + 一行一步去重打印 + 收尾 summary + 退出码 0/1/2/3 | 真实现 | `test/five-minute-path.test.js`（子进程） | 只有 `--workspace/--config/--max-seconds/--quiet`，无子命令（暂停/授权走 intents CLI） |
| `cli/dump.js`（324） | 时间线、停止原因（四态 + 终态双事实）、前沿位置、工作区停止规则、身份绑定、job、工件引用；`--rebuild` 增量 vs 全量比对 | 真实现 | `test/dump.test.js`（7）、`dump-views.test.js`（10） | 只读单候选/重建，无跨工作区 |
| `cli/intents.js`（239） | `place <kind>` / `list [--json]`，7 种 intent 的 flag 解析 | 真实现 | `test/intents.test.js`（子进程，`const CLI = .../cli/intents.js`） | — |

### 2.2 未提交的新文件

| 路径 | 能力 | 深度 | 测试 | 说明 |
|---|---|---|---|---|
| `packages/core/locale/en.json` / `zh.json` | 各 5 行，仅 `meta.title` + `meta.description` | 骨架-元数据 | 无 | 仓库内无代码引用（`grep locale` 只命中 client 的 `ctx.locale`），属 host bundle 元数据位 |
| `packages/core/client/index.js`（457） | DSH Web UI 侧栏面板：`sidebar.panellist` + `main` 槽位、`ctx.locale.register` 双语、读 `/api/reprise/overview` 渲染 phase/rounds/candidates/spend/frontier/best/stop/warnings/notes/events | 真实现 | 无 | `package.json` 已声明 `dsh.client.platform/web` + `./client` 导出 |
| `packages/core/icon.svg` | 侧栏图标 | 桩（静态资源） | 无 | — |

---

## 3. `packages/exec`

| 模块 | 能力 | 深度 | 钉住它的测试 | 缺口 |
|---|---|---|---|---|
| `lib/platform.js`（598） | 端口词表（5 状态 / 4 error_class）、5 个断言、`judgeTimeout`/`pollWithLimits`（wall 优先、idle 次之，超时后真 cancel）、**公开一致性套件** `runPlatformConformance`（12 例） | 真实现 | `test/platform.test.js`（套件跑两遍） | error_class 只有 `oom/code/data/canceled` |
| `lib/platform-local.js`（349） | 真子进程：独立 supervisor、job 目录 `job.json/spec.json/started.json/status.json/metrics.json`、pid 探活、`SIGTERM→SIGKILL` 进程组、失败签名分类、slug 碰撞拒绝 | 真实现 | `test/platform-local.test.js`（8）+ 一致性套件 | pid 复用可能把死任务看成活的（README 自承）；无容器/资源隔离 |
| `lib/platform-ray.js`（441） | Ray Dashboard REST：`/api/jobs`、`/api/v0/tasks`、`/logs`；409/400 already-exists 幂等；`STOPPED→canceled`；`TaskState.error_type` + 日志签名；metrics 文件或执行器约定的指标行 | 真实现（对注入 fetch） | `test/platform-ray.test.js`（13）+ 一致性套件 | 无真实集群；只走 Job Submission REST 这一条路；真实部署未验 |
| `lib/harness.js`（865） | `landWithCli`：cwd=worktree、prompt 契约、超时 + 进程组 kill、stream 上限、结果解析、**git diff 是权威**、self-report 交叉核对、12 类错误分类、`validateLandResult` 一致性契约 | 真实现 | `test/harness.test.js`（7）、`harness-errors.test.js`（5） | 只认两种事件流形状；`RETRYABLE_CLASSES` 定义了但 core 不消费；不创建 worktree/ref（有意） |
| `lib/harness-claude.js`（103） | `claude -p --output-format stream-json` 参数与结果归一 | 真实现 | `harness-errors.test.js`（假 CLI） | **未对真 claude CLI 验证**（README 明说） |
| `lib/harness-dsh.js`（101） | `dsh --profile headless --json -` 参数与结果归一 | 真实现 | `harness-errors.test.js`（假 CLI） | **未对真 dsh 验证** |
| `lib/local-runner.js`（114） | local 平台的 supervisor 脚本：读 spec、spawn、写 started/status/metrics、driver.log | 真实现 | 经 `platform-local.test.js` 间接 | — |

## 4. `packages/exec-python`

`package.json`（7 行）声明 `"Optional Python bridge for the second-scale proxy metric (forward smoke). Needs torch."`，
**没有 `lib/`、没有 `test/`、没有任何 `main`/`exports`**。`scripts/check.mjs` 对"有代码却无 main"的检查因此不触发。
→ **空目录**。所谓"秒级代理指标 forward smoke"零实现。

## 5. `packages/memory`

| 模块 | 能力 | 深度 | 钉住它的测试 | 缺口 |
|---|---|---|---|---|
| `lib/packet.js`（485） | `buildPacket`：hard 段 `guardrails`/`singletons`/`frontier` 逐条不裁剪，ranked 段 `recipes`/`candidate_experiences` 交给 strategy；digest（canonical JSON）；跨段去重 `suppressed`；`problems`/`degraded` | 真实现 | `test/packet.test.js`（13）、`isolation`、`render` | 输入依赖调用方给 `view`（frontier 视图）与 `config.injection.*` |
| `lib/experiences.js`（146） | 读 `<workspace>/experiences/*.json`、严格校验（未知字段拒收）、按 section 一分流 | 真实现 | `test/experiences.test.js`（5） | 只有一个 writer（intents 的 experience） |
| `lib/strategy.js`（122） | `mnemonStrategyPort` 把真实 `MemoryStrategyDefinition.compose` 包成 ranked 端口；eager/routed/字符预算原样采纳 | 真实现（接口层） | `test/strategy.test.js`（5） | **没有内置/默认策略**；无 strategy 时整段 `degraded: no_ranked_strategy` |
| `lib/source.js`（344） | mnemon Source `{manifest, create}` → `{facts, project, query}`；capabilities 只 `status/project/search`；`actions: []`；hard 段永不裁剪 | 真实现 | `test/source.test.js`（9）、`auto-capture-off.test.js` | 需要宿主装 `dsh-mnemon` 且策略角色可入；`query` 只有 2 次调用预算 |
| `lib/register.js`（112） | `inject:['mnemonMemory']`、`apply` 装 contribution、服务缺失时**显式抛错** | 真实现 | `test/registration.test.js`（7） | 默认 build 的 `view` 只来自 `config.view()`，无则 frontier 段报 `no_frontier_view` |
| `lib/render.js`（121） | packet → 文本，逐行带 provenance，明确标注"not in packet" | 真实现 | `test/render.test.js`（5） | 只给 dump 用，CLI 未接 |
| `cordis.patch.yml` | 一行 `insert: @dsh-reprise/memory` | 桩（只有包名） | — | **不带 config**：没有 `workspaceDir`/`view`/`strategy`（§8.5） |

## 6. `packages/ui`

| 模块 | 能力 | 深度 | 钉住它的测试 | 缺口 |
|---|---|---|---|---|
| `lib/routes.js`（192） | 6 条**只 GET** 路由（4 视图 + `page` + `dashboard.js`），每请求一个只读句柄，dispose 全量反注册，失败半程回滚 | 真实现 | `test/routes.test.js`（4）、`read-only.test.js`（7） | **没有写端点**（有意，写走 intents 文件） |
| `lib/views.js`（194） | 4 个视图 envelope + 工作区级游标 `wall_clock:candidate:seq` + `configFrom(store)` 读记录配置 + `notes` | 真实现 | `test/views.test.js`（8）、`incremental.test.js`（6）、`dump-agreement.test.js`（6） | 无鉴权/多租户（按注册的 workspace 隔离） |
| `client/dashboard.js`（413） | 浏览器模块：轮询 4 视图 + 增量事件流（200 条上限）、渲染 overview/rounds/candidate/conclusion/stream，含 warnings 行 | 真实现 | `test/client.test.js`（6，读源码 + 断言关键字） | severity 判等用 `=== 'warn'`，而 `warnings.js` 产出的是 `'warning'`，标签渲染成 note 样式 |
| `client/index.html` | 页面壳（跟随 host theme token） | 真实现 | `client.test.js` | — |

## 7. `skills/` 与 `examples/feed-structure`

`skills/`：`land`(41) / `verify`(56) / `cand-analyze`(50) / `round-plan`(49) / `round-reflect`(50)，
每个都有 frontmatter + 正文；由 `test/skills.test.js` 钉住"存在、非空、改文件即改 prompt、缺失要炸"。
**真实现**（指令层），但内容质量无法由测试判定。

`examples/feed-structure`（13 文件）：

| 文件 | 作用 | 深度 |
|---|---|---|
| `lab/metric.mjs`（234） | 合成带交互项的 feed 数据 + 训练 + 写 `metrics.json` | 真实现（种子确定） |
| `init.mjs`（147） | 建模型仓库并 commit、冻结 `priors.manifest.json`（sha256）、**用真实 local executor 跑 baseline 并写 `baseline.json`** | 真实现（唯一的生产 baseline 的地方） |
| `apply-change.mjs`（69） | 机械把 hypothesis 的 `change` 写进 worktree | 真实现（非模型 harness） |
| `recorded-model.mjs`（93） | 回放 4 个 call site 答案；按 `priors.json` 拒绝未声明的 hypothesis class | 桩（回放，但走真线协议） |
| `inspect.mjs`（60） | 打印四个数据文件 | 真实现 |
| `config.json`/`priors.json`/`hypotheses.json`/`metric-contract.json`/`recorded/judgement.json` | 全部是数据 | 真实现（数据） |

端到端由 `test/five-minute-path.test.js` 钉住：README 五步逐条执行、断言真实 AUC、断言语义方向翻转可换赢家。

---

## 8. 接口有了、但没有真实实现的（逐条带证据）

1. **身份链第三环 `fold_state` 从来没有人写。**
   `contract/lib/identity.js:16` 定义 `BINDING_KINDS = ['parent_binding','verify_gate','fold_state']`，`validateChain` 缺一环即 `missing`；
   但 `grep -rn "freezeBinding" packages/core/lib` 只有 `loop.js:332`（parent_binding）与 `loop.js:380`（verify_gate）两处。
   `validateChain` 的唯一调用方是 `contract/test/identity.test.js`。→ 完整身份链在生产路径上**永远不可能成立**，也没有调用点去问它成不成立。

2. **父代选择（parent selection）不存在。**
   `loop.js:308`：`const parentId = state.parent_id ?? ports.parentId ?? null`；`ports.js` 的 `portsFromConfig` 从不设 `parentId`，
   core 里唯一写 `parent_id` 的地方是 `freezeBinding` 用 harness 回传值（`loop.js:336`），而 `landWithCli` 的 `parent_id` 默认就是 `null`。
   → 每个候选的 `parent_binding.parent_id` 都是 `null`，只有 `parent_commit`（base ref 的 commit）是真实的。没有父代打分、没有快照、没有绑定策略。

3. **`anchor` 意图没有任何消费者。**
   `intents.js:635` 把锚点写进 `workspace.code_base_anchor`；`grep -rn code_base_anchor packages examples` 只有这一处写入 +
   `core/test/intents.test.js:577` 一处断言。`ports.js` 的 `createWorktreeRunner` 的 `base_ref` 只来自 `config.runner.base_ref`。
   → 锚点记录了，但下一次 LAND 仍从原 base ref 分支。

4. **注入包没有接进主循环。**
   `judge.js:178` 接受 `packet` 端口并在 `:220` 使用；但 `ports.js:309` 的 `createJudge({...})` 没有传 `packet`，core 里也没有任何
   `import '@dsh-reprise/memory'`（`grep -rn "@dsh-reprise/memory" packages/core` 为空）。`skills.js:161` 因此在所有真实运行里打印
   `(no injection packet was provided for this call)`。`core/test/skills.test.js:103` 只用手搓的 packet 数组证明了渲染分支存在。

5. **memory 的 bundle patch 只有包名，没有配置。**
   `packages/memory/cordis.patch.yml` 只有 `name: '@dsh-reprise/memory'`；`register.js:73` 的 `defaultBuild` 需要 `workspaceDir`/`view`/`strategy`，
   三者都来自 config 且都可缺省。→ 即使被 host 挂上，packet 也会是"空 guardrails + `no_frontier_view` + `no_ranked_strategy`"的降级形态。
   同时 `register.js:22-25` 的注释仍写着"manifest 还导出 `./src/index.ts`、没有 `dsh.bundle.patch`"，与现在的 `package.json` 不符（注释过期）。

6. **`reprise_status` 工具是未接线的新代码。**
   `core/lib/status-tool.js` 是未提交文件，`grep -rn "status-tool\|reprise_status" packages/*/test` 无命中，
   `package.json` 的 `exports` 里也没有 `./status-tool`；它只在 `lib/index.js:44` 以 `ctx.plugin(statusTool, …)` 挂载。
   它还是仓库里唯一的 `core → @dsh-reprise/ui/routes` 反向依赖（`status-tool.js:16`）。

7. **`exec-python` 是空包。** 见 §4：只有一句 description，没有任何代码或导出。

8. **baseline 只有读取器，没有生产者。** `ports.js:270` 的 `baselinePort.read()` 只读
   `<workspace>/baseline.json` 或已冻结的 rounds 状态；`rounds.js:245 freezeBaseline` 在拿不到证据时只会 `waiting_for_baseline`。
   仓库里唯一真的"跑一次 baseline 并写文件"的代码是 `examples/feed-structure/init.mjs:44`（示例脚本，不是 kernel/CLI）。

9. **harness 的 `retryable` 承诺没有被兑现。** `exec/lib/harness.js:76` 定义 `RETRYABLE_CLASSES = [transient]`，`landWithCli` 返回 `retryable`；
   `grep -rn retryable packages/core` 为空 —— `loop.js:319` 拿到 `ok:false` 直接 `reject`。→ 一次上游 503 就判死一个候选，尽管分类层明知它可重试。

10. **`metric-contract.json` 这个文件类型内核从不解析。** `rounds.js:70` 把 `metric.contract_ref` 当作**字符串**传递，
    `judge.js` 也只是把它写进 artifact 的 `metric_contract_ref`。真正被读的是 `config.metrics`（`frontier.js:60`）与
    `config.rounds.metric`（`rounds.js:64`）。示例 README 里"kernel 读 `direction` 和 `objectives`"指的是 config，不是这个文件。→ 契约文件没有 schema、没有校验、没有一致性检查（只有 `warnings.js` 比较 config 内部两处声明）。

11. **`priors.json` / `search_space` 不是内核概念。** `priors.json` 只被 `examples/feed-structure/recorded-model.mjs` 读；
    内核里唯一相关的是 `memory/lib/packet.js:187` 把 `config.injection.search_space` 当**文本**渲染进 singletons。没有 prior 注入、没有 recipe prior、没有先验与候选的关联。

12. **`verify_gate` 名不副实。** `judge.js:105 defaultStaticChecks` 只做三条元数据检查（hypothesis 非空、round 正整数、parent_commit 形状）；
    代码注释明确说"更深的检查属于有 worktree 的 phase worker"，但仓库里没有这样的 worker。→ 没有编译、没有导入解析、没有测试执行、没有质量门。

13. **UI 没有任何写端点。** `ui/test/routes.test.js` 用测试把"GET-only / POST 404"钉死；所有人工操作只能经
    `cli/intents.js` 写文件。这条是设计选择，但对 parity 而言意味着"网页上点按钮改预算"这类能力**不存在**。

---

## 9. 42 个测试文件各守什么（按包归类）

`packages/contract`（3）

| 文件 | 守什么 |
|---|---|
| `artifacts.test.js` | 每 kind 有 fixture；未知 kind 是 invalid；毫秒上下界（秒/纳秒都拒）；第三方可加 kind；`schema_version` 按 kind |
| `identity.test.js` | 未写→missing、无 phase→invalid、需求随相位增长、`passed` 必须严格布尔、parent 不一致是 conflict、四态优先级、三环链齐全 |
| `order.test.js` | `isBeyond` 严格 / `isPast` 含边界；未知相位不满足任何边界；相位不会要求自己即将产出的东西；需求单调；终态只有两个 |

`packages/core`（20）

| 文件 | 守什么 |
|---|---|
| `store.test.js` | 迁移与重开、事件三态幂等、毫秒校验、64KB 上限、binding 只插不改、崩溃可检测、replay 幂等、settled/in-flight 不为负、submission 唯一、ops_log、只读句柄、双读者 |
| `loop.test.js` | 全相位走到 DONE、一 tick 一步、非法 artifact→invalid、review 拒绝但 pass→conflict、gate 失败不造 job、崩溃后 adopt、事件补折叠、折叠幂等、grace、退避、上游失败带 error_class、硬预算暂停、显式暂停、内核不读系统时钟、真失败不诬为 malformed、hypothesis 传到 harness、事件流可恢复状态 |
| `rounds.test.js` | 两个 round kind 注册幂等、INIT/BASELINE 零模型调用、无基线就等、配置不可用则暂停、未配置 rounds 完全 no-op、metric 在 INIT 冻结、plan→候选生成、重放不重造、拒绝不推进并点名缺字段、连续拒绝后暂停、退避重试、重复 id conflict、无文件 hypothesis 拒收、超预算 plan 拒收、judge 抛错只是拒绝、一轮只 reflect 一次、reflection 被拒则轮次不关、有候选在跑不 reflect、模型说停不算、降预算立即停、预算耗尽后 finalize 不调模型、重启可恢复、外部候选不算本轮 |
| `stop.test.js` | 默认 3 轮、2 轮不停、有在飞不停、最后一飞落即停、无改进停并点名保持者、改进清零、空轮与无改进是不同理由、规则优先级固定、finalize 吸收、0 即禁用、非数字被报告并禁用、报告 blocked_by、无候选不算 finished |
| `budget.test.js` | 默认无上限不判 token、reserve 即刻计入、soft 只挡新派发、hard 与 soft 不同 verdict、tokens 只记录、wall clock 是第三道闸、自动暂停自清、人工暂停不自清、未暂停 resume 是 no-op、workspace 预算覆盖 config、崩溃不退钱 |
| `frontier.test.js` | best 由平台指标定、objective 顺序稳定、down 方向、互有取舍同在前沿、缺目标记为 incomplete、平局按 round→id、按轮分组、空轮≠更差、无契约不排序并说明、未知方向拒收、增量=全量、增量只重算有变化的候选、全量能抓出不再吻合的物化行、只读可算、旧版本物化行作废 |
| `projection.test.js` | overview 回答"在哪/花多少"、settled≠in-flight、已结论的 run 用当时记录措辞、rounds 谁改进谁空、candidate detail 带时间线/闸门/失败文本/工件、conclusion 点名最优与对照、只读、纯函数、未知候选报缺失 |
| `dump.test.js` | 不看代码能答"为何停"、dump 绝不写、未知候选有说明、无候选是用法错误、CLI 已接线、渲染纯函数、两种暂停分得清 |
| `dump-views.test.js` | dump 回答"为何结束/排在哪"、被拒候选给四态原因且从未入榜、未结论的 run 也报规则、`--rebuild` 一致与不一致都出声、可与 `--candidate` 组合、`--rebuild` 不写、`--config` 用旧契约读旧工作区、渲染纯函数、部分向量列为 incomplete |
| `config.test.js` | 归一化默认、无 workspace 拒、executor 无命令拒、未知 kind 拒、ray 无 URL 拒、candidate 无 runner 拒、rounds 无 model 拒、纯 proposal 可无 model、未设上限只告警、interval 非法拒、校验不建目录 |
| `warnings.test.js` | 真执行器无上限要警告（文案面向人）、local 不警告、设了上限就静音、警告进 projection、空投影是空数组不是缺字段、方向不一致告警、轮次指标不是目标告警、无模型端口告警 |
| `host-plugin.test.js` | 入口在任何服务之前 apply 并说明缺哪半、有 timer 时无 session 也能开库并 tick、开不了库只记日志、无 workspace 拒但 host 仍启动、无上限真执行器开机即播报 |
| `host-tick.test.js` | 一间隔一 tick、重叠跳过、抛错不终止、dispose 只清一次且先清 interval 再关库 |
| `intents.test.js` | grant 一次生效、pending 不覆盖、CLI 与 UI 同形、CLI 拒非法、各类错误都拒并说明、已应用不可重放、pause 当 tick 生效且只由人清、自动暂停自清、resume 可强推人工暂停、held proposal 不阻塞、超时落 fallback、超时 apply、按时人答算数、按时人拒则拒、超时后的批准被拒、默认 proposal 免审批、anchor 只指向已完成候选、promotion 落文件且只一次、对未请求审批者批准被拒、重复候选拒、CLI 能下每一类 |
| `judge.test.js` | accept 得到合法 verdict 且 L1 来自内核、模型不能贡献 check、reject 不诬为 malformed、accept 与失败 check 是 conflict、模型给数字无效、模型端口故障 fail-closed、prose/fence 仍能解析、改进由代码算并回显、模型声称改进无效、无指标即缺证据、端口未答即不完整、空根因是 malformed、state 上的 metrics 是证据、契约决定采哪个数、无基线则 inconclusive、改 skill 即时生效、plan 身份字段来自代码、重复 hypothesis id 是 conflict、无 statement 是 invalid、空 plan 拒、reflection 结构化且丢弃 stop 旗标、无 summary 不推进、全空 lessons 是 malformed、LAND 冻结 hypothesis 并从 skill 出 prompt、无文件 hypothesis 不成候选 |
| `skills.test.js` | 5 个 call site 各有非空 SKILL.md、改文件即改 prompt、prompt 顺序（skill→facts→answer）、缺 skill 要炸、未知 call site 拒、packet 段存在且空时要说明 |
| `model-numbers.test.js` | 模型数字不能延长、也不能缩短运行；平台没报的指标不能由分析编造；分析给的 verdict 词不是比较 |
| `dashboard.test.js` | UI 包把路由挂到 connection 并交回 disposer、没有 UI 包只是"原因"不是异常、没有 connection 面（headless）也只是原因、UI 抛错时带自身消息、真 `@dsh-reprise/ui` 能挂且 disposer 全反注册、overview 页带着 GPU 小时警告 |
| `workspace-tick.test.js` | 纯 tick 走完 plan/run/reflect/finalize、确定性相位零模型调用、无 rounds 时行为不变、review 拒绝在提交前拦住、accept 覆盖失败 check 记 conflict、verdict 落盘可被引用、dump 能点名缺字段、换 skill 换判定、模型编的数字进不了事实库 |
| `five-minute-path.test.js` | README 恰好五步且命令逐字一致、五步真跑出真实 AUC、指标方向是数据（翻转则换赢家） |

`packages/exec`（5）

| 文件 | 守什么 |
|---|---|
| `platform.test.js` | local 与 ray 两个实现各跑一遍同一套一致性用例（唯一跨实现契约） |
| `platform-local.test.js` | 无集群无 GPU 出真指标、第二实例接管在跑任务、cancel 真杀进程、退出 0 无指标是 data 失败、非零退出胜过 metrics 文件、跑在 plan cwd（worktree）、无命令就抛、slug 相同仍区分 |
| `platform-ray.test.js` | 任务态优先于 JobDetails；只有日志能判 data；无证据时不甩锅代码；集群故障≠候选故障；外部停止是 canceled；两种 already-exists 形状都归并；dashboard 不可达=unknown；恢复靠 submission_id；成功无指标=data 失败；提交体带幂等键/候选/指标路径；被拒提交抛错；未知状态=unknown；日志签名只在无任务记录时用 |
| `harness.test.js` | harness 不报 diff 也能落地（cross_check=not_reported）、同 worktree 二次落地报的是 diff 不是累加、runner 能删 worktree 与 ref、调用错误在起进程前抛、git 读不出是 runner bug 不是零改动、prompt 写明隔离规则、一致性契约会拒掉不该收到的结果 |
| `harness-errors.test.js` | 每个结果恰一个 class 且优先级固定、其余上游结果各归各类、缺二进制被分类而不是 spawn 崩、self-report 从散文里读且散文不算报告、交叉核对只说哪边不一致且绝不合并 |

`packages/memory`（8）

| 文件 | 守什么 |
|---|---|
| `packet.test.js` | guardrails 原序原样、永不因 ranked 预算被裁、singletons=全局最优+搜索空间且完整、frontier 是每个候选（非 top-N）、digest 由事实决定、ranked 完全按端口决定、无点名时填满预算且溢出进 staged、routed 不投影但仍 staged、guardrail promotion 只有一个家、strategy 缺失时 packet 仍完整并说明、被拒的 promotion 在 packet 内可见、无事实重复 |
| `experiences.test.js` | 文件名序 + section 保留、无目录=空不是坏、坏文件必上报、一事实一家、无 section 默认 recipe |
| `strategy.test.js` | 看到 mnemon 形状的 view request 与两个 ranked source、授予什么就得到什么、未选中即 routed 零预算、两个 source 地址符合宿主格式、非 strategy 在缝上被拒 |
| `source.test.js` | manifest/create/只读 runtime、facts() 不写不需 host、project 交出完整 hard 段与预算内 ranked、hard 段已超预算要报告而非裁剪、routed 不在文本里但 query 可取、build 失败返回 unavailable、无内存空间仍完整且标 degraded、abort 即停、两段各有 instance 身份 |
| `registration.test.js` | 声明 memory 服务、无 host 也能构建 definition、registration 用自己 ctx、随 fiber 生灭、只贡献 source（无 capture/写）、坏 ctx 显式抛、无 builder 时也用 workspace 构建 |
| `render.test.js` | 每行带出处、provenance 旁列打印、degraded 要明说、routed recipe 显示为可达未投影 |
| `isolation.test.js` | 两工作区同 id 不同 packet、provenance 只指本工作区、两 source 投影互不重叠 |
| `auto-capture-off.test.js` | 全仓无"模型写内存"的代码路径、manifest 与 runtime 都没有写能力/动作/方法、只贡献 sources |

`packages/ui`（6）

| 文件 | 守什么 |
|---|---|
| `routes.test.js` | 挂载与 dispose 全量反注册、每条路由只 GET、POST 到挂载路径 404、半程失败不留残路由 |
| `read-only.test.js` | 句柄拒写、全路由巡游后事实字节不变、四视图无需 session/agent、坏 query 是 400 JSON、路由表是闭合集合、两工作区两套看板 |
| `incremental.test.js` | 全量读带游标且重复读字节一致、游标是工作区级（新建候选不会漏）、增量同时带视图且与全量一致、已在头部则空增量、两窗口互不干扰、坏游标拒 |
| `views.test.js` | overview 仅凭目录就能答、未记录预算要说明而不是显示 0、未开工是零页不是失败、从未存在也是空、candidate 需要 id 并回显、rounds 列每轮与是否推进、conclusion 点名最优与对照、被拒候选带四态 |
| `dump-agreement.test.js` | 页面与 dump 对"为何停/排在哪/为何结束/身份与工件"逐条一致、无契约时不发明排名 |
| `client.test.js` | 两个资源路由能取到页面与模块、模块读四视图并跟游标、不硬编码颜色、页面声明只读、单模块可解析、页面画出 payload 里的 warnings |

---

## 10. 最容易在 parity 分析里被漏掉的几件事

1. **"能跑通"的证据强度不均匀**：`loop/rounds/stop/frontier/judge/intents/store` 有厚单测；
   而 `ports.js`（真正的执行器/harness/judge 装配）、`workspace.js`、`cli/run.js` 只有 `five-minute-path` 一条端到端路径覆盖。
   parity 若以"测试锚定"为口径，这几块会被低估。
2. **多目标是"展示级"而不是"决策级"**：`frontier.js` 有 Pareto 支配，但 `best`、`stop.js`、`judge.compareMetric` 全部只看 `contract.primary`。
3. **`baseline`、`priors`、`metric-contract.json` 三者都不是内核对象**：前者靠文件+端口读，后两者只在示例/内存包里以数据形式出现。
4. **`fold_state` / `anchor` / `parent_id` 是一组相关缺口**：它们共同构成"候选谱系"能力，而当前只有 `parent_commit`（base ref）是真事实。
5. **`exec-python` 与 memory 的 `cordis.patch.yml` 是无代码/无配置的接线位**，容易被当成"已有能力"。
6. **`status-tool.js` 与 `client/index.js` 是尚未进测试与导出的新代码**：能力真实存在，但无回归保护，也未被 `scripts/check.mjs` 的导出检查覆盖（它们不是 `exports` 目标）。