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
 * Two rules from `references/ui-plugin.md` are load-bearing here:
 *
 *   - the module registers a *lazy factory* whose id is the package name, and takes React from the
 *     browser module table (`require('react')`) — no bundle, no build step, no second React;
 *   - visible text goes through the Client locale service (`ctx.locale.register` + `bind`), so the
 *     label follows the active language instead of freezing at load time.
 *
 * Everything is registered inside `apply`, through `ctx.effect` / `ctx.slots.inject`, so unloading
 * the bundle removes the icon, the page and the dictionaries it added.
 *
 * All data comes from the read-only HTTP routes the Host half already mounts
 * (`/api/reprise/overview`). This module computes nothing: the projection is the single source
 * of the numbers, and the tool the model calls reads the same projection.
 */

window.__ModuleLoader__.load({
  id: 'dsh-reprise',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const NS = 'reprise'
    const PANEL_KEY = 'reprise'
    const OVERVIEW_URL = '/api/reprise/overview'

    const EN = {
      'panel.title': 'Reprise',
      'panel.subtitle': 'Model-structure exploration loop',
      'panel.refresh': 'Refresh',
      'panel.loading': 'Reading the fact plane…',
      'panel.failed': 'Cannot reach the dashboard route',
      'panel.empty': 'This workspace has no facts yet — the loop has not run a single tick.',
      'panel.readAt': 'read at',
      'panel.lastFact': 'last fact',
      'panel.stoppedAt': 'stopped at',
      'panel.phase': 'Phase',
      'panel.rounds': 'Rounds',
      'panel.candidates': 'Candidates',
      'panel.spend': 'GPU hours',
      'panel.frontier': 'Frontier',
      'panel.best': 'Best candidate',
      'panel.stop': 'Why it stopped',
      'panel.warnings': 'Warnings',
      'panel.notes': 'Notes',
      'panel.events': 'Latest facts',
      'panel.unlimited': 'unlimited',
      'panel.none': 'none',
      'panel.running': 'running',
      'panel.stopped': 'stopped',
      'panel.loadingShort': '…',
    }

    const ZH = {
      'panel.title': '复现',
      'panel.subtitle': '模型结构探索回路',
      'panel.refresh': '刷新',
      'panel.loading': '正在读取事实库…',
      'panel.failed': '读不到看板路由',
      'panel.empty': '这个工作区还没有任何事实——回路一次 tick 都没跑过。',
      'panel.readAt': '读取于',
      'panel.lastFact': '最后事实',
      'panel.stoppedAt': '停止于',
      'panel.phase': '相位',
      'panel.rounds': '轮次',
      'panel.candidates': '候选',
      'panel.spend': 'GPU 小时',
      'panel.frontier': '前沿',
      'panel.best': '最优候选',
      'panel.stop': '为什么停',
      'panel.warnings': '警告',
      'panel.notes': '说明',
      'panel.events': '最近的事实',
      'panel.unlimited': '无上限',
      'panel.none': '无',
      'panel.running': '运行中',
      'panel.stopped': '已停止',
      'panel.loadingShort': '…',
    }

    const font = 'var(--dsw-font-family, system-ui, sans-serif)'
    const mono = 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, monospace)'

    const styles = {
      page: {
        fontFamily: font,
        color: 'var(--dsw-alias-label-primary, CanvasText)',
        background: 'var(--dsw-alias-bg-base, Canvas)',
        height: '100%',
        overflow: 'auto',
        padding: '20px 24px 40px',
        boxSizing: 'border-box',
      },
      header: { display: 'flex', alignItems: 'baseline', gap: '12px', marginBottom: '4px' },
      h1: { fontSize: '18px', fontWeight: 600, margin: 0 },
      sub: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, GrayText)' },
      path: {
        fontFamily: mono,
        fontSize: '11px',
        color: 'var(--dsw-alias-label-tertiary, GrayText)',
        marginTop: '6px',
        wordBreak: 'break-all',
      },
      toolrow: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '12px' },
      button: {
        fontFamily: font,
        fontSize: '12px',
        padding: '4px 10px',
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        border: '1px solid var(--dsw-alias-border-l1, ButtonBorder)',
        background: 'var(--dsw-alias-bg-layer-1, ButtonFace)',
        color: 'var(--dsw-alias-label-primary, ButtonText)',
        cursor: 'pointer',
      },
      grid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap: '10px',
        marginTop: '16px',
      },
      cell: {
        border: '1px solid var(--dsw-alias-border-l1, ButtonBorder)',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        background: 'var(--dsw-alias-bg-layer-1, Canvas)',
        padding: '10px 12px',
      },
      cellLabel: {
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary, GrayText)',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
      },
      cellValue: { fontSize: '18px', fontWeight: 600, marginTop: '4px' },
      cellFoot: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, GrayText)', marginTop: '2px' },
      section: { marginTop: '22px' },
      sectionTitle: {
        fontSize: '12px',
        fontWeight: 600,
        color: 'var(--dsw-alias-label-secondary, GrayText)',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        marginBottom: '8px',
      },
      row: {
        fontFamily: mono,
        fontSize: '12px',
        display: 'flex',
        gap: '10px',
        padding: '5px 0',
        borderTop: '1px solid var(--dsw-alias-border-l1, ButtonBorder)',
      },
      time: { color: 'var(--dsw-alias-label-tertiary, GrayText)', flex: '0 0 62px' },
      type: { color: 'var(--dsw-alias-label-primary, CanvasText)', flex: '0 0 170px', wordBreak: 'break-all' },
      summary: { color: 'var(--dsw-alias-label-secondary, GrayText)', flex: 1, wordBreak: 'break-word' },
      warnItem: {
        fontSize: '12px',
        borderLeft: '3px solid var(--dsw-static-amber-500, goldenrod)',
        background: 'var(--dsw-alias-bg-layer-1, Canvas)',
        padding: '8px 10px',
        marginBottom: '6px',
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        color: 'var(--dsw-alias-label-primary, CanvasText)',
      },
      note: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, GrayText)', marginBottom: '4px' },
      stopped: {
        border: '1px solid var(--dsw-alias-border-l1, ButtonBorder)',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        background: 'var(--dsw-alias-bg-layer-1, Canvas)',
        padding: '10px 12px',
        fontSize: '13px',
      },
      badge: (tone) => ({
        display: 'inline-block',
        fontSize: '11px',
        padding: '2px 8px',
        borderRadius: '999px',
        border: `1px solid ${tone}`,
        color: tone,
        marginLeft: '8px',
        verticalAlign: 'middle',
      }),
    }

    const clock = (ms) => {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '--:--:--'
      const d = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    }

    const num = (value, digits = 4) =>
      typeof value === 'number' && Number.isFinite(value) ? String(Number(value.toFixed(digits))) : '—'

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
          style: { display: 'block' },
        },
        h('path', { d: 'M12 46 L26 28 L38 34 L52 14' }),
        h('circle', { cx: 12, cy: 46, r: 4, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 38, cy: 34, r: 4, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 52, cy: 14, r: 5, fill: 'currentColor', stroke: 'none' }),
      )
    }

    /** `best` is `{ candidate_id, round, metric, value }` — one objective, named. */
    const bestSummary = (best) =>
      best === undefined || best === null || typeof best !== 'object'
        ? '—'
        : `${String(best.metric ?? 'metric')}=${num(best.value)}  ·  round ${String(best.round ?? '?')}`

    /** One progress page. Reads the projection the Host already computes; renders, never derives. */
    function Panel(props) {
      const t = props.t
      const [answer, setAnswer] = useState(null)
      const [failure, setFailure] = useState(null)
      const [reading, setReading] = useState(true)
      const [at, setAt] = useState(null)
      const alive = useRef(true)
      // `at` is the browser's clock at the last successful read; the fact clock is the newest
      // recorded event. They are two different questions — "when did I last ask" and "when did the
      // run last do something" — and a page that printed only the first looked like a run that
      // kept going after it had stopped.
      const stopped = answer?.data?.stop?.stopped === true
      const newest = Array.isArray(answer?.incremental?.events) ? answer.incremental.events.at(-1) : undefined
      const newestFactAt = typeof newest?.wall_clock_ms === 'number' ? newest.wall_clock_ms : undefined

      const read = useCallback(async () => {
        try {
          const response = await fetch(OVERVIEW_URL, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const body = await response.json()
          if (!alive.current) return
          setAnswer(body)
          setFailure(null)
          setAt(Date.now())
        } catch (error) {
          if (!alive.current) return
          setFailure(error instanceof Error ? error.message : String(error))
        } finally {
          if (alive.current) setReading(false)
        }
      }, [])

      useEffect(() => {
        alive.current = true
        void read()
        const timer = setInterval(() => void read(), stopped ? 15000 : 3000)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [read, stopped])

      const data = answer?.data

      const header = h(
        'div',
        null,
        h(
          'div',
          { style: styles.header },
          h('h1', { style: styles.h1 }, t('panel.title')),
          data?.workspace?.phase
            ? h('span', { style: styles.badge('var(--dsw-alias-brand-primary, AccentColor)') }, String(data.workspace.phase))
            : null,
          stopped
            ? h('span', { style: styles.badge('var(--dsw-alias-state-idle-primary, GrayText)') }, t('panel.stopped'))
            : null,
        ),
        h('div', { style: styles.sub }, t('panel.subtitle')),
        answer?.workspace ? h('div', { style: styles.path }, answer.workspace) : null,
        h(
          'div',
          { style: styles.toolrow },
          h(
            'button',
            { type: 'button', style: styles.button, onClick: () => void read(), disabled: reading },
            t('panel.refresh'),
          ),
          at === null
            ? null
            : h(
                'span',
                { style: styles.sub },
                newestFactAt === undefined
                  ? `${t('panel.readAt')} ${clock(at)}`
                  : `${t('panel.readAt')} ${clock(at)} · ${t('panel.lastFact')} ${clock(newestFactAt)}`,
              ),
          failure === null ? null : h('span', { style: styles.sub }, `${t('panel.failed')}: ${failure}`),
        ),
      )

      if (data === null || data === undefined) {
        const message = failure !== null
          ? `${t('panel.failed')}: ${failure}`
          : answer === null
            ? t('panel.loading')
            : answer.reason ?? t('panel.empty')
        return h('div', { style: styles.page }, header, h('div', { style: styles.section }, message))
      }

      const cell = (label, value, foot) =>
        h(
          'div',
          { style: styles.cell, key: label },
          h('div', { style: styles.cellLabel }, label),
          h('div', { style: styles.cellValue }, value),
          foot === undefined
            ? null
            : h('div', { style: styles.cellFoot }, typeof foot === 'string' ? foot : '' ),
        )

      const rounds = data.rounds ?? {}
      const candidates = data.candidates ?? {}
      const spend = data.spend ?? {}
      const limit = typeof spend.limitGpuHours === 'number' && spend.limitGpuHours > 0
        ? `${num(spend.limitGpuHours, 2)}`
        : t('panel.unlimited')
      const best = data.best
      const events = (answer.incremental?.events ?? []).slice(-8).reverse()

      return h(
        'div',
        { style: styles.page },
        header,
        h(
          'div',
          { style: styles.grid },
          cell(t('panel.rounds'), `${rounds.current ?? 0} / ${rounds.total ?? 0}`, `${rounds.completed ?? 0} 完成`),
          cell(
            t('panel.candidates'),
            String(candidates.total ?? 0),
            `${candidates.done ?? 0} 完成 · ${candidates.rejected ?? 0} 否决 · ${(candidates.inFlight ?? []).length} 在飞`,
          ),
          cell(t('panel.best'), best?.candidate_id ?? t('panel.none'), best ? bestSummary(best) : undefined),
          cell(t('panel.spend'), `${num(spend.usedGpuHours, 2)} / ${limit}`, `${num(spend.inFlightGpuHours, 2)} 在飞`),
          cell(
            t('panel.frontier'),
            String(data.frontier?.size ?? 0),
            (data.frontier?.objectives ?? [])
              .map((objective) => `${objective.metric ?? objective.name ?? '?'} ${objective.direction ?? ''}`)
              .join(' · '),
          ),
        ),
        (data.warnings ?? []).length === 0
          ? null
          : h(
              'div',
              { style: styles.section },
              h('div', { style: styles.sectionTitle }, t('panel.warnings')),
              ...(data.warnings ?? []).map((warning, index) =>
                h(
                  'div',
                  { style: styles.warnItem, key: `w${index}` },
                  `[${String(warning.severity ?? 'warning')}] ${String(warning.code ?? '')}: ${String(warning.message ?? '')}`,
                ),
              ),
            ),
        (answer.notes ?? []).length === 0
          ? null
          : h(
              'div',
              { style: styles.section },
              h('div', { style: styles.sectionTitle }, t('panel.notes')),
              ...(answer.notes ?? []).map((note, index) => h('div', { style: styles.note, key: `n${index}` }, String(note))),
            ),
        stopped
          ? h(
              'div',
              { style: styles.section },
              h('div', { style: styles.sectionTitle }, t('panel.stop')),
              h(
                'div',
                { style: styles.stopped },
                `${String(data.stop.rule ?? '')}  ·  limit ${String(data.stop.limit ?? '?')} / observed ${String(data.stop.observed ?? '?')}`,
                data.stop.message ? h('div', { style: styles.note }, String(data.stop.message)) : null,
                typeof data.stop.atMs === 'number'
                  ? h('div', { style: styles.note }, `${t('panel.stoppedAt')} ${clock(data.stop.atMs)}`)
                  : null,
              ),
            )
          : null,
        h(
          'div',
          { style: styles.section },
          h('div', { style: styles.sectionTitle }, t('panel.events')),
          ...(events.length === 0
            ? [h('div', { style: styles.note, key: 'none' }, '—')]
            : events.map((event, index) =>
                h(
                  'div',
                  { style: styles.row, key: event.cursor ?? index },
                  h('span', { style: styles.time }, clock(event.wall_clock_ms)),
                  h('span', { style: styles.type }, String(event.event_type ?? '')),
                  h('span', { style: styles.summary }, String(event.summary ?? '')),
                ),
              )),
        ),
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

        const t = ctx.locale.bind(NS)

        // One list id in the rail addresses one `main` key. The sidebar owns the button; this module
        // only says which id, where, and how it is labelled.
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_KEY, order: 25, label: () => t('panel.title') },
            PanelIcon,
          ),
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_KEY }, () => h(Panel, { t })),
        )
      },
    }
  },
})