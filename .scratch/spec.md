# Spec: dsh-reprise —— 把模型结构探索 loop 做成 dsh 插件

Status: open
Labels: ready-for-agent
Tracker: 本仓库本地 markdown（无远端 issue tracker）

**来源**：早期设计票的塌缩，不新增决策；票里的推理与实测证据留在各自的票里。

---

## Problem Statement

今天要发起一次模型结构探索，我必须在一个自研的 Python 单体里找路：四件事全部是自实现的，并且全在同一个进程里，每改一处都要理解整个调度器。

1. **记忆是黑箱。** 上一轮哪条经验被喂进 prompt、为什么被喂、为什么另一条被丢掉，答案是一段相关性排序（token 计数 + 日龄衰减 + 硬预算丢弃）。结果既不可预测也不可解释，而且它决定了模型看到什么——这是最该可解释的地方。
2. **看板是另一套栈。** detached 的 Python web 进程 + 一堆手写 vanilla JavaScript，按固定间隔全量轮询，**零写端点**。改看板要同时懂 Python、JS 和那套手写的进程管理；所有人工介入都在看板之外，靠 pending 文件加命令行。
3. **等外部作业靠约定。** 作业状态、轮询节律、超时、失败分类全靠 `next_action_at` 时间戳和 mkdir 锁协作。暂停是用 `next_action_at = 9999-12-31` 伪装的。三道预算闸里有两道是死的（一道只写不读、一道只读不写），而这只有读代码才能发现。
4. **规模一上来就崩。** 上到万级事件，一次 tick 就退到秒级，其中**绝大部分时间花在每个 tick 把全部事件排三遍**；量再大一个数量级，全量重建按十分钟计；每次登账是 O(N)，一次写按百毫秒计。

而它同时**要开源**。上面四层里，执行器（内部 LLM CLI）、集群（内部 Ray 与 k8s）、看板（自己写的 web 栈）一件都带不出去。

真正想保留的只有一件事：**一个候选 = 一个结构假设 + 它落地所需的一批变更**，循环负责提出假设、实现、评估、反思；代码保证它无人值守、失败即停、重启可恢复、多候选可比。其余的都该由生态提供。

## Solution

把它做成一个 **DeepSeek Harness 插件**，独立开源仓库，Apache-2.0。宿主提供记忆、展示、定时与生命周期；我们只保留循环本身与它的契约。

- **控制流在代码里。** phase 图固定；整个候选生命周期只有五处调用模型（LAND、VERIFY 的对抗性审查、CAND_ANALYZE、ROUND_PLAN、ROUND_REFLECT），且**模型的输出必须先变成 validator 接受的 artifact 才可能影响状态**。没有任何一条模型判断能直接改状态。
- **事实面是一个工作区目录**，插件拥有、外部进程可读：追加事件流与状态进目录内的一个 SQLite 文件，被校验的产物、先验清单、人的意图仍是文件。SQLite 买到的是「不可能被并发写坏」，代价是失去 `grep` / `git diff`——用一个 `dump` 命令补回来。
- **唤醒是宿主 timer**（`ctx.interval`）：不需要会话、不烧模型。模型只在需要判断时才被叫起一轮。重启靠启动时对账——先问外部平台的真实状态，再决定推进。
- **记忆交给 `dsh-mnemon`**：事实 → mnemon Source → 注入包。硬配额的部分（护栏、单例、当前前沿）由我们直给；需要取舍的部分（配方、候选经验）交给 mnemon 的 strategy。
- **看板挂在宿主已有的 HTTP 表面上**（`connection.fetch.register`）：不起第二个端口，没有 launcher，没有 liveness 探针。客户端只是一组读只读投影的 React 组件。
- **执行器可插**：外部作业是 `submit / poll / collect` 三件套；候选实现者是任意 CLI coding harness，首个适配 `claude -p` 与 `dsh --profile headless`，`cwd` 必须绑到候选 worktree。

一句话：本仓库只交付「循环 + 契约 + 领域差异的数据形态」，其余全部换成公开生态。

## User Stories

### 跑实验的人

