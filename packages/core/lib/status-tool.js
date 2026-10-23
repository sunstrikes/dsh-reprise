/**
 * `reprise_status`: the loop's progress, readable inside a conversation.
 *
 * The dashboard page (client/index.js) answers "what is happening" while a person watches the
 * window. This answers the same question for the model, in the same words, from the same
 * projection — `@dsh-reprise/ui`'s views, which is what the HTTP routes serve. One projection, two
 * exits: a tool that recomputed the numbers would be the second, unchecked account of the run this
 * repository exists to avoid.
 *
 * Read-only by construction: every read opens its own `readOnly` handle through `withStore`, so the
 * tool physically cannot record a fact — including one about itself.
 *
 * @module
 */

import { ViewError, withStore } from '@dsh-reprise/ui/routes'
import { candidateView, overviewView } from '@dsh-reprise/ui/views'

export const name = 'reprise-status-tool'
export const inject = ['tools']

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

const json = (value) => JSON.parse(JSON.stringify(value))

/** Keep the tool's answer small enough to read: the whole fact stream is not progress. */
function trim(answer, { events = 6, members = 10 } = {}) {
  if (answer === undefined) return undefined
  const kept = answer.incremental?.events ?? []
  return {
    ...answer,
    incremental: { events: kept.slice(-Math.max(0, Math.min(events, 20))) },
    ...(answer.data?.frontier === undefined
      ? {}
      : {
          data: {
            ...answer.data,
            frontier: {
              ...answer.data.frontier,
              members: (answer.data.frontier.members ?? []).slice(0, members),
            },
          },
        }),
  }
}

/**
 * Build the tool definition for one configured workspace.
 *
 * @param {string | undefined} workspaceDir the directory the run owns
 * @param {(message: string) => void} log where a refusal is reported
 */
function definition(workspaceDir, log) {
  return {
    name: 'reprise_status',
    description:
      'Read the loop\'s progress from the workspace fact plane: current phase, rounds, ' +
      'candidates and their verdicts, the best result so far, the frontier, GPU-hour spend, warnings ' +
      'the run owes its operator, and why it stopped. Read-only; call it whenever someone asks how ' +
      'the run is doing, or pass a candidate id to see one candidate\'s timeline.',
    parameters: {
      type: 'object',
      properties: {
        candidate: {
          type: 'string',
          description: 'One candidate id (e.g. r1-h2) for its own page instead of the overview.',
        },
        events: {
          type: 'integer',
          description: 'How many recent facts to include, 0 through 20. Default 6.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const { candidate, events } = args !== null && typeof args === 'object' ? args : {}
      if (typeof workspaceDir !== 'string' || workspaceDir === '') {
        return { ok: false, reason: 'the plugin has no workspace configured, so there is no fact plane to read' }
      }

      let answer
      try {
        answer = withStore(workspaceDir, (store) =>
          typeof candidate === 'string' && candidate !== ''
            ? candidateView(store, { candidate })
            : overviewView(store, {}),
        )
      } catch (error) {
        // A ViewError is a refusal the caller can act on (unknown candidate, unreadable workspace);
        // anything else is a bug and is reported as one.
        log(`status tool failed: ${messageOf(error)}`)
        return {
          ok: false,
          reason: messageOf(error),
          refused: error instanceof ViewError,
        }
      }

      if (answer === undefined) {
        return {
          ok: true,
          workspace: workspaceDir,
          data: null,
          reason: 'no facts recorded in this workspace yet — the loop has not ticked',
        }
      }
      return { ok: true, ...json(trim(answer, { events: Number.isSafeInteger(events) ? events : 6 })) }
    },
  }
}

/**
 * @param {any} ctx the host's context
 * @param {object} [config] the resolved plugin configuration
 */
export function apply(ctx, config = {}) {
  const log = typeof config.log === 'function' ? config.log : () => {}
  ctx.effect(() => ctx.tools.register(definition(config.workspaceDir, log)))
}