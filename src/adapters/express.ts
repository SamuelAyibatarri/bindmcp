import type { NextFunction, Request as ExpressRequest, Response as ExpressResponse } from 'express'
import type { BindMCP } from '../core/gateway.js'
import type { HandleRequestOptions } from '../core/generation/types.js'

export function createExpressAdapter(
  gateway: BindMCP,
  options: HandleRequestOptions = {},
) {
  return async (
    req: ExpressRequest,
    res: ExpressResponse,
    next: NextFunction,
  ): Promise<void> => {
    try {
      const webRequest = toWebRequest(req)
      const webResponse = await gateway.handle(webRequest, options)

      if (!webResponse) {
        next()
        return
      }

      res.status(webResponse.status)
      webResponse.headers.forEach((value, key) => {
        res.setHeader(key, value)
      })

      const bodyBuffer = Buffer.from(await webResponse.arrayBuffer())
      res.send(bodyBuffer)
    } catch (error) {
      next(error)
    }
  }
}

function toWebRequest(req: ExpressRequest): Request {
  const protocol = req.protocol || 'http'
  const host = req.get('host') || 'localhost'
  const url = new URL(req.originalUrl || req.url, `${protocol}://${host}`)

  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item)
      }
    } else if (typeof value === 'string') {
      headers.set(key, value)
    }
  }

  const method = req.method.toUpperCase()
  const init: RequestInit = { method, headers }

  if (method !== 'GET' && method !== 'HEAD') {
    // Support both apps with express.json() already mounted and raw unparsed streams
    if (req.body !== undefined && Object.keys(req.body).length > 0) {
      init.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body)
    } else if (req.readable) {
      init.body = req as unknown as ReadableStream
      // Required by Node's native fetch Request when passing a readable stream body
      ;(init as RequestInit & { duplex: 'half' }).duplex = 'half'
    }
  }

  return new Request(url.toString(), init)
}