1. As 一个跑结构探索的人, I want 用一个命令在工作区里启动一次探索, so that 我不必先读懂几万行代码才知道怎么发起请求。
2. As 一个跑结构探索的人, I want 看板直接告诉我当前在哪个 phase、还剩几条候选、预算用了多少, so that 我一眼就能判断这次运行是否还健康。
3. As 一个跑结构探索的人, I want 看到任何一个候选的完整时间线, so that 我能回答「它为什么停在这里」而不需要读代码。
4. As 一个跑结构探索的人, I want 手动暂停一个工作区, so that 我能在开会时让它安静下来而不会丢掉进度。
5. As 一个跑结构探索的人, I want 区分「我按下的暂停」和「系统因预算暂停的」, so that 我不会把系统的决定误当成自己的操作。
6. As 一个跑结构探索的人, I want 恢复运行时不要重投已经在跑的作业, so that 我不必去集群上手工清理重复作业。
7. As 一个跑结构探索的人, I want 通过追加一份预算授权文件给正在跑的轮次加预算, so that 我不会因为算错了一次预算就丢掉已经跑掉的三个小时。
8. As 一个跑结构探索的人, I want 预算面板把「已结算」和「在途预扣」分开显示, so that 我知道此刻真正还能花多少。
9. As 一个跑结构探索的人, I want 结论页直接给出本轮最好的候选、它的指标和对照组, so that 我不必自己拼 diff 与日志。
10. As 一个跑结构探索的人, I want 一个候选的「改了哪些文件」只由外层 runner 的 `git diff` 生成, so that 我不会被候选实现者自述的改动清单误导。
11. As 一个跑结构探索的人, I want 把一条候选经验提升成长期经验, so that 下一轮不必重新发现同一件事。
12. As 一个跑结构探索的人, I want 看到每个候选的验证 gate 拿到的结构化结论, so that 我能判断是门禁错了还是候选真的不行。

### 无人值守的夜班

13. As 一个让实验跑整夜的人, I want 循环在没有打开任何会话时也能推进, so that 我不必为了让它跑而保持一个聊天窗口。
14. As 一个让实验跑整夜的人, I want 宿主崩溃重启后循环自己接着跑而不是从头开始, so that 一夜的进度不会因为一次进程退出归零。
15. As 一个让实验跑整夜的人, I want 刚提交的作业在平台上暂时查不到时不被判死, so that 重启不会杀掉正在跑的训练。
16. As 一个让实验跑整夜的人, I want 需要人审批的环节一定能在超时后回落, so that 整次运行不会永久挂在一个没人看的对话框上。
17. As 一个让实验跑整夜的人, I want 预算烧到硬限时进入暂停而不是结束, so that 我第二天加钱就能继续,而不是看到一个伪造的「已完成」。
18. As 一个让实验跑整夜的人, I want 派发作业时预扣预算、完成时按实际结算, so that 剩余预算在任何一个 tick 里都是确定值。
19. As 一个让实验跑整夜的人, I want 不需要模型的 phase 一次模型调用都不产生, so that 三天的等待不是四千次无意义的推理。
20. As 一个让实验跑整夜的人, I want 外部平台返回 404 时判成「丢失」而不是无限重试, so that 卡死的候选会让位给别的候选。
21. As 一个让实验跑整夜的人, I want 未结算的在途作业在重启后仍然计入已用预算, so that 崩溃不会让预算凭空回滚。

### 第一次用它的开源用户

22. As 一个刚 clone 这个仓库的人, I want 五分钟内看到第一个真实指标, so that 我在投入任何集群资源之前就相信它能跑。
23. As 一个刚 clone 这个仓库的人, I want 不需要 GPU 就能跑通一条路径, so that 我可以在笔记本上先看懂它在做什么。
24. As 一个刚 clone 这个仓库的人, I want 默认预算不会在我看到第一条结论之前就停掉, so that 我的第一印象不是「它坏了」。
25. As 一个刚 clone 这个仓库的人, I want 一旦我配上真实训练执行器就收到「当前无 GPU 小时上限」的显眼警告, so that 默认安全不是默认沉默。
26. As 一个刚 clone 这个仓库的人, I want 不需要安装 Rust 工具链或额外的私有 CLI, so that 安装成本不成为我放弃的理由。
27. As 一个刚 clone 这个仓库的人, I want 一个能照抄修改的完整例子（结构假设、指标契约、先验）, so that 我知道要改哪几个地方才能用在我自己的模型上。
28. As 一个刚 clone 这个仓库的人, I want 指标方向、角色、结构假设分类都通过配置表达而不是通过改代码, so that 领域差异不需要 fork 内核。
29. As 一个刚 clone 这个仓库的人, I want 清楚地知道哪些依赖的许可证与 Apache-2.0 兼容, so that 我不会在不知情的情况下引入法务风险。

### 贡献者

30. As 一个想接新执行器的贡献者, I want 只实现三个方法并通过一套契约一致性测试, so that 我不必读懂状态机。
31. As 一个想支持新 artifact 类型的贡献者, I want 只加一个 validator 加一组合格/不合格 fixtures, so that 契约的权威只有一个地方。
32. As 一个改投影逻辑的贡献者, I want 用全量重建验证旧数据算出的视图仍然正确, so that 我的改动不会静默改变历史结论。
33. As 一个读测试的贡献者, I want 每个测试文件开头写清它守的是哪条契约, so that 我知道删掉它会失去什么。
34. As 一个改事件 schema 的贡献者, I want 升级不必重写历史事件, so that 老工作区在新版本下仍可打开。
35. As 一个改数据库结构的贡献者, I want 顺序 migration 加版本号, so that 我不需要猜某个工作区是哪个版本。
36. As 一个调试循环的贡献者, I want 一个 phase 的完整行为能在 tick 这一层被复现和断言, so that 我不必起真宿主、真集群、真模型。

