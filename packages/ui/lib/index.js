/**
 * `@dsh-reprise/ui` — the read-only dashboard's composition root.
 *
 * The display layer has exactly one thing to wire: a workspace directory and the host's connection
 * service go in, seven mounted read routes and their disposer come out.
 *
 * ```js
 * export const inject = ['connection']           // the host service, read from our own ctx
 * export function apply(ctx, config) {
 *   ctx.effect(
 *     () => registerRoutes({ connection: ctx.connection, workspace: config.workspace }),
 *     'reprise-ui: read-only routes',
 *   )
 * }
 * ```
 *
 * There is no session in that snippet and no agent: the dashboard is a workspace's observer, so the
 * routes must not be mounted per conversation. (The plugin entry itself lives in the host plugin's
 * `apply`; this package only owns the routes and the views behind them.)
 *
 * @module
 */

export {
  ASSETS,
  ROUTES,
  ViewError,
  callHandler,
  callsHandler,
  candidateHandler,
  conclusionHandler,
  overviewHandler,
  queryOf,
  registerRoutes,
  roundsHandler,
  treeHandler,
  withStore,
} from './routes.js'
export {
  allEvents,
  callView,
  callsView,
  candidateView,
  conclusionView,
  configFrom,
  cursorOf,
  overviewView,
  roundsView,
  treeView,
} from './views.js'