# 09: 模型判断的五个入口、skill 包与 VERIFY 混合门禁

**What to build:** 模型真正参与的那五处。每处的出口都是一份 artifact，被 validator 接受才可能推进状态；VERIFY 的对抗性审查以结构化 verdict 进入门禁判决，而不是一段自然语言意见。策略写在 markdown skill 里，改策略不需要重新打包。

**Blocked by:** 04（相位机与端口）

**Status:** resolved

- [x] 五个调用点（LAND、VERIFY 的对抗性审查、CAND_ANALYZE、ROUND_PLAN、ROUND_REFLECT）各有出口 artifact；未通过 validator 时相位不推进，且 `dump` 能指出缺哪个字段或哪条绑定。
- [x] VERIFY 是混合相位：L1 静态检查与门禁路由在内核，对抗性审查是模型且参与判决。有一条用例证明「审查判否 → 候选不前进」。
- [x] 其余相位一次模型调用都不产生：确定性相位下断言调用计数为 0。
- [x] 模型给出的任何数值（分数、排名、阈值）不进入前沿或判停计算。
- [x] skill 是 markdown，改内容不需要重新打包或改代码；有一个「换一份 skill 就换掉某相位策略」的演示。
- [x] 审查与根因分析的结果必须能落成可比较的结构化字段，不是自由文本——否则门禁无法消费它。

## 结论

五个模型入口、轮次相位、skill 包与两条新 artifact kind（`round_reflect` / `land_hypothesis`，经 contract 的公开 `defineArtifact` 注册）。核心套件 131 条，全仓库 275 条时绿。

**实现时暴露的 spec 缺陷（已修在集成分支上）：** `createCandidate` 只把假设写进事件、没写进相位状态，于是 LAND 交给真实适配器的 `hypothesis` 是 `undefined`（真实适配器会抛），VERIFY 也看不到它；票 12 的提案候选因此会在门禁处被判 conflict。修复：创建时写入相位状态，折叠时一并恢复；被拒的 gate 现在还会留下审查者的 rationale 与被检查项名字，而不只是「失败了」。

**未验**：没有真模型；`model.command` 端口在 laptop 上回放的是录制答案（13 号票）。
