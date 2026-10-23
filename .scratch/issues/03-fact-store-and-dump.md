# 03: 事实面 —— 工作区 SQLite 与 `dump`

**What to build:** 工作区目录里的事实面。追加事件流、工作区与候选状态、不可变绑定、作业台账、spend 账本住进目录内的一个 SQLite 文件；人靠一个只读的 `dump` 命令看它。它替换掉 mkdir 锁、`reaper` 与三套手写的原子写协调。

**Blocked by:** 02（四态与身份链的词汇、毫秒时间戳、幂等的三态语义）

**Status:** resolved

- [x] 同一身份同 payload 再写一次返回 duplicate 且状态不变；同身份异 payload 返回 conflict 且不写入。两者不得被压成「静默忽略」或一个布尔。
- [x] 绑定表只 INSERT：直接 `UPDATE` / `DELETE` 被数据库拒绝（由触发器强制，不靠代码习惯）。
- [x] 先写事件、后写状态的两个事务：在两者之间硬杀进程，重开后能看出状态落后于事件（`applied_seq` 对不上），重放到头且重放幂等。
- [x] `dump --candidate <id>` 打出可读时间线（时间 / 类型 / 一句话摘要），只读，不需要写权限。
- [x] 库用 `user_version` + 顺序 migration；空目录可一键初始化成可用的工作区。
- [x] 不存在「写进去了但读不出来」的行：要么写入即校验，要么进独立的运维日志表，不允许现状那种「读时静默丢弃」。

## 结论

`packages/core/lib/store.js` + `lib/cli/dump.js`。全套 42/42。**六个表**：`events` / `candidate_state` / `workspace_state` / `candidate_bindings` / `jobs` / `ledger`，外加一张 `ops_log`。

### 票面没定、我定了的四件事

1. **冲突返回状态，不抛异常。** `appendEvent` 返回 `inserted | duplicate | conflict`，因为「重放同一个事件」是日常（崩溃恢复、重试）而「同一身份写出不同 payload」是事故——但**该不该因此杀掉候选，是内核的判断，不是存储的判断**。存储只保证不覆盖。
2. **三类记账行进 `ops_log` 独立表。** 票 11 给了二选一，我选了「移出事件流」。理由：`round_plan_harvest` / `orphan_reaped` 过不了 `validate_event`，把它们升格成正式事件会让事件流里出现一批不影响任何状态的行，重放时还得跳过它们——那就是现状「写进去、读时丢掉」换了个位置。
3. **`jobs.submission_id` 上建唯一索引。** `submission_id` 幂等是契约保证的事实，不是调用方的自觉；重复提交在数据库层就撞墙，而不是靠 `jobBySubmission` 的调用者先查一遍。
4. **`dump` 只读打开，且验证过它与写者可以并存。** WAL 下实测：写者持有时另开 read-only 句柄能读到最新已提交事实。这条不验就会变成「dump 只在宿主关掉后能用」——那正好与它存在的理由相反。

### 测试抓到的一个真 bug

第一版 `dump` 取「最后一个带 blocking 信息的行」作为停机原因。但正常时序是 **判定事件在前、终止事件在后**，于是它每次都取到那句 terse 的 `reject_reason`，把四态结论整段丢了——恰恰是验收线要的那一段。

改成两个检索：**判定**（带四态 `status` 的行）与**终止**（带 `reject_reason`/`blocking_message` 的行）分开取，各占一行。现在输出是「status=conflict + 一句人话解释 + 终止原因 + 证据路径」。这个错误很值得记：把「最后一件事」当成「原因」，在事件流里几乎总是错的。

### 与下游的接口

- `requirementsAt(phase)`（来自 02）是唯一「这个 phase 能索要什么」的入口。
- `appliedSeq` / `eventsAfter` 是重放的全部所需；`maxSeq > appliedSeq` 就是崩溃窗口的判据。
- 派生视图（物化表 + 增量投影）**不在这张票里**——归 06。

### 示例输出

```
why it stopped
  at phase   VERIFY
  status     conflict
  message    passed is true while the adversarial review rejected the candidate
  terminal   reason verify gate conflict
  recorded   2026-10-22T08:01:30.000Z (event 3 gate_result)
  terminal   2026-10-22T08:01:31.000Z (event 4 candidate_rejected)
  from       artifacts/cand-7/verify_verdict.json
```