### 写领域 skill 的人

37. As 一个领域专家, I want 只改 markdown skill 就能改变某个 phase 的策略, so that 我不需要重新打包插件。
38. As 一个领域专家, I want skill 产出的 artifact 被拒时错误信息指出缺了哪个字段或哪条绑定, so that 我能自己修好它。

### dsh 宿主与生态

39. As dsh 宿主, I want 插件在启动时挂载而不是等会话创建, so that 无人值守成立。
40. As dsh 宿主, I want 插件不新增 session 事件类型, so that 装了它之后会话仍然能被重新打开。
41. As dsh 宿主, I want 插件被卸载时 timer 与路由一起摘掉, so that 不会留下无人拥有的后台任务。
42. As dsh 用户, I want 看板不绑定任何会话, so that 我可以开两个窗口看同一个工作区,也可以关掉聊天只留看板。
43. As dsh 用户, I want 看板跟随宿主的主题, so that 它看起来是这个产品的一部分而不是一个外来页面。
44. As dsh 用户, I want 插件的薄状态（工作区指针、游标）与事实严格分开, so that 删掉插件状态不会丢实验结果。

### 审计与恢复

45. As 一个事后排查的人, I want `dump --candidate <id>` 只读地渲染出这个候选的时间线、每个 gate 的四态结论、失败原文和相关产物, so that 一个没读过代码的人也能说出它为什么被拒。
46. As 一个事后排查的人, I want 「状态推进了但事件没落」这个窗口在恢复时能被检测并重放, so that 我不必相信任何一次崩溃都恰好落在安全点上。
47. As 一个事后排查的人, I want 不可变绑定在数据库层就改不动, so that 「父是谁、验的是什么、折叠成什么」不依赖代码自觉。
48. As 一个事后排查的人, I want 事件流里的每一行都能被系统相信, so that 文件里的内容与系统的认知不会分叉。

## Implementation Decisions

### 仓库与包

- pnpm monorepo，Apache-2.0。**产品名 `dsh-reprise`**（插件包名，宿主按这个名字解析）；内部五个包在 `@dsh-reprise` scope 下。
- 六个包，依赖方向无环：`contract` 不依赖本仓库任何东西；`exec` / `memory` 只依赖 `contract`；`core` 依赖这三者；`ui` 以**相对路径**读 `core` 的 store（只读句柄）与 projection——它是同一个投影的第二个渲染器，让看板与 `dump` 不可能讲不同的故事。**这条边刻意不写进 manifest**：写了就是把 `core ↔ ui` 变成包级环，而例外存在的意义正是让看板拿不到写句柄。包与包之间的依赖仍然无环。另有 `skills/`（markdown，不打包，用户改它比改代码容易）与 `examples/feed-structure`。
- `contract` 单独成包的理由不是「给别人接」，是「自己能独立测、独立演进」：一个和 scheduler 纠缠在一起的 validator，永远分不清它守的是契约还是调度器的内部约定。
- **固定 phase 图 + 可插执行体**。不做可配置 phase 图——「任意循环」那条赛道已被 OpenEvolve / ShinkaEvolve / GEPA 占满，我们会输。可插执行体不是通用性，是运维需求：执行器要从内部 LLM CLI 换成公开 CLI，焊死一次就要改内核。
- **领域差异必须是数据，不是 `if`**：指标方向、指标角色、结构假设分类都以 metric contract 与配置表达，内核对它们一无所知。

### 宿主边界

- 插件是 dsh **host 插件**：`apply(ctx, config)`，在**宿主启动时**挂载，不等待会话创建。无人值守的前提就是这一条。
- tick 由 `ctx.interval` 驱动，随 fiber dispose 自动停。不需要 session，不烧模型。
- **取宿主服务一律声明 `export const inject = [...]`，并从自己的 ctx 访问**（宿主服务都是自己的祖先）。未声明的服务只能 `ctx.get()` 探测，属性访问会被拒（`cannot get property "timer" without inject`）；声明了但服务缺席时 apply 会被**推迟**而不是报错——所以「没跑」与「缺依赖」在日志里长得一样，需要分开观测时必须拆成两个入口。也不用 `root.get()` 探测，更不假设「提供了就同步可见」——`ctx.plugin()` 在其 promise settle 之前，那个 fiber 提供的服务一律读不到。dispose 用 `ctx.fiber.dispose()`。（实测见 `.scratch/research/cordis-fiber-settling.md`。）
- 只有需要判断的 phase 才起一轮 subagent。**不使用 `dsh-schedule` 做 tick**：它的投递等于一次完整 agent turn，分钟级 tick 跑三天 = 4,320 次模型调用。**不使用 `dsh-goal` 的 `armed`**：任何 session-start 边沿都会 disarm，重启后是「active 但 disarmed」。
- 崩溃自愈**不归插件管**：宿主常驻由 `dsh web` 保证，进程守护是外部 supervisor 一行配置的事。插件不该知道自己跑在哪个 init 系统下。
- `storageDomain` 只放**丢了必须能重建**的薄状态：工作区指针、UI 偏好、订阅游标、最近 tick 时间、mnemon source 注册信息。判停结论、预算余额、候选状态一律不许进。
- **不新增 session 事件类型**：`Session.append()` 从不写 `ignorable`，而已知事件类型是封闭集；写了自有类型会让那个 session 之后永远打不开。

