/**
 * Usage Watch — Host 集成自检（引擎 + 路由 + llm/stream 包装 + 持久化）。
 * 运行：node test/host-integration.mjs
 *
 * 不启动 Cordis：用假的 ctx 提供 probe / fetchImpl，走真实的路由对象与
 * Request/Response，验证浏览器会拿到的 State JSON。
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createEngine } from '../lib/engine.js'
import { buildRoutes, ROUTE_MANIFEST } from '../lib/routes.js'
import { wrapStream } from '../index.js'
import { dayKey } from '../lib/tracker.js'

const NOW = new Date('2026-10-29T12:00:00+08:00').getTime()

let passed = 0
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1
      console.log(`ok ${passed} - ${name}`)
    })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeProbe(rows) {
  return {
    supported: true,
    async sample() {
      return { supported: true, error: null, at: NOW, rows, services: {} }
    },
    reset() {},
  }
}

const PROBE_ROWS = [
  {
    pid: 1001,
    name: 'Doubao',
    nameLower: 'doubao',
    workingSet: 300 * 1024 * 1024,
    cpuSeconds: 12,
    startTime: NOW - 2 * 3600 * 1000,
    cpuPercent: 1.5,
  },
]

async function postJson(route, path, body) {
  const request = new Request(`http://127.0.0.1:55422${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const response = await route.fetch(request)
  return { status: response.status, json: await response.json(), response }
}

const dir = await mkdtemp(join(tmpdir(), 'usage-watch-test-'))
const storeFile = join(dir, 'state.json')
const clock = () => NOW
const offlineFetch = async () => {
  throw new Error('offline (test)')
}

await test('engine start + refresh aggregates process probe', async () => {
  const engine = createEngine({
    config: {
      services: {
        doubao: {
          processes: ['Doubao'],
          quota: { manual: { used: 2, limit: 10, unit: '次' } },
        },
      },
    },
    storeFile,
    probe: makeProbe(PROBE_ROWS),
    clock,
    fetchImpl: offlineFetch,
  })
  engine.start()
  await engine.refresh()
  await sleep(30)
  await engine.refresh()

  const state = engine.buildState()
  assert.equal(state.ok, true)
  assert.equal(state.services[0].id, 'doubao')
  assert.equal(state.services[0].running, true)
  assert.equal(state.services[0].memoryMB, 300)
  assert.equal(state.services[0].cpuPercent, 1.5)
  assert.equal(state.services[0].quota.source, 'manual')
  assert.equal(state.services[0].quota.percent, 20)
  assert.equal(state.dshtoken.today.totalTokens, 0)
  assert.deepEqual(state.config.services.doubao.quota.manual, { used: 2, limit: 10, unit: '次' })
  assert.equal(JSON.stringify(state).includes('"token"'), false)

  const routes = buildRoutes(engine)
  assert.equal(ROUTE_MANIFEST.length, 3)
  assert.deepEqual(routes.map((route) => route.path), ROUTE_MANIFEST.map((entry) => entry.path))

  const stateRoute = routes.find((route) => route.path === '/api/usage-watch/state')
  const response = await stateRoute.fetch(new Request('http://127.0.0.1:55422/api/usage-watch/state'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const json = await response.json()
  assert.equal(json.ok, true)
  assert.equal(json.services[0].label, '豆包')
  assert.equal(json.dshtoken.today.requests, 0)

  const refreshRoute = routes.find((route) => route.path === '/api/usage-watch/refresh')
  const refreshedResponse = await refreshRoute.fetch(new Request('http://127.0.0.1:55422/api/usage-watch/refresh', { method: 'POST' }))
  assert.equal(refreshedResponse.status, 200)
  const refreshed = await refreshedResponse.json()
  assert.equal(refreshed.ok, true)
  assert.equal(refreshed.services[0].running, true)

  engine.dispose()
})

await test('wrapStream counts one usage per stream and passes chunks through', async () => {
  const engine = createEngine({ config: {}, storeFile: join(dir, 'ignored.json'), probe: makeProbe([]), clock, fetchImpl: offlineFetch })
  const requestOptions = { provider: 'deepseek-account', model: 'deepseek-flash', sessionId: 's1' }
  const upstream = async function* upstreamStream() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'hello' }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } }
    // 同一调用里的第二个 usage 不应该被重复累加
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 40 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const seen = []
  for await (const chunk of wrapStream(requestOptions, () => upstream(), engine)) {
    seen.push(chunk.type)
  }
  assert.deepEqual(seen, ['block-start', 'text-delta', 'usage', 'usage', 'finish'])

  const state = engine.buildState()
  assert.equal(state.dshtoken.today.inputTokens, 100)
  assert.equal(state.dshtoken.today.outputTokens, 40)
  assert.equal(state.dshtoken.today.totalTokens, 140)
  assert.equal(state.dshtoken.today.requests, 1)
  assert.equal(state.dshtoken.lastCall.model, 'deepseek-flash')
  engine.dispose()
})

await test('config route updates manual quota and persists', async () => {
  const persistFile = join(dir, 'persist.json')
  const engine = createEngine({
    config: { services: { doubao: { processes: ['Doubao'] } } },
    storeFile: persistFile,
    probe: makeProbe(PROBE_ROWS),
    clock,
    fetchImpl: offlineFetch,
  })
  engine.start()
  await engine.refresh()

  const routes = buildRoutes(engine)
  const configRoute = routes.find((route) => route.path === '/api/usage-watch/config')

  const result = await postJson(configRoute, '/api/usage-watch/config', {
    patch: {
      refreshSeconds: 20,
      dshtoken: { dailyLimit: 5000 },
      services: {
        doubao: {
          quota: {
            endpoint: 'https://example.com/usage',
            token: 'secret',
            manual: { used: 7, limit: 20, unit: '次' },
          },
        },
      },
    },
  })
  assert.equal(result.status, 200)
  assert.equal(result.json.config.refreshSeconds, 20)
  assert.equal(result.json.config.dshtoken.dailyLimit, 5000)
  assert.equal(result.json.config.dshtoken.apiEndpoint, 'http://127.0.0.1:8765/api/v1/token/usage')
  assert.equal(result.json.config.services.doubao.quota.hasToken, true)
  assert.equal(result.json.config.services.doubao.quota.manual.used, 7)

  const bad = await postJson(configRoute, '/api/usage-watch/config', { patch: { nothing: 1 } })
  assert.equal(bad.status, 400)
  assert.equal(bad.json.ok, false)

  const notObject = await postJson(configRoute, '/api/usage-watch/config', { patch: [1, 2] })
  assert.equal(notObject.status, 400)

  engine.dispose()
  await sleep(150)
  const persisted = JSON.parse(await readFile(persistFile, 'utf8'))
  assert.equal(persisted.version, 1)
  assert.equal(persisted.config.services.doubao.quota.manual.used, 7)
  assert.equal(persisted.config.services.doubao.quota.endpoint, 'https://example.com/usage')
})

await test('quota endpoint success and failure fallback', async () => {
  const settings = {
    services: {
      doubao: {
        processes: ['Doubao'],
        quota: { endpoint: 'https://example.com/usage', manual: { used: 1, limit: 4, unit: '次' } },
      },
    },
  }
  const okEngine = createEngine({
    config: settings,
    storeFile: join(dir, 'quota-ok.json'),
    probe: makeProbe([]),
    clock,
    fetchImpl: async () => new Response(JSON.stringify({ used: 3, limit: 10, unit: '次' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  })
  okEngine.start()
  await okEngine.refresh()
  const okState = okEngine.buildState()
  assert.equal(okState.services[0].quota.source, 'endpoint')
  assert.equal(okState.services[0].quota.percent, 30)
  okEngine.dispose()

  const failEngine = createEngine({
    config: settings,
    storeFile: join(dir, 'quota-fail.json'),
    probe: makeProbe([]),
    clock,
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED')
    },
  })
  failEngine.start()
  await failEngine.refresh()
  const failState = failEngine.buildState()
  assert.equal(failState.services[0].quota.source, 'manual')
  assert.ok(failState.services[0].quotaError.includes('ECONNREFUSED'))
  failEngine.dispose()
})

await test('token usage API feeds dshtoken, falls back when unavailable', async () => {
  const tokenPayload = {
    ok: true,
    service: 'dsh-token-usage-api',
    version: 1,
    updatedAt: NOW,
    today: { date: '2026-10-29', inputTokens: 1000, outputTokens: 500, totalTokens: 12345, cacheReadTokens: 10845, requests: 7 },
    allTime: { inputTokens: 2000, outputTokens: 1000, totalTokens: 22345, requests: 9 },
    days: { '2026-10-28': { inputTokens: 1, outputTokens: 1, totalTokens: 2, requests: 1 } },
    lastCall: { at: NOW - 1000, provider: 'deepseek-account', model: 'deepseek-flash', inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    trackingSince: NOW - 86400000,
  }
  const engine = createEngine({
    config: { dshtoken: { apiEndpoint: 'http://127.0.0.1:8765/api/v1/token/usage' } },
    storeFile: join(dir, 'token-api.json'),
    probe: makeProbe([]),
    clock,
    fetchImpl: async (url) => {
      if (String(url).includes('/api/v1/token/usage')) {
        return new Response(JSON.stringify(tokenPayload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      throw new Error(`unexpected url: ${url}`)
    },
  })
  engine.start()
  await engine.refresh()
  const state = engine.buildState()
  assert.equal(state.dshtoken.api.ok, true)
  assert.equal(state.dshtoken.api.endpoint, 'http://127.0.0.1:8765/api/v1/token/usage')
  assert.equal(state.dshtoken.api.data.today.totalTokens, 12345)
  assert.equal(state.dshtoken.api.data.allTime.totalTokens, 22345)
  assert.equal(state.dshtoken.api.data.today.requests, 7)
  assert.equal(state.config.dshtoken.apiEndpoint, 'http://127.0.0.1:8765/api/v1/token/usage')
  engine.dispose()

  const fallback = createEngine({
    config: {},
    storeFile: join(dir, 'token-api-fail.json'),
    probe: makeProbe([]),
    clock,
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED')
    },
  })
  fallback.start()
  await fallback.refresh()
  const fallbackState = fallback.buildState()
  assert.equal(fallbackState.dshtoken.api.ok, false)
  assert.ok(fallbackState.dshtoken.api.error.includes('ECONNREFUSED'))
  // 本机统计仍然可用，客户端会回退显示它
  assert.equal(fallbackState.dshtoken.today.totalTokens, 0)
  fallback.dispose()

  const disabled = createEngine({
    config: { dshtoken: { apiEndpoint: '' } },
    storeFile: join(dir, 'token-api-off.json'),
    probe: makeProbe([]),
    clock,
    fetchImpl: async () => {
      throw new Error('should not be called')
    },
  })
  disabled.start()
  await disabled.refresh()
  assert.equal(disabled.buildState().dshtoken.api, null)
  disabled.dispose()
})

await test('running desktop apps accumulate daily usage time', async () => {
  let now = new Date('2026-10-30T09:00:00+08:00').getTime()
  let rows = [
    {
      pid: 2001,
      name: 'Doubao',
      nameLower: 'doubao',
      workingSet: 100 * 1024 * 1024,
      cpuSeconds: 1,
      startTime: now - 60 * 1000,
      cpuPercent: 2,
    },
  ]
  const probe = {
    supported: true,
    async sample() {
      return { supported: true, error: null, at: now, rows }
    },
    reset() {},
  }
  const activeFile = join(dir, 'active-time.json')
  const engine = createEngine({
    config: {},
    storeFile: activeFile,
    probe,
    clock: () => now,
    fetchImpl: offlineFetch,
  })
  await engine.refresh()
  assert.equal(engine.buildState().services[0].todayActiveSeconds, 0)

  now += 30_000
  await engine.refresh()
  now += 30_000
  await engine.refresh()
  const runningState = engine.buildState()
  assert.equal(runningState.services[0].running, true)
  assert.equal(runningState.services[0].todayActiveSeconds, 60)
  assert.ok(runningState.services[0].activeSeconds >= 60)

  // 进程退出：当前连续时长归零，但今日累计保留
  rows = []
  now += 30_000
  await engine.refresh()
  const stoppedState = engine.buildState()
  assert.equal(stoppedState.services[0].running, false)
  assert.equal(stoppedState.services[0].activeSeconds, 0)
  assert.equal(stoppedState.services[0].todayActiveSeconds, 60)

  engine.dispose()
  await sleep(150)
  const persisted = JSON.parse(await readFile(activeFile, 'utf8'))
  assert.equal(persisted.activeTime.days[dayKey(now)].doubao, 60)
})

await test('per-service token endpoint feeds the card', async () => {
  const payload = {
    ok: true,
    service: 'dsh-token-usage-api',
    today: { inputTokens: 10, outputTokens: 5, totalTokens: 777, requests: 3 },
    allTime: { inputTokens: 20, outputTokens: 10, totalTokens: 888, requests: 4 },
  }
  const engine = createEngine({
    config: {
      services: {
        doubao: { tokenEndpoint: 'http://127.0.0.1:8765/api/v1/token/usage' },
        workbuddy: { tokenEndpoint: '' },
      },
    },
    storeFile: join(dir, 'service-token.json'),
    probe: makeProbe([]),
    clock,
    fetchImpl: async (url) => {
      if (String(url).includes('/api/v1/token/usage')) {
        return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      throw new Error(`unexpected url: ${url}`)
    },
  })
  engine.start()
  await engine.refresh()
  const state = engine.buildState()
  assert.equal(state.services[0].tokenUsage.ok, true)
  assert.equal(state.services[0].tokenUsage.today.totalTokens, 777)
  assert.equal(state.services[0].tokenUsage.today.requests, 3)
  assert.equal(state.services[0].tokenUsage.allTime.totalTokens, 888)
  assert.equal(state.services[0].tokenUsage.endpoint, 'http://127.0.0.1:8765/api/v1/token/usage')
  assert.equal(state.services[1].tokenUsage, null)
  engine.dispose()
})

await test('workbuddy metrics API maps today / window totals / credit', async () => {
  const metrics = {
    generatedAt: new Date(NOW).toISOString(),
    usage: {
      window: { days: 7, since: '2026-10-23' },
      totals: { promptTokens: 45140668, completionTokens: 294831, totalTokens: 45435499, credit: 176.22, requests: 456 },
      windowTotals: { promptTokens: 45140668, completionTokens: 294831, totalTokens: 45435499, credit: 176.22, requests: 456 },
      daily: [
        { date: '2026-10-29', promptTokens: 100, completionTokens: 20, totalTokens: 120, credit: 0.5, requests: 2 },
        { date: '2026-10-28', promptTokens: 10, completionTokens: 2, totalTokens: 12, credit: 0.1, requests: 1 },
      ],
      models: [],
    },
  }
  let healthy = true
  const engine = createEngine({
    config: {},
    storeFile: join(dir, 'workbuddy-metrics.json'),
    probe: makeProbe([]),
    clock,
    fetchImpl: async (url) => {
      if (!String(url).includes('/api/metrics?days=7')) throw new Error(`unexpected url: ${url}`)
      if (!healthy) throw new Error('ECONNREFUSED')
      return new Response(JSON.stringify(metrics), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  engine.start()
  await engine.refresh()
  const state = engine.buildState()
  const workbuddy = state.services.find((service) => service.id === 'workbuddy')
  assert.equal(workbuddy.tokenUsage.ok, true)
  assert.equal(workbuddy.tokenUsage.endpoint, 'http://127.0.0.1:8787/api/metrics?days=7')
  assert.equal(workbuddy.tokenUsage.today.totalTokens, 120)
  assert.equal(workbuddy.tokenUsage.today.requests, 2)
  assert.equal(workbuddy.tokenUsage.today.credit, 0.5)
  assert.equal(workbuddy.tokenUsage.allTime.totalTokens, 45435499)
  assert.equal(workbuddy.tokenUsage.window.days, 7)
  // 豆包默认配的 8765 就是 DSH Token 的同一接口 → 失败时允许回退本机统计
  const doubao = state.services.find((service) => service.id === 'doubao')
  assert.equal(doubao.tokenUsage.ok, false)
  assert.equal(doubao.tokenUsage.fallback, true)
  assert.equal(doubao.tokenUsage.today.totalTokens, state.dshtoken.today.totalTokens)

  // WorkBuddy 的 8787 是间歇性服务：掉线后保留上次真实数字，只标记失败
  healthy = false
  await engine.refresh()
  const stale = engine.buildState().services.find((service) => service.id === 'workbuddy')
  assert.equal(stale.tokenUsage.ok, false)
  assert.ok(stale.tokenUsage.error.includes('ECONNREFUSED'))
  assert.equal(stale.tokenUsage.today.totalTokens, 120)
  engine.dispose()
})

await test('token service auto-start spawns once per cooldown and retries the fetch', async () => {
  const spawnCalls = []
  let fail = true
  const engine = createEngine({
    config: {
      dshtoken: { apiEndpoint: 'http://127.0.0.1:8765/api/v1/token/usage' },
      tokenService: { autoStart: true, startScript: fileURLToPath(import.meta.url) },
      services: { workbuddy: { tokenEndpoint: '' } },
    },
    storeFile: join(dir, 'autostart.json'),
    probe: makeProbe([]),
    clock,
    tokenServiceWaitMs: 0,
    spawnProcess: (command, args, options) => {
      spawnCalls.push({ command, args, options })
      return { on() {}, unref() {} }
    },
    fetchImpl: async () => {
      if (fail) throw new Error('ECONNREFUSED')
      throw new Error('still down')
    },
  })
  engine.start()
  await engine.refresh()
  const state = engine.buildState()
  assert.equal(state.dshtoken.api.ok, false)
  // 同源接口失败 → 回退本机统计，而不是数字消失
  assert.equal(state.dshtoken.api.data.source, 'local')
  assert.equal(spawnCalls.length, 1)
  assert.equal(spawnCalls[0].command, 'powershell.exe')
  assert.ok(spawnCalls[0].args.includes('-File'))
  const doubao = state.services.find((service) => service.id === 'doubao')
  assert.equal(doubao.tokenUsage.ok, false)
  assert.equal(doubao.tokenUsage.fallback, true)

  // 冷却期内不再重复拉起
  await engine.refresh()
  assert.equal(spawnCalls.length, 1)
  engine.dispose()
  fail = false
})

await test('state route survives an engine without probe support', async () => {
  const engine = createEngine({
    config: {},
    storeFile: join(dir, 'noprobe.json'),
    probe: { supported: false, async sample() { return { supported: false, error: null, at: NOW, rows: [], services: {} } }, reset() {} },
    clock,
    fetchImpl: offlineFetch,
  })
  engine.start()
  await engine.refresh()
  const state = engine.buildState()
  assert.equal(state.probe.supported, false)
  assert.equal(state.services.every((service) => service.running === null), true)
  engine.dispose()
})

await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
console.log(`\n${passed} integration checks passed`)
