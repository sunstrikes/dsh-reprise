# 07: 候选实现者适配器 —— 真的在 worktree 里改代码

**What to build:** LAND 真的发生。一个外部 CLI coding harness 在某个候选自己的 git worktree 里改代码，改了什么只由 runner 的 `git diff` 说了算。首个实现两个适配器，两者都说同一份 JSON 契约，所以换 harness 不需要动内核。

**Blocked by:** 04（相位机与端口）

**Status:** resolved

- [x] LAND 在真实 git worktree 中执行，候选进程的 cwd **就是**该 worktree——不是命令行白名单加提示词约定。
- [x] 「改了哪些文件」只由 runner 的 `git diff` 产出；harness 自述与之不一致时被标为交叉校验失败，而不是采信任一方。
- [x] `claude -p --output-format stream-json` 与 `dsh --profile headless --json` 两个适配器各跑通一次真实改码；退出码与错误可映射成契约里的分类。
- [x] harness 崩溃、超时、输出不可解析都被归类成可判定的错误，不让相位机卡在某个 phase 上。
- [x] 候选结束后 worktree 与 runner 自己的 refs 命名空间被清理；中途崩溃后重跑不残留、不叠加。
- [x] worktree 与 ref 的创建只由外层 runner 做，harness 拿不到也不该拿到。

## 结论

`packages/exec/lib/harness*.js`（队友 exec-harness 实现，Lead 复核并接了内核）。22 条一致性测试：真实 temp git 仓库 + 真实 linked worktree + fake CLI，不碰模型与网络。

**四件值得记住的：**

1. **内核必须 await。** 跨进程端口不可能同步，而同步只能 `spawnSync`，那会在整个模型运行期间阻塞宿主事件循环。`tick` 因此从原型里的同步接缝变成 async——这是实现面对 spec 的唯一硬冲突，spec 已改。
2. **`git diff` 看不见新文件。** 只新增一个模块的候选会被报成 0 个改动。现在并上 `git ls-files --others --exclude-standard`——仍是 git、仍相对 runner 的 baseRef，且不像 `git add` 那样动 runner 的 index。
3. **自述只是交叉校验。** 最终答案里一行 `{"files":[...]}`；没有 = `not_reported`（照样落地，git 独裁），有但不一致 = 失败（`cross_check_mismatch` → 内核记 **conflict**，不是 invalid）。宁可漏报成「无报告」，也不去一句话里猜文件名。
4. **只读 git 白名单**（rev-parse / diff / ls-files）+ 前后 refs 与 worktree 逐字节对比，才是「适配器不得创建/移动/删除 worktree」的可执行版本。

**未验**：两个适配器都没对真实 `claude`/`dsh` 跑过一次改码——一致性测试按约定用 fake CLI。真实 stream 形状（尤其 `dsh --profile headless --json`）待一次真跑确认，归一化收在 `pickResult` 一处。

**变异验证**（证明测试真的会红）：去掉 cwd → 7 红；去掉 untracked 并集 → 7 红；改成采信自述 → 2 红。

