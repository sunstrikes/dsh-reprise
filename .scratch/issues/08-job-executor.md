# 08: 外部作业执行器 —— 提交、轮询、收集，两种实现一套契约

**What to build:** 评估真正的发生方式。作业被提交到外部执行面、被轮询、被收集回指标；失败被分类到能据以决策的粒度。两种实现（本机子进程、Ray）跑同一套契约一致性测试，所以「换执行器」是换一个包而不是改内核。

**Blocked by:** 04（相位机与端口）

**Status:** resolved

- [x] 一套契约一致性测试对两个实现全绿：提交 → 轮询 → 收集。
- [x] `state` 区分 running / succeeded / failed / **lost**（平台上 404）/ **unknown**（暂时查不到）；`error_class` 区分 oom / 代码错 / 数据错 / **canceled**，且 canceled 不与 failed 合并。
- [x] 超时由 poller 依墙钟与静默时长判定后主动调 `cancel()`，并把超时结论落成事件——不是让候选无限等。
- [x] `submission_id` 幂等：重复提交收到 409 时直接转入轮询，不换集群重投。
- [x] Ray 的失败分类取自任务状态而非 JobDetails 的 `error_type`（后者从不填充），日志正则只作兜底。
- [x] 五分钟路径的一半：本机执行器在无集群、无 GPU 的情况下跑完一次合成输入的秒级指标，返回结构化 metrics。

## 结论

`packages/exec/lib/platform*.js`（队友 exec-platform 实现，Lead 复核并接了内核）。49 条测试，其中 13 个场景在**同一套一致性断言**下分别打真本机子进程与打假 Ray dashboard。

**四件值得记住的：**

1. **一致性套件住在 `lib/` 而不是 `test/`。** 它是对外发布的契约，第三方执行器应当能 import 它自证——这比写在文档里强。
2. **`canceled` 是 error_class，不是 state。** state 只有 running/succeeded/failed/lost/unknown，poll 若返回 `stopped`/`pending` 直接在接缝处抛错。这样第三方执行器不可能发明一个状态把调用方挂死。
3. **没证据就不猜。** Ray 失败但拿不到 TaskState 证据时，`error_class` **留空**而不是归因到候选代码；本机 exit 0 但没写 metrics → `data`，不是空的指标集。
4. **假 dashboard 故意在 `JobDetails.error_type` 上撒谎**（写 OUT_OF_MEMORY，任务状态说 TASK_EXECUTION_EXCEPTION），断言拿到的是后者。这就是「不许读 JobDetails.error_type」的可执行版本。

**未验**：没有真集群。响应形状按录制/文档回放；driver 级崩溃时 TaskState.error_type 是否写入仍未验；Ray 的 metrics 依赖共享挂载，非共享目录会让每个作业都成 `data` 失败——上真集群第一件事要查这个。

