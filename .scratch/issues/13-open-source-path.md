# 13: 开源就绪 —— 五分钟路径与可照抄的例子

**What to build:** 一个陌生人 clone 之后能跑出结果。照 README 五步，在没有集群、没有 GPU 的机器上看到第一个真实指标；领域差异全在配置与 markdown 里；一旦配了真执行器，界面显式警告「当前无 GPU 小时上限」。这不是收尾美化——这是唯一一张会被外部人跑到的票。

**Blocked by:** 08（本机执行器与五分钟路径的一半）、09（skill 包与模型入口）

**Status:** resolved

- [x] 照 README 五步，在无集群、无 GPU 的机器上跑出第一个真实指标；步骤数与依赖在文档里写死，不需要读源码。
- [x] `examples/feed-structure` 提供可照抄的指标契约、先验与结构假设分类；改指标方向、角色、假设分类只改配置，不改代码。
- [x] 配置了真实训练执行器时，界面显示「当前无 GPU 小时上限」的显式警告——默认安全，但默认不沉默。
- [x] `CONTEXT.md` 从词表毕业：事实 / 视图 / 注入包 / 看板投影 / 候选 / 身份绑定链 / 四态 / 判断权与写权 / 唤醒 / 薄状态。
- [x] 许可证审计通过：所有依赖与借鉴来源与 Apache-2.0 兼容；AI-Scientist 家族只留概念不留代码。
- [x] 有一页扩展点文档：怎样加执行器（实现三件套 + 过一致性测试）、怎样加 artifact 类型（validator + fixtures）。各不超过一页。

## 结论

宿主接线（boot 无依赖 / tick 注入 timer / dashboard 注入 connection，三个入口分开，headless 宿主丢掉看板而不是丢掉循环）、`examples/feed-structure`、README 五步、`CONTEXT.md` 十个词、`docs/extending.md`、`docs/license-audit.md`。**五步路径由测试逐条执行**，并在一个没有装 DeepSeek Harness 的裸 clone 上手工跑过：init 用本地执行器量到 baseline `auc=0.706981`，循环到 `best r1-h2 auc=0.729697`，`dump` 与 `dump --rebuild` 一致。

**领域差异确实是数据**：只改配置里 `metrics.objectives.auc=down`，赢家从 h2 变成 h1、结论词从 improved 变成 regressed，代码零改动。

**未验 / 留给后来者**：看板客户端还没把 `warnings[]` 画出来（数据已在 payload 里，测试钉住了）；模型与编码 harness 仍是录制回放；裸 clone 上 5 条宿主生命周期测试因没有 cordis 而跳过。
