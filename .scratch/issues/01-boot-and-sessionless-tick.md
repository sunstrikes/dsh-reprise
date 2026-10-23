# 01: 宿主 boot 时挂载 + 无会话 tick 探针

**What to build:** 一个最小插件，作为 profile bundle 装进宿主，证明两件事：它在**宿主启动时**被 apply，以及它在**没有 turn 在跑**的情况下被 `ctx.interval` 定时唤醒。同时给出裸 cordis 下的等价断言作为对照组。这一票结掉 spec 里最后一个未验假设——第三方 profile 插件能否在真宿主里拿到 `timer` 并真的被 tick。

**Blocked by:** None（可以立即开始）

**Status:** resolved

- [x] 裸 cordis 下：插件 apply 后不需要任何会话，`ctx.interval` 至少触发若干次；该断言进测试套件。
- [x] 装进 desktop profile 的 bundles 并重启宿主后，在没有任何 turn 在跑的情况下，`~/.dsh/reprise-probe.log` 里出现 apply 记录与连续心跳，时间戳可查。
- [x] 记录 interval 的实际周期与抖动，写下后续 tick 节奏可用的数字。
- [x] 插件 dispose 时清掉自己的定时器；裸 cordis 与真宿主里都观测到 dispose 路径执行。
- [x] 假设成立，因此不需要写备选路径（tick 挪进常驻 subagent）。

## 结论

**假设成立：第三方 profile 插件在宿主启动时被 apply，并且在没有 turn 的情况下被 `ctx.interval` 稳定唤醒。**

### 裸 cordis（`node --test packages/core/test/heartbeat.test.js`，2/2）

- `ctx.interval` 无会话 tick 成立；dispose 之后停止；无 timer 时 apply 被推迟且不抛错。

### 真宿主（2026-10-22，冷启动两次）

| 观测 | 结果 |
|---|---|
| 两次冷启动都 apply | 是（pid 42359 与 67661 各有一组 `boot-applied` / `tick-applied`） |
| `timer` / `connection` / `sessions` / `subagents` / `storageDomain` | 全部 `present` |
| 心跳周期 | 78 次、跨 415 s，间隔 4999–5002 ms，均值 5000.8 ms，**累计漂移 ≤ 3 ms** |
| dispose | 优雅退出时写下 `disposed` 行 |
| 宿主 Node | v24.21.0（本地测试 v26.6.0，行为一致） |
| 宿主 HTTP 表面 | `GET /` 不是裸开的——将来挂的路由会落在宿主已有的访问控制后面 |

**口径修正**：`sessions` 在宿主里是 `present`（启动即恢复已有会话记录，日志里是 2、之后 1），不是 `absent`。所以验收证据不能写成「没有任何会话」，只能写成「没有任何 turn 在跑，而心跳照跑」——那 78 次心跳期间确实没有 turn。裸 cordis 那半边才是干净的 `sessions: absent`。

### 撞出来的硬约束

**未在 `inject` 里声明的服务只能探测、不能访问。** `ctx.get('timer')` 返回 `present`，紧接着 `ctx.interval(...)` 抛 `cannot get property "timer" without inject`——因为 `ctx.interval` 内部就是 `ctx.timer.interval`。推论同样要紧：声明了但服务缺席时 apply 会被**推迟**而不是报错，所以「没被加载」与「依赖缺失」在日志里长得一样。探针为此拆成一个无依赖的 `boot` 观测加一个 `inject: ['timer']` 的子 fiber——组合放在同一个 Loader 入口里，不赌 Loader 认子路径名。

其余两条：dispose 用 `ctx.fiber.dispose()`（`root.dispose` 不存在）；cordis 4.0.4 里 `ctx.set(name, value)` 会抛 `cannot set property without provide`。

### 清理

探针仍在每 5 秒写一行（约 1.5 MB/天）。票 04 接入真实 tick 时一并替换：让 `packages/core/lib/index.js` 不再记心跳（或把 `dsh-reprise` 从 `dsh.profile.bundles` 移除），然后删 `~/.dsh/reprise-probe.log`。