import type { BindMCP } from '../core/gateway.js'
import type { HandleRequestOptions } from '../core/generation/types.js'

export interface FetchAdapterOptions extends HandleRequestOptions {
  /** Optional fallback handler when a request does not match MCP routes */
  onUnhandled?: (request: Request) => Promise<Response> | Response
}

export function createFetchAdapter(
  gateway: BindMCP,
  options: FetchAdapterOptions = {},
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const response = await gateway.handle(request, options)

    if (response) {
      return response
    }

    if (options.onUnhandled) {
      return await options.onUnhandled(request)
    }

    return new Response('Not Found', { status: 404 })
  }
}