### 事实面

- 事实面 = 插件拥有的**工作区目录**，介质混合。理由不是「人能 cat」（事后测绘证明没有任何脚本这么做），而是**外部消费者可读**：看板投影与运维脚本要读它。
- **进 SQLite**：`events` 追加表（身份 = 二元 `(candidate_id, local_seq)`；`wall_clock_ms` 只排序、不参与身份）、工作区状态与候选状态（KV 行，加字段不需要 migration）、不可变绑定表、作业台账、spend 账本。
- **留文件**：phase artifact（validator 的校验对象，可能被 git 带走）、先验 freeze 的 sha256 manifest、人的意图（提案 / 预算授权 / 代码基锚点 / pause marker）。
- **不可变绑定单独一张只 INSERT 的表**，`kind ∈ {parent_binding, verify_gate, fold_state}`，用 SQLite 触发器 `BEFORE UPDATE/DELETE → RAISE(ABORT)` 强制，不靠代码约定。现状是分散在四个文件里、各自有各自的失效方式；合并成一张表，是为了让「绑定链是否完整」有一个可判定的答案，而不是四次独立读取后的巧合。
- 幂等是**三态**：同身份同 payload 静默忽略；同身份异 payload 抛 conflict。**不得被 `INSERT OR IGNORE` 压成两态**——它与 validator 的 `conflict` 态同构。
- **双事务**：先写事件并提交，再推进状态并提交。恢复时比对各候选 `max(local_seq)` 与状态里的 `applied_seq`，落后则重放，对账步骤幂等。选双事务是为了保住**自证**：单事务会让「事件流能完整重建状态」从「每次崩溃都验证」降级成「没人验证」。落后是可检测的，丢掉的正确性不可检测。
- 派生视图：物化表 + seq stamp 做增量投影；全量重建保留为校验手段（亦用于开源用户改了投影逻辑后验证旧数据）。现状的「增量」路径命中缓存戳后仍全量 read+sort 且每个 tick 都被调用——新实现必须真是增量的。
- **运行配置在启动时作为事实记入工作区**（`metrics` / `stop` / `budget` / `injection`）。不记的话，指标契约与判停规则只活在 tick 的调用参数里，`dump` 与看板就没法回答「这次运行正在按什么标准判」，只能靠命令行再给一遍——两个各带各的参数读者会对同一个工作区得出不同结论。人为加预算仍走 pending 授权写进工作区，语义不变：工作区说话时它赢。
- 版本化：库用 SQLite `user_version` + 顺序 migration；**artifact 的 `schema_version` 独立演进**，不与库版本绑定（artifact 会被 git 带走、被外部工具读，库只在本机）。
- **时间戳一律毫秒**。纳秒（~1.79e18）超过 `Number.MAX_SAFE_INTEGER`，`node:sqlite` 读出直接抛 `RangeError`；Python 的任意精度整数把这条约束完全藏住了。
- **删掉** mkdir 锁、`reaper`，以及 `write_json_atomic` 在跨进程协调上的那份职责（artifact 落盘仍用它做原子写）。这三样本质是在 SQLite 已经解决的地方手写了一个更差的数据库。
- 不依赖 `eventsourcing` 库：它是 Python-only，而本仓库是 TS。照它的模型（追加 + 版本重放 + snapshot + projection）自实现。

### 相位机

