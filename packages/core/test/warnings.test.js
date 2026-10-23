/**
 * The warnings the run owes a stranger: spend that nothing caps, and a contract that contradicts
 * itself.
 *
 * Contract guarded (ticket 13, user stories 25 and 28): **the moment a real training executor is
 * configured, the absence of a GPU-hours limit must be visible** — the default is unlimited, and a
 * default must be safe without being silent. The check lives here, in the layer the dashboard and
 * the injection packet both read, because the rendering surface (`@dsh-reprise/ui`, ticket 11) is not
 * merged: `overview()` carries the warning today, and any renderer that asks the projection gets it.
 *
 * The second warning is the one a domain expert hits first: the metric contract is declared in two
 * places for two consumers (frontier objectives vs the judge's comparison), and if they disagree the
 * run silently ranks on a different "better" than the gate does.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { overview } from '../lib/projection.js'
import { Store } from '../lib/store.js'
import { configWarnings, noGpuHoursLimit } from '../lib/warnings.js'

const CONTRACT = { metrics: { primary: 'auc', objectives: { auc: 'up' } } }

const withStore = (body) => {
  const store = Store.open(mkdtempSync(join(tmpdir(), 'reprise-warnings-')))
  try {
    return body(store)
  } finally {
    store.close()
  }
}

const codes = (config) => configWarnings(config).map((warning) => warning.code)

test('a real training executor with no GPU-hours limit is warned about, in words a stranger reads', () => {
  const warnings = configWarnings({ ...CONTRACT, executor: { kind: 'ray' }, budget: {} })
  const warning = warnings.find((entry) => entry.code === 'no_gpu_hours_limit')

  assert.ok(warning, 'an unbounded spend on a real cluster must never be the silent default')
  assert.equal(warning.severity, 'warning')
  assert.match(warning.message, /GPU-hours limit/i, 'the message says which limit is missing')
  assert.equal(warning.label, '当前无 GPU 小时上限', 'the shipped client renders this label verbatim')
  assert.equal(warning.where, 'dashboard.overview', 'the projection says which surface is expected to show it')
})

test('the local executor bills no GPU hours, so it is not warned about them', () => {
  assert.deepEqual(
    codes({ ...CONTRACT, executor: { kind: 'local' }, budget: {} }).filter((code) => code === 'no_gpu_hours_limit'),
    [],
    'a laptop run has nothing to cap; warning here would train people to ignore the warning',
  )
  assert.equal(noGpuHoursLimit({ executor: { kind: 'local' }, budget: { gpu_hours_limit: 0 } }), undefined)
})

test('a configured limit, or a truthy limit of zero hours, silences it', () => {
  assert.equal(codes({ ...CONTRACT, executor: { kind: 'ray' }, budget: { gpu_hours_limit: 40 } }).includes('no_gpu_hours_limit'), false)
  assert.equal(noGpuHoursLimit({ executor: { kind: 'ray' }, budget: { gpu_hours_limit: 0 } }).code, 'no_gpu_hours_limit')
})

test('the warning is part of the dashboard projection, which is where it renders', () => {
  const config = { ...CONTRACT, executor: { kind: 'ray' }, budget: { gpu_hours_limit: 0 } }
  withStore((store) => {
    const page = overview(store, { config })
    assert.equal(page.warnings.length, 1)
    assert.equal(page.warnings[0].code, 'no_gpu_hours_limit')
    assert.equal(page.spend.limitGpuHours, 0, 'the same page already reports the unlimited budget as 0')
  })
})

test('an empty projection carries an empty warning list, never a missing field', () => {
  withStore((store) => {
    assert.deepEqual(overview(store, { config: { ...CONTRACT, executor: { kind: 'local' } } }).warnings, [])
  })
})

test('a metric contract that ranks "up" while the judge compares "lower" is a warning, not a silent answer', () => {
  const mismatched = configWarnings({
    metrics: { primary: 'auc', objectives: { auc: 'up' } },
    rounds: { metric: { name: 'auc', direction: 'lower' } },
    executor: { kind: 'local' },
  })
  const warning = mismatched.find((entry) => entry.code === 'metric_direction_mismatch')
  assert.ok(warning, 'two declarations of "better" that disagree make two rounds incomparable')
  assert.match(warning.message, /auc/)

  const agreeing = codes({
    metrics: { primary: 'auc', objectives: { auc: 'up' } },
    rounds: { metric: { name: 'auc', direction: 'higher' } },
    executor: { kind: 'local' },
  })
  assert.equal(agreeing.includes('metric_direction_mismatch'), false)
})

test('a round metric that is not one of the frontier objectives is a warning', () => {
  const warnings = configWarnings({
    metrics: { primary: 'auc', objectives: { auc: 'up' } },
    rounds: { metric: { name: 'val_loss', direction: 'lower' } },
    executor: { kind: 'local' },
  })
  assert.ok(warnings.some((entry) => entry.code === 'round_metric_not_an_objective'))
})

test('a round workflow with no model port is reported before it stalls a night unread', () => {
  const warnings = configWarnings({
    ...CONTRACT,
    rounds: { metric: { name: 'auc', direction: 'higher' } },
    executor: { kind: 'local' },
  })
  assert.ok(warnings.some((entry) => entry.code === 'no_model_port'))
  assert.equal(
    configWarnings({ ...CONTRACT, executor: { kind: 'local' }, model: { command: ['node', 'x.mjs'] } }).length,
    0,
    'a configured model port is the whole difference',
  )
})