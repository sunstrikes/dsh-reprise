/**
 * The browser half: the icon in the left rail and the page it opens.
 *
 * Why this file exists at all. The package shipped a *page* — `client/index.html`, served over
 * `/api/reprise/page` — and a page is not a plugin: the Harness loads it only when someone types
 * its URL, so a run could finish a whole round with nothing on screen. `dsh.client` in
 * `package.json` is what makes the Host load this module into the Web UI, and `sidebar.panellist`
 * is the seat the red box in the sidebar already allocates: one list id, one matching `main` key,
 * and the sidebar draws the button while the main column renders the page.
 *
 * **This file is the page, in React.** Ticket #6 is the last slice of the redesign and the only one
 * about the second surface: the panel used to be its own design — a hundred-line inline style table,
 * five equal cells, and Chinese sentences assembled inside template strings. It is now the same
 * seven regions, in the same order, wearing the same class names, painted by the same stylesheet and
 * formatted by the same two modules. Three things make "the same" checkable rather than claimed:
 *
 *   1. **One stylesheet.** The page's `dashboard.css` is served at `/api/reprise/dashboard.css`; this
 *      module fetches it and injects *one* `<style>` through `ctx.effect`, and its container carries
 *      `class="reprise"` plus `data-mount="panel"` (the one rule in that file about being docked:
 *      a panel is a box inside someone else's layout, so it owns its scrollbar). There is no style
 *      table here and no inline property that is a design decision — only the projection's own
 *      percentages, placed where a chart or a bar draws them.
 *   2. **One vocabulary.** `format.js` turns a fact into words (`clock`, `number`, `percent`,
 *      `cursorAt`, `pathTail`) and `states.js` decides which words a candidate state has
 *      (`SHAPE_WORDS`, `VERDICT_WORDS`, `phaseMark`). Both are the page's own modules, fetched at run
 *      time from the routes that serve them; neither is re-implemented here.
 *   3. **One dictionary.** Every sentence a person reads goes through `ctx.locale`; the English side
 *      is pinned to `states.js` for the words that module owns, so a candidate cannot be "rejected"
 *      on one surface and something else on the other.
 *
 * Read-only, like the page: every request is a `GET` against the routes the Host half already
 * mounts, and this module never sends anything back. v1 has no write endpoint, so there is no button
 * here that could change a run.
 *
 * Two rules from `references/ui-plugin.md` are load-bearing:
 *
 *   - the module registers a *lazy factory* whose id is the package name, and takes React from the
 *     browser module table (`require('react')`) — no bundle, no build step, no second React;
 *   - everything is registered inside `apply`, through `ctx.effect` / `ctx.slots.inject`, so
 *     unloading the bundle removes the icon, the page, the stylesheet and the dictionaries.
 *
 * The rendering is side-effect-free on purpose: every component below is a pure function of the
 * payloads it is given, the only hooks live in the two containers (`Panel` and `Dashboard`), and the
 * only work an effect does is the poll, the stylesheet, and the shared module imports.
 */