- 两级：工作区 4 个 phase（INIT / BASELINE / ROUND_PLAN / FINALIZE），候选 9 个（LAND / BUILD / VERIFY / SUBMIT_QUEUED / SUBMIT / MONITOR_POLL / CAND_ANALYZE / DONE / REJECTED）。一个 tick 对每个候选最多推进一步。
- **整个候选生命周期只有 5 处调用模型**；其余全是确定性代码。前沿、目标向量、判停条件一律在代码里算，模型从不产出数字分数。
- **VERIFY 是混合 phase**：L1 静态检查与 gate 路由在内核；对抗性审查是 LLM 且**参与判决**。约束因此不是「LLM 只出咨询」，而是「gate 消费的是结构化 verdict」。
- **BUILD 仅框架模式存在**；模型模式下是 no-op，直接 advance。
- 三条性能结构**必须内建，不是优化项**：事件归并用二叉堆（现状每个 tick 把全部事件排三遍，占掉大半 tick 时间）；tick 内派生视图只折叠一次（现状三遍）；事件追加 O(1)（现状每次写入按百毫秒计）。继承现状结构会让万级事件下的 tick 退到秒级。
- **恢复口径：先对账再推进。** 启动时对每个处于 SUBMIT_QUEUED / SUBMIT / MONITOR_POLL 的候选，先去平台查真实状态再决定推进。**必须有宽限期**：刚提交的作业在平台上可能还查不到，宽限期内查不到算「未生效」而非「丢失」。
- **`pause` 是显式状态字段**（`paused` + `paused_reason` + `paused_at`），区分人工暂停（只能人工恢复）与自动暂停（条件消失后自己恢复）。废掉 `next_action_at = 9999-12-31` 这种用未来时间戳伪装状态的写法。

### 契约

- **四态** `ok` / `missing` / `conflict` / `invalid`。`conflict`（事实互相矛盾）与 `invalid`（产物不合契约）**不得合并**，恢复时处理方式不同。
- **身份绑定链** `parent_binding → verify_gate.candidate_tree → fold_state.parent_commit` 原样保留。
- **比较必须区分 `isPast` 与 `isBeyond`**：判断「某 phase 需要哪些绑定」时用严格大于，否则 phase 会要求它即将自己创建的绑定。原型的第一版因此在第一个 tick 让两个候选全 `REJECTED`——fail-closed 的方向对，结论错。
- **artifact 的字段、枚举、必填性由 validator 与 fixtures 定义**，本 spec 不复述字段级 schema；改了 validator 就等于改了契约，必须同时改 fixtures。
- 事件流里混着的三类记账行（`round_plan_harvest` / `orphan_reaped` / `ray_orphan_reaped`）现在过不了校验、读时被**静默丢弃**。新实现必须二选一：升格为正式事件类型，或移进独立的运维日志表。**不允许「写进去但读时丢掉」**——它让文件里的内容与系统相信的内容不一致。
- **不再搬的死字段**：旧实现的状态快照里有一批字段，注释声称「可热调不需重建」，但代码没有 config→state 的回写路径，事实上 init 即冻结；另有一个恒为 null 的当前轮次指针，以及几处只有声明、没有写入者的索引与并发字段。照抄会把「注释承诺」与「实际行为」的分裂一起继承。

### 注入包与记忆

- 事实 → mnemon Source → 注入包。检索、排序、预算的逻辑不自研。
- **分层**：`guardrails`（禁止方向 + 反模式）、`singletons`（全局最优 + 搜索空间）、当前前沿由内核直给——**硬配额、不排序、不裁剪**；`recipes` 与 `candidate_experiences` 交给 mnemon 的 strategy 决定 `eager` / `routed` 与预算。
- 旧实现那套相关性排序（token 计数 + 日龄衰减 + 硬预算丢弃）**整段退场**。
- **mnemon 的 auto-capture 必须关闭**：它的 idle review 会 spawn subagent 让模型自己写记忆，违反「代码持有状态写权」。写记忆只走 事件 → Source → 注入包。
- mnemon 作用域 = **workspace**（`<repo>/.mnemon`），跨工作区隔离是刻意的：共享记忆会让实验之间互相污染。将来若要跨工作区经验，做一个**显式挑选的共享 Source**，不要用切换 storageScope 这种一揽子开关。
- memory spaces（durable evidence）当前因缺少「非继承 + toolFilter + persona + depthLimit 的 subagent provider」而无法创建，未确诊。**它不是本设计的前提**：SSOT 在事实面，mnemon 只做投影。v1 不修它。
- **mnemon 的角色词表装不下一个注入包**：`default-three-tier` 只接受 working-context / narrative / durable-evidence，且同角色两个来源会直接抛错。所以注入包 Source 的角色是 `injection-packet`，profile 必须选 any-role 的 `general` 策略；而 `general` 默认对每个来源 routed，想让配方与候选经验常驻，必须在 `residentSourceKeys` 里显式列出（`source:injection-packet-*`，名字要匹配 mnemon 自己的 `source:` 键格式）。mnemon 的策略只能按来源决定 mode 与字符预算，**不能挑单条 insight**——所以「排序交给 mnemon」的准确含义是「准入与预算交给 mnemon」，条目顺序退回文件顺序。
- Source 契约（实测抄录）：`MemorySourceDefinition{manifest, create}` → `MemorySourceRuntime{facts, project, query?, mutate?}`；`project` 对应 eager 常驻，`query` 对应 routed 按需——正好对上上面那条分层。

