---
description: "把模型结构探索循环做成 DeepSeek Harness 插件：确定性相位、冻结基线、花费账本，以及只读取事实的判停。"
kind: "package-bundle"
---

<p align="center">
  <img src="packages/core/icon.svg" alt="dsh-reprise" width="96" height="96">
</p>

<p align="center">
  <strong>简体中文</strong> | <a href="README.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/sunstrikes/dsh-reprise/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/sunstrikes/dsh-reprise/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-263146?style=flat-square"></a>
  <img alt="status: public beta" src="https://img.shields.io/badge/status-public%20beta-7da1de?style=flat-square">
  <a href="https://github.com/sunstrikes/dsh-reprise/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/sunstrikes/dsh-reprise?style=flat-square&color=4b6fff"></a>
  <img alt="node &gt;= 22" src="https://img.shields.io/badge/node-%E2%89%A522-4b6fff?style=flat-square">
  <img alt="DeepSeek Harness bundle" src="https://img.shields.io/badge/DeepSeek%20Harness-bundle-4b6fff?style=flat-square">
</p>

<div align="center">

# dsh-reprise

**一个结论经得起复核的探索循环。**
</div>

> 一个 DeepSeek Harness 插件包：先复现一个已发表的数字，再在这份复现之上受控地迭代——确定性相位、
> 由运行自己跑出来再冻结的基线、先预扣再花费的花费账本，以及由已记录事实（而不是记忆中的意图）算出的判停。

<a id="summary"></a>
## 摘要

`dsh-reprise` 复现一个已发表的实验，然后在这份复现之上受控地迭代：确定性相位、走与候选相同的执行器路径
跑出来再冻结的基线、先预扣再花费的预算，以及由已记录事实（而不是记忆中的意图）算出的判停决定。

一个候选（candidate）是**一个结构假设，加上它落地所需的那一批代码改动**——不是一个超参数取值。循环本身是
普通代码；模型只在恰好五个位置被咨询，而它说的话只有变成一个已被校验器接受的 artifact（产物）时，
才会进入事实面（fact plane）。

挂载这个插件包只新增三个面（surface），别的什么也不加：一个在没有会话打开的工作区里推进相位机的
tick，一个在会话内读取同一份投影的 `reprise_status` 工具，以及侧边栏里的 **Reprise** 面板（背后是
六个只读 GET 路由）。它不碰你的仓库，不开端口，也不调用模型——除非你在 `model.command` 里点名一个。

如果你要的是 prompt 搜索、超参数扫描，或者一个可以手动操作的看板，就不要用它：v1 完全没有写端点，
浏览器那一半在构造上就是只读的，而且循环每轮只优化一个声明过的指标，而不是优化一批 prompt 组成的种群。

<a id="contents"></a>
## 目录

