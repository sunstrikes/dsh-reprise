/**
 * The `connection` double: the host's exact Fetch-route registry, shape for shape.
 *
 * The real one is a host service (`HostConnectionService` in `@deepseek-ai/dsh-client-connection`):
 * `connection.fetch.register(route)` validates the route, throws when the path is already taken,
 * and returns a disposer that removes it again — registration belongs to the calling fiber, so
 * unloading the plugin unregisters its routes. A test double that let a bad route through, or
 * forgot to hand back a disposer, would let this package ship a route the host rejects at boot.
 *
 * So the double copies the host's validation rules verbatim (`assertFetchRoute`, `endpointFromPath`
 * below) and its dispatch rule (a path is matched exactly; a method the route did not declare is a
 * 404, never a fallback). It does NOT model browser authentication or the Peer fence: this package
 * never sees those, and a fake that pretended to would prove nothing about the real one.
 *
 * Not a `*.test.js` file on purpose: `node --test test/*.test.js` must not run it.
 */

const API_PATH = '/api'
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

/** The host's own path rule: an exact route lives under `/api/` and cannot traverse. */
function endpointFromPath(channel, pathname) {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  if (
    endpoint
      .split('/')
      .some((segment) => segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))
  ) {
    return undefined
  }
  return endpoint
}

function assertFetchRoute(route) {
  if (endpointFromPath(API_PATH, route.path) === undefined) {
    throw new Error(`connection: invalid exact Fetch route ${JSON.stringify(route.path)}`)
  }
  if (!Array.isArray(route.methods) || route.methods.length === 0) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} declares no methods`)
  }
  if (new Set(route.methods).size !== route.methods.length) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} repeats a method`)
  }
  if (typeof route.fetch !== 'function') {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} has no fetch handler`)
  }
}

export function fakeConnection() {
  /** @type {Map<string, { path: string, methods: string[], requestBody: string, fetch: Function }>} */
  const routes = new Map()

  const connection = {
    /** The registry, as the host keeps it — tests read it to prove what is (and is not) mounted. */
    routes,

    fetch: {
      register(route) {
        assertFetchRoute(route)
        if (routes.has(route.path)) {
          throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`)
        }
        const registered = {
          path: route.path,
          methods: [...route.methods],
          requestBody: route.requestBody ?? 'buffered',
          fetch: route.fetch,
        }
        routes.set(route.path, registered)
        let disposed = false
        return () => {
          // Disposing twice must not remove a route someone else has registered in the meantime.
          if (disposed) return
          disposed = true
          routes.delete(route.path)
        }
      },
    },

    /** Mounted paths, sorted — the assertion surface for registration and disposal. */
    paths() {
      return [...routes.keys()].sort()
    },

    /**
     * Dispatch one request the way the host's shared Fetch handler does: exact path, declared
     * method, everything else 404. Returns the status and the decoded body.
     */
    async dispatch(method, url) {
      const { pathname, searchParams } = new URL(url, 'http://dsh.test')
      const route = routes.get(pathname)
      if (route === undefined || !route.methods.includes(method)) {
        return { status: 404, text: 'not found', json: undefined, searchParams }
      }
      const response = await route.fetch(new Request(`http://dsh.test${pathname}${new URL(url, 'http://dsh.test').search}`, { method }))
      const text = await response.text()
      let json
      try {
        json = JSON.parse(text)
      } catch {
        json = undefined
      }
      return { status: response.status, contentType: response.headers.get('content-type'), text, json, searchParams }
    },
  }

  return connection
}