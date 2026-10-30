/**
 * Usage Watch — HTTP 路由。
 *
 * 三条只读/设置路由，通过 `ctx.connection.fetch.register` 注册：
 * 只有已认证的 owner peer 可访问；浏览器同源 fetch 自带 Cookie。
 * handler 内的异常一律转成 JSON，不冒泡到 Host fiber。
 */

/** 路由清单（测试用来断言条数与 path）。 */
export const ROUTE_MANIFEST = Object.freeze([
  { path: '/api/usage-watch/state', methods: Object.freeze(['GET']) },
  { path: '/api/usage-watch/refresh', methods: Object.freeze(['POST']) },
  { path: '/api/usage-watch/config', methods: Object.freeze(['POST']) },
])

function jsonResponse(data, status = 200) {
  const headers = { 'cache-control': 'no-store' }
  try {
    if (typeof Response.json === 'function') return Response.json(data, { status, headers })
  } catch {
    /* 手工构造 */
  }
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  })
}

function httpError(message, status) {
  const error = new Error(message)
  error.status = status
  return error
}

async function readJsonBody(request) {
  let text = ''
  try {
    text = await request.text()
  } catch (error) {
    throw httpError(`读取请求体失败: ${error && error.message ? error.message : String(error)}`, 400)
  }
  if (!text || !text.trim()) return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw httpError('请求体不是合法 JSON', 400)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw httpError('请求体必须是 JSON 对象', 400)
  }
  return parsed
}

function route(definition) {
  const { path, methods, handler } = definition
  return {
    path,
    methods,
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        return await handler(request)
      } catch (error) {
        const status = Number.isInteger(error && error.status) ? error.status : 500
        const message = error && error.message ? error.message : String(error)
        return jsonResponse({ ok: false, error: message }, status)
      }
    },
  }
}

export function buildRoutes(engine) {
  return [
    route({
      path: '/api/usage-watch/state',
      methods: ['GET'],
      handler: () => jsonResponse(engine.buildState()),
    }),

    route({
      path: '/api/usage-watch/refresh',
      methods: ['POST'],
      handler: async () => jsonResponse(await engine.refresh()),
    }),

    route({
      path: '/api/usage-watch/config',
      methods: ['POST'],
      handler: async (request) => {
        const body = await readJsonBody(request)
        const patch = body.patch
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
          throw httpError('patch 必须是对象', 400)
        }
        return jsonResponse(await engine.patchConfig(patch))
      },
    }),
  ]
}