- [何时使用](#when-to-use-it)
- [安装与挂载](#install-and-mount)
- [配置](#configure-it)
- [它新增了什么](#what-it-adds)
- [五分钟路径](#the-five-minute-path)
- [检查与本地开发](#checks-and-local-development)
- [设计](#design)
- [源码地图](#source-map)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知局限与推迟的工作](#known-limitations-and-deferred-work)

-----

<a id="when-to-use-it"></a>
## 使用本包

### 何时使用

你有一个可以测两次的指标，一条你愿意冻结的基线，以及一个信念：出问题的地方是模型的*结构*，而不是它
的学习率。你希望「这个候选为什么停了？」的答案来自一个文件，而不是来自当时盯着终端的那个人。

当运行必须扛得住无人值守时，`dsh-reprise` 是合适的：相位中途崩溃会表现为事实面上一段可检测的滞后，
被暂停的预算是被记录下来的决定，页面上的每个数字都能只从事实推导出来（`dump --rebuild` 会证明这一
点）。当指标是人的判断、当基线无法做到可复现、或者当你需要一个工作区上并发跑多个运行时，它都不合适
——一个工作区只属于一次运行。

<a id="install-and-mount"></a>
### 安装与挂载

仓库是一个 pnpm workspace，包之间通过 `workspace:*` 互相依赖，所以 `packages/core` 不能单独安装。
请整仓克隆。

```sh
git clone https://github.com/sunstrikes/dsh-reprise.git
cd dsh-reprise
node scripts/link-workspace.mjs          # Node 22.5+; makes packages/* importable, idempotent
```

然后把插件包装进你的 Harness profile。用宿主自己的工具，而不是手工编辑 profile——`install_bundle`
一步完成依赖安装、链接与插件包选择，把 `target` 设成 `<clone>/packages/core` 的**绝对路径**：

```
plugin_manager { action: "install_bundle", target: "/absolute/path/to/dsh-reprise/packages/core" }
```

然后提供你自己的配置。**随包发布的 patch 里根本没有 `config` 块**：没有 `workspace` 与 `domain`
领域包就无法启动运行，而一份真实配置需要的每个路径都属于拥有这次运行的那台机器。新增一条按 id 指向 `reprise-core` 的条目，
并把整份配置重述一遍——一个匹配的 override 会**整块替换** `config`，而不是深合并。把它写进你 profile
的 `cordis.patch.yml`（或 `$DSH_HOME/cordis.patch.yml`，后者的优先级高于 profile 层）；
[`packages/core/cordis.example.yml`](packages/core/cordis.example.yml) 是下面这个形状的填好版本，连
两条各花掉一轮调试的路径规则都包含在内。

```yaml
- id: reprise-core
  name: dsh-reprise
  config:
    workspace: /absolute/path/to/my-run      # required; created facts live here
    domain: /absolute/path/to/my-domain-pack # required; 指标契约、先验、可调面白名单、五段提示词、执行器入口
    interval_ms: 5000
    candidate:
      kind: command
      command: ['node', '/absolute/path/to/apply-change.mjs', '{candidate}']
    runner: { repo: model-repo, dir: worktrees }
    model: { command: ['node', '/absolute/path/to/my-model-port.mjs'] }
    rounds: { metric: { name: auc, direction: higher }, max_rounds: 3 }
    metrics: { primary: auc, objectives: { auc: up } }
    budget: { candidate_gpu_hours: 0.5, gpu_hours_limit: 0 }
```

按任务起一次运行的操作者，其实不必改这个 patch。下面两种做法都可以，而且可以叠加——优先级是
**内联 `config` → `config_file` → 环境变量**：

- **每次运行一个文件。** 在 patch 的 `config` 里写 `config_file: /path/to/run.json`（或者让
  `DSH_REPRISE_CONFIG` 指向它，适合不写 YAML 的启动器）。这个文件在**挂载时**读取一次：它是基础
  配置，任何内联 `config` 键都会覆盖它——按 key 的浅合并。文件*内部*的 `workspace` 相对**文件自身
  所在目录**解析，所以文件可以放在它所描述的那次运行旁边；其它路径仍然遵循下方「相对宿主 cwd」的规则。
  文件缺失、不可读或不是 JSON 时，启动日志会给出一条点名的拒绝（含路径与解析错误），绝不会悄悄退回默认值。
- **一个环境变量。** 配置里没有 `workspace` 时，`DSH_REPRISE_WORKSPACE` 就是它；相对路径按宿主 cwd
  解析，绝对路径原样使用。内联的 `workspace` 仍然优先。

无论走哪条路，启动日志里的 `run:` 行都用一行回答*这个宿主到底在跑什么*：解析后的工作区（以及它来自
哪里）、候选分支自哪个仓库、工作树建在哪里、是否保留，以及配置读自哪个文件。

重启宿主（插件包清单只在启动时读取；开着 HMR 时，单独改 patch 就会立即生效）。当日志里出现 boot 那一
半的 `applied` 行、接着出现 tick 那一半的 `tick-applied`、侧边栏显示 **Reprise**、并且模型能用
`reprise_status` 时，你就挂载好了。

三种缺失会降级而不是失败，这是设计如此：没有 `timer` 服务意味着 tick 那一半被*推迟*，而不是失败
（cordis 对这两种情况的报告一模一样，这也是本包有两个入口的原因）；没有 `connection` 服务意味着没有
看板；打不开的工作区或跑不起来的配置只是一行日志，宿主照常启动。**这三种情况都不会以错误的形式出现。**

`@dsh-reprise/memory` 插件包是可选的、独立的（行 `reprise-memory`），它把注入包（injection packet）
作为一个 `dsh-mnemon` Source 暴露出来。`packages/core` 里没有任何东西 import 它。

<a id="configure-it"></a>
### 配置

所有领域特定的东西都是数据，而且都在一个**领域包**里——一个目录，它的 `domain.json` 指明自己的指标
契约、先验、可调面白名单、五段提示词和执行器入口（[`examples/feed-structure`](examples/feed-structure)
就是一个完整的包）。内核不知道任何指标名、模型仓库或提示词：它从包里读；包缺了某一部分会在启动时被
点名拒绝，而不是半配置地跑起来。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `workspace` | **必填**，或 `DSH_REPRISE_WORKSPACE` | 运行拥有的目录；事实面就是它里面的 `workspace.db`。相对路径按宿主 cwd 解析，绝对路径原样使用 |
| `config_file` | —（或 `DSH_REPRISE_CONFIG`） | 一份 JSON 运行配置文件，挂载时读一次：**基础**配置，任何内联键都覆盖它（按 key 的浅合并）。文件里的 `workspace` 相对文件所在目录解析。文件缺失或格式错误会是点名的启动拒绝 |
| `domain` | **必填** | 领域包目录；没有包就没有指标契约、没有提示词 |
| `interval_ms` | `5000` | tick 节律 |
| `executor.kind` | 取领域包 | `local`（子进程）或 `ray`（Job Submission REST） |
| `executor.command` | 取领域包，**`local` 时必填** | 一个作业的 argv，在候选的工作树（worktree）里解析 |
| `executor.base_url` | **`ray` 时必填** | Ray dashboard URL |
| `executor.root_dir` / `metrics_required` | `'jobs'` / `true` | 作业目录所在位置；没有指标的作业算失败 |
| `candidate.kind` | `'command'` | `command`、`claude` 或 `dsh`——LAND 的实现者 |
| `candidate.command` | **`command` 时必填** | argv；`{candidate}` 和 `{worktree}` 会被替换 |
| `runner.repo` / `runner.dir` | **配置 `candidate` 时必填** | 工作区里的仓库；工作树创建的位置（`<workspace>/worktrees/<candidateId>`） |
| `runner.keep` | `true` | 保留策略。为 `true` 时内核里没有任何东西会删掉候选工作树；为 `false` 本身也不会删，只是允许显式执行 `worktrees prune` |
| `runner.base_ref` | git 默认值 | 候选从中拉分支的那个 commit；代码基滚动之后以锚点为准（见 `rounds.anchor`） |
| `model.command` | **配置了 `rounds` 时必填** | 每个判断相位都通过这个 argv 触达模型 |
| `rounds.metric.name` / `.direction` | 取领域包的契约 | 轮次闸门优化的那一个指标；重述它就是让这次运行指向另一个目标 |
| `rounds.metric.contract_ref` | 契约自己的 `name` | 指向已冻结的指标契约（metric contract）的指针 |
| `rounds.max_rounds` / `.candidates_per_round` | `3` / `2` | 轮次工作流的形状 |
| `rounds.anchor` | `'automatic'` | 谁可以把代码基往前滚：`automatic` 在轮次之间按双支配规则（同时支配当前锚点与已冻结的基线）自动滚；`human` 只在 `anchor-pending/` 写一份待审批，等 `dsh-reprise intents anchor --candidate-id … --commit …`。两种模式都不动差分分母 |
| `rounds.retry.base_ms` / `.max_ms` / `.max_attempts` | `60000` / `3600000` / `3` | artifact 被拒后的退避，退到最后交给人 |
| `stop.max_rounds` | `3` | `0` 关闭这条规则 |
| `stop.max_no_improvement_rounds` / `.consecutive_empty_rounds` | `0`（关闭） | 可选启用的判停规则 |
| `stop.max_wall_hours` / `.max_windows` | `0`（关闭） | 工作区级上限：开得太久或窗口数到顶即结束整次运行——记在 `_workspace` 上，与「否掉一个候选」不是同一个结论 |
| `stop.regression_windows` / `.regression_floor` | `0`（关闭）/ `0` | 尾部 N 个窗口逐个都比基线差才杀掉候选；下限只抬高容差、从不放宽 |
| `budget.gpu_hours_limit` | `0`（不限） | 硬上限；未设上限的远程执行器每次读取都会被警告 |
| `budget.soft_ratio` / `.candidate_gpu_hours` | `0.8` / `0.5` | 到这个比例就停止派发；一次派发预扣多少 |
| `budget.max_runtime_hours` / `.judge_tokens` | `0`（不限）/ `false` | 墙钟闸门；token 只记录，从不裁决 |
| `metrics.primary` / `.objectives` | 取领域包的契约 | 在 INIT 时记录；会与轮次契约交叉核对 |
| `poll.base_ms` / `.max_ms` / `.grace_attempts` | `1000` / `60000` / `2` | 作业轮询退避 |
| `limits.max_wall_ms` / `.max_idle_ms` | `3600000` / `1800000` | 单作业的墙钟与静默期限 |

校验在 `packages/core/lib/config.js` 里，启动时只跑一次。本包不导出 `Config` 对象，所以宿主对这条
配置行没有 schema：配置有问题只是一行日志，永远不会变成启动失败。有两处拒绝值得在你撞上之前先知道——有
`rounds` 却没有 `model.command`，以及有 `candidate` 却没有 `runner`——否则替代方案就是一次在第一轮
就卡住的运行，而不是在启动时卡住。`metrics`、`stop`、`budget`、`executor` 与 `runner` 会在 INIT 时被复制进
工作区，之后只从那里读取，所以运行中途改 patch 不会改变看板报告的任何东西（`dump` 也仍然能只凭工作区
目录说出工作树去了哪里）。

**候选工作树是有意保留的。** 一个已落地（LAND）的候选，它的树在
`<workspace>/<runner.dir>/<candidateId>`——判定它时看的那份 diff *就是*那个目录里的文件——所以没有任何
阶段、恢复路径或清理例程会删掉它。`runner.keep`（默认 `true`）是契约而不是巧合；`dump --candidate <id>`
会打印路径以及它是否还在磁盘上，`worktrees list` 是整次运行的清单，而 `worktrees prune --candidate <id>`
是唯一可以删树的东西——它会拒绝尚未结束的候选、不认识的 id，以及声明了 `keep: true` 的那次运行里的每一个候选。

<a id="what-it-adds"></a>
### 它新增了什么

| 面 | 标识符 | 作用 |
|---|---|---|
| 模型工具 | `reprise_status` | 运行进度以 JSON 返回，只读，取自页面绘制所用的同一份投影 |
| 侧边栏面板 | `sidebar.panellist` id `reprise`，order `25`，外加 `main` key `reprise` | **Reprise** 按钮（zh: 复现）以及它打开的页面；文案跟随当前语言（`en`、`zh`） |
| HTTP 路由 | `GET /api/reprise/{overview,rounds,candidate,conclusion,calls,call}` | 四个视图与模型调用审计，各自通过自己的只读句柄读取 |
| 静态资源 | `GET /api/reprise/page`、`/api/reprise/dashboard.js` | 给没有客户端 slot 的宿主用的独立页面 |
| CLI | `node packages/core/lib/cli/run.js --workspace <dir> --config <file>` | 与宿主 tick 的同一套接线，由循环驱动；退出码 0 表示有结论、1 表示没有可比的指标、2 用法错误、3 超时 |
| CLI | `node packages/core/lib/cli/dump.js --candidate <id>` | 时间线、每个闸门的结论、候选工作树路径以及它是否还在磁盘上、身份绑定、前沿（frontier）位置，以及运行为什么停下来 |
| CLI | `node packages/core/lib/cli/intents.js place <kind>` / `list` | 人的意图（`proposal`、`grant`、`anchor`、`pause`、`resume`、`approval`、`experience`）写入 `<workspace>/pending/` |
| Skills | `<domain>/prompts/{land,verify,cand-analyze,round-plan,round-reflect}/SKILL.md` | 模型在五个调用点各自被告知什么；磁盘上的 markdown，属于领域包，每次调用都重新读取——**不是** DSH skills，也没有按 DSH skill 注册 |

本包不提供服务、不发事件：它消费 `timer`、`connection` 和 `tools`。所有路由都是 `GET`；没有写端点
可以去找，包括那种能让页面修改它正在报告的那次运行的端点。

<a id="the-five-minute-path"></a>
<a id="five-minute-path"></a>
## 五分钟路径

一台笔记本、一次克隆，别的什么也不要：没有 GPU，没有集群，没有模型服务商。整条路径由
`packages/core/test/five-minute-path.test.js` 在一个临时目录里跑一遍——它执行的就是本节印出的这些
命令，所以这五行是契约，不是示意。

### Step 1 — 让工作区的各个包可被导入

```
node scripts/link-workspace.mjs
```

它检查 Node 版本，为 `packages/*` 建链接使仓库根目录能 import 它们，最后真的 import 一次内核：一个
连内核都 import 不了的克隆，别的什么也做不了。不联网，不用包管理器，可重复执行。

### Step 2 — 建一个工作区

```
node examples/feed-structure/init.mjs .workspace/feed
```

一次真实的搭建，不是 fixture：它复制玩具模型仓库并提交（候选从那个 commit 拉分支），冻结一份记录
运行起点的 sha256 清单，并通过真实的本地执行器跑 `metric.mjs` 测出基线。那个数字只是旁证：运行自己在
BASELINE 相位跑一次基线（提交、等待、采集）并冻结成事实，分母与所有跟它比的东西出自同一次执行器运行。

### Step 3 — 看你拥有的领域包

```
node examples/feed-structure/inspect.mjs
```

包的清单、指标契约（方向和角色）、可调面白名单、先验与假设分类、本轮的结构假设、执行器入口，以及
接线。改动其中任何一个都是配置变更；内核对 AUC、点击，或你的模型一无所知。

### Step 4 — 跑循环

```
node packages/core/lib/cli/run.js --workspace .workspace/feed --config examples/feed-structure/config.json
```

每个相位步一行，然后是胜出者、它的指标、它打败的基线，以及结束这次运行的那条规则。这就是宿主插件
用的同一套接线——`workspace.js` 和 `tick()`——只是由循环而不是宿主的 timer 驱动，所以你刚看到的就是
插件的行为。

### Step 5 — 追问原因

```
node packages/core/lib/cli/dump.js --candidate r1-h2 --workspace .workspace/feed
```

时间线、每个闸门的结论、身份绑定、前沿位置，以及运行为什么停下来——只从事实面得到。`r1-h2` 是随包
示例产出的胜出者；用第 4 步印出的那个。不需要 `--config`：运行在 INIT 时把指标契约和判停规则写进
工作区，所以只有一个目录的读者会得到同样的答案。加上 `--rebuild` 可以重放整个事件流，检查物化视图
是否仍然能从事实推出来。

示例没有覆盖的：活的模型（`recorded/judgement.json` 重放四个回答）和真实的编码 harness
（`apply-change.mjs` 机械地应用假设）。两者都是配置——`model.command` 和 `candidate.command`。
[`examples/feed-structure/README.md`](examples/feed-structure/README.md) 说了要改什么、以及什么仍未
验证。

<a id="checks-and-local-development"></a>
## 检查与本地开发

```sh
npm test         # scripts/check.mjs, then the full suite
npm run check    # manifests, export targets, and a parse of every module under lib/
```

`scripts/check.mjs` 覆盖套件看不见的东西：不存在的导出目标、指向宿主无法 import 的 TypeScript 的
导出、没有任何东西 import 的已声明依赖、没有声明来源的 import，以及没有测试恰好加载到的模块。

这些包从宿主 profile 解析 cordis，而不是再装一份，所以请链接 profile 的模块树，而不要跑
`pnpm install`：

```sh
ln -s ~/.dsh/profiles/node_modules node_modules
```

`packages/core/test/host-plugin.test.js` 里有五个测试驱动 cordis 的真实生命周期。cordis 是插件宿主
（MIT，随 Harness profile 发布），不是本仓库的依赖，所以在没有它的机器上，这五个测试把自己报告为
**跳过**，而不是加载失败。每个克隆接线一次 pre-commit hook：`git config core.hooksPath .githooks`。

这里的任何东西都不允许被宿主当作 TypeScript import：每个插件包都暴露 `main: lib/*.js`，随包发布的
代码是纯 ESM，没有构建步骤。

-----

<a id="design"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 设计

- **要有两个入口，是因为依赖缺失只会推迟一个插件，而不会让它失败。** `boot.js` 什么都不声明，只做报告；
  `tick.js` 声明 `inject: ['timer']` 并 tick；`dashboard.js` 声明 `inject: ['connection']`。如果合并成
  一个插件，「包从未加载」和「timer 从未出现」会产生同一份空日志。
- **事实先于状态，永远如此。** 一条事实是由 `(candidate_id, local_seq)` 标识的追加行，在它所支撑的
  状态*之前*、在自己的事务里写入，所以崩溃留下的是可检测的滞后，而不是静默的偏差。用相同 payload
  重放一条事实是 `duplicate`；同一身份、不同 payload 是 `conflict`，会被拒绝。
- **视图要么可推导，要么就是错的。** 前沿、轮次历史和看板的四个页面全部由事实算出。
  `dump --rebuild` 拒绝认可一个不再能从事实推出的视图。
- **模型只有五个调用点，没有别的。** `land`、`verify`、`cand_analyze`、`round_plan`、
  `round_reflect`。每次调用是一个独立进程，prompt 由一份 markdown skill 加上作为 JSON 的事实渲染而
  成；回答的形状写在代码里、紧挨着它的解析器，所以 markdown 里的示例不会漂移到与判定器（judge）
  所接受的内容不一致。
- **只读是结构性的，不是一句承诺。** 每次读取都打开自己的 `readOnly` SQLite 句柄并关掉：工具在物理
  上无法记录事实，两个浏览器窗口无法互相干扰，页面在所有会话都关掉时也能用——它只需要工作区目录，
  别的都不要。
- **先预扣，再结算。** 一次派发在作业开始前预扣 `budget.candidate_gpu_hours`，之后按实测成本结算，
  所以作业中途崩溃会被计费而不是被遗忘。token 只记录、从不裁决，因为各家 harness 上报 token 的口径
  差得太多，不能当作闸门。
- **把危险的默认值说出来。** 未设上限的远程执行器是合法的、是随包默认值，并且每次读取都会被警告
  ——启动日志、`run` 的横幅，以及 `overview().warnings`，两个客户端都会画出来。

<a id="source-map"></a>
### 源码地图

| 路径 | 角色 |
|---|---|
| `packages/contract` | 四态校验、身份绑定链、artifact schema、指标契约 |
| `packages/core` | 相位机、tick、事实存储、派生视图、判停策略、插件接线、CLI |
| `packages/exec` | 候选实现者与外部作业适配器（local、ray、claude、dsh），带一致性套件 |
| `packages/memory` | 注入包，以 `dsh-mnemon` Source 暴露 |
| `packages/ui` | 只读看板：宿主侧对路由的投影，加一个纯 ESM 客户端 |
| `packages/exec-python` | 可选的代理指标桥（需要 torch）——只有 manifest，还没有代码 |
| `examples/feed-structure` | 一个完整的领域包，也是一个走通的场景：`domain.json` 加上指标契约、先验、可调面白名单、五段提示词、执行器入口、结构假设与本地指标 |

依赖方向按包名无环：`contract` 不依赖这里的任何东西；`exec` 和 `memory` 依赖 `contract`；`core`
依赖这三者。有一处刻意的例外：`ui` 用相对路径读 `core` 的 store 与 projection 模块，因为看板必须
无法对事实面打开*写*句柄，而对只读读取器的相对 import 恰好就把这句话写在了代码里。

</details>

<a id="further-exploration"></a>
## 进一步阅读

- [`CONTEXT.md`](CONTEXT.md) — 代码依赖的十个词，以及它假定的精确含义
- [`docs/extending.md`](docs/extending.md) — 加一个执行器；加一种 artifact 类型
- [`docs/license-audit.md`](docs/license-audit.md) — 每个依赖和借鉴的想法，对照 Apache-2.0
- [`docs/adr/0001-acceptance-is-a-reproduced-public-experiment.md`](docs/adr/0001-acceptance-is-a-reproduced-public-experiment.md) — 对这个项目而言「完成」意味着什么
- [`examples/feed-structure/README.md`](examples/feed-structure/README.md) — 那个走通的场景的细节
- [`CODING_STANDARDS.md`](CODING_STANDARDS.md) — 这里怎么审一个 diff

<a id="model-experience"></a>
## 模型体验

#### 模型看到什么

两条路，都是只读，都不在关键路径上。

`reprise_status` 是本包唯一注册的工具。它的输入是 `candidate`（一个可选 id，用来看那个候选的页面而
不是总览）和 `events`（0–20，默认 6）。它的回答就是 HTTP 路由所服务的那个信封——`view`、
`workspace`、`cursor`、`data`、一个 `incremental.events` 列表——裁到六条事实和十个前沿成员；当工作
区里还没有事实时，它用 `data: null` 加一个原因说明这件事，而不是失败。拒绝会带 `ok: false` 和
`reason`。整条事实流永远不会成为一个工具结果。

在循环内部，模型是一个子进程：在五个调用点的每一个，它读领域包里的一份 `SKILL.md` 加上 JSON 事实
（候选身份、L1 检查结果、监视器上报的指标），并以判定器能解析的 wire format 作答。它永远拿不到事实
面、会话，或另一个候选的结果。

#### Token 影响

很小而且有界。一次状态回答是一页投影，裁到六条事件和十个前沿成员；工具是在有人问运行进展时被调用，
不是每轮都调。五次判断调用各带一份 markdown 提示词（领域包的 `prompts/` 一共 246 行）加 JSON，而且
每次都是新进程，所以一次运行里不会有东西累积。

#### KV Cache 影响

会话内没有：这次工具调用落在正常的工具调用序列里，不新增 system 前缀。判断调用之间也没有——它们是
按调用点分别启动的独立进程，没有共享前缀可缓存，也没有缓存需要失效。插件里没有任何东西会改写
system prompt。

<a id="known-limitations-and-deferred-work"></a>
## 已知局限与推迟的工作

这些局限定义了它何时不合适——它们不是一份任务清单。

- **只在离线环境验证过。** 相位机、校验器、身份链、事实面、账本、前沿、判停规则、执行器与 harness
  端口、`dump`，以及那五条命令组成的路径，全都在 `npm test` 里跑。未在这里端到端验证的：活的模型、真实的
  编码 harness、真实集群，以及浏览器真正对着一个真实宿主加载页面。
- **不在 npm 上。** 每个包都是 `private`，版本 `0.0.0`，通过 `workspace:*` 依赖它的兄弟包。请分享
  仓库并链接 profile；目前没有可发布的产物。
- **随包发布的 bundle patch 故意不带配置。** 包无法知道你的工作区在哪，所以它只发这一行、别的什么
  也不发；你 profile patch 里的 `reprise-core` 条目提供其余全部，而 patch 旁边的
  `cordis.example.yml` 是一份填好的完整示例。没有配置的运行只是一行日志，不是一次挂载。
- **宿主侧没有配置 schema。** 包不导出 `Config`，所以 Plugin Manager 无法渲染或校验这一行；
  `config.js` 是唯一的校验器，它的结论是一行日志。
- **没有写入口。** 暂停、恢复、授权和审批以 `<workspace>/pending/` 下的文件形式到达（`intents.js`），
  不是 HTTP 调用。
- **一个工作区，一次运行。** 一个目录里两次运行不是受支持的配置；两个工作区是两个独立的看板。
- **`packages/exec-python` 只是一个 manifest。** 没有代码，没有 import `torch`；代理指标桥被推迟。

### Dev Note

<details>
<summary>非权威的维护者说明——点击展开</summary>

本仓库是六个包的 pnpm workspace，在 Node 24 上测试（Node 22 能跑但会警告，因为那里的 `node:sqlite`
还是实验性的）。`npm test` 就是全部闸门；pre-commit hook 跑的正是它，只是剥掉了 git 的环境变量，因为
测试会创建自己的临时仓库，而继承来的 `GIT_DIR` 会把它们指向本仓库。

值得在评审时不要重新发明的独特机制：相位级的 artifact 契约、四态结论词汇（`ok` / `conflict` /
`missing` / `invalid`）、身份绑定链，以及写成代码而不是策略配置的前沿与判停规则。一个决定的权威链
就是代码；代码是「什么被接受、什么被拒绝」的记录。

代码注释里还会出现 `spec: 相位机`、`issue 06` 这样的引用。那是这套代码成长过程中形成的简写，指的是
作者留在仓库之外的设计记录。这类注释里的每一条论断都自成一句——读那句话，不必读它的引用。

</details>

<a id="license"></a>
## 许可证

Apache-2.0 — 见 [LICENSE](LICENSE)。