#!/usr/bin/env node
/**
 * The training run this example evaluates: a real metric, from a real process, in a second, with no
 * GPU, no cluster and no dependencies.
 *
 * It is small on purpose — the point of the example is the *loop*, not the model — but it is not a
 * fake: it generates a seeded synthetic dataset, trains the structure `model/structure.json`
 * describes with hand-written gradient descent, and evaluates AUC on a held-out split. Change the
 * structure and the number really moves, which is what makes "the candidate improved the metric" a
 * fact rather than a claim.
 *
 * The contract with the executor (`packages/exec/lib/platform-local.js`) is three lines long:
 *
 *   - read the structure from `model/structure.json` beside this file;
 *   - write `{ "metrics": { ... } }` to `$REPRISE_METRICS_PATH`;
 *   - exit 0 on success. Exiting 0 *without* that file is classified as a `data` failure — because an
 *     empty metric set becomes a candidate score, and a fabricated score is worse than a failed run.
 *
 * The dataset has one deliberately *structural* feature: a pairwise interaction that no amount of
 * capacity in a purely additive model can recover. That is what makes the two candidate hypotheses
 * in `hypotheses.json` differ, and why the frontier can prefer one of them.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// ------------------------------------------------------------------ data

/** Deterministic PRNG: same dataset on every machine, so two candidates are comparable. */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const FIELDS = 3
const CATEGORIES = 8
const FEATURES = FIELDS * CATEGORIES
const TRAIN_ROWS = 6_000
const TEST_ROWS = 2_000

/**
 * The latent truth: a per-category main effect plus **one interaction** between two categories of
 * the first two fields. An additive model sees the main effects and misses the interaction; an
 * explicit cross feature or a hidden layer can capture it. That gap is the whole example.
 */
function makeDataset(seed) {
  const random = mulberry32(seed)
  const mainEffect = Array.from({ length: FIELDS }, () =>
    Array.from({ length: CATEGORIES }, () => (random() - 0.5) * 2.2),
  )

  const rows = []
  for (let index = 0; index < TRAIN_ROWS + TEST_ROWS; index += 1) {
    const categories = Array.from({ length: FIELDS }, () => Math.floor(random() * CATEGORIES))
    let score = 0
    for (let field = 0; field < FIELDS; field += 1) score += mainEffect[field][categories[field]]
    // The interaction: "a young user × a long session" style, worth more than either part alone.
    if (categories[0] < 2 && categories[1] < 2) score += 2.4
    const label = random() < 1 / (1 + Math.exp(-score)) ? 1 : 0
    rows.push({ categories, label })
  }
  return { rows: rows.slice(0, TRAIN_ROWS), test: rows.slice(TRAIN_ROWS) }
}

/** One-hot, plus the crossed field if the structure asks for it. */
function featurise(categories, { field_crosses: crosses }) {
  const vector = new Array(crosses ? FEATURES + 4 : FEATURES).fill(0)
  for (let field = 0; field < FIELDS; field += 1) vector[field * CATEGORIES + categories[field]] = 1
  if (crosses) {
    // Four crosses (2×2) of "is this field's category low", the shape the interaction lives in.
    vector[FEATURES + (categories[0] < 2 ? 2 : 0) + (categories[1] < 2 ? 1 : 0)] = 1
  }
  return vector
}

// ----------------------------------------------------------------- model

const sigmoid = (z) => 1 / (1 + Math.exp(-z))

/**
 * The structure under test: an optional tanh hidden layer between the features and the logit.
 * `hidden_units: 0` is plain logistic regression; anything else is a one-hidden-layer MLP. Trained
 * with full-batch gradient descent — deterministic, no shuffling, no learning-rate schedule.
 */
