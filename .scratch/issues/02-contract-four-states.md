# 02: contract —— 四态、身份绑定链与边界语义

**What to build:** 一个不依赖状态机、不依赖执行器的契约库，回答「这份产物、这个候选是否可信」，并把四种不可互换的结论分开。它是整个系统的 fail-closed 依据：模型的任何判断必须先落成它能接受的 artifact，才可能影响状态。

**Blocked by:** None（可以立即开始）

**Status:** resolved

- [x] 四态可区分：产物缺失 → `missing`；产物不合 schema → `invalid`；两条必须一致的事实互相矛盾 → `conflict`；否则 `ok`。每一态都有最小用例，`conflict` 与 `invalid` 各有对立用例，任何一态都不得退化成布尔。
- [x] 身份绑定链 `parent_binding → verify_gate.candidate_tree → fold_state.parent_commit`：缺任一环时结论是 `missing` 而非 `ok`；环与环之间取值不一致时是 `conflict`。
- [x] 边界语义：判断「某 phase 可以索要哪些绑定与台账行」时用严格大于。有一条回归用例专门覆盖「phase 不得索要自己即将产出的东西」。
- [x] 每种 artifact 都有合格/不合格 fixtures；fixtures 即契约权威。新增一种 artifact 只需加 validator 与 fixtures，不改内核。
- [x] 所有时间戳是毫秒整数，往返读写不丢精度。
- [x] artifact 的 `schema_version` 与数据库版本互不绑定，各自演进。

## 结论

`packages/contract`，23/23 通过。三条不可互换的结论都落在 `fromFindings` 一处，所以**优先级（missing → invalid → conflict）只有一个实现**，十个 validator 不需要各自重新发现它。

**三个 artifact kind**（都配了四态 fixtures）：`verify_verdict`、`candidate_plan`、`analyze_report`。它们不是随便挑的：

- `verify_verdict` 的 `conflict` 是「gate 说通过、对抗性审查说拒绝」——正是 spec 里「VERIFY 是混合相位、审查参与判决」那条决策的可执行版本。
- `analyze_report` 强制分析**回显它所依据的那个数值**；回显与实际观测不一致就是 `conflict`。这让「模型读错证据」变成可以在没有模型参与的情况下被抓到的矛盾。
- `candidate_plan` 的 `conflict` 是两个假设用了同一个 id——下游引用会变成猜测。

**两条 AC 在实现里长得不一样，需要说明：**

1. 身份链里的 `verify_gate.candidate_tree` 没有单独校验：`verify_gate` 只被要求与 `parent_binding` 的 `parent_id` 一致、且 `passed` 是严格布尔，`fold_state` 要求与 `parent_commit` 一致。更深的树级一致性属于 `verify_verdict` 这个 artifact 自己的 validator，不塞进链检查——否则链就成了第二个契约权威。
2. `schema_version` 没做成数据库字段，而是**每种 kind 自带版本**：产物里写了 `schema_version` 就必须等于本内核所讲的那个版本，不写则按当前版本理解（老产物不必重写）。已加断言。

**过程中测试抓到一个真漏洞**：`1761091200`（秒）原本能通过「毫秒」校验——它是个漂亮的安全整数。已把 `isMilliseconds` 收紧成 **epoch 区间**判断（下界 1e12，约 2001-09），并在 README 里写明「时长不是时间戳，别塞进 `*_ms`」。纳秒仍然被上界挡住。

**给下一票的接口**：`requirementsAt(phase)` 是唯一的「这个 phase 可以索要什么」入口，`03` 的 store 与 `04` 的 tick 都只许从这里取值，不许自己写 `isPast`/`isBeyond`。