### 展示层

- **不起 HTTP 服务**。路由挂在宿主已有的 connection 表面上（`connection.fetch.register`），随 fiber dispose 摘除。旧实现那套自起的 HTTP 服务、进程拉起与 liveness 探针整体消失。
- 看板是**独立整页、不绑会话**：tick 与会话解耦，看板是工作区的观察者，不是聊天的附件。
- 数据走增量游标，协议形状设计成可升级为流式（换传输层不改协议）。**游标不是裸整数**：事件身份是二元组 `(candidate_id, local_seq)`，后建的候选会从 1 重新开始，裸整数会静默漏掉它的头几条事实。游标是 `<wall_clock_ms>:<candidate_id>:<local_seq>`——即存储自己的 `events_by_time` 顺序，里面含 `local_seq`。
- projection 的**计算**搬成 host 侧只读模块（可测、可被 `dump` 复用），**渲染层全丢**。
- 客户端自建 React 组件，用宿主主题 token 对齐；`@changfenhuang/dsh-genui`（MIT，靠 DOM observer 塞组件）**只用于会话内汇报**，不进关键路径——官方一改渲染它会无声地坏。
- v1 **无写端点**。

### 人工介入

- **pending 文件是事实**；dsh 的 approval / user-questions 只是它的**另一个写入入口**（双写），不是唯一真相。
- 硬约束：所有交互式介入**必须可超时回落**。否则一次无人值守会永久挂在等人审批上——这正是本系统最不能出现的状态。

### 预算

- 先切术语：旧实现里的 `cost_*` 是把推理成本当**优化目标维度**与 AUC 做帕累托，**不是花销**；`budget` 才是花销闸。
- 引入 **spend 账本**，两个口径：GPU 小时 + token。**v1 只强制 GPU 小时**；token 记账但不判停（各 harness 报得不准，拿它当硬判据会因计量误差误杀）。
- **预扣式记账**：派发按上限预扣，完成按实际结算退回差额。好处是剩余预算在任何 tick 里都是确定值，判停可以真在 tick 里算；代价是看起来偏保守，所以 UI 必须分开显示**已结算**与**在途预扣**。
- **分级动作**：软限（默认 80%）只停**新派发**，在途候选跑完——那笔钱已经花了，杀掉等于把已花的钱变成零收益；硬限（100%）走 **`pause` 而不是 `FINALIZE`**——钱花完不等于实验结束。
- 删掉旧实现那两道死闸：墙钟上限 `max_runtime_hours` 并入账本（它本质就是墙钟口径的花销）；「stop gate 已关闭」那个只读不写的开关删除，由真正的 stop gate 状态取代。
- 开源默认：`max_rounds: 3`、GPU 小时不限（0 = 不强制）、token 记而不判，三者都在 UI 显示。一旦配了真实训练执行器，UI **必须**显示「当前无 GPU 小时上限」。

### 执行面

- A 端（改代码的候选实现者）与 B 端（提交 / 监控外部作业）都必须跨进程边界、走 JSON 契约。
- A 端两适配器：`claude -p --output-format stream-json`（`subtype` / `total_cost_usd` 与现有错误分类一一对应，迁移零位移）与 `dsh --profile headless --json`。进程内 subagent 没有独立 cwd，只适合纯判断 phase，不能替代 LAND 的进程隔离。
- **`git diff` 不足以说出「改了哪些文件」**：它看不见新文件，而只新增一个模块的候选正是常态。runner 的事实来源是 `git diff --name-only` 加上 `git ls-files --others --exclude-standard`，两者都相对 baseRef，且都不动 index。
- **`cwd` 必须写死成候选 worktree**。现状启动候选进程时没有设 `cwd`，「绑定 worktree」只是命令行白名单加提示词约定——这是要修的 bug，不是要继承的设计。
- worktree 与 runner 自己的 refs 命名空间由外层 runner 独占，harness 只改文件；「改了哪些文件」由 runner 的 `git diff` 独占，harness 自述只作交叉校验。
- B 端三件套 `submit / poll / collect`。`state` 除 running / succeeded / failed 外必须有 `lost`（404）与 `unknown`；`error_class` 除 oom / 代码错 / 数据错外必须有 `canceled`，且**与 failed 分离**。超时由 poller 依 `max_wall_seconds` + `max_idle_seconds` 判定后调 `cancel()`。
- `submission_id` 幂等为真：映射为 409 duplicate 就直接进 poll，不再换集群重投。
- Ray OSS 的 `JobDetails.error_type` 是 TODO、从不填充；失败分类走 `/api/v0/tasks` 的 `TaskState.error_type`，日志正则仅作兜底。
- 五分钟默认路径 = 本地执行器 + 合成输入的秒级冒烟，不碰 k8s、内部集群、内部存储。