function train(structure, trainRows) {
  const crosses = structure.field_crosses === true
  const dims = crosses ? FEATURES + 4 : FEATURES
  const hidden = Math.max(0, Number(structure.hidden_units ?? 0))
  const l2 = Number(structure.l2 ?? 0)
  const epochs = Math.max(1, Number(structure.epochs ?? 3))
  const batchSize = 64
  const rate = hidden === 0 ? 0.35 : 0.25

  const data = trainRows.map((row) => ({ x: featurise(row.categories, structure), y: row.label }))

  const w1 =
    hidden === 0
      ? null
      : Array.from({ length: hidden }, (_, unit) =>
          Array.from({ length: dims }, (_, dim) => Math.sin((unit + 1) * (dim + 3)) * 0.2),
        )
  const b1 = hidden === 0 ? null : new Array(hidden).fill(0)
  const w2 = hidden === 0 ? new Array(dims).fill(0) : new Array(hidden).fill(0)
  let b2 = 0

  const g2 = new Array(hidden === 0 ? dims : hidden).fill(0)
  const gb1 = hidden === 0 ? null : new Array(hidden).fill(0)
  const g1 = hidden === 0 ? null : Array.from({ length: hidden }, () => new Array(dims).fill(0))
  const activations = hidden === 0 ? null : new Array(hidden)

  for (let epoch = 0; epoch < epochs; epoch += 1) {
    for (let start = 0; start < data.length; start += batchSize) {
      const batch = data.slice(start, start + batchSize)
      g2.fill(0)
      if (hidden !== 0) {
        gb1.fill(0)
        for (const row of g1) row.fill(0)
      }
      let gb2 = 0

      for (const { x, y } of batch) {
        let logit = b2
        if (hidden === 0) {
          for (let dim = 0; dim < dims; dim += 1) if (x[dim] !== 0) logit += w2[dim] * x[dim]
        } else {
          for (let unit = 0; unit < hidden; unit += 1) {
            let z = b1[unit]
            for (let dim = 0; dim < dims; dim += 1) if (x[dim] !== 0) z += w1[unit][dim] * x[dim]
            activations[unit] = Math.tanh(z)
            logit += w2[unit] * activations[unit]
          }
        }
        const error = sigmoid(logit) - y // dL/dlogit for log loss
        gb2 += error
        if (hidden === 0) {
          for (let dim = 0; dim < dims; dim += 1) if (x[dim] !== 0) g2[dim] += error * x[dim]
        } else {
          for (let unit = 0; unit < hidden; unit += 1) {
            const delta = error * w2[unit] * (1 - activations[unit] * activations[unit])
            g2[unit] += error * activations[unit]
            gb1[unit] += delta
            for (let dim = 0; dim < dims; dim += 1) if (x[dim] !== 0) g1[unit][dim] += delta * x[dim]
          }
        }
      }

      const scale = rate / batch.length
      b2 -= scale * gb2
      if (hidden === 0) {
        for (let dim = 0; dim < dims; dim += 1) w2[dim] -= scale * (g2[dim] + l2 * w2[dim])
      } else {
        for (let unit = 0; unit < hidden; unit += 1) {
          w2[unit] -= scale * (g2[unit] + l2 * w2[unit])
          b1[unit] -= scale * gb1[unit]
          for (let dim = 0; dim < dims; dim += 1) w1[unit][dim] -= scale * (g1[unit][dim] + l2 * w1[unit][dim])
        }
      }
    }
  }

  return function predict(categories) {
    const x = featurise(categories, structure)
    if (hidden === 0) {
      let logit = b2
      for (let dim = 0; dim < dims; dim += 1) logit += w2[dim] * x[dim]
      return logit
    }
    let logit = b2
    for (let unit = 0; unit < hidden; unit += 1) {
      let z = b1[unit]
      for (let dim = 0; dim < dims; dim += 1) if (x[dim] !== 0) z += w1[unit][dim] * x[dim]
      logit += w2[unit] * Math.tanh(z)
    }
    return logit
  }
}

/** Rank-based AUC with ties handled by average rank — the metric the contract names. */
function auc(scored) {
  const positives = scored.filter((row) => row.label === 1).length
  const negatives = scored.length - positives
  if (positives === 0 || negatives === 0) throw new Error('the test split has one class; AUC is undefined')

  const sorted = [...scored].sort((left, right) => left.score - right.score)
  let rank = 1
  let index = 0
  let positiveRanks = 0
  while (index < sorted.length) {
    let end = index
    while (end + 1 < sorted.length && sorted[end + 1].score === sorted[index].score) end += 1
    const averageRank = (rank + (rank + (end - index))) / 2
    for (let at = index; at <= end; at += 1) if (sorted[at].label === 1) positiveRanks += averageRank
    rank += end - index + 1
    index = end + 1
  }
  return (positiveRanks - (positives * (positives + 1)) / 2) / (positives * negatives)
}

function logLoss(scored) {
  const total = scored.reduce((sum, row) => sum + (row.label === 1 ? -Math.log(Math.max(row.probability, 1e-12)) : -Math.log(Math.max(1 - row.probability, 1e-12))), 0)
  return total / scored.length
}

// ------------------------------------------------------------------ main

const structure = JSON.parse(readFileSync(join(HERE, 'model', 'structure.json'), 'utf8'))
const startedAt = Date.now()
const dataset = makeDataset(20_261_022)
const predict = train(structure, dataset.rows)

const scored = dataset.test.map((row) => {
  const logit = predict(row.categories)
  const probability = sigmoid(logit)
  return { label: row.label, score: probability, probability }
})

const metrics = {
  auc: Number(auc(scored).toFixed(6)),
  logloss: Number(logLoss(scored).toFixed(6)),
  train_seconds: Number(((Date.now() - startedAt) / 1000).toFixed(3)),
  parameters: (structure.field_crosses === true ? FEATURES + 4 : FEATURES) * Math.max(1, Number(structure.hidden_units ?? 0) || 1),
}

const document = `${JSON.stringify({ metrics }, null, 2)}\n`
const target = process.env.REPRISE_METRICS_PATH
if (target !== undefined && target !== '') writeFileSync(target, document)
process.stdout.write(document)