window.__ModuleLoader__.load({
  id: 'dsh-reprise',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const NS = 'reprise'
    const PANEL_KEY = 'reprise'

    /**
     * The routes this surface reads — the page's six, absolute because the Host mounts them on its
     * own origin. `calls` is the audit list and `call` opens one record, so a hundred calls cost a
     * hundred lines rather than a hundred prompts.
     */
    const ROUTES = {
      overview: '/api/reprise/overview',
      rounds: '/api/reprise/rounds',
      candidate: '/api/reprise/candidate',
      conclusion: '/api/reprise/conclusion',
      tree: '/api/reprise/tree',
      calls: '/api/reprise/calls',
      call: '/api/reprise/call',
    }

    /** The page's cadence (spec §9.1: the panel moved from 3s to the page's 5s). */
    const POLL_MS = 5_000

    /** How many facts the stream keeps before dropping the oldest: a window, not a history. */
    const STREAM_LIMIT = 200

    /** The page's stylesheet and the page's two shared modules, served by the Host. */
    const STYLESHEET_URL = '/api/reprise/dashboard.css'
    const STYLE_ID = 'reprise-dashboard-css'
    const FORMAT_URL = '/api/reprise/format.js'
    const STATES_URL = '/api/reprise/states.js'

    // ------------------------------------------------------------------ the words
    //
    // One dictionary per language, the same keys on both sides. Nothing a reader sees is written in a
    // template: `say(t, 'ladder.rise', { rounds, metric, value, round })` is the shape of every
    // sentence, so a language the Host adds later is a third object and not a sweep through the code.
    //
    // Keys are grouped by region, and the groups are the regions of the page: masthead, headline,
    // strips, stop, ladder, readings, candidate, stream, audit — plus the shared vocabulary at the
    // end (`shape.*`, `verdict.*`, `mark.*`, `state.*`) whose English side is pinned to `states.js`
    // by a test, because those words are the contract's and not this module's to invent.

    const EN = {
      'panel.title': 'Reprise',
      'panel.mode': 'read-only',
      'panel.loading': 'Reading the fact plane…',
      'panel.sharedFailed': 'The page modules did not load ({reason}) — asking again.',

      'phase.noFacts': 'no facts yet',
      'phase.notRecorded': 'phase not recorded',
      'phase.notRead': 'not read',
      'state.running': 'running',
      'state.stopped': 'stopped',
      'state.unknown': 'unknown',

      'stamp.workspace': 'workspace',
      'stamp.readAt': 'read at',
      'stamp.lastFact': 'last fact',
      'stamp.cursor': 'cursor',

      'headline.empty': 'No conclusion yet.',
      'headline.waiting':
        'The loop has not ticked here yet: once it does, the first round appears below and the conclusion line fills in as soon as a candidate reaches a metric.',
      'headline.nothingComparable':
        'No candidate has produced a comparable {metric} yet: every candidate was stopped at a gate, or none has reached the step that reports the number. The candidate inspector below says what each one stopped at.',
      'headline.sentence': 'The best result came from {candidate} in round {round}: {percent} against {against}.',
      'headline.sentenceNoGroup':
        'The best result came from {candidate} in round {round}, but this run recorded no comparable baseline and no earlier round produced a number to measure it against — so there is no percentage to report.',
      'headline.sentenceNoPercent':
        'The best result came from {candidate} in round {round}: {change} on {against}, which is a change of no percentage.',
      'headline.behind': 'This run is behind what it is measured against, not ahead of it.',
      'headline.againstBaseline': 'the frozen baseline {value}',
      'headline.againstPrevious': 'the previous best ({candidate}, {value})',
      'headline.noCandidate': 'no candidate',
      'headline.noResult': 'result',

      'fact.change': 'change',
      'fact.noGroup': 'no comparison group',
      'fact.published': 'they published',
      'fact.nothingPublished': 'nothing published',
      'fact.difference': 'difference',
      'fact.objectives': 'objectives',
      'fact.publishedFrom': 'published numbers: {file}',
      'fact.publishedFromDataset': 'published numbers: {file} ({dataset})',

      'strip.readFailed': 'could not read {error}',
      'strip.neverRead': 'nothing has been read successfully yet, so the panel is still empty',
      'strip.lastGood': 'the panel is showing the last successful read ({time})',
      'strip.cannotRank': 'nothing can be ranked — {error}',
      'strip.noContract': 'no metric contract',

      'stop.title': 'Stop rules',
      'stop.whyTitle': 'Why it stopped here',
      'stop.noFacts': 'no facts recorded yet',
      'stop.noneFired': 'none of them has fired',
      'stop.observed': 'observed {observed} / limit {limit}',
      'stop.recorded': 'recorded {time} · event {seq}',
      'stop.noMessage': '(no message recorded)',
      'stop.everyRule':
        'Every rule is listed with the value it had reached, so "which one would have been next" is answerable.',
      'stop.off': 'off',
      'stop.notMeasured': 'not measured',
      'stop.noReading': 'this rule has no reading',
      'stop.gauge': '{rule}: {reading}',

      'rule.max_rounds': 'rounds completed',
      'rule.max_no_improvement_rounds': 'no improvement',
      'rule.consecutive_empty_rounds': 'empty round',
      'rule.max_wall_hours': 'wall clock',
      'rule.max_windows': 'windows',

      'ladder.title': 'Best so far, round by round',
      'ladder.noRounds': 'no round has facts yet',
      'ladder.noAxis': 'no comparable result yet, so there is no staircase to draw',
      'ladder.nothingYet': 'None of the {rounds} rounds produced a comparable {metric} yet.',
      'ladder.rise': '{rounds} rounds: the best {metric} is {value}, set in round {round}.',
      'ladder.againstBaseline': ' The INIT baseline, {value}, is the dashed line.',
      'ladder.noBaseline': ' No baseline was recorded, so there is no INIT line to measure against.',
      'ladder.baselineLabel': '{metric} {value} · INIT frozen',
      'ladder.init': 'INIT',
      'ladder.baseline': 'baseline',
      'ladder.baselineMissing': 'baseline not recorded — no INIT line',
      // Why there is no line: a run that froze no baseline and a baseline recording another metric are
      // two different reasons, and the projection publishes which one it is.
      'ladder.baselineMissingWhy': 'no INIT line — {why}',
      'ladder.noBaselineWhy': ' No INIT line: {why}.',
      'ladder.keyBaseline': 'baseline {value} · INIT frozen',
      'ladder.asTable': 'Read it as a table',
      'ladder.round': 'round',
      'ladder.whatHappened': 'what happened',
      'ladder.bestInRound': 'best in the round',
      'ladder.bestAfter': 'best after',
      'ladder.candidates': 'candidates',
      'ladder.tableNote':
        "Each round on the primary metric ({metric}); a candidate is named with the gate's own four-state word when it has one.",
      'ladder.noneDeclared': 'none declared',
      'ladder.result': 'result',
      'ladder.value': 'value',

      'tree.title': 'The search, as a tree',
      'tree.empty': 'no facts yet, so there is no tree to draw',
      'tree.noCandidates': 'no candidate has facts yet, so there is no tree to draw',
      'tree.summary': '{rounds} round(s), {candidates} candidate(s), {edges} branch edge(s)',
      'tree.summaryWithCounts': '{summary} — {counts}.',
      'tree.count.continued': '{n} continued',
      'tree.count.passed-over': '{n} passed over',
      'tree.count.rejected': '{n} rejected',
      'tree.count.in-flight': '{n} in flight',
      'tree.count.roster-unused': '{n} named but unused',
      'tree.count.off-frontier': '{n} off a later frontier',
      'tree.count.no-roster': '{n} with no roster recorded',
      'tree.count.no-later-round': '{n} with no later round',
      'tree.keyNote':
        "The square is the round rail's vocabulary: five shapes, no hue. A row under a candidate means a later round started from it.",
      'tree.round': 'R{n}',
      'tree.aGate': 'a gate',
      'tree.noMessage': 'no message recorded',
      'tree.aRecordedRule': 'a recorded rule',
      'tree.parents': '{n} parent(s)',
      'tree.rotation': ' ({axis} led, offset {offset})',
      'tree.axis': 'an axis',
      'tree.root': 'frozen reference point',
      'tree.baseline': 'frozen baseline',
      'tree.noParent': 'no parent recorded',
      'tree.reason.fromBaseline': 'the frozen reference point every candidate is measured against',
      'tree.why.continuedOne': 'branched: {child}',
      'tree.why.continuedMany': 'branched: {count} candidates',
      'tree.why.rejected': 'rejected at {phase}',
      'tree.why.inFlight': 'in flight',
      'tree.why.passedOver': 'passed over in {round}',
      'tree.why.rosterUnused': 'named for {round}, unused',
      'tree.why.offFrontier': "not on {round}'s frontier",
      'tree.why.noRoster': '{round} recorded no roster',
      'tree.why.noLaterRound': 'no later round yet',
      'tree.why.noLaterRoundStopped': 'no later round — stopped',
      'tree.reason.continued': 'continued into {children}',
      'tree.reason.rejected': 'rejected at {phase}: {message}',
      'tree.reason.inFlight': 'still running, so it may still become a parent',
      'tree.reason.passedOver':
        "round {round} started from {parents}{rotation} and this candidate was on that round's frontier but not in the roster",
      'tree.reason.rosterUnused': 'round {round} named it as a parent and created fewer candidates than slots',
      'tree.reason.offFrontier': 'round {round} chose from a frontier this candidate was not on',
      'tree.reason.noRoster': 'round {round} recorded no parent roster, so the reason is not in the facts',
      'tree.reason.noLaterRound': 'no round after this one has been planned yet',
      'tree.reason.noLaterRoundStopped': 'the run stopped ({rule}), so no later round was planned',

      'readings.title': 'Readings',
      'readings.noFacts': 'no facts recorded yet',
      'readings.rounds': 'Rounds',
      'readings.roundsUnit': 'rounds completed',
      'readings.noRound': 'no round yet',
      'readings.currentRound': 'current round {n}',
      'readings.emptyStreak': 'empty streak {n}',
      'readings.candidates': 'Candidates',
      'readings.candidatesSub': 'completed {done} · rejected {rejected} · in flight {flying}',
      'readings.gpu': 'GPU hours',
      'readings.gpuUnit': '/ {limit} GPU h',
      'readings.gpuUnitUnlimited': 'GPU h, no cap',
      'readings.reserved':
        'reserved, not yet settled {n} — held against the ledger, including what a finished candidate did not spend',
      'readings.tokens': 'tokens {n}',
      'readings.frontier': 'Frontier',
      'readings.frontierUnit': 'members',
      'readings.objectives': '{n} objective(s)',
      'readings.primary': 'primary {metric}',
      'readings.primaryNone': 'primary none declared',
      'readings.cluster': 'Cluster',
      'readings.clusterUnit': 'cards in use',
      'readings.clusterLedger': 'our ledger holds {jobs} open job(s), {cards} card(s) each',
      'readings.clusterFloor': 'our own ledger holds at least {cards} card(s)',
      'readings.unknown': 'unknown',
      'readings.waiting': 'waiting {n}',
      'readings.floorAbsent': 'our own ledger cannot say how many cards it holds',

      'budget.settled': 'settled {n}',
      'budget.reserved': 'reserved, not yet settled {n}',
      'budget.remaining': 'remaining {n}',
      'budget.soft': 'soft limit {n}',
      'budget.cap': 'cap {n}',
      'budget.noCap': 'no cap — the bar is scaled by what was used',
      'budget.nothingSpent': 'nothing spent yet — there is no bar to draw',

      'hold.budget': 'the budget soft limit is reached',
      'hold.single_job_gpu': 'another job holds the cards (gpu_exclusivity: single_job)',
      'hold.none': 'no hold recorded',

      'candidate.title': 'Candidate',
      'candidate.titleFor': 'Candidate {id}',
      'candidate.empty': 'choose a candidate from a round.',
      'candidate.noFacts': 'no facts recorded for this candidate',
      'candidate.round': 'round {n}',
      'candidate.noRound': 'no round recorded',
      'candidate.noJob': 'no job recorded',
      'candidate.job': 'job {id} · {state} · attempts {n}',
      'candidate.noMetric': 'no metric measured',
      'candidate.measured': 'measured {readings}',
      'candidate.noHypothesis': 'no hypothesis was recorded for this candidate',
      'candidate.lag':
        '{n} event(s) recorded but not yet folded into state — this panel shows the facts, the kernel will catch up',
      'candidate.phases': 'the phases it walked',
      'candidate.here': 'here',
      'candidate.rejection': 'why it stopped',
      'candidate.rejectionAt': 'why it stopped at {phase}',
      'candidate.noMessage': 'no message was recorded with this decision',
      'candidate.decision': 'the decision recorded: ',
      'candidate.recorded': 'recorded {time} · event {event} {seq}',
      'candidate.gateSaid': 'the gate at {phase} said ',
      'candidate.decided': 'decided {time} · event {event} {seq}',
      'candidate.chain': 'gate chain',
      'candidate.attempts': 'attempts: {list}',
      'candidate.attempt': '{n} {outcome}',
      'candidate.attemptReview': '{n} {outcome} (review: {verdict})',
      'candidate.passed': 'passed',
      'candidate.failed': 'failed',
      'candidate.timeline': 'the last {n} facts',
      'candidate.aside': 'the facts behind this candidate',
      'candidate.frontier': 'on the frontier',
      'candidate.frontierPosition': 'frontier position: {position}',
      'candidate.vector': 'vector {json}',
      'candidate.best': 'best {reading}',
      'candidate.noBest': 'best: no comparable result yet',
      'candidate.bindings': 'identity bindings',
      'candidate.artifacts': 'referenced artifacts',

      'stream.title': 'Facts',
      'stream.read': '{n} read',
      'stream.empty': 'nothing yet.',

      'audit.title': 'model calls',
      'audit.empty': 'no judgement has asked a model yet.',
      'audit.gone': 'that call is no longer recorded',
      'audit.site': '{site} · {status}',
      'audit.withError': '{site} · {status} ({error})',
      'audit.prompt': 'prompt',
      'audit.response': 'response',
      'audit.emptyResponse': '(an empty response)',

      'shape.done': 'completed',
      'shape.frontier': 'completed, on the frontier',
      'shape.rejected': 'rejected',
      'shape.in-flight': 'in flight',
      'shape.invalid': 'invalid artifact',

      'verdict.raised': 'raised',
      'verdict.held': 'held',
      'verdict.empty': 'empty round',
      'verdict.running': 'running',

      'mark.no-verdict': 'no verdict',
      'mark.not-reached': 'not reached',

      'state.ok': 'ok',
      'state.missing': 'missing',
      'state.invalid': 'invalid',
      'state.conflict': 'conflict',
    }

    const ZH = {
      'panel.title': 'Reprise',
      'panel.mode': '只读',
      'panel.loading': '正在读取事实…',
      'panel.sharedFailed': '页面模块加载失败（{reason}）——正在重试。',

      'phase.noFacts': '还没有任何事实',
      'phase.notRecorded': '阶段未记录',
      'phase.notRead': '未读取',
      'state.running': '运行中',
      'state.stopped': '已停止',
      'state.unknown': '未知',

      'stamp.workspace': '工作区',
      'stamp.readAt': '读取于',
      'stamp.lastFact': '最新事实',
      'stamp.cursor': '游标',

      'headline.empty': '尚无结论。',
      'headline.waiting': '这个探索循环还没有在这里跑起来。一旦跑起来，第一轮的候选会出现在下面；候选产出指标后，结论行就会填上。',
      'headline.nothingComparable': '还没有候选产出可比的 {metric}：所有候选都被闸门拦下，或者还没有候选跑到产出指标的那一步。下面的“候选”区域会说明每个候选停在哪里。',
      'headline.sentence': '目前的最好成绩来自第 {round} 轮的 {candidate}：相对{against}，{percent}。',
      'headline.sentenceNoGroup': '目前的最好成绩来自第 {round} 轮的 {candidate}，但这次运行既没有记录可比的基线，也没有更早的轮次产出可对照的数——所以算不出百分比。',
      'headline.sentenceNoPercent': '目前的最好成绩来自第 {round} 轮的 {candidate}：相对{against}变化 {change}，这个变化无法用百分比表示。',
      'headline.behind': '这次运行落后于它的对照，而不是领先。',
      'headline.againstBaseline': '冻结基线 {value}',
      'headline.againstPrevious': '此前最好成绩（{candidate}，{value}）',
      'headline.noCandidate': '无候选',
      'headline.noResult': '结果',

      'fact.change': '变化',
      'fact.noGroup': '无对照',
      'fact.published': '论文公布',
      'fact.nothingPublished': '未公布',
      'fact.difference': '差距',
      'fact.objectives': '目标',
      'fact.publishedFrom': '已公布数字：{file}',
      'fact.publishedFromDataset': '已公布数字：{file}（{dataset}）',

      'strip.readFailed': '读不到 {error}',
      'strip.neverRead': '还没有一次成功的读取，所以面板仍是空的',
      'strip.lastGood': '面板停在最后一次成功的读取上（{time}）。',
      'strip.cannotRank': '无法排名 —— {error}',
      'strip.noContract': '没有指标契约',

      'stop.title': '停止规则',
      'stop.whyTitle': '为什么停在这里',
      'stop.noFacts': '还没有任何事实',
      'stop.noneFired': '都没有触发',
      'stop.observed': '实际 {observed} / 上限 {limit}',
      'stop.recorded': '记录于 {time} · 事件 {seq}',
      'stop.noMessage': '（没有记录说明）',
      'stop.everyRule': '每条规则都列出它已经到达的值，所以“下一个会触发的是哪条”有答案。',
      'stop.off': '关闭',
      'stop.notMeasured': '未测量',
      'stop.noReading': '这条规则没有读数',
      'stop.gauge': '{rule}：{reading}',

      'rule.max_rounds': '已完成轮次',
      'rule.max_no_improvement_rounds': '无改进轮次',
      'rule.consecutive_empty_rounds': '连续空轮',
      'rule.max_wall_hours': '实际耗时',
      'rule.max_windows': '窗口数',

      'ladder.title': '历轮最好成绩',
      'ladder.noRounds': '还没有任何轮次的事实',
      'ladder.noAxis': '还没有可比的数，所以画不出阶梯图',
      'ladder.nothingYet': '{rounds} 轮都没有产出可比的 {metric}。',
      'ladder.rise': '{rounds} 轮中，最好的 {metric} 是 {value}，在第 {round} 轮取得。',
      'ladder.againstBaseline': 'INIT 基线 {value} 就是那条虚线。',
      'ladder.noBaseline': '这次运行没有记录基线，所以没有 INIT 线可对照。',
      'ladder.baselineLabel': '{metric} {value} · INIT 冻结基线',
      'ladder.init': 'INIT',
      'ladder.baseline': '基线',
      'ladder.baselineMissing': '基线未记录——没有 INIT 线',
      'ladder.baselineMissingWhy': '没有 INIT 线 —— {why}',
      'ladder.noBaselineWhy': ' 没有 INIT 线：{why}。',
      'ladder.keyBaseline': 'INIT 冻结基线 {value}',
      'ladder.asTable': '以表格查看',
      'ladder.round': '轮次',
      'ladder.whatHappened': '本轮情况',
      'ladder.bestInRound': '本轮最好',
      'ladder.bestAfter': '至此最好',
      'ladder.candidates': '候选',
      'ladder.tableNote': '每一轮按主指标（{metric}）计；候选若有闸门给出的四态判定，就写该判定本身。',
      'ladder.noneDeclared': '未声明',
      'ladder.result': '结果',
      'ladder.value': '值',

      'tree.title': '搜索树',
      'tree.empty': '还没有任何事实，所以没有树可画',
      'tree.noCandidates': '还没有任何候选的事实，所以没有树可画',
      'tree.summary': '{rounds} 轮、{candidates} 个候选、{edges} 条分支边',
      'tree.summaryWithCounts': '{summary} —— {counts}。',
      'tree.count.continued': '{n} 个继续',
      'tree.count.passed-over': '{n} 个被跳过',
      'tree.count.rejected': '{n} 个被拒绝',
      'tree.count.in-flight': '{n} 个执行中',
      'tree.count.roster-unused': '{n} 个列进名单但没用上',
      'tree.count.off-frontier': '{n} 个不在后续一轮的帕累托前沿上',
      'tree.count.no-roster': '{n} 个所在轮次没有记录名单',
      'tree.count.no-later-round': '{n} 个还没有更晚的一轮',
      'tree.keyNote': '方块用的是轮次条那五个形状，靠形状而不是颜色区分；候选下面还压着一行，说明有更晚的一轮从它出发。',
      'tree.round': '第 {n} 轮',
      'tree.aGate': '某道闸门',
      'tree.noMessage': '没有记录说明',
      'tree.aRecordedRule': '一条已记录的规则',
      'tree.parents': '{n} 个父候选',
      'tree.rotation': '（{axis} 轴领先，偏移 {offset}）',
      'tree.axis': '某条轴',
      'tree.root': '冻结的参照点',
      'tree.baseline': '冻结基线',
      'tree.noParent': '没有记录父候选',
      'tree.reason.fromBaseline': '每个候选都以它衡量自己的那个冻结参照点',
      'tree.why.continuedOne': '分支：{child}',
      'tree.why.continuedMany': '分支：{count} 个候选',
      'tree.why.rejected': '在{phase}被拒绝',
      'tree.why.inFlight': '执行中',
      'tree.why.passedOver': '{round}被跳过',
      'tree.why.rosterUnused': '列进{round}的名单，没被使用',
      'tree.why.offFrontier': '不在{round}的帕累托前沿上',
      'tree.why.noRoster': '{round}没有记录名单',
      'tree.why.noLaterRound': '还没有更晚的一轮',
      'tree.why.noLaterRoundStopped': '没有更晚的一轮——已停止',
      'tree.reason.continued': '继续到 {children}',
      'tree.reason.rejected': '在{phase}被拒绝：{message}',
      'tree.reason.inFlight': '还在运行，所以它仍可能成为父候选',
      'tree.reason.passedOver': '第 {round} 轮从 {parents}{rotation} 出发，这个候选在该轮的前沿上，但不在该轮名单里',
      'tree.reason.rosterUnused': '第 {round} 轮把它列为父候选，但创建的候选少于名额',
      'tree.reason.offFrontier': '第 {round} 轮从一个不含这个候选的帕累托前沿里挑选',
      'tree.reason.noRoster': '第 {round} 轮没有记录父候选名单，所以事实里没有这条原因',
      'tree.reason.noLaterRound': '这一轮之后还没有规划过任何一轮',
      'tree.reason.noLaterRoundStopped': '运行已停止（{rule}），所以没有再规划更晚的一轮',

      'readings.title': '读数',
      'readings.noFacts': '还没有任何事实',
      'readings.rounds': '轮次',
      'readings.roundsUnit': '已完成轮次',
      'readings.noRound': '还没有轮次',
      'readings.currentRound': '当前第 {n} 轮',
      'readings.emptyStreak': '连续空轮 {n}',
      'readings.candidates': '候选',
      'readings.candidatesSub': '已完成 {done} · 已拒绝 {rejected} · 执行中 {flying}',
      'readings.gpu': 'GPU 小时',
      'readings.gpuUnit': '/ {limit} GPU h',
      'readings.gpuUnitUnlimited': 'GPU h，无上限',
      'readings.reserved': '已预留、未结算 {n} —— 计入账本，含已结束候选没花完的部分',
      'readings.tokens': 'tokens {n}',
      'readings.frontier': '帕累托前沿',
      'readings.frontierUnit': '个成员',
      'readings.objectives': '{n} 个目标',
      'readings.primary': '主指标 {metric}',
      'readings.primaryNone': '未声明主指标',
      'readings.cluster': '集群',
      'readings.clusterUnit': '在用卡数',
      'readings.clusterLedger': '我们的账本里有 {jobs} 个未完成的 job，每个占用 {cards} 张卡',
      'readings.clusterFloor': '我们自己的账本显示至少占着 {cards} 张卡',
      'readings.unknown': '未知',
      'readings.waiting': '等待 {n}',
      'readings.floorAbsent': '我们自己的账本说不出它占了多少张卡',

      'budget.settled': '已结算 {n}',
      'budget.reserved': '已预留、未结算 {n}',
      'budget.remaining': '剩余 {n}',
      'budget.soft': '软上限 {n}',
      'budget.cap': '硬上限 {n}',
      'budget.noCap': '没有上限——进度条按已用量缩放',
      'budget.nothingSpent': '还没有花费，画不出进度条',

      'hold.budget': '已到预算软上限',
      'hold.single_job_gpu': '另一个 job 占着卡（gpu_exclusivity: single_job）',
      'hold.none': '没有记录等待原因',

      'candidate.title': '候选',
      'candidate.titleFor': '候选 {id}',
      'candidate.empty': '在上面的轮次轨道里点一个方块，查看这个候选走过了哪些阶段。',
      'candidate.noFacts': '这个候选还没有任何事实',
      'candidate.round': '第 {n} 轮',
      'candidate.noRound': '没有记录轮次',
      'candidate.noJob': '没有记录 job',
      'candidate.job': 'job {id} · {state} · 尝试 {n}',
      'candidate.noMetric': '没有测到任何指标',
      'candidate.measured': '测到 {readings}',
      'candidate.noHypothesis': '这个候选没有记录假设',
      'candidate.lag': '已记录 {n} 条事实，但还没有并入状态——这里显示的是事实，内核随后会跟上',
      'candidate.phases': '走过的阶段',
      'candidate.here': '当前',
      'candidate.rejection': '为什么停下',
      'candidate.rejectionAt': '为什么停在 {phase} 阶段',
      'candidate.noMessage': '这个决定没有记录说明',
      'candidate.decision': '记录的决定：',
      'candidate.recorded': '记录于 {time} · 事件 {event} {seq}',
      'candidate.gateSaid': '{phase} 阶段的闸门给出：',
      'candidate.decided': '判定于 {time} · 事件 {event} {seq}',
      'candidate.chain': '闸门记录',
      'candidate.attempts': '尝试：{list}',
      'candidate.attempt': '第 {n} 次{outcome}',
      'candidate.attemptReview': '第 {n} 次{outcome}（复审：{verdict}）',
      'candidate.passed': '通过',
      'candidate.failed': '失败',
      'candidate.timeline': '最近 {n} 条事实',
      'candidate.aside': '这个候选背后的事实',
      'candidate.frontier': '在帕累托前沿上',
      'candidate.frontierPosition': '在前沿中的位置：{position}',
      'candidate.vector': '目标向量 {json}',
      'candidate.best': '最好 {reading}',
      'candidate.noBest': '最好：还没有可比的数',
      'candidate.bindings': '身份绑定',
      'candidate.artifacts': '引用的产物',

      'stream.title': '事实流',
      'stream.read': '已读 {n} 条',
      'stream.empty': '还没有。',

      'audit.title': '模型调用',
      'audit.empty': '还没有需要模型判断的地方。',
      'audit.gone': '这次调用已不在记录里',
      'audit.site': '{site} · {status}',
      'audit.withError': '{site} · {status}（{error}）',
      'audit.prompt': '提示词',
      'audit.response': '响应',
      'audit.emptyResponse': '（响应为空）',

      'shape.done': '已完成',
      'shape.frontier': '已完成，在帕累托前沿上',
      'shape.rejected': '已拒绝',
      'shape.in-flight': '执行中',
      'shape.invalid': '产物无效',

      'verdict.raised': '有提升',
      'verdict.held': '持平',
      'verdict.empty': '空轮',
      'verdict.running': '进行中',

      'mark.no-verdict': '未判定',
      'mark.not-reached': '未到达',

      'state.ok': 'ok',
      'state.missing': 'missing',
      'state.invalid': 'invalid',
      'state.conflict': 'conflict',
    }

    /**
     * The two page modules, fetched once.
     *
     * They are plain ESM served by the Host at their own routes (`format.js`, `states.js`), so a
     * dynamic `import()` is all the browser needs — and it keeps one formatter and one vocabulary in
     * charge of both surfaces. `SHARED` is a module-level cache rather than React state because it
     * never changes: the first mount pays for the import, every render after it is synchronous.
     *
     * A failed import is *not* cached: those two routes are mounted by the Host half of the plugin,
     * and a Host that loaded this bundle before those routes existed (or that was reloaded while the
     * route table stayed put) answers 404 to them. Caching the rejection would leave the panel
     * saying "reading the fact plane" for the lifetime of the window — the silent staleness this
     * whole view exists to remove — so the next attempt asks again, and `Panel` says why meanwhile.
     */
    const SHARED = { format: null, words: null }
    let importing = null

    function loadShared() {
      if (SHARED.format !== null && SHARED.words !== null) return Promise.resolve(SHARED)
      if (importing === null) {
        importing = Promise.all([import(FORMAT_URL), import(STATES_URL)]).then(
          ([format, words]) => {
            SHARED.format = format
            SHARED.words = words
            return SHARED
          },
          (error) => {
            importing = null
            throw error
          },
        )
      }
      return importing
    }

    // ---------------------------------------------------------------- formatting
    //
    // Sentences are templates, and their holes are filled here. `t(key)` answers the dictionary's
    // text for the active language; `say` is the same call with the holes in it. A missing parameter
    // leaves `{name}` visible rather than printing `undefined` — the defect the redesign exists to
    // remove — and an unknown key prints as its own name, which is ugly and therefore noticed.

    function fill(text, params) {
      if (params === undefined || params === null) return text
      return String(text).replace(/\{(\w+)\}/g, (whole, name) =>
        params[name] === undefined || params[name] === null ? whole : String(params[name]),
      )
    }

    const say = (t, key, params) => fill(t(key), params)

    /**
     * The word for a payload identifier, and the identifier itself when the dictionary has none.
     *
     * A key built out of a payload word (`rule.max_windows`) is one the dictionary cannot be checked
     * for at build time. `hold.*` already reads its answer this way; `rule.*` used to print the raw
     * *key* instead, so a rule the kernel added met a reader as `rule.max_cost`. Both families now
     * answer with `rule.max_cost` -> `max_cost`: wrong and legible, rather than wrong and unreadable.
     */
    const wordFor = (t, family, id) => {
      const key = `${family}.${id}`
      const word = say(t, key)
      return word === key ? String(id) : word
    }

    /** A fact's stamp on screen: `#9`. One spelling, because a reader quotes it back. */
    const seqStamp = (seq) => `#${seq}`

    /** One metric reading, spelled one way: `auc=0.7331`, or `r5-h2 auc=0.7331` with a candidate. */
    const measurement = (fmt, candidateId, metric, value) =>
      `${candidateId === null || candidateId === undefined || candidateId === '' ? '' : `${candidateId} `}` +
      `${metric ?? fmt.EM_DASH}=${fmt.number(value)}`

    /** One route URL, with the cursor, the candidate and the audit reference as query parameters. */
    function urlFor(view, { cursor, candidate, ref } = {}) {
      const query = []
      if (cursor) query.push(`after=${encodeURIComponent(cursor)}`)
      if (candidate) query.push(`candidate=${encodeURIComponent(candidate)}`)
      if (ref) query.push(`ref=${encodeURIComponent(ref)}`)
      return query.length === 0 ? ROUTES[view] : `${ROUTES[view]}?${query.join('&')}`
    }

    /** The per-client bookkeeping the increment protocol needs. Not rendered: a ref, not state. */
    function newBook() {
      return { cursors: new Map(), seen: new Set(), events: [], factTotal: 0 }
    }

    /**
     * One read, with the cursor bookkeeping the Host's increment protocol expects.
     *
     * `?after=` costs the new facts and not the whole history, and the same facts arriving twice (a
     * repeated cursor, a page asking too often) are deduplicated here — the server is idempotent and
     * so is this client, because a doubled timeline is a lie about what happened.
     */
    async function readView(view, book, options = {}) {
      const key = `${view}|${options.candidate ?? ''}`
      const url = urlFor(view, { cursor: book.cursors.get(key), ...options })
      const response = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' })
      const answer = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(`${view}: HTTP ${response.status} — ${answer?.error?.message ?? 'no answer'}`)
      }
      if (answer.cursor) book.cursors.set(key, answer.cursor)
      for (const event of answer.incremental?.events ?? []) {
        if (book.seen.has(event.cursor)) continue
        book.seen.add(event.cursor)
        book.events.push(event)
        book.factTotal += 1
      }
      if (book.events.length > STREAM_LIMIT) book.events.splice(0, book.events.length - STREAM_LIMIT)
      return answer
    }

    /** One read with no cursor bookkeeping: the audit's detail request is not part of the increment. */
    async function readOnce(view, options = {}) {
      const response = await fetch(urlFor(view, options), {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      })
      const answer = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(`${view}: HTTP ${response.status} — ${answer?.error?.message ?? 'no answer'}`)
      }
      return answer
    }

    /** The card count, or the word for "we could not ask": an unread listing is never `0`. */
    const cardsInUse = (t, cluster) =>
      cluster?.cards === undefined || cluster?.cards === null
        ? '—'
        : cluster.cards.inUse === null
          ? say(t, 'readings.unknown')
          : String(cluster.cards.inUse)

    /**
     * One stop rule: its name, a gauge of the distance left, and the reading.
     *
     * `data-state` carries the four things a rule can be (measured, fired, off, and "nobody could
     * measure it"), and the stylesheet draws each differently — a name at tertiary ink with no gauge
     * for a rule that is off, a bold name and a filled dot for the rule that fired. Reaching a limit
     * is *stopping*, not succeeding, so the gauge is a distance and never a progress bar.
     */
    function stopRule(t, fmt, rule, { fired = false } = {}) {
      const name = wordFor(t, 'rule', rule.rule)
      const reading =
        rule.enabled !== true
          ? say(t, 'stop.off')
          : rule.observed === null
            ? say(t, 'stop.notMeasured')
            : `${fmt.number(rule.observed)}/${fmt.number(rule.limit)}`
      const state = rule.enabled !== true ? 'disabled' : rule.observed === null ? 'blocked' : fired ? 'fired' : 'measured'
      return h('div', { className: 'stop-rule', 'data-rule': rule.rule, 'data-state': state, key: rule.rule }, [
        h('span', { className: 'stop-rule-name', key: 'name' }, name),
        rule.enabled === true && rule.observed !== null
          ? h(
              'span',
              {
                className: 'stop-gauge',
                role: 'progressbar',
                'aria-label': say(t, 'stop.gauge', { rule: name, reading }),
                'aria-valuenow': String(rule.observed),
                'aria-valuemin': '0',
                'aria-valuemax': String(rule.limit),
                key: 'gauge',
              },
              [
                h('span', {
                  className: 'stop-gauge-fill',
                  key: 'fill',
                  style: { width: `${rule.distancePercent}%` },
                }),
              ],
            )
          : null,
        h('span', { className: 'stop-rule-reading', key: 'reading' }, reading),
        fired ? h('span', { className: 'stop-dot', 'aria-hidden': 'true', key: 'dot' }) : null,
      ])
    }

    /** The sentences behind the gauges: why a rule could not be measured. */
    function ruleNotes(t, rules) {
      return rules
        .filter((rule) => rule.enabled === true && rule.observed === null)
        .map((rule) =>
          h(
            'p',
            { className: 'note', key: `note-${rule.rule}` },
            `${wordFor(t, 'rule', rule.rule)}: ${rule.reason ?? rule.unmeasured ?? say(t, 'stop.noReading')}`,
          ),
        )
    }

    /**
     * Where a value sits inside the plot, measured from the top in percent.
     *
     * Placement, not derivation: the bounds are the projection's (`ladder.axis`) and this answers only
     * "how far down the box". It is the one division this surface performs on a metric, which is why
     * the axis is published instead of computed from the series.
     */
    function heightPercent(value, axis) {
      const range = axis.top - axis.bottom
      if (range === 0) return 50
      return ((axis.top - value) / range) * 100
    }

    /** One cell of the conclusion's facts row: a label and its value. */
    const fact = (label, value, key) =>
      h('div', { className: 'fact', key }, [h('dt', { key: 'label' }, label), h('dd', { key: 'value' }, value)])

    /** One cell of the readings row: label, headline number with its unit, then the sentences under it. */
    function reading(label, value, unit, subs = [], extra = [], key) {
      return h('div', { className: 'reading', key }, [
        h('dt', { className: 'reading-label', key: 'label' }, label),
        h('dd', { className: 'reading-headline', key: 'headline' }, [value, unit === undefined ? null : h('span', { className: 'reading-unit', key: 'unit' }, unit)]),
        ...subs.filter(Boolean).map((text, index) => h('dd', { className: 'reading-sub', key: `sub-${index}` }, text)),
        ...extra.filter(Boolean),
      ])
    }

    // -------------------------------------------------------------- the containers

    /**
     * The panel as the Host mounts it: wait for the two shared modules, then render.
     *
     * The wait is one fetch of two small files, and it buys the thing this ticket is about — the same
     * formatter and the same words as the page rather than a second copy of them. Until it resolves
     * the panel says so, in the dictionary's own words, because an empty dock reads as a broken one.
     */
    function Panel({ t }) {
      const [shared, setShared] = useState(null)
      const [failure, setFailure] = useState(null)
      useEffect(() => {
        let alive = true
        let timer = null
        const attempt = () => {
          void loadShared().then(
            (loaded) => {
              if (!alive) return
              setShared(loaded)
              setFailure(null)
            },
            (error) => {
              if (!alive) return
              // Say which module and why, in the dictionary's words, and keep asking: the usual cause
              // is a Host whose route table predates these two files, which a reload of the plugin
              // repairs. A panel that waits forever instead is the failure nobody can diagnose.
              setFailure(error instanceof Error ? error.message : String(error))
              timer = setTimeout(attempt, POLL_MS)
            },
          )
        }
        attempt()
        return () => {
          alive = false
          if (timer !== null) clearTimeout(timer)
        }
      }, [])
      if (shared === null) {
        return h('div', { className: 'reprise', 'data-mount': 'panel' }, [
          h(
            'p',
            { className: failure === null ? 'empty' : 'warning', key: 'loading' },
            failure === null ? say(t, 'panel.loading') : say(t, 'panel.sharedFailed', { reason: failure }),
          ),
        ])
      }
      return h(Dashboard, { t, shared })
    }

    /**
     * One poll's worth of answers, plus the reader's own choices.
     *
     * The bookkeeping the increment protocol needs lives in a ref (`newBook()`), because it is not
     * rendered: it is what the *next* request asks for. Everything a reader can see is state, and the
     * only two pieces of state a poll must not own are the selection and the audit — both survive a
     * re-render because they are the reader's, not the run's.
     */
    function Dashboard({ t, shared }) {
      const [snapshot, setSnapshot] = useState(null)
      const [failure, setFailure] = useState(null)
      const [readAt, setReadAt] = useState(null)
      const [selected, setSelected] = useState(null)
      const [auditOpen, setAuditOpen] = useState(false)
      const [openRef, setOpenRef] = useState(null)
      const [openRecord, setOpenRecord] = useState(null)
      const book = useRef(null)
      if (book.current === null) book.current = newBook()
      const alive = useRef(true)
      /**
       * The generation of the read in flight. Two reads can be outstanding at once — a poll and the
       * click that re-points the inspector — and they finish in whatever order the Host answers, so
       * the last *response* to land used to win rather than the last one *started*: click two squares
       * quickly and the inspector flipped back to the earlier candidate for one read while the newer
       * square stayed pressed. A read applies its answer only while it is still the newest.
       */
      const gen = useRef(0)
      // What the poll should ask for on its next tick. A ref, so changing the selection does not tear
      // down and rebuild the interval (which would also reset its phase).
      const chosen = useRef(null)

      const poll = useCallback(async (candidateId) => {
        const mine = ++gen.current
        try {
          const [overview, rounds, conclusion, tree, calls] = await Promise.all([
            readView('overview', book.current),
            readView('rounds', book.current),
            readView('conclusion', book.current),
            readView('tree', book.current),
            readView('calls', book.current),
          ])
          const candidate =
            candidateId === null || candidateId === undefined
              ? null
              : await readView('candidate', book.current, { candidate: candidateId })
          // A newer read started while this one was in flight: its answer is the one that describes the
          // page now, and applying this one would overwrite it with an older selection.
          if (!alive.current || mine !== gen.current) return
          setSnapshot({
            overview,
            rounds,
            conclusion,
            tree,
            calls,
            candidate,
            events: [...book.current.events],
            factTotal: book.current.factTotal,
          })
          setFailure(null)
          setReadAt(Date.now())
        } catch (error) {
          if (!alive.current || mine !== gen.current) return
          // The last good page stays up (spec §6.9's 500 row); what changes is the strip that says why.
          setFailure(error instanceof Error ? error.message : String(error))
        }
      }, [])

      useEffect(() => {
        alive.current = true
        void poll(chosen.current)
        const timer = setInterval(() => void poll(chosen.current), POLL_MS)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [poll])

      const select = useCallback(
        (candidateId) => {
          chosen.current = candidateId
          setSelected(candidateId)
          void poll(candidateId)
        },
        [poll],
      )

      const openCall = useCallback(async (ref) => {
        setOpenRef(ref)
        setOpenRecord(null)
        try {
          setOpenRecord((await readOnce('call', { ref }))?.data ?? { reason: 'gone' })
        } catch (error) {
          setOpenRecord({ reason: error instanceof Error ? error.message : String(error) })
        }
      }, [])

      const answers = snapshot ?? {
        overview: null,
        rounds: null,
        conclusion: null,
        tree: null,
        calls: null,
        candidate: null,
        events: [],
        factTotal: 0,
      }

      return h('div', { className: 'reprise', 'data-mount': 'panel' }, [
        h(RegionMasthead, { key: 'masthead', t, shared, snapshot: answers, readAt, failure }),
        h(RegionHeadline, { key: 'headline', t, shared, conclusion: answers.conclusion }),
        h(RegionStrips, { key: 'strips', t, shared, snapshot: answers, failure, readAt }),
        h(RegionStop, { key: 'stop', t, shared, overview: answers.overview }),
        h(RegionLadder, {
          key: 'ladder',
          t,
          shared,
          rounds: answers.rounds,
          conclusion: answers.conclusion,
          selected,
          onSelect: select,
        }),
        h(RegionReadings, { key: 'readings', t, shared, overview: answers.overview }),
        h(RegionTree, {
          key: 'tree',
          t,
          shared,
          tree: answers.tree,
          selected,
          onSelect: select,
        }),
        h('div', { className: 'lower', key: 'lower' }, [
          h(RegionInspector, { key: 'candidate', t, shared, candidate: answers.candidate, selected }),
          h('div', { className: 'lower-side', key: 'side' }, [
            h(RegionAudit, {
              key: 'audit',
              t,
              shared,
              calls: answers.calls,
              open: auditOpen,
              onToggle: setAuditOpen,
              openRef,
              openRecord,
              onOpenCall: openCall,
            }),
            h(RegionStream, {
              key: 'stream',
              t,
              shared,
              events: answers.events,
              factTotal: answers.factTotal,
            }),
          ]),
        ]),
      ])
    }

    // --------------------------------------------------------------- the regions

    /**
     * The masthead: the phase capsule, and the four stamps that answer "which run, when did I read,
     * when did the run last move, and at which fact".
     *
     * The capsule is the only place the workspace phase appears, and it is `aria-live` because a phase
     * change is worth hearing. The stamps come from the envelope: `read at` is this browser's last
     * successful poll, and `last fact` is the *published cursor's* instant — never a running maximum
     * over the facts this client happened to read, because the page and the panel see different
     * windows of one run and would then print two different answers.
     */
    function RegionMasthead({ t, shared, snapshot, readAt, failure }) {
      const fmt = shared.format
      const overview = snapshot.overview
      const data = overview?.data
      const stopped = data?.stop?.stopped === true
      const unread = (data === null || data === undefined) && failure !== null && readAt === null
      const phaseState = data === null || data === undefined ? 'unknown' : stopped ? 'stopped' : 'running'
      const capsuleName =
        data === null || data === undefined
          ? say(t, unread ? 'phase.notRead' : 'phase.noFacts')
          : (data.workspace?.phase ?? say(t, 'phase.notRecorded'))
      const capsuleState =
        data === null || data === undefined ? say(t, 'state.unknown') : say(t, stopped ? 'state.stopped' : 'state.running')
      const cursorKey = overview?.cursor ?? null

      const stamp = (id, label, value, title) =>
        h('span', { className: 'stamp', key: id }, [
          h('span', { className: 'stamp-label', key: 'label' }, label),
          h('span', { className: 'stamp-value', title: title ?? undefined, key: 'value' }, value),
        ])

      return h('header', { className: 'masthead' }, [
        h('div', { className: 'masthead-run', key: 'run' }, [
          h('h1', { key: 'title' }, say(t, 'panel.title')),
          h('span', { className: 'phase-capsule', 'data-state': phaseState, 'aria-live': 'polite', key: 'phase' }, [
            h('span', { className: 'phase-capsule-dot', 'aria-hidden': 'true', key: 'dot' }),
            h('span', { className: 'phase-capsule-name', key: 'name' }, capsuleName),
            h('span', { className: 'phase-capsule-state', key: 'state' }, capsuleState),
          ]),
          h('span', { className: 'masthead-mode', key: 'mode' }, say(t, 'panel.mode')),
        ]),
        h('div', { className: 'masthead-stamps', key: 'stamps' }, [
          stamp('workspace', say(t, 'stamp.workspace'), fmt.pathTail(overview?.workspace), overview?.workspace),
          stamp('readAt', say(t, 'stamp.readAt'), fmt.clock(readAt)),
          // The instant the cursor names — one published value, rendered twice.
          stamp('lastFact', say(t, 'stamp.lastFact'), fmt.clock(fmt.cursorAt(cursorKey))),
          stamp('cursor', say(t, 'stamp.cursor'), cursorKey === null ? fmt.EM_DASH : fmt.cursor(cursorKey)),
        ]),
      ])
    }

    /**
     * The conclusion line and the facts under it.
     *
     * Every number here is the projection's comparison block. This surface adds no subtraction and no
     * division, and it decides only how to *say* what it was given — including the two states where
     * there is nothing to say (spec §6.9): nothing comparable yet, and a result with nothing to
     * measure it against. "Worse than the baseline" is a sentence, never a fifth four-state word.
     */
    function RegionHeadline({ t, shared, conclusion }) {
      const fmt = shared.format
      const data = conclusion?.data
      const comparison = data?.comparison

      if (comparison === null || comparison === undefined) {
        // No facts at all. A blank headline reads as "nothing to say"; this says why there is nothing
        // and where the answer will appear — the difference between an empty state and a bug.
        const why = conclusion?.reason
        return h('section', { className: 'headline' }, [
          h('p', { className: 'headline-empty', key: 'empty' }, say(t, 'headline.empty')),
          why === undefined || why === null ? null : h('p', { className: 'dim', key: 'why' }, why),
          h('p', { className: 'dim', key: 'waiting' }, say(t, 'headline.waiting')),
        ])
      }

      const measured = comparison.measured
      const metric = comparison.metric ?? say(t, 'headline.noResult')
      if (measured === null || measured === undefined) {
        return h('section', { className: 'headline' }, [
          h('p', { className: 'headline-empty', key: 'empty' }, say(t, 'headline.empty')),
          h('p', { className: 'dim', key: 'why' }, say(t, 'headline.nothingComparable', { metric })),
        ])
      }

      const group = comparison.group
      const where = { candidate: measured.candidate_id, round: fmt.number(measured.round) }
      let sentence
      if (group === null || group === undefined) {
        sentence = say(t, 'headline.sentenceNoGroup', where)
      } else {
        const against = say(
          t,
          group.kind === 'baseline' ? 'headline.againstBaseline' : 'headline.againstPrevious',
          {
            value: fmt.number(group.value),
            candidate: group.candidate_id ?? say(t, 'headline.noCandidate'),
          },
        )
        sentence =
          typeof comparison.changePercent !== 'number'
            ? say(t, 'headline.sentenceNoPercent', { ...where, change: fmt.change(comparison.change), against })
            : say(t, 'headline.sentence', {
                ...where,
                percent: fmt.percent(comparison.changePercent, { sign: true }),
                against,
              }) + (comparison.better === false ? ` ${say(t, 'headline.behind')}` : '')
      }

      const published = comparison.published
      const facts = h('dl', { className: 'facts', key: 'facts' }, [
        fact(
          say(t, 'fact.change'),
          comparison.change === null || comparison.change === undefined
            ? say(t, 'fact.noGroup')
            : `${fmt.change(comparison.change)}${comparison.metric === null ? '' : ` ${comparison.metric}`}`,
          'change',
        ),
        fact(
          say(t, 'fact.published'),
          published === null
            ? say(t, 'fact.nothingPublished')
            : `${published.method} ${measurement(fmt, null, published.metric, published.value)}`,
          'published',
        ),
        published === null
          ? null
          : fact(
              say(t, 'fact.difference'),
              `${fmt.change(comparison.publishedChange)}${comparison.metric === null ? '' : ` ${comparison.metric}`}`,
              'difference',
            ),
        fact(
          say(t, 'fact.objectives'),
          data.objectives.length === 0
            ? fmt.EM_DASH
            : data.objectives
                .map(
                  (objective) =>
                    `${objective.name} (${objective.direction}${objective.kind === 'primary' ? ', primary' : ''})`,
                )
                .join(' · '),
          'objectives',
        ),
      ])

      const notes = []
      if (published === null) {
        if (comparison.publishedAbsent !== null && comparison.publishedAbsent !== undefined) {
          notes.push(h('p', { className: 'dim', key: 'absent' }, comparison.publishedAbsent))
        }
      } else if (published.source?.file !== undefined) {
        notes.push(
          h(
            'p',
            { className: 'dim', key: 'source' },
            say(
              t,
              published.dataset === null ? 'fact.publishedFrom' : 'fact.publishedFromDataset',
              { file: published.source.file, dataset: published.dataset },
            ),
          ),
        )
      }

      return h('section', { className: 'headline' }, [
        h('p', { className: 'headline-value', key: 'value' }, [
          h('span', { className: 'headline-number', key: 'number' }, fmt.number(measured.value)),
          h('span', { className: 'headline-unit', key: 'unit' }, comparison.metric ?? ''),
        ]),
        h('p', { className: 'headline-sentence', key: 'sentence' }, sentence),
        facts,
        ...notes,
      ])
    }

    /**
     * The strip under the conclusion: the loud facts that are not a step in any region.
     *
     * The warnings the run owes a reader, the notes the route attached to its own answer, the metric
     * contract's refusal, and — in the same voice — a failed poll. A panel that leaves its last good
     * page up is right; one that stays silent about *why* it is stale is not.
     */
    function RegionStrips({ t, shared, snapshot, failure, readAt }) {
      const fmt = shared.format
      const overview = snapshot.overview
      const data = overview?.data
      const rows = []

      if (failure !== null && failure !== undefined) {
        rows.push(h('p', { className: 'warning', key: 'failed' }, say(t, 'strip.readFailed', { error: failure })))
        rows.push(
          h(
            'p',
            { className: 'note', key: 'stale' },
            readAt === null || readAt === undefined
              ? say(t, 'strip.neverRead')
              : say(t, 'strip.lastGood', { time: fmt.clock(readAt) }),
          ),
        )
      }

      if (data !== null && data !== undefined) {
        for (const warning of data.warnings ?? []) {
          rows.push(
            h(
              'p',
              { className: warning.severity === 'warning' ? 'warning' : 'note', key: `w-${warning.code}` },
              warning.label ?? warning.code,
            ),
          )
          if (typeof warning.message === 'string' && warning.message !== '' && warning.message !== warning.label) {
            rows.push(h('p', { className: 'dim', key: `wm-${warning.code}` }, warning.message))
          }
        }
        if (data.metricContract?.ok !== true) {
          rows.push(
            h(
              'p',
              { className: 'note', key: 'contract' },
              say(t, 'strip.cannotRank', { error: data.metricContract?.error ?? say(t, 'strip.noContract') }),
            ),
          )
        }
      }

      for (const [index, note] of (overview?.notes ?? []).entries()) {
        rows.push(h('p', { className: 'note', key: `n-${index}` }, note))
      }

      return h('section', { className: 'strips' }, rows)
    }

    /**
     * The stop section: one row of gauges while the run is going, a two-column panel once it has
     * stopped — "why here" on the left, and every rule with the value it reached on the right, so
     * "which one would have been next" is answerable. The rule that fired is bold and carries a dot:
     * weight and shape, never hue (CODING_STANDARDS §2).
     */
    function RegionStop({ t, shared, overview }) {
      const fmt = shared.format
      const data = overview?.data
      if (data === null || data === undefined) {
        return h('section', { className: 'stop' }, [
          h('h2', { key: 'title' }, say(t, 'stop.title')),
          h('p', { className: 'empty', key: 'empty' }, overview?.reason ?? say(t, 'stop.noFacts')),
        ])
      }

      const stop = data.stop ?? {}
      const rules = stop.rules ?? []

      if (stop.stopped === true) {
        return h('section', { className: 'card stop' }, [
          h('h2', { key: 'title' }, say(t, 'stop.whyTitle')),
          h('div', { className: 'stop-panel', key: 'panel' }, [
            h('div', { className: 'stop-why', key: 'why' }, [
              h('p', { className: 'stop-why-rule', key: 'rule' }, stop.rule ?? fmt.EM_DASH),
              h('p', { className: 'stop-why-message', key: 'message' }, stop.message ?? say(t, 'stop.noMessage')),
              h(
                'p',
                { className: 'stop-why-reading', key: 'reading' },
                say(t, 'stop.observed', { observed: fmt.number(stop.observed), limit: fmt.number(stop.limit) }),
              ),
              h(
                'p',
                { className: 'dim', key: 'when' },
                say(t, 'stop.recorded', { time: fmt.clock(stop.atMs), seq: fmt.number(stop.eventSeq) }),
              ),
            ]),
            h(
              'div',
              { className: 'stop-rules', 'data-layout': 'panel', key: 'rules' },
              rules.map((rule) => stopRule(t, fmt, rule, { fired: rule.rule === stop.rule })),
            ),
          ]),
          ...ruleNotes(t, rules),
          h('p', { className: 'dim', key: 'every' }, say(t, 'stop.everyRule')),
        ])
      }

      return h('section', { className: 'stop' }, [
        h('h2', { key: 'title' }, say(t, 'stop.title')),
        h('div', { className: 'stop-rules', key: 'rules' }, rules.map((rule) => stopRule(t, fmt, rule))),
        h('p', { className: 'stop-summary', key: 'none' }, say(t, 'stop.noneFired')),
        ...ruleNotes(t, rules),
      ])
    }
    /**
     * The staircase: the best result after each round, the INIT baseline across it, and the round rail
     * underneath — one cell per round, one square per candidate.
     *
     * The chart and the rail share one slot model (`n+1` slots, whose width is `--reprise-slot`), so a
     * marker and the round under it cannot drift apart (spec §6.4). Every number is the projection's:
     * the series (`cumulative`), the flag that says which round raised it (`improving`), the axis, the
     * baseline, and the shape of each candidate. This surface places them.
     *
     * The chart carries a one-sentence `aria-label` and the same sentence is on screen; the same rounds
     * are expandable below as a table, because a chart cannot be read aloud.
     */
    function RegionLadder({ t, shared, rounds, conclusion, selected, onSelect }) {
      const fmt = shared.format
      const words = shared.words
      const rows = rounds?.data
      const ladder = conclusion?.data?.ladder ?? null

      if (!Array.isArray(rows) || rows.length === 0) {
        // A figure, not a card — the same component the page uses, so the dock and the sheet show one
        // design. Boxing the staircase is what made nine equal-weight panels of this page.
        return h('section', { className: 'figure' }, [
          h('h2', { key: 'title' }, say(t, 'ladder.title')),
          h('p', { className: 'empty', key: 'empty' }, rounds?.reason ?? say(t, 'ladder.noRounds')),
        ])
      }

      const metric = ladder?.metric ?? null
      const axis = ladder?.axis ?? null
      const baseline = ladder?.baseline ?? null
      // The projection distinguishes "no frozen baseline was recorded" from "the frozen baseline
      // records another metric"; the key and the sentence say which, because "not recorded" over the
      // second case would send a reader looking for a file that is right there.
      const baselineAbsent = ladder?.baselineAbsent ?? null
      const best = conclusion?.data?.best ?? null
      const slots = rows.length + 1
      const slot = 100 / slots
      const summary = ladderSentence(t, fmt, { rows, best, baseline, baselineAbsent, metric })

      const grid = h('div', { className: 'ladder', 'data-slots': String(slots), style: { '--reprise-slot': `${slot}%` } }, [
        axis === null
          ? null
          : h('div', { className: 'ladder-axis', key: 'axis' }, [axis.top, axis.middle, axis.bottom].map((bound, index) =>
              h('span', { className: 'ladder-axis-label', key: `bound-${index}` }, fmt.fixed(bound)),
            )),
        axis === null ? null : ladderPlot(t, fmt, { rows, axis, baseline, slot, summary }),
        rail(t, fmt, words, { rows, metric, slots, selected, onSelect }),
      ])

      return h('section', { className: 'figure' }, [
        h('h2', { key: 'title' }, say(t, 'ladder.title')),
        h('p', { className: 'ladder-summary', key: 'summary' }, summary),
        axis === null
          ? h('p', { className: 'note', key: 'no-axis' }, ladder?.axisAbsent ?? say(t, 'ladder.noAxis'))
          : null,
        grid,
        ladderKey(t, fmt, words, { baseline, baselineAbsent }),
        ladderTable(t, fmt, { rows, metric }),
      ])
    }

    /** The plot: the INIT baseline, the steps, the risers, and one marker per round that produced a best. */
    function ladderPlot(t, fmt, { rows, axis, baseline, slot, summary }) {
      const children = []
      if (baseline !== null) {
        children.push(
          h(
            'div',
            { className: 'ladder-baseline', key: 'baseline', style: { top: `${heightPercent(baseline.value, axis).toFixed(3)}%` } },
            [
              h(
                'span',
                { className: 'ladder-baseline-label', key: 'label' },
                say(t, 'ladder.baselineLabel', {
                  metric: baseline.metric ?? say(t, 'ladder.baseline'),
                  value: fmt.number(baseline.value),
                }),
              ),
            ],
          ),
        )
      }

      rows.forEach((entry, index) => {
        const cumulative = entry.cumulative
        if (cumulative === null || cumulative === undefined) return
        // Slot 0 is INIT, so round `index` sits in slot `index + 1`; a mark sits at the slot's centre.
        const centre = (index + 1.5) * slot
        const level = heightPercent(cumulative.value, axis)
        const previous = rows[index - 1]?.cumulative ?? null
        const tail = index === rows.length - 1 ? slot / 2 : slot

        children.push(
          h('span', {
            className: 'ladder-step',
            key: `step-${entry.round}`,
            style: { left: `${centre.toFixed(3)}%`, width: `${tail.toFixed(3)}%`, top: `${level.toFixed(3)}%` },
          }),
        )

        if (entry.improving === true && previous !== null) {
          // A running best never falls, so the riser runs from this level down to the previous one:
          // the height is one subtraction of two *placements*, and there is no "which is higher" left
          // to decide — the projection already decided it with `improving`.
          const from = heightPercent(previous.value, axis)
          children.push(
            h('span', {
              className: 'ladder-riser',
              key: `riser-${entry.round}`,
              style: {
                left: `${centre.toFixed(3)}%`,
                top: `${level.toFixed(3)}%`,
                height: `${(from - level).toFixed(3)}%`,
              },
            }),
          )
        }

        // A round that produced no comparable number gets no marker: the step runs on at the value the
        // run still held, and the gap at the slot is the fact (spec §6.4).
        if (entry.empty !== true) {
          children.push(
            h('span', {
              className: 'ladder-marker',
              key: `marker-${entry.round}`,
              'data-filled': entry.improving === true ? 'true' : 'false',
              style: { left: `${centre.toFixed(3)}%`, top: `${level.toFixed(3)}%` },
            }),
          )
        }
      })

      return h('div', { className: 'ladder-plot', role: 'img', 'aria-label': summary, key: 'plot' }, children)
    }

    /** One candidate's accessible name: who it is, what shape it is, and what it scored if it scored. */
    function candidateLabel(t, fmt, metric, candidate) {
      const shape = say(t, `shape.${candidate.shape}`)
      const score =
        candidate.value === null || candidate.value === undefined
          ? ''
          : ` · ${metric ?? say(t, 'ladder.value')} ${fmt.number(candidate.value)}`
      return `${candidate.candidate_id} · ${shape}${score}`
    }

    /** The round rail: one cell per round, one square per candidate, shapes carrying the meaning. */
    function rail(t, fmt, words, { rows, metric, slots, selected, onSelect }) {
      const cells = [
        h('div', { className: 'rail-cell', 'data-round': 'init', key: 'init' }, [
          h('div', { className: 'rail-candidates', 'data-role': 'none', key: 'squares' }),
          h('span', { className: 'rail-round', key: 'round' }, say(t, 'ladder.init')),
          h('span', { className: 'rail-verdict', 'data-verdict': 'init', key: 'verdict' }, say(t, 'ladder.baseline')),
        ]),
      ]

      for (const entry of rows) {
        const candidates = entry.candidates ?? []
        cells.push(
          h('div', { className: 'rail-cell', 'data-round': String(entry.round), 'data-verdict': entry.verdict, key: `r${entry.round}` }, [
            h(
              'div',
              { className: 'rail-candidates', key: 'squares' },
              candidates.map((candidate) =>
                h('button', {
                  type: 'button',
                  className: 'rail-candidate',
                  'data-shape': candidate.shape,
                  'aria-pressed': selected === candidate.candidate_id,
                  'aria-label': candidateLabel(t, fmt, metric, candidate),
                  title: candidateLabel(t, fmt, metric, candidate),
                  key: candidate.candidate_id,
                  onClick: () => onSelect(candidate.candidate_id),
                }),
              ),
            ),
            h('span', { className: 'rail-round', key: 'round' }, `R${entry.round}`),
            h('span', { className: 'rail-verdict', 'data-verdict': entry.verdict, key: 'verdict' }, say(t, `verdict.${entry.verdict}`)),
          ]),
        )
      }

      return h('div', { className: 'rail', 'data-slots': String(slots), key: 'rail' }, cells)
    }

    /** The key: the five shapes and the baseline line, because a shape nobody can name is decoration. */
    function ladderKey(t, fmt, words, { baseline, baselineAbsent }) {
      const key = []
      for (const shape of Object.keys(words.SHAPE_WORDS)) {
        key.push(
          h('span', { key: `shape-${shape}` }, [
            h('i', { className: 'rail-candidate', 'data-shape': shape, key: 'swatch' }),
            say(t, `shape.${shape}`),
          ]),
        )
      }
      key.push(
        baseline === null
          ? h(
              'span',
              { key: 'baseline' },
              baselineAbsent === null
                ? say(t, 'ladder.baselineMissing')
                : say(t, 'ladder.baselineMissingWhy', { why: baselineAbsent }),
            )
          : h('span', { key: 'baseline' }, [
              h('span', { className: 'ladder-key-line', key: 'line' }),
              say(t, 'ladder.keyBaseline', { value: fmt.number(baseline.value) }),
            ]),
      )
      return h('p', { className: 'ladder-key' }, key)
    }

    /** The text alternative: the same rounds as a table, because a chart cannot be read aloud. */
    function ladderTable(t, fmt, { rows, metric }) {
      const body = rows.map((entry) =>
        h('tr', { key: `row-${entry.round}` }, [
          h('td', { key: 'round' }, `R${entry.round}`),
          h('td', { key: 'verdict' }, say(t, `verdict.${entry.verdict}`)),
          h(
            'td',
            { key: 'best' },
            entry.best === null || entry.best === undefined
              ? fmt.EM_DASH
              : measurement(fmt, entry.best.candidate_id, entry.best.metric, entry.best.value),
          ),
          h(
            'td',
            { key: 'after' },
            entry.cumulative === null || entry.cumulative === undefined
              ? fmt.EM_DASH
              : measurement(fmt, entry.cumulative.candidate_id, entry.cumulative.metric, entry.cumulative.value),
          ),
          h(
            'td',
            { key: 'candidates' },
            (entry.candidates ?? [])
              .map((candidate) => `${candidate.candidate_id} ${candidate.verdict ?? candidate.status}`)
              .join(' · '),
          ),
        ]),
      )
      return h('details', { className: 'ladder-aside' }, [
        h('summary', { key: 'summary' }, say(t, 'ladder.asTable')),
        h('table', { key: 'table' }, [
          h('thead', { key: 'head' }, [
            h(
              'tr',
              null,
              ['ladder.round', 'ladder.whatHappened', 'ladder.bestInRound', 'ladder.bestAfter', 'ladder.candidates'].map((key) =>
                h('th', { key }, say(t, key)),
              ),
            ),
          ]),
          h('tbody', { key: 'body' }, body),
        ]),
        h(
          'p',
          { className: 'dim', key: 'note' },
          say(t, 'ladder.tableNote', { metric: metric ?? say(t, 'ladder.noneDeclared') }),
        ),
      ])
    }

    /**
     * The one sentence the staircase is worth — the plot's `aria-label` and the visible summary both.
     *
     * It states only what the projection published: how many rounds there were, the best result and the
     * round it was set in, and whether a baseline was recorded at all. "No baseline" is a sentence here,
     * never a zero and never an em dash.
     */
    function ladderSentence(t, fmt, { rows, best, baseline, baselineAbsent, metric }) {
      const what =
        best === null || best === undefined
          ? say(t, 'ladder.nothingYet', { rounds: rows.length, metric: metric ?? say(t, 'ladder.result') })
          : say(t, 'ladder.rise', {
              rounds: rows.length,
              metric: metric ?? say(t, 'ladder.result'),
              value: fmt.number(best.value),
              round: fmt.number(best.round),
            })
      const against =
        baseline === null
          ? baselineAbsent === null
            ? say(t, 'ladder.noBaseline')
            : say(t, 'ladder.noBaselineWhy', { why: baselineAbsent })
          : say(t, 'ladder.againstBaseline', { value: fmt.number(baseline.value) })
      return what + against
    }

    // ------------------------------------------------------------------- the tree

    /**
     * The tree's drawing grid, in CSS pixels: the page's own constants.
     *
     * Duplicated number for number on purpose, and the only duplication in this region: one stylesheet
     * draws both surfaces, and a node whose box were a different size on the panel would put every edge
     * end in the wrong place on one of them. The alternative — serving the constants from the page's
     * module — would make the panel import a renderer, which is the coupling ticket #6 removed.
     */
    const TREE_GRID = Object.freeze({ column: 184, row: 108, nodeWidth: 160, nodeHeight: 82, header: 22 })

    /** `R2` in the dictionary's words — the same string the page prints. */
    function treeRound(t, fmt, round) {
      return say(t, 'tree.round', { n: fmt.number(round) })
    }

    /**
     * Why this node has no child, in the fewest words that stay true.
     *
     * The projection published the kind and the round; this turns it into one scannable line. The full
     * sentence (with the rotation and the slot count) is the node's title and accessible name.
     */
    function treeWhy(t, fmt, tree, node) {
      const continuation = node.continuation ?? { kind: 'unknown' }
      switch (continuation.kind) {
        case 'continued':
          return node.children.length === 1
            ? say(t, 'tree.why.continuedOne', { child: node.children[0] })
            : say(t, 'tree.why.continuedMany', { count: fmt.number(node.children.length) })
        case 'rejected':
          return say(t, 'tree.why.rejected', { phase: node.rejection?.phase ?? say(t, 'tree.aGate') })
        case 'in-flight':
          return say(t, 'tree.why.inFlight')
        case 'passed-over':
          return say(t, 'tree.why.passedOver', { round: treeRound(t, fmt, continuation.round) })
        case 'roster-unused':
          return say(t, 'tree.why.rosterUnused', { round: treeRound(t, fmt, continuation.round) })
        case 'off-frontier':
          return say(t, 'tree.why.offFrontier', { round: treeRound(t, fmt, continuation.round) })
        case 'no-roster':
          return say(t, 'tree.why.noRoster', { round: treeRound(t, fmt, continuation.round) })
        case 'no-later-round':
          return tree.stop?.stopped === true ? say(t, 'tree.why.noLaterRoundStopped') : say(t, 'tree.why.noLaterRound')
        case 'root':
          return say(t, 'tree.root')
        default:
          // A kind this panel has not learnt yet reads as its own name rather than vanishing.
          return continuation.kind ?? ''
      }
    }

    /**
     * The whole sentence a node carries as its tooltip and accessible name: who it is, where it sits,
     * what it measured, and why it has no child.
     */
    function treeReason(t, fmt, tree, node) {
      const metric = tree.metric ?? 'value'
      const continuation = node.continuation ?? { kind: 'unknown' }
      const parts = [node.candidate_id]
      parts.push(node.shape === null || node.shape === undefined ? say(t, 'tree.baseline') : say(t, `shape.${node.shape}`))
      if (node.value !== null && node.value !== undefined) parts.push(`${metric} ${fmt.number(node.value)}`)
      // A root that is not the baseline: a person proposed it, or the run predates parent selection.
      if (node.parent === null && node.candidate_id !== 'baseline') parts.push(say(t, 'tree.noParent'))
      if (continuation.kind === 'root') {
        parts.push(say(t, 'tree.reason.fromBaseline'))
        return parts.join(' · ')
      }
      const parents =
        continuation.slots === null || continuation.slots === undefined
          ? ''
          : say(t, 'tree.parents', { n: fmt.number(continuation.slots) })
      const rotation =
        continuation.offset === null || continuation.offset === undefined
          ? ''
          : say(t, 'tree.rotation', {
              axis: continuation.axis ?? say(t, 'tree.axis'),
              offset: fmt.number(continuation.offset),
            })
      switch (continuation.kind) {
        case 'continued':
          parts.push(say(t, 'tree.reason.continued', { children: node.children.join(', ') }))
          break
        case 'rejected':
          parts.push(
            say(t, 'tree.reason.rejected', {
              phase: node.rejection?.phase ?? say(t, 'tree.aGate'),
              message: node.rejection?.message ?? say(t, 'tree.noMessage'),
            }),
          )
          break
        case 'in-flight':
          parts.push(say(t, 'tree.reason.inFlight'))
          break
        case 'passed-over':
          parts.push(say(t, 'tree.reason.passedOver', { round: fmt.number(continuation.round), parents, rotation }))
          break
        case 'roster-unused':
          parts.push(say(t, 'tree.reason.rosterUnused', { round: fmt.number(continuation.round) }))
          break
        case 'off-frontier':
          parts.push(say(t, 'tree.reason.offFrontier', { round: fmt.number(continuation.round) }))
          break
        case 'no-roster':
          parts.push(say(t, 'tree.reason.noRoster', { round: fmt.number(continuation.round) }))
          break
        case 'no-later-round':
          parts.push(
            tree.stop?.stopped === true
              ? say(t, 'tree.reason.noLaterRoundStopped', { rule: tree.stop.rule ?? say(t, 'tree.aRecordedRule') })
              : say(t, 'tree.reason.noLaterRound'),
          )
          break
        default:
          parts.push(continuation.kind)
          break
      }
      return parts.join(' · ')
    }

    /**
     * Where every node sits: columns by round, rows below the parent.
     *
     * The same rule the page uses, in the same order (round, then id), so the two surfaces draw the same
     * picture from the same facts. A candidate with no parent is a root in its own round and starts a
     * fresh row; the tree does not invent an edge to the baseline.
     */
    function treeLayout(tree) {
      const columns = [0, ...tree.rounds.map((entry) => entry.round)]
      const columnOf = new Map(columns.map((round, index) => [round, index]))
      const placed = new Map()
      const used = new Set()
      const place = (candidateId, column, row) => {
        placed.set(candidateId, { column, row })
        used.add(`${column}|${row}`)
      }
      place(tree.baseline.candidate_id, 0, 0)
      const ordered = [...tree.nodes].sort(
        (left, right) => (left.round ?? 0) - (right.round ?? 0) || (left.candidate_id < right.candidate_id ? -1 : 1),
      )
      for (const node of ordered) {
        const column = columnOf.get(node.round ?? 0) ?? 0
        const parent = node.parent === null ? undefined : placed.get(node.parent)
        let row = parent === undefined ? 1 : parent.row + 1
        while (used.has(`${column}|${row}`)) row += 1
        place(node.candidate_id, column, row)
      }
      return { columns, placed }
    }

    /** Where a node's box goes, and where an edge should leave and enter it. */
    function treeBox({ column, row }) {
      return {
        left: column * TREE_GRID.column + (TREE_GRID.column - TREE_GRID.nodeWidth) / 2,
        top: TREE_GRID.header + row * TREE_GRID.row,
      }
    }

    /**
     * Every way a branch can end, in the order the summary prints them.
     *
     * All of them are counted and a kind with no node is skipped, so the parts add up to the candidate
     * count beside them. The page prints the same list in the same order — a summary that dropped a
     * kind would be the fastest way to make a reader distrust the picture.
     */
    const TREE_COUNT_KEYS = Object.freeze({
      continued: 'tree.count.continued',
      'passed-over': 'tree.count.passed-over',
      rejected: 'tree.count.rejected',
      'in-flight': 'tree.count.in-flight',
      'roster-unused': 'tree.count.roster-unused',
      'off-frontier': 'tree.count.off-frontier',
      'no-roster': 'tree.count.no-roster',
      'no-later-round': 'tree.count.no-later-round',
    })

    /**
     * The search as a tree: one column per round, one node per candidate, the edges the planner wrote.
     *
     * The region that answers a question no other region can — which branch the search carried forward,
     * and why each one it left behind ended. The reasons are the projection's (`continuation.kind`);
     * this surface chooses words and geometry and nothing else. Clicking a node opens it in the
     * inspector; the baseline is drawn but not clickable, because it has no facts of its own.
     */
    function RegionTree({ t, shared, tree, selected, onSelect }) {
      const fmt = shared.format
      const words = shared.words
      const data = tree?.data
      const title = h('h2', { key: 'title' }, say(t, 'tree.title'))

      if (data === null || data === undefined) {
        return h('section', { className: 'figure' }, [
          title,
          h('p', { className: 'empty', key: 'empty' }, tree?.reason ?? say(t, 'tree.empty')),
        ])
      }
      const notes = (data.notes ?? []).map((note, index) => h('p', { className: 'note', key: `note-${index}` }, note))
      if (data.nodes.length === 0) {
        return h('section', { className: 'figure' }, [title, ...notes, h('p', { className: 'empty', key: 'empty' }, say(t, 'tree.noCandidates'))])
      }

      const base = say(t, 'tree.summary', {
        rounds: fmt.number(data.rounds.length),
        candidates: fmt.number(data.nodes.length),
        edges: fmt.number(data.edges.length),
      })
      // The projection counted and ordered the kinds; this only chooses the words.
      const counted = (data.counts ?? []).map(({ kind, count }) =>
        Object.hasOwn(TREE_COUNT_KEYS, kind)
          ? say(t, TREE_COUNT_KEYS[kind], { n: fmt.number(count) })
          : `${fmt.number(count)} ${kind}`,
      )
      const summary =
        counted.length === 0 ? `${base}.` : say(t, 'tree.summaryWithCounts', { summary: base, counts: counted.join(' · ') })

      const { columns, placed } = treeLayout(data)
      let deepest = 0
      for (const entry of placed.values()) if (entry.row > deepest) deepest = entry.row
      const width = columns.length * TREE_GRID.column
      const height = TREE_GRID.header + (deepest + 1) * TREE_GRID.row

      const heads = columns.map((round, index) =>
        h(
          'span',
          {
            className: 'tree-column',
            key: `column-${index}`,
            style: { left: index * TREE_GRID.column, width: TREE_GRID.column },
          },
          index === 0 ? say(t, 'ladder.init') : treeRound(t, fmt, round),
        ),
      )

      const edges = h(
        'svg',
        { className: 'tree-edges', key: 'edges', width, height, 'aria-hidden': 'true' },
        data.edges.map((edge) => {
          const from = placed.get(edge.from)
          const to = placed.get(edge.to)
          if (from === undefined || to === undefined) return null
          const start = treeBox(from)
          const end = treeBox(to)
          const x1 = start.left + TREE_GRID.nodeWidth / 2
          const y1 = start.top + TREE_GRID.nodeHeight
          const x2 = end.left + TREE_GRID.nodeWidth / 2
          const y2 = end.top
          return h('path', {
            className: 'tree-edge',
            key: `${edge.from}->${edge.to}`,
            d: `M ${x1} ${y1} C ${x1} ${y1 + 26}, ${x2} ${y2 - 26}, ${x2} ${y2}`,
            'data-from': edge.from,
            'data-to': edge.to,
          })
        }),
      )

      const nodes = [data.baseline, ...data.nodes].map((node) => {
        const at = placed.get(node.candidate_id)
        if (at === undefined) return null
        const box = treeBox(at)
        const root = node.shape === null
        const name = treeReason(t, fmt, data, node)
        const style = { left: box.left, top: box.top, width: TREE_GRID.nodeWidth, height: TREE_GRID.nodeHeight }
        const children = [
          h('span', { className: 'tree-node-head', key: 'head' }, [
            h('i', {
              className: 'rail-candidate tree-node-shape',
              key: 'shape',
              'data-shape': root ? 'baseline' : node.shape,
            }),
            h('span', { className: 'tree-node-id', key: 'id' }, node.candidate_id),
          ]),
          h(
            'span',
            { className: 'tree-node-value', key: 'value' },
            node.value === null || node.value === undefined
              ? fmt.EM_DASH
              : `${node.metric ?? data.metric ?? 'value'} ${fmt.number(node.value)}`,
          ),
          h('span', { className: 'tree-node-why', key: 'why' }, treeWhy(t, fmt, data, node)),
        ]
        if (root) {
          // The root has no facts of its own: a button that opens nothing is a trap.
          return h('div', { className: 'tree-node', key: node.candidate_id, 'data-shape': 'baseline', style, title: name }, children)
        }
        return h(
          'button',
          {
            type: 'button',
            className: 'tree-node',
            key: node.candidate_id,
            'data-shape': node.shape,
            'data-continuation': node.continuation?.kind ?? 'unknown',
            style,
            title: name,
            'aria-label': name,
            'aria-pressed': selected === node.candidate_id ? 'true' : 'false',
            onClick: () => onSelect(node.candidate_id),
          },
          children,
        )
      })

      const key = h(
        'p',
        { className: 'ladder-key', key: 'key' },
        Object.keys(words.SHAPE_WORDS).map((shape) =>
          h('span', { key: `shape-${shape}` }, [
            h('i', { className: 'rail-candidate', key: 'swatch', 'data-shape': shape }),
            say(t, `shape.${shape}`),
          ]),
        ),
      )

      return h('section', { className: 'figure' }, [
        title,
        ...notes,
        h('p', { className: 'tree-summary', key: 'summary' }, summary),
        h('div', { className: 'tree-map', key: 'map', style: { width, height } }, [...heads, edges, ...nodes]),
        key,
        h('p', { className: 'tree-key-note', key: 'key-note' }, say(t, 'tree.keyNote')),
      ])
    }

    /**
     * The readings row (spec §6.6): rounds, candidates, GPU hours with the budget bar, the frontier, and
     * what the run occupies on a shared cluster.
     *
     * Every number is the projection's, including the three shares of the bar; this surface decides only
     * how to say them. Two cells can be "unknown" — the cluster a page could not ask, and the floor its
     * own ledger cannot compute — and both say so in words, because "0 cards" is an answer somebody acts
     * on. Who is *waiting*, and why, is named here too: a count with no cause cannot be acted on either.
     */
    function RegionReadings({ t, shared, overview }) {
      const fmt = shared.format
      const data = overview?.data
      if (data === null || data === undefined) {
        return h('dl', { className: 'readings' }, [
          h('div', { className: 'reading', key: 'empty' }, [
            h('dt', { className: 'reading-label', key: 'label' }, say(t, 'readings.title')),
            h('dd', { className: 'reading-sub', key: 'sub' }, overview?.reason ?? say(t, 'readings.noFacts')),
          ]),
        ])
      }

      const rounds = data.rounds
      const candidates = data.candidates
      const spend = data.spend
      const frontier = data.frontier ?? {}
      const cluster = data.cluster ?? {}
      const cards = cluster.cards ?? {}
      const queue = cluster.queue ?? {}

      const clusterSubs = []
      if (cluster.read === true) {
        clusterSubs.push(
          say(t, 'readings.clusterLedger', { jobs: (cluster.jobs?.open ?? []).length, cards: fmt.number(cards.perJob) }),
        )
      } else if (cards.floor === null) {
        clusterSubs.push(cards.floorAbsent ?? say(t, 'readings.floorAbsent'))
      } else {
        clusterSubs.push(say(t, 'readings.clusterFloor', { cards: fmt.number(cards.floor) }))
      }
      if (cluster.read !== true && cluster.reason) clusterSubs.push(cluster.reason)

      const waiting = queue.waiting ?? []

      return h('dl', { className: 'readings' }, [
        reading(
          say(t, 'readings.rounds'),
          h('span', { className: 'reading-value', key: 'value' }, fmt.number(rounds.completed)),
          say(t, 'readings.roundsUnit'),
          [
            rounds.total === 0 ? say(t, 'readings.noRound') : say(t, 'readings.currentRound', { n: fmt.number(rounds.current) }),
            say(t, 'readings.emptyStreak', { n: fmt.number(rounds.emptyStreak) }),
          ],
          [],
          'rounds',
        ),
        reading(
          say(t, 'readings.candidates'),
          h('span', { className: 'reading-value', key: 'value' }, fmt.number(candidates.total)),
          undefined,
          [
            say(t, 'readings.candidatesSub', {
              done: fmt.number(candidates.done),
              rejected: fmt.number(candidates.rejected),
              flying: fmt.number(candidates.inFlight.length),
            }),
          ],
          [
            h(
              'ul',
              { className: 'reading-list', key: 'list' },
              candidates.inFlight.map((candidateId) => h('li', { key: candidateId }, candidateId)),
            ),
          ],
          'candidates',
        ),
        reading(
          say(t, 'readings.gpu'),
          budgetBar(t, fmt, spend) ?? h('span', { className: 'reading-value', key: 'value' }, fmt.number(spend?.settledGpuHours)),
          undefined,
          [
            say(t, 'readings.reserved', { n: fmt.number(spend?.budget?.reservedUnsettledGpuHours) }),
            say(t, 'readings.tokens', { n: fmt.number(spend?.tokens) }),
          ],
          [],
          'gpu',
        ),
        reading(
          say(t, 'readings.frontier'),
          h('span', { className: 'reading-value', key: 'value' }, fmt.number(frontier.size)),
          say(t, 'readings.frontierUnit'),
          [
            say(t, 'readings.objectives', { n: fmt.number(frontier.objectives?.length) }),
            frontier.primary === null || frontier.primary === undefined
              ? say(t, 'readings.primaryNone')
              : say(t, 'readings.primary', { metric: frontier.primary }),
          ],
          [
            h(
              'ul',
              { className: 'reading-list', key: 'list' },
              (frontier.readings ?? []).map((member) =>
                h('li', { key: member.candidate_id }, measurement(fmt, member.candidate_id, frontier.primary, member.value)),
              ),
            ),
          ],
          'frontier',
        ),
        reading(
          say(t, 'readings.cluster'),
          h('span', { className: 'reading-value', key: 'value' }, cardsInUse(t, cluster)),
          say(t, 'readings.clusterUnit'),
          clusterSubs,
          [
            h('dd', { className: 'reading-sub', key: 'waiting' }, say(t, 'readings.waiting', { n: fmt.number(queue.count) })),
            waiting.length === 0
              ? null
              : h(
                  'ul',
                  { className: 'reading-list', key: 'waiters' },
                  waiting.map((entry) =>
                    h(
                      'li',
                      { key: entry.candidate_id },
                      `${entry.candidate_id} — ${
                        entry.reason === null || entry.reason === undefined
                          ? say(t, 'hold.none')
                          : wordFor(t, 'hold', entry.reason)
                      }`,
                    ),
                  ),
                ),
          ],
          'cluster',
        ),
      ])
    }

    /**
     * The budget bar: settled (solid), reserved but not yet settled (hatch), and what is left of the cap.
     *
     * The three materials and two markers all arrive as percentages, because a surface that divided two
     * GPU-hour readings would be a second derivation of a number the page also prints. They are a fill, a
     * hatch and an emptiness rather than three colours: the bar has to survive a greyscale screenshot.
     */
    function budgetBar(t, fmt, spend) {
      const budget = spend?.budget
      if (budget === undefined || budget === null) return null
      if (budget.scaleGpuHours === null) {
        return h('p', { className: 'reading-sub', key: 'nobar' }, say(t, 'budget.nothingSpent'))
      }

      const key = (material, word, marker) =>
        h('span', { className: 'budget-key', key: `key-${material}` }, [
          h('i', marker === undefined ? { 'data-material': material, key: 'swatch' } : { 'data-marker': marker, key: 'swatch' }),
          word,
        ])

      const legend = [
        key('settled', say(t, 'budget.settled', { n: fmt.number(spend.settledGpuHours) })),
        key('reserved', say(t, 'budget.reserved', { n: fmt.number(budget.reservedUnsettledGpuHours) })),
        budget.limited ? key('remaining', say(t, 'budget.remaining', { n: fmt.number(budget.remainingGpuHours) })) : null,
        budget.limited && budget.softLimitPercent !== null
          ? key('soft', say(t, 'budget.soft', { n: fmt.number(spend.softLimitGpuHours) }), 'soft')
          : null,
        budget.limited
          ? key('limit', say(t, 'budget.cap', { n: fmt.number(spend.limitGpuHours) }), 'limit')
          : h('span', { className: 'budget-key', key: 'key-nocap' }, say(t, 'budget.noCap')),
      ]

      return h('div', { className: 'budget', key: 'budget' }, [
        h('div', { className: 'budget-head', key: 'head' }, [
          h('span', { className: 'reading-value', key: 'value' }, fmt.number(spend.settledGpuHours)),
          h(
            'span',
            { className: 'reading-unit', key: 'unit' },
            budget.limited
              ? say(t, 'readings.gpuUnit', { limit: fmt.number(spend.limitGpuHours) })
              : say(t, 'readings.gpuUnitUnlimited'),
          ),
        ]),
        h('div', { className: 'budget-track', key: 'track' }, [
          h('span', {
            className: 'budget-segment',
            'data-material': 'settled',
            key: 'settled',
            style: { width: `${fmt.number(budget.settledPercent)}%` },
          }),
          h('span', {
            className: 'budget-segment',
            'data-material': 'reserved',
            key: 'reserved',
            style: { width: `${fmt.number(budget.reservedPercent)}%` },
          }),
          h('span', {
            className: 'budget-segment',
            'data-material': 'remaining',
            key: 'remaining',
            style: { width: `${fmt.number(budget.remainingPercent)}%` },
          }),
          budget.softLimitPercent === null
            ? null
            : h('span', {
                className: 'budget-marker',
                'data-marker': 'soft',
                key: 'soft',
                style: { left: `${fmt.number(budget.softLimitPercent)}%` },
              }),
          budget.limited
            ? h('span', { className: 'budget-marker', 'data-marker': 'limit', key: 'limit', style: { left: '100%' } })
            : null,
        ]),
        h('p', { className: 'budget-legend', key: 'legend' }, legend),
      ])
    }

    /** The metric readings a candidate carries, in one line: the primary first, then the rest by name. */
    function measuredText(t, fmt, detail) {
      const vector = detail.frontier.vector ?? {}
      const primary = detail.frontier.best?.metric ?? null
      const names = Object.keys(vector).sort((left, right) => {
        if (left === primary) return -1
        if (right === primary) return 1
        return left < right ? -1 : left > right ? 1 : 0
      })
      if (names.length === 0) return say(t, 'candidate.noMetric')
      return say(t, 'candidate.measured', {
        readings: names.map((name) => measurement(fmt, null, name, vector[name])).join(' '),
      })
    }

    /**
     * Who this candidate is: its id, its round, the shape word the rail draws for it, its job and what it
     * was measured at — then the hypothesis it was created to test.
     *
     * The shape word is the dictionary's, pinned to `states.js` by a test, so the square over the round
     * and the sentence here cannot call one candidate two things. Nothing in this row says whether the
     * news is good: "in flight", "rejected" and "invalid artifact" are facts about where it got to.
     */
    function identityRow({ t, fmt, words, detail }) {
      const job = detail.job
      const meta =
        job === null || job === undefined
          ? say(t, 'candidate.noJob')
          : `${say(t, 'candidate.job', { id: job.job_id, state: job.state, n: fmt.number(job.attempts) })}${
              job.error_class === null || job.error_class === undefined ? '' : ` · ${job.error_class}`
            }`

      const children = [
        h('div', { className: 'identity-line', key: 'line' }, [
          h('span', { className: 'identity-id', key: 'id' }, detail.candidate_id),
          h(
            'span',
            { className: 'identity-round', key: 'round' },
            detail.round === null || detail.round === undefined
              ? say(t, 'candidate.noRound')
              : say(t, 'candidate.round', { n: fmt.number(detail.round) }),
          ),
          h('span', { className: 'identity-shape', key: 'shape' }, say(t, `shape.${detail.shape}`) === `shape.${detail.shape}` ? detail.shape ?? fmt.EM_DASH : say(t, `shape.${detail.shape}`)),
        ]),
        h('p', { className: 'identity-meta', key: 'meta' }, `${meta} · ${measuredText(t, fmt, detail)}`),
        typeof detail.hypothesis === 'string' && detail.hypothesis !== ''
          ? h('p', { className: 'identity-hypothesis', key: 'hypothesis' }, detail.hypothesis)
          : h('p', { className: 'identity-hypothesis dim', key: 'hypothesis' }, say(t, 'candidate.noHypothesis')),
      ]

      if (detail.lag.pending > 0) {
        children.push(
          h('p', { className: 'note', key: 'lag' }, say(t, 'candidate.lag', { n: fmt.number(detail.lag.pending) })),
        )
      }
      return h('div', { className: 'identity', key: 'identity' }, children)
    }

    /**
     * The whole path, all eight phases, drawn from the projection.
     *
     * Every phase carries a mark **and** the word for it: the mark is for the reader scanning the row,
     * the word for the reader who cannot tell a dashed square from a hatched one — which is also what
     * makes the four states survive a greyscale screenshot. The order is the payload's; a list kept here
     * would be a second order to drift from the kernel's.
     */
    function phasePathRow({ t, fmt, words, detail }) {
      const running = detail.status === 'active'
      const items = (detail.phasePath ?? []).map((step) => {
        const mark = words.phaseMark({ status: step.status, reached: step.reached })
        const word = words.STATE_ORDER.includes(mark.mark) ? say(t, `state.${mark.mark}`) : say(t, `mark.${mark.mark}`)
        const here = running && step.current === true
        const children = [
          h('span', { className: 'phase-mark', 'aria-hidden': 'true', key: 'mark' }),
          h('span', { className: 'phase-name', key: 'name' }, step.phase),
          h('span', { className: 'phase-word', key: 'word' }, word),
        ]
        if (here) children.push(h('span', { className: 'phase-here', key: 'here' }, say(t, 'candidate.here')))
        if (Number.isSafeInteger(step.seq)) {
          children.push(
            h('span', { className: 'phase-stamp', key: 'stamp' }, `${seqStamp(step.seq)} ${fmt.clock(step.atMs)}`),
          )
        }
        return h(
          'li',
          { className: 'phase', 'data-mark': mark.mark, 'data-current': here ? 'true' : 'false', key: step.phase },
          children,
        )
      })
      return h('section', { className: 'inspector-section', key: 'phases' }, [
        h('h3', { key: 'title' }, say(t, 'candidate.phases')),
        h('ol', { className: 'phase-path', key: 'path' }, items),
      ])
    }

    /**
     * Why it stopped: the original words, and the fact that recorded them.
     *
     * No four-state badge here (CODING_STANDARDS §2): the four states answer "is this fact present and
     * trustworthy", and "the answer was no" is a decision made *from* them. The phase path above already
     * carries the state word at the phase it was decided at. The words are verbatim — a `<pre>`, never a
     * paraphrase — because this is the message a future reader compares against the artifact.
     */
    function rejectionBlock({ t, fmt, rejection, verdictStep }) {
      const children = [
        h(
          'h3',
          { className: 'rejection-title', key: 'title' },
          rejection.phase === null || rejection.phase === undefined
            ? say(t, 'candidate.rejection')
            : say(t, 'candidate.rejectionAt', { phase: rejection.phase }),
        ),
        rejection.message === null || rejection.message === undefined || rejection.message === ''
          ? h('p', { className: 'dim', key: 'words' }, say(t, 'candidate.noMessage'))
          : h('pre', { className: 'rejection-words', key: 'words' }, rejection.message),
      ]

      if (rejection.reason !== undefined && rejection.reason !== rejection.message) {
        children.push(
          h('p', { className: 'rejection-reason', key: 'reason' }, [
            h('span', { className: 'dim', key: 'label' }, say(t, 'candidate.decision')),
            h('span', { key: 'value' }, rejection.reason),
          ]),
        )
      }

      children.push(
        h(
          'p',
          { className: 'rejection-when dim', key: 'when' },
          say(t, 'candidate.recorded', {
            time: fmt.clock(rejection.atMs),
            event: rejection.eventType,
            seq: seqStamp(rejection.seq),
          }),
        ),
      )

      // The gate said something too, and it is a different fact from the decision: the schema error,
      // the missing artifact, the two numbers that disagree. Both are printed, each with its own seq.
      if (verdictStep !== undefined && typeof verdictStep.message === 'string' && verdictStep.message !== '') {
        children.push(
          h('p', { className: 'rejection-reason dim', key: 'gate' }, [
            say(t, 'candidate.gateSaid', { phase: verdictStep.phase }),
            `${seqStamp(verdictStep.seq)} ${fmt.clock(verdictStep.atMs)} (${verdictStep.eventType})`,
          ]),
          h('pre', { className: 'rejection-words', key: 'gatewords' }, verdictStep.message),
        )
      }

      if (rejection.terminal !== undefined) {
        children.push(
          h(
            'p',
            { className: 'rejection-when dim', key: 'decided' },
            say(t, 'candidate.decided', {
              time: fmt.clock(rejection.terminal.atMs),
              event: rejection.terminal.eventType,
              seq: seqStamp(rejection.terminal.seq),
            }),
          ),
        )
      }

      return h('section', { className: 'rejection', key: 'rejection' }, children)
    }

    /** Ticket 29's gate chain: passed / failed / missing, where missing is not failed. */
    function chainBlock({ t, fmt, detail }) {
      const chain = detail.gateChain
      if (chain === undefined || chain.chain.length === 0) return null

      const rows = chain.chain.map((step) =>
        h('li', { key: step.name }, [
          h('span', { className: 'badge', 'data-state': step.status, key: 'badge' }, step.status),
          h('span', { key: 'name' }, ` ${step.name}${step.detail === '' ? '' : ` — ${step.detail}`}`),
        ]),
      )
      const children = [h('h3', { key: 'title' }, say(t, 'candidate.chain')), h('ul', { key: 'list' }, rows)]
      if (chain.attempts.length > 0) {
        children.push(
          h(
            'p',
            { className: 'dim', key: 'attempts' },
            say(t, 'candidate.attempts', {
              list: chain.attempts
                .map((attempt) =>
                  attempt.review === null
                    ? say(t, 'candidate.attempt', {
                        n: attempt.attempt,
                        outcome: say(t, attempt.passed === true ? 'candidate.passed' : 'candidate.failed'),
                      })
                    : say(t, 'candidate.attemptReview', {
                        n: attempt.attempt,
                        outcome: say(t, attempt.passed === true ? 'candidate.passed' : 'candidate.failed'),
                        verdict: attempt.review.verdict,
                      }),
                )
                .join(' · '),
            }),
          ),
        )
      }
      return h('section', { className: 'inspector-section', key: 'chain' }, children)
    }

    /** The facts that got it here: time, type, summary and `#seq`, newest first. */
    function timelineBlock({ t, fmt, timeline }) {
      const recent = (timeline ?? []).slice(-9).reverse()
      if (recent.length === 0) return null
      const items = recent.map((event) =>
        h('li', { key: event.seq }, [
          h('span', { className: 'timeline-time', key: 'time' }, fmt.clock(event.atMs)),
          h('span', { className: 'timeline-type', key: 'type' }, event.eventType),
          h('span', { className: 'timeline-summary', key: 'summary' }, event.summary === '' ? fmt.EM_DASH : event.summary),
          h('span', { className: 'timeline-stamp', key: 'stamp' }, seqStamp(event.seq)),
        ]),
      )
      return h('section', { className: 'inspector-section', key: 'timeline' }, [
        h('h3', { key: 'title' }, say(t, 'candidate.timeline', { n: recent.length })),
        h('ol', { className: 'timeline', key: 'list' }, items),
      ])
    }

    /**
     * Everything else the fact plane recorded about this candidate, collapsed.
     *
     * The frontier position, the identity bindings and the artifact names are reference material: a
     * reader checking a claim opens them, a reader deciding whether to believe the run does not. They
     * stay — removing them would make this inspector weaker than the `dump` it mirrors — but they do not
     * cost a screen by default.
     */
    function asideBlock({ t, fmt, detail }) {
      const body = [
        h('p', { key: 'position' }, detail.frontier.position === 'frontier' ? say(t, 'candidate.frontier') : say(t, 'candidate.frontierPosition', { position: detail.frontier.position })),
        h('p', { className: 'dim', key: 'vector' }, say(t, 'candidate.vector', { json: JSON.stringify(detail.frontier.vector) })),
        h(
          'p',
          { className: 'dim', key: 'best' },
          detail.frontier.best === undefined
            ? say(t, 'candidate.noBest')
            : say(t, 'candidate.best', {
                reading: measurement(fmt, detail.frontier.best.candidate_id, detail.frontier.best.metric, detail.frontier.best.value),
              }),
        ),
      ]

      const bindingKinds = Object.keys(detail.bindings).sort()
      if (bindingKinds.length > 0) {
        body.push(
          h('h3', { key: 'bindings-title' }, say(t, 'candidate.bindings')),
          h(
            'pre',
            { key: 'bindings' },
            bindingKinds.map((kind) => `${kind} ${JSON.stringify(detail.bindings[kind])}`).join('\n'),
          ),
        )
      }
      if (detail.artifacts.length > 0) {
        body.push(
          h('h3', { key: 'artifacts-title' }, say(t, 'candidate.artifacts')),
          h('pre', { key: 'artifacts' }, detail.artifacts.join('\n')),
        )
      }

      return h('details', { className: 'inspector-aside', key: 'aside' }, [
        h('summary', { key: 'summary' }, say(t, 'candidate.aside')),
        h('div', { className: 'inspector-aside-body', key: 'body' }, body),
      ])
    }

    /**
     * The candidate inspector: identity, the path it walked, why it stopped, the gate chain, and the
     * facts that got it there — the order a reader asks the questions in.
     *
     * Nothing here decides anything: the path, the shape word, the four-state marks and the rejection
     * text arrive from the projection, and this surface lays them out.
     */
    function RegionInspector({ t, shared, candidate, selected }) {
      const fmt = shared.format
      const words = shared.words
      const title = selected === null ? say(t, 'candidate.title') : say(t, 'candidate.titleFor', { id: selected })

      if (selected === null) {
        return h('section', { className: 'card' }, [
          h('h2', { key: 'title' }, title),
          h('p', { className: 'empty', key: 'empty' }, say(t, 'candidate.empty')),
        ])
      }

      const detail = candidate?.data
      if (detail === null || detail === undefined) {
        return h('section', { className: 'card' }, [
          h('h2', { key: 'title' }, title),
          h('p', { className: 'empty', key: 'empty' }, candidate?.reason ?? say(t, 'candidate.noFacts')),
        ])
      }

      const children = [h('h2', { key: 'title' }, title), identityRow({ t, fmt, words, detail }), phasePathRow({ t, fmt, words, detail })]

      if (detail.rejection !== undefined) {
        const verdictStep = (detail.phasePath ?? []).find(
          (step) => step.phase === detail.rejection.phase && step.message !== null && step.message !== detail.rejection.message,
        )
        children.push(rejectionBlock({ t, fmt, rejection: detail.rejection, verdictStep }))
      }

      const chain = chainBlock({ t, fmt, detail })
      if (chain !== null) children.push(chain)
      children.push(timelineBlock({ t, fmt, timeline: detail.timeline }), asideBlock({ t, fmt, detail }))

      return h('section', { className: 'card' }, children)
    }

    /**
     * The audit: every judgement the run asked a model for, folded into one line until asked.
     *
     * It answers "what did it ask the model, and what came back" — the same kind of thing as the fact
     * stream beside it, and the thing nobody reads while skimming. So it costs one line; opening it
     * lists the call sites and the `ref` of each call, and opening one call asks the server for that
     * record instead of carrying a hundred prompts in the list.
     *
     * The open state is React state (not derived from the payload) on purpose: a poll every five
     * seconds that snapped the audit shut would be worse than one that never opened.
     */
    function RegionAudit({ t, shared, calls, open, onToggle, openRef, openRecord, onOpenCall }) {
      const fmt = shared.format
      const data = calls?.data
      const list = data?.calls ?? []

      const children = [
        h('summary', { className: 'audit-line', key: 'summary' }, [
          h('span', { key: 'title' }, say(t, 'audit.title')),
          h('span', { className: 'audit-count', key: 'count' }, fmt.number(list.length)),
        ]),
      ]

      if (data === undefined || data === null || list.length === 0) {
        children.push(h('p', { className: 'empty', key: 'empty' }, calls?.reason ?? data?.reason ?? say(t, 'audit.empty')))
      } else {
        // Call sites first, because the interesting question is usually "was the gate asked anything".
        const sorted = [...list].sort((left, right) => {
          const where = String(left.call_site ?? '').localeCompare(String(right.call_site ?? ''))
          return where !== 0 ? where : String(left.ref).localeCompare(String(right.ref))
        })
        children.push(
          h(
            'ul',
            { className: 'calls', key: 'calls' },
            sorted.map((call) =>
              h('li', { key: call.ref }, [
                h('span', { className: 'call-site', key: 'site' }, call.call_site ?? '?'),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'call-ref',
                    'aria-pressed': openRef === call.ref,
                    key: 'ref',
                    onClick: () => onOpenCall(call.ref),
                  },
                  call.ref,
                ),
                h('span', { className: 'dim', key: 'status' }, call.status ?? ''),
              ]),
            ),
          ),
        )
      }

      if (openRecord !== null) {
        if (openRecord.reason !== undefined) {
          children.push(
            h(
              'p',
              { className: 'note', key: 'gone' },
              openRecord.reason === 'gone' ? say(t, 'audit.gone') : openRecord.reason,
            ),
          )
        } else {
          children.push(
            h('h3', { key: 'ref' }, openRecord.ref),
            h(
              'p',
              { className: 'dim', key: 'meta' },
              openRecord.error_class === null || openRecord.error_class === undefined
                ? say(t, 'audit.site', { site: openRecord.call_site ?? '?', status: openRecord.status })
                : say(t, 'audit.withError', {
                    site: openRecord.call_site ?? '?',
                    status: openRecord.status,
                    error: openRecord.error_class,
                  }),
            ),
            openRecord.message === null ? null : h('p', { className: 'note', key: 'message' }, openRecord.message),
            h('h3', { key: 'prompt-title' }, say(t, 'audit.prompt')),
            h('pre', { key: 'prompt' }, openRecord.prompt),
            h('h3', { key: 'response-title' }, say(t, 'audit.response')),
            h(
              'pre',
              { key: 'response' },
              openRecord.response === '' ? say(t, 'audit.emptyResponse') : openRecord.response,
            ),
          )
        }
      }

      return h(
        'section',
        { className: 'card' },
        [h('details', { className: 'audit', open: open === true, onToggle: (event) => onToggle(event.currentTarget.open), key: 'details' }, children)],
      )
    }

    /**
     * The fact stream: what just happened, newest first, one row per fact.
     *
     * Each row is two lines — `22:14:40 gate_result r6-g1 #9` over the one-line summary — because a
     * reader scanning the column is looking for a time, an event and a candidate, and only then for the
     * detail. `#seq` is on every row: it is the stamp a reader quotes when they say "that fact".
     */
    function RegionStream({ t, shared, events, factTotal }) {
      const fmt = shared.format
      const recent = (events ?? []).slice(-12).reverse()

      const children = [
        h('div', { className: 'card-head', key: 'head' }, [
          h('h2', { key: 'title' }, say(t, 'stream.title')),
          h('span', { className: 'dim', key: 'read' }, say(t, 'stream.read', { n: fmt.number(factTotal) })),
        ]),
      ]

      if (recent.length === 0) {
        children.push(h('p', { className: 'empty', key: 'empty' }, say(t, 'stream.empty')))
      } else {
        children.push(
          h(
            'ol',
            { className: 'stream', key: 'stream' },
            recent.map((event) =>
              h('li', { className: 'stream-row', key: `${event.cursor}` }, [
                h('span', { className: 'stream-head', key: 'head' }, [
                  h('span', { className: 'stream-time', key: 'time' }, fmt.clock(event.wall_clock_ms)),
                  h('span', { className: 'stream-type', key: 'type' }, event.event_type),
                  h('span', { className: 'stream-candidate', key: 'candidate' }, event.candidate_id),
                  h('span', { className: 'stream-seq', key: 'seq' }, seqStamp(event.local_seq)),
                ]),
                h(
                  'span',
                  {
                    className: 'stream-summary',
                    title: event.summary === '' ? event.event_type : event.summary,
                    key: 'summary',
                  },
                  event.summary === '' ? fmt.EM_DASH : event.summary,
                ),
              ]),
            ),
          ),
        )
      }

      return h('section', { className: 'card' }, children)
    }

    /** The sidebar glyph. Monochrome on purpose: the rail tints the active entry, not the artwork. */
    function PanelIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 20
      return h(
        'svg',
        {
          viewBox: '0 0 64 64',
          width: size,
          height: size,
          'aria-hidden': true,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        h('path', { d: 'M12 46 L26 28 L38 34 L52 14' }),
        h('circle', { cx: 12, cy: 46, r: 4, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 38, cy: 34, r: 4, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 52, cy: 14, r: 5, fill: 'currentColor', stroke: 'none' }),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          const disposeEn = ctx.locale.register(NS, 'en', EN)
          const disposeZh = ctx.locale.register(NS, 'zh', ZH)
          return () => {
            disposeEn()
            disposeZh()
          }
        })

        // The page's own stylesheet, injected once. Fetching it — rather than carrying a copy — is the
        // whole of checkbox 1 of this ticket: one file, one palette, one set of spacing decisions, and
        // the panel cannot fall behind an edit the page made.
        ctx.effect(() => {
          const style = document.createElement('style')
          style.id = STYLE_ID
          let alive = true
          void fetch(STYLESHEET_URL, { cache: 'no-store' })
            .then((response) => (response.ok ? response.text() : ''))
            .then((text) => {
              if (alive && text !== '') style.textContent = text
            })
            .catch(() => {
              // The panel keeps the host's own look rather than a broken half-design; the masthead's
              // stamps still say what the numbers are.
            })
          const parent = document.head ?? document.body
          parent.appendChild(style)
          return () => {
            alive = false
            style.remove()
          }
        })

        const t = ctx.locale.bind(NS)

        // One list id in the rail addresses one `main` key. The sidebar owns the button; this module
        // only says which id, where, and how it is labelled.
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_KEY, order: 25, label: () => t('panel.title') },
            PanelIcon,
          ),
        )

        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_KEY }, () => h(Panel, { t })))
      },
    }
  },
})
