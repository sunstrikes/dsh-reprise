# 06: 前沿、判停，与 `dump` 的可读性验收

**What to build:** 对「哪条更好」「要不要停」这两个问题给出 100% 由代码算出的答案（模型不参与任何数值判断），并把判停理由落成可查的事实。同时把 `dump` 补到能通过那条验收线：一个没读过代码的人，只靠它就能说出一个候选为什么停在这里。

**Blocked by:** 04（相位机与 tick）

**Status:** resolved

- [x] 前沿与目标向量由代码算出；有断言证明模型的输出不进入任何数值计算路径（不是「模型不给分」，而是「给了也不采纳」）。
- [x] 判停规则命中 → 工作区进 FINALIZE，并落一条可查的判停理由与命中的规则。
- [x] 增量投影与全量重建对同一批事实给出相同视图；全量重建可作为一个校验命令单独跑。
- [x] `dump --candidate <id>` 的验收线：**一个没读过代码的人，只看输出就能说出这个候选为什么停在 REJECTED。** 形态是时间线 → 每个 gate 的四态结论 → 失败点原文 → 相关产物。
- [x] 投影逻辑改动后，用全量重建验证旧数据算出来的视图仍然正确（这条同时是给开源贡献者的回滚手段）。

## 结论

`packages/core`，121/121 通过（本票新增 52 条：前沿 15、判停 13、投影 9、dump 视图 10、模型数字 5；其余为 12 并入后的整体回归）。四个文件分工明确，没有一处把领域知识写进内核：

- `frontier.js`：唯一的**数值**入口。指标值只来自 `metrics_collected`（内核从 `platform.poll()` 写出），方向只来自 metric contract（`config.metrics`），比较与帕累托前沿全在代码里。视图按候选物化到 `candidate_state` 的一条 KV 行（`derived_frontier`，带 `max(local_seq)` 戳），所以一个 tick 只为「有新事件的那条候选」折叠一次；`rebuildFrontier` 忽略物化行、整条事件流重算，供校验与回滚。
- `stop.js`：三条规则 `max_rounds`(默认 3) / `max_no_improvement_rounds` / `consecutive_empty_rounds`，按声明顺序取第一条命中，只记一条理由；命中后先写 `workspace_stopped` 事件、再把工作区推进 FINALIZE。
- `projection.js`：`overview` / `rounds` / `candidateDetail` / `conclusion`，全部只读（`frontier(..., {persist:false})`），`dump` 与将来的看板读同一份数据。
- `dump`：新增 `frontier position` 与 `workspace stop` 两节、`--config`、`--rebuild`（不一致退 1）。渲染层全量改成消费 `projection`，输出逐字保持，原 6 条 dump 验收测试未改一行仍全绿。

### 票面没定、我定了的五件事

1. **判停要等「没有在飞的候选」。** 三条规则都先过这一道闸。杀掉在跑的作业不能把已花的钱退回来，所以 FINALIZE 必须等活干完——这也让「工作区级、先于候选」的次序变成一条可观察的性质：已经 FINALIZE 的工作区**吸收**掉之后创建的任何候选（有专门用例）。
2. **规则优先级 = 声明顺序，只记一条。** 两条规则同时具备条件时，记录必须是可复现的一条理由，而不是一次投票。
3. **`DERIVED_VERSION` 是投影逻辑改动的失效机制。** 物化行的戳只证明「看的是同一批事实」，不证明「读法没变」；改了读法而不升版本，旧行会带着匹配的戳永远服务旧答案。升常量即失效，`dump --rebuild` 是发现不一致的检查（两者各有一条用例证明能失败）。
4. **平手不给新的最好。** 主目标相同时按 round 再按 id 让在位者。否则「没有改进」永远观察不到——重复一次最好成绩不算收益。
5. **「空轮」= 完成但没有可比结果的轮**（没有候选得到完整目标向量），不是「没有候选的轮」：当前没有任何事件记录「计划了但没产出候选」的轮。若 10 的 planner 写出 `round_planned`，空轮的可见性应该由它提供。

### 与票面/规格不符或需要后续接的一处

**`dump` 的零参数前提不成立。** metric contract 与判停配置只在 `tick` 的 `config` 里，内核没有写进工作区；而 `dump` 只有工作区目录。所以：

- 已判停的运行可以自证——`workspace_stopped` 事件的 payload 里带着当时的规则状态、best、limit/observed；
- 未判停的运行要靠 `--config <file>`，否则 frontier 一节诚实地说「not computed — no metric contract configured」，而不会猜一个方向。

真正该做的是**运行开始时把 `config.metrics` / `config.stop` 记进工作区状态**（测试里用 `seedConfig` 模拟）。这是 config→workspace 的接线，属于 10/11 的范围，本票不越界。次要的：`packages/core/package.json` 的 `exports` 还没有 `./frontier` / `./stop` / `./projection`，包外暂时只能按路径 import（本票不许改 package.json）。

### 未验的

- 没有真宿主：判停只在假端口下测过，「插件 + timer 真 tick」属于 `pnpm smoke`。
- 没有压测：证明了「命中缓存时不读一条事件」「只有新候选的事件流被折叠」，没有测 10k 事件下的 tick 耗时。
- `--config` 的坏 JSON 返回 exit 2，实现了但没有用例覆盖。
- 看板（11）尚不存在，投影只按形状与只读性验证，没有真实页面。