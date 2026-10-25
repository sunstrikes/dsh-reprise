/**
 * Windowed-sample fixtures for the kernel tests.
 *
 * The shape is the contract's (`contract/lib/windows.js`, artifact kind `window_series`), written
 * here so a test reads as "three epochs of auc" rather than as eight lines of object literal. Not a
 * `*.test.js` file: `node --test test/*.test.js` must not run it.
 */

/** One series from `[index, start, end, metrics]` rows — the bounds and ordinal the contract names. */
export function windowSeries(rows, { unit = 'epoch', schemaVersion = 1 } = {}) {
  return {
    schema_version: schemaVersion,
    unit,
    windows: rows.map(([index, start, end, metrics]) => ({ index, start, end, metrics })),
  }
}

/** The baseline every test starts from unless it says otherwise: three epochs, auc rising. */
export const BASELINE_SERIES = windowSeries([
  [0, 0, 1, { auc: 0.69, logloss: 0.62 }],
  [1, 1, 2, { auc: 0.7, logloss: 0.6 }],
  [2, 2, 3, { auc: 0.71, logloss: 0.58 }],
])

/** A candidate's series over the same windows, so pairing has something to pair. */
export const CANDIDATE_SERIES = windowSeries([
  [0, 0, 1, { auc: 0.7, logloss: 0.6 }],
  [1, 1, 2, { auc: 0.72, logloss: 0.57 }],
  [2, 2, 3, { auc: 0.74, logloss: 0.55 }],
])

/** A well-formed document holding no window: the "the run measured nothing" case. */
export const EMPTY_SERIES = windowSeries([])

/** A document whose window breaks the shape (no length): `invalid`, not "no measurement". */
export const MALFORMED_SERIES = {
  schema_version: 1,
  unit: 'epoch',
  windows: [{ index: 0, start: 4, end: 4, metrics: { auc: 0.7 } }],
}

/** Two accounts of one window: `conflict`, never a malformed document. */
export const CONTRADICTORY_SERIES = windowSeries([
  [0, 0, 1, { auc: 0.7 }],
  [1, 0, 1, { auc: 0.9 }],
])