### 原型带入的形状

以下片段来自一次性垂直原型，保留它是因为**形状本身是决策**，不是因为它是生产代码。原型已证：boot 时 apply、无会话 tick、三态幂等、触发器强制绑定不可变、预扣预算确定可读、崩溃窗口真实存在且恢复能 adopt 而非重投。

```ts
// 唯一的主接缝。store 是真 SQLite（工作区内单文件），其余全是注入的端口。
// 原型里是同步的；接上真实适配器后必须是 async —— 跨进程端口只能 await，
// 而同步只剩 spawnSync，会在整个模型运行期间阻塞宿主事件循环。
await tick({ store, clock, platform, harness, judge, config, log, crashAt }) → { actions, paused }

const CANDIDATE_PHASES = [
  'LAND', 'BUILD', 'VERIFY', 'SUBMIT_QUEUED', 'SUBMIT',
  'MONITOR_POLL', 'CAND_ANALYZE', 'DONE', 'REJECTED',
]

isPast(phase, boundary)   // a >= b —— 这个 phase 是否已经到达
isBeyond(phase, boundary) // a >  b —— 这个 phase 是否可以索要 boundary 产出的东西
```

崩溃窗口的形状（必须进常驻测试）：`platform.submit()` 之后、作业行写入之前杀掉进程 → 平台知道、我们不知道 → 重启 → **先问平台** → adopt，平台侧只有一个作业。

## Testing Decisions

**什么是好测试。** 只测接缝上的外部行为，不测实现细节。一个在业务逻辑改变时不会失败的测试是错的；一个只在某台机器上才过的测试比没有更糟。每个测试文件开头写清它守的是哪条契约（对应哪一条决策）。

**确定性是前提。** 内核不读 `Date.now()`，时间从 `clock` 端口进入；平台、候选实现者、模型判断全部是注入的端口。因此任何一条相位行为都可以在一个测试里被完整复现，不需要真宿主、真集群、真模型。

**三条接缝及其责任边界。**

1. **`tick`（主接缝，绝大多数测试住在这里）** —— 覆盖相位推进、四态 gate、身份链冻结、预算软 / 硬限、pause 与自动恢复、指数退避、恢复对账与宽限期、幂等三态、崩溃注入。不再往低，是因为 phase worker / 前沿 / 判停没有一条决策可独立观察，它们只能通过 state / binding / event 的变化体现；不再往高，是因为再高就是起真宿主加真 timer，那是集成冒烟而非行为测试。
2. **`contract` 校验器（纯函数 + fixture 矩阵）** —— 覆盖四态区分、`isPast` / `isBeyond` 边界、`schema_version`。单独成缝是因为经 `tick` 每个用例只能看到一个分支，而四态之间的区别正是唯一必须逐格钉死的东西。
3. **`dump` CLI（进程级）** —— 验收对象是命令的 stdout，不是函数返回值。它守的就是那条验收线：一个没读过代码的人能靠它说出「这个候选为什么停在 REJECTED」。

**`store` 不单列。** `tick` 的测试**始终用真 SQLite**（临时目录，毫秒级），所以三态幂等、双事务、`applied_seq` 重放都在接缝 1 里自然被覆盖，不需要一个假 store。**唯一例外**：不可变绑定的不可改写由触发器强制，「不可能发生」没有行为观察点——直接 `UPDATE` 并断言 `RAISE(ABORT)`，这是唯一一条对 store 直说的测试，且应当只有十来行。

**崩溃注入是一等测试工具。** `crashAt(point)` 抛一个 Crash 错误，测试随即关库、重开同一目录、`reconcile`、再 tick。除了 SUBMIT 那个窗口，至少还要覆盖：事件已落、状态未推进；预算已预扣、作业行未写；gate 已冻结、phase 未推进。

**fixture 政策。** 每种 artifact 都要有合格与不合格 fixtures，`conflict` 与 `invalid` 各有最小对立用例。fixtures 即契约权威——spec 故意不复述字段级 schema。

**prior art（前身仓库）。**

- 判停是纯函数加表驱动测试，这是接缝 2 的样板。
- 崩溃恢复用真 git 仓库 + 杀进程 + resume 来测，这是崩溃注入测试的样板。
- artifact 用一份 golden 目录当权威，这是 `contract` fixtures 的样板。
- **反例**：打补丁进模块内部、断言某个私有状态被调用过——那种测试描述的是实现而不是行为，新仓库一律改为注入端口。

**运行器。** `node:test`，零依赖；`pnpm test` 跑全套，不需要 dsh 宿主、不需要网络、不需要 GPU。覆盖率不作为目标。

