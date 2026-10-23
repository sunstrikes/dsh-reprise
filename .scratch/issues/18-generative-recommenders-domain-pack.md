# 18: generative-recommenders 领域内容

**What to build:** 让自动机制在 [generative-recommenders](https://github.com/meta-recsys/generative-recommenders) 上能提出像样的结构假设——靠的是指标契约、先验、可调面白名单和五段提示词，不是靠模型自由发挥。

**Blocked by:** 17

**Status:** ready-for-agent

- [ ] 指标契约：HR@k 与 NDCG@k 的主次与方向写清楚，最小有效幅度有具体数值。
- [ ] 可调面白名单：列出允许改的 gin 键与源码符号；越界改动在门禁二被拒。
- [ ] 先验：结构假设分类、禁止方向、已知反模式（从论文与 README 提炼，标注出处）。
- [ ] 五段提示词（LAND / VERIFY / CAND_ANALYZE / ROUND_PLAN / ROUND_REFLECT）针对这个仓库重写，写清「改动必须落成 diff」的出口约定。
- [ ] 有人过一遍内容（先验与白名单由人审）。