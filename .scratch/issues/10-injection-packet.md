# 10: 注入包 —— 事实经 mnemon 变成模型看得见的上下文

**What to build:** 模型每一轮实际看到的东西，变成一个可以逐条解释的产物。硬配额的部分（护栏、单例、当前前沿）由本插件直给，不排序不裁剪；需要取舍的部分（配方、候选经验）交给 dsh-mnemon 的 strategy。记忆层不再自研检索与预算逻辑，也没有任何路径让模型自己写记忆。

**Blocked by:** 06（前沿与派生视图）

**Status:** resolved

- [x] 护栏、单例、当前前沿走硬配额直给：不排序、不裁剪；`dump` 能列出这一轮实际注入的每一条及其来源。
- [x] 配方与候选经验走 mnemon source；同一条事实不会同时出现在注入口的两处。
- [x] auto-capture 关闭并且可验证关闭：没有「模型自己写记忆」的代码路径。
- [x] mnemon 存储作用域是工作区：两个工作区互相看不见（这是刻意的隔离，不是缺陷）。
- [x] durable evidence（memory spaces）不可用时，注入包完整降级、不报错、不阻塞 tick——SSOT 在事实面，mnemon 只做投影。
- [x] 注册 Source 时从自己的 ctx 取服务，不假设「提供了就同步可见」（cordis 4.0.4 实测：`get` 能跨 fiber，但要等 fiber settle；`inject` 只走祖先链）。
- [x] 注入包的组成有预算与裁剪，但裁剪发生在 mnemon 那一侧，本插件只给硬配额。

## 结论

注入包 48 条测试。硬配额半区（护栏 / 单例 / 前沿）逐字直给、不排序不裁剪；排序半区只经 strategy 端口准入与预算；一个事实只出现在一处；两个工作区互不可见；auto-capture 关闭是结构性断言（扫描源码里不存在 mutate/actions/capture 槽）。

**用真实 mnemon 代码验过**（一次性脚本，未提交）：`defineMemorySource` / `defineMemoryPlugin` 接受这份定义，真实 `general` 策略能在两个 ranked 伪来源上合成——正是这次实跑暴露出：`default-three-tier` 的角色词表装不下注入包（同角色两个来源会抛），来源键必须匹配 mnemon 自己的 `source:` 格式，且 `general` 默认 routed，常驻需要在 `residentSourceKeys` 里点名。三条都已写进 spec。

**未验**：没有真宿主运行（memory spaces 上游仍是坏的）。