**不放进快测套件的两条**（明确写下来，免得以后被当成已验）：真 dsh 宿主的启动冒烟（起进程、加载 bundle、timer 真 tick）——放可选的 `pnpm smoke` 加手工 checklist；客户端 DOM 渲染——v1 只测路由返回的 JSON 形状。

## Out of Scope

- **老 Python 实现的物理退场顺序与时间表。** 本 spec 只定义新仓库；旧仓库在 parity 达成前继续运行。
- **既有工作区数据的迁移**（旧实现的追加日志与状态快照 → SQLite）。v1 从空工作区开始；导入器是独立的一件事。
- **Ray 之外的第二家集群**，以及 k8s / 内部集群 / 内部存储的任何适配。
- **写端点与 `promote-experience` 的 GUI 化。** v1 的人工介入只有 pending 文件加 CLI。
- **多工作区并行 / 多租户语义。**
- **可配置 phase 图 / 广度通用。**
- **修复 mnemon memory spaces 的 provider 阻塞。** 未确诊，且不是本设计的前提。
- **AI-Scientist 家族的代码复用。** 许可证已于 2025-12 从 Apache-2.0 改为带用途限制的 Responsible-AI 派生，法务红线；只能读概念。
- **Rust 实现。** 需要 4–5 个平台的预编译包，对开源获客是净负。
- **`exec-python` 的 torch 依赖进主包。** 它始终是可选项。

## Further Notes

**两条未验假设都已有结论。**

1. ~~服务可见性按 fiber 作用域~~ —— **实测推翻**（cordis 4.0.4，见 `.scratch/research/cordis-fiber-settling.md`）。`root.get(name)` 能拿到子 fiber 提供的服务，**只要那个 fiber 已经 settle**；同步读、或 `plugin()` 的 promise 尚未 resolve 时读，得到 `undefined`。这是**时序**，不是作用域。`ctx.inject()` 倒是走祖先链，不解析后代。由此只剩三条常规写法：从自己的 ctx `inject` 宿主服务；不用 `root.get()` 探测；任何「等服务出现」的逻辑必须 await fiber settle。**mnemon 的同源假设因此不成立**——`subagents.list()` 读的是 service 实例上的 Map，与 fiber 无关；它要的 `spawn` provider 在 `dsh-base` 里正常挂载且能力项全满足。那句报错的真实原因仍然未知，out of scope 的决定不变。附带一条更硬的约束：**未在 `inject` 里声明的服务不能访问**（`ctx.interval` 会抛 `cannot get property "timer" without inject`），而声明了但缺席时 apply 被推迟而非报错——「没加载」与「缺依赖」在日志里同形。
2. **宿主启动时挂载 + 无 turn tick：已验。** Loader 在宿主启动时把 base 与 profile bundle 挂成 live entry；`@deepseek-ai/cordis-plugin-timer` 在 base 里，第三方 profile 插件能拿到它；`ctx.interval` 在真宿主里以 78 次 / 415 s、间隔 4999–5002 ms（累计漂移 ≤ 3 ms）稳定唤醒，全程没有任何 turn 在跑；宿主 Node 是 v24.21.0。**结论：B 方案的唤醒骨架成立，不需要把 tick 挪进常驻 subagent。** 要记住两个口径：`ctx.interval` 不保证毫秒精度；宿主启动会恢复既有会话记录，所以「没有 turn」不等于「没有会话」。实测见 `.scratch/issues/01-boot-and-sessionless-tick.md`。

**性能数字是回归基线，不是优化目标。** 新内核若在万级事件下 tick 超过 200 ms，说明又把全排序搬回去了。实测过的结论是：语言差距是常数倍，算法差距是数量级——换语言救不了结构。

**自研预算的分配。** 先例测绘的结论是：循环骨架已被商品化（OpenEvolve / ShinkaEvolve / GEPA，Apache-2.0 与 MIT），契约层没有先例（MLMD 最接近但仍只有 ok / invalid；`conflict` 这一态在开源里普遍被「重试 / 模型判断 / 保活推进」消化掉）。所以自研全部压在 **validator + 身份链 + phase 契约** 上，叙事只说四条差异化（phase 级 artifact 契约、四态与身份链 fail-closed、前沿与判停全在代码、真实小时级作业 + 多候选可比 + 无人值守 + 可恢复同时成立），不说「我们也有自动化实验循环」。

**词表毕业。** 早期设计里固定下来的十个词（事实 / 视图 / 注入包 / 看板投影 / 候选 / 身份绑定链 / 四态 / 判断权与写权 / 唤醒 / 薄状态）在本 spec 被接受后毕业成仓库根 `CONTEXT.md`。

**原型不是交付物。** 上面「原型带入的形状」那一节只有形状：不合并、不引用原型代码。