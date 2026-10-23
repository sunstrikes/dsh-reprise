# 实测：cordis 4.0.4 的服务可见性（fiber 作用域 vs fiber 时序）

**结论先行**：早期原型报告里那条「服务可见性是**按 fiber 作用域**的，所以 `root.get('connection')` 拿不到」**不成立**。真正的原因是**时序**——`ctx.plugin()` 返回 promise，在其 settle 之前，那个 fiber 提供的服务一律读不到。作用域并不隔离。

## 为什么值得单独验

它在 spec 里挂着两条下游结论：

1. 「v1 的 memory Source 注册与路由挂载都要按这个约束写」；
2. 「mnemon 找不到 subagent provider 很可能是同源问题」。

第一条若成立，插件装配方式要变；第二条若成立，票 01 的阻塞就有了根治路径。两条都不成立，spec 就少一条结构性约束。

## 环境

- cordis 4.0.4，来自 dsh 自带的那一份（`~/.dsh/profiles/node_modules/@deepseek-ai/cordis` 是指向 `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/...` 的符号链接，两者是同一个文件）。
- Node v26.6.0。
- 探针跑在裸 cordis 里，没有 dsh 宿主、没有 Loader、没有 session。

## 探针一：可见性

```js
const root = new Context()
class RootSvc extends Service { constructor(ctx) { super(ctx, 'rootSvc') } }
await root.plugin(RootSvc)

let childCtx
await root.plugin((ctx) => { childCtx = ctx; ctx.plugin(ChildSvc) })   // childSvc 在子 fiber 里提供

// 再从同级 plugin 里读
await root.plugin((ctx) => { ctx.get('childSvc'); root.get('childSvc') })
```

| 读法 | 结果 |
|---|---|
| `root.get('rootSvc')`（root 自己提供） | `object` |
| `root.get('childSvc')`（子 fiber 提供，已 await） | `object` |
| 子 fiber 内 `ctx.get('childSvc')` | `object` |
| **同级** plugin `ctx.get('childSvc')` | `object` |
| **同级** plugin `root.get('childSvc')` | `object` |
| 子 fiber 内 `ctx.get('rootSvc')`（祖先的） | `object` |
| 同级 plugin `ctx.inject(['childSvc'], ...)` | **一直等待**（300 ms 超时未触发） |

结论：`get()` 能看到兄弟 fiber 与后代 fiber 提供的服务；只有 `inject()` 走祖先链，不解析后代的。

## 探针二：时序

| 场景 | 结果 |
|---|---|
| root 提供，`root.get` | `stub` |
| 子 fiber 提供，在父 plugin 内**同步**读 `root.get('childSvc')` | **`undefined`** |
| 子 fiber 提供，`plugin()` 刚返回、未 await 时读 | **`undefined`** |
| 同一读法，`await plugin()` 之后 | `child` |
| 同级 plugin `ctx.get('childSvc')` | `child` |
| async apply 里 `await` 之后才 provide，await 前读 | **`undefined`** |
| 同一读法，`await` 之后 | `async` |

这就是早期原型撞到的那一堵墙：`super(ctx, 'connection')` 之后立刻 `root.get('connection')`，读到 `undefined`。它在构造函数里捕获实例后就好了——因为那之后才真正用到它。**是等待问题，不是作用域问题。**

## 因此写进代码的规则

1. 取宿主服务一律用 `ctx.inject([...])`，从**自己的** ctx 出发——宿主服务（`connection` / `subagents` / `timer`）都是自己的祖先，成立。
2. 不要用 `root.get()` 去探测或断言「服务已经在那儿了」。
3. 任何「等某个服务出现」的逻辑必须等对应 fiber settle（await `plugin()`），不能假设同步可见。

## 对 mnemon 那条阻塞的影响

**同源假设不成立。** 依据：

- `SubagentService.providers` 是 service **实例上的 Map**（`dsh-subagent/lib/index.js` 的 `registerProvider` / `getProvider` / `list`），与调用方的 fiber 无关；`list()` 返回的是实例状态。
- 若 mnemon 真的拿不到 `subagents`，报的会是 `TypeError: Cannot read properties of undefined (reading 'list')`，而不是它实际报的那句。
- 它要的 provider 在 `@deepseek-ai/dsh-base/cordis.patch.yml` 里以 `providerName: spawn` 正常挂载，且 `capabilities` 的 `toolFilter` / `persona` / `depthLimit` 三项都是 `true`、`inheritsParentContext` 是 `false`——完全满足它的筛选条件。

所以那句报错的真实原因**仍然未知**。它留在 out of scope 的决定不变：SSOT 在事实面，mnemon 只做投影。

## 顺带记下的一件事

`root.set(name, value)` 在 4.0.4 里会直接抛 `cannot set property "name" without provide`。要在裸 cordis 里造替身服务，用一个 `Service` 子类，不要 `set`。

---

# 追加：服务访问需要声明式 `inject`（票 01 撞出）

不是「可见性」的另一半，而且更要紧：**未在 `inject` 里声明的服务，只能 `get()` 探测，不能访问。**

```
ctx.get('timer')      → 对象        （允许，即使没声明 inject）
ctx.timer             → undefined   （属性访问被拦）
ctx.interval(cb, ms)  → throws: cannot get property "timer" without inject
```

第一版探针就是栽在这里：`ctx.get('timer')` 报 `present`，紧接着 `ctx.interval(...)` 抛错。它不报错才怪——`ctx.interval` 内部就是 `ctx.timer.interval`。

由此得到三条写法，且都不是风格偏好：

1. 要用某个宿主服务的方法，**必须**在插件里 `export const inject = ['timer', ...]`。
2. 声明了但服务缺席时，apply 会被**推迟**而不是报错——所以「插件没跑」与「依赖缺失」在日志里长得一样。想分开，就拆成两个插件入口（一个不声明、只记录；一个声明、只干活）。探针为此拆成了 `boot` 与 `tick` 两个 module。
3. dispose 用 `ctx.fiber.dispose()`；`ctx.dispose` / `root.dispose` 在这个版本里不存在。

## 处置

- 已写进 spec 的宿主边界规则。
- 已写进票 01 的验收：两个入口缺一不可。