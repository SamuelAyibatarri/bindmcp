import type { Hono, MiddlewareHandler } from 'hono'
import type { BindMCP } from '../core/gateway.js'
import type { HandleRequestOptions } from '../core/generation/types.js'

export interface HonoAdapterOptions extends HandleRequestOptions {
  /**
   * Optional Hono app instance. When provided, `dispatch` defaults to `app.fetch`
   * so route-proxied tools invoke your Hono routes in-memory automatically.
   */
  app?: Hono<any, any, any>
}

export function createHonoAdapter(
  gateway: BindMCP,
  options: HonoAdapterOptions = {},
): MiddlewareHandler {
  const dispatch =
    options.dispatch ??
    (options.app ? (req: Request) => Promise.resolve(options.app!.fetch(req)) : undefined)

  return async (c, next) => {
    const response = await gateway.handle(c.req.raw, {
      ...(options.basePath ? { basePath: options.basePath } : {}),
      ...(dispatch ? { dispatch } : {}),
    })

    if (response) {
      return response
    }

    await next()
  }
}