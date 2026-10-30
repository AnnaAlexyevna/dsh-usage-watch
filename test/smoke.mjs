/**
 * Usage Watch — 纯逻辑自检（不触达 Cordis / 浏览器）。
 * 运行：node test/smoke.mjs
 */

import assert from 'node:assert/strict'

import { normalizeConfig, publicConfig, normalizeQuota } from '../lib/config.js'
import { createTracker, dayKey, normalizeUsage } from '../lib/tracker.js'
import { parseProcessRows, aggregateService, buildScript } from '../lib/probe.js'
import { parseQuotaPayload, decorateQuota, manualQuota, normalizeEndpointUrl } from '../lib/quota.js'
import { deepMerge, sanitizePatch } from '../lib/engine.js'

let passed = 0
function test(name, fn) {
  fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

/* ---------------------------------------------------------------- config */

test('normalizeConfig fills defaults and keeps unknown services', () => {
  const config = normalizeConfig({
    refreshSeconds: '45',
    historyDays: 3,
    dshtoken: { dailyLimit: 1234 },
    services: {
      doubao: { processes: ['Doubao.exe', ' Doubao '] },
      workbuddy: { label: 'Work Buddy' },
      custom: { label: 'Custom', processes: ['Custom'] },
    },
  })
  assert.equal(config.refreshSeconds, 45)
  assert.equal(config.historyDays, 3)
  assert.equal(config.dshtoken.dailyLimit, 1234)
  assert.deepEqual(config.services.map((service) => service.id), ['doubao', 'workbuddy', 'custom'])
  assert.deepEqual(config.services[0].processes, ['Doubao.exe', 'Doubao'])
  assert.equal(config.services[1].label, 'Work Buddy')
  assert.equal(config.services[2].label, 'Custom')
})

test('normalizeConfig clamps bad numeric input', () => {
  const config = normalizeConfig({ refreshSeconds: 1, historyDays: 999, dshtoken: { dailyLimit: -5 } })
  assert.equal(config.refreshSeconds, 10)
  assert.equal(config.historyDays, 60)
  assert.equal(config.dshtoken.dailyLimit, 0)
})

test('publicConfig hides endpoint token', () => {
  const config = normalizeConfig({
    services: {
      doubao: {
        quota: { endpoint: 'https://example.com/usage', token: 'secret-token' },
      },
    },
  })
  const exposed = publicConfig(config)
  const serialized = JSON.stringify(exposed)
  assert.equal(serialized.includes('secret-token'), false)
  assert.equal(exposed.services.doubao.quota.hasToken, true)
  assert.equal(exposed.services.doubao.quota.endpoint, 'https://example.com/usage')
})

test('token API endpoint defaults to local 8765 and can be disabled', () => {
  const defaults = normalizeConfig({})
  assert.equal(defaults.dshtoken.apiEndpoint, 'http://127.0.0.1:8765/api/v1/token/usage')
  const exposed = publicConfig(defaults)
  assert.equal(exposed.dshtoken.apiEndpoint, 'http://127.0.0.1:8765/api/v1/token/usage')
  const disabled = normalizeConfig({ dshtoken: { apiEndpoint: '' } })
  assert.equal(disabled.dshtoken.apiEndpoint, '')
})

test('doubao defaults to 8765 token API, workbuddy to its 8787 metrics API', () => {
  const config = normalizeConfig({})
  assert.equal(config.services[0].tokenEndpoint, 'http://127.0.0.1:8765/api/v1/token/usage')
  assert.equal(config.services[1].tokenEndpoint, 'http://127.0.0.1:8787/api/metrics?days=7')
  const exposed = publicConfig(config)
  assert.equal(exposed.services.doubao.tokenEndpoint, 'http://127.0.0.1:8765/api/v1/token/usage')
  assert.equal(exposed.services.workbuddy.tokenEndpoint, 'http://127.0.0.1:8787/api/metrics?days=7')
  const disabled = normalizeConfig({ services: { doubao: { tokenEndpoint: '' }, workbuddy: { tokenEndpoint: '' } } })
  assert.equal(disabled.services[0].tokenEndpoint, '')
  assert.equal(disabled.services[1].tokenEndpoint, '')
})

test('tokenService auto-start defaults on, script path is user-configured', () => {
  const config = normalizeConfig({})
  assert.equal(config.tokenService.autoStart, true)
  // 发布版默认留空：不同机器的 start-api.ps1 路径不同，由用户在设置里填。
  assert.equal(config.tokenService.startScript, '')
  const disabled = normalizeConfig({ tokenService: { autoStart: false, startScript: '' } })
  assert.equal(disabled.tokenService.autoStart, false)
  assert.equal(disabled.tokenService.startScript, '')
  const configured = normalizeConfig({
    tokenService: { startScript: ' D:\\DSH-Workspace\\token-usage-api\\start-api.ps1 ' },
  })
  assert.equal(configured.tokenService.autoStart, true)
  assert.equal(configured.tokenService.startScript, 'D:\\DSH-Workspace\\token-usage-api\\start-api.ps1')
})

test('sanitizePatch keeps per-service token endpoint', () => {
  const sanitized = sanitizePatch({
    services: { doubao: { tokenEndpoint: ' 127.0.0.1:8765/api/v1/token/usage ', quota: { manual: { used: 1, limit: 2 } } } },
  }, new Set(['doubao']))
  assert.equal(sanitized.services.doubao.tokenEndpoint, '127.0.0.1:8765/api/v1/token/usage')
  assert.equal(sanitized.services.doubao.quota.manual.used, 1)
})

test('normalizeQuota defaults tokenHeader and manual fields', () => {
  const quota = normalizeQuota({ manual: { used: '3', limit: 10 } })
  assert.equal(quota.tokenHeader, 'Authorization')
  assert.equal(quota.manual.used, 3)
  assert.equal(quota.manual.limit, 10)
  assert.equal(quota.fields.used, 'used')
})

/* --------------------------------------------------------------- tracker */

test('normalizeUsage falls back to input+output', () => {
  const usage = normalizeUsage({ inputTokens: '12', outputTokens: 8 })
  assert.equal(usage.totalTokens, 20)
  assert.equal(usage.inputTokens, 12)
})

test('tracker accumulates today and history without double counting', () => {
  const clock = () => new Date('2026-10-29T10:00:00+08:00').getTime()
  const tracker = createTracker({ retentionDays: 14, clock })
  tracker.record({ provider: 'deepseek-account', model: 'deepseek-flash' }, { inputTokens: 100, outputTokens: 40 })
  tracker.record({ model: 'deepseek-flash' }, { inputTokens: 10, outputTokens: 5, totalTokens: 15 })
  const snapshot = tracker.snapshot()
  assert.equal(snapshot.today.inputTokens, 110)
  assert.equal(snapshot.today.outputTokens, 45)
  assert.equal(snapshot.today.totalTokens, 155)
  assert.equal(snapshot.today.requests, 2)
  assert.equal(snapshot.allTime.totalTokens, 155)
  assert.equal(snapshot.lastCall.model, 'deepseek-flash')
  assert.equal(snapshot.history.length, 7)
  assert.equal(snapshot.history[6].date, dayKey(clock()))
})

test('tracker hydrate restores days and ignores garbage', () => {
  const tracker = createTracker({ retentionDays: 60 })
  tracker.hydrate({
    days: {
      '2026-10-28': { inputTokens: 10, outputTokens: 2, totalTokens: 12, requests: 1 },
      garbage: { inputTokens: 5 },
    },
    allTime: { inputTokens: 10, outputTokens: 2, totalTokens: 12, requests: 1 },
    trackingSince: 1700000000000,
    lastCall: { at: 1700000000000, model: 'm', inputTokens: 1, outputTokens: 1 },
  })
  const serialized = tracker.serialize()
  assert.equal(serialized.days['2026-10-28'].totalTokens, 12)
  assert.equal(serialized.days.garbage, undefined)
  assert.equal(serialized.trackingSince, 1700000000000)
  assert.equal(serialized.allTime.totalTokens, 12)
})

/* ----------------------------------------------------------------- probe */

test('powerShell script quotes process names safely', () => {
  const script = buildScript(["Doubao", "O'Brien"])
  assert.ok(script.includes("'Doubao'"))
  assert.ok(script.includes("'O''Brien'"))
})

test('parseProcessRows handles single object and array', () => {
  const single = parseProcessRows(JSON.stringify({
    Id: 123,
    ProcessName: 'Doubao',
    WorkingSet64: 104857600,
    CPU: 12.5,
    StartTime: '2026-10-29T08:00:00.1234567+08:00',
  }))
  assert.equal(single.length, 1)
  assert.equal(single[0].pid, 123)
  assert.equal(single[0].workingSet, 104857600)
  assert.equal(single[0].cpuSeconds, 12.5)
  assert.equal(typeof single[0].startTime, 'number')

  const many = parseProcessRows(JSON.stringify([
    { Id: 1, ProcessName: 'WorkBuddy', WorkingSet64: 10, CPU: 1 },
    { Id: 2, ProcessName: 'Other', WorkingSet64: 20, CPU: 2 },
    null,
  ]))
  assert.equal(many.length, 2)
  assert.equal(parseProcessRows('not json').length, 0)
  assert.equal(parseProcessRows('').length, 0)
})

test('aggregateService sums memory and cpu of matching processes', () => {
  const at = Date.now()
  const rows = [
    { pid: 1, name: 'Doubao', nameLower: 'doubao', workingSet: 100 * 1024 * 1024, cpuSeconds: 1, startTime: at - 3600_000, cpuPercent: 2.5 },
    { pid: 2, name: 'Doubao', nameLower: 'doubao', workingSet: 50 * 1024 * 1024, cpuSeconds: 1, startTime: at - 3600_000, cpuPercent: 1.5 },
    { pid: 3, name: 'Other', nameLower: 'other', workingSet: 999, cpuSeconds: 1, startTime: at, cpuPercent: 99 },
  ]
  const status = aggregateService(rows, ['Doubao'], at)
  assert.equal(status.running, true)
  assert.equal(status.processCount, 2)
  assert.equal(status.memoryMB, 150)
  assert.equal(status.cpuPercent, 4)
  assert.equal(status.uptimeSeconds, 3600)

  const idle = aggregateService([], ['Doubao'], at)
  assert.equal(idle.running, false)
  assert.equal(idle.processCount, 0)
})

/* ----------------------------------------------------------------- quota */

test('parseQuotaPayload reads configured paths first', () => {
  const parsed = parseQuotaPayload(
    { data: { consumed: 30, total: 100, label: '次' } },
    { used: 'data.consumed', limit: 'data.total', unit: 'data.label' },
  )
  assert.equal(parsed.used, 30)
  assert.equal(parsed.limit, 100)
  assert.equal(parsed.unit, '次')
})

test('parseQuotaPayload falls back to common field names and reports errors', () => {
  const parsed = parseQuotaPayload({ used_tokens: '1,200', limit: 5000, status: '月度额度' })
  assert.equal(parsed.used, 1200)
  assert.equal(parsed.limit, 5000)
  assert.equal(parsed.note, '月度额度')
  assert.ok(parseQuotaPayload({ foo: 1 }).error)
  assert.ok(parseQuotaPayload('nope').error)
})

test('parseQuotaPayload explains token-API / health endpoint misuse', () => {
  const tokenApi = parseQuotaPayload({
    ok: true,
    service: 'dsh-token-usage-api',
    today: { totalTokens: 1 },
    allTime: { totalTokens: 2 },
  })
  assert.ok(tokenApi.error.includes('DSH Token'))
  const health = parseQuotaPayload({ ok: true, service: 'dsh-token-usage-api', stateOk: true, stateFile: 'x' })
  assert.ok(health.error.includes('健康检查'))
  const generic = parseQuotaPayload({ foo: 1 })
  assert.ok(generic.error.includes('used / limit'))
})

test('normalizeEndpointUrl prefixes a bare host:port with http://', () => {
  assert.equal(normalizeEndpointUrl('127.0.0.1:8765/api/v1/token/usage'), 'http://127.0.0.1:8765/api/v1/token/usage')
  assert.equal(normalizeEndpointUrl('https://example.com/usage'), 'https://example.com/usage')
  assert.equal(normalizeEndpointUrl('  '), '')
  assert.equal(normalizeEndpointUrl(null), '')
})

test('manualQuota and decorateQuota compute percent', () => {
  const service = { quota: { manual: { used: 50, limit: 200, unit: '次' } } }
  const manual = manualQuota(service)
  const decorated = decorateQuota(manual, 'manual', 123)
  assert.equal(decorated.percent, 25)
  assert.equal(decorated.unit, '次')
  assert.equal(manualQuota({ quota: { manual: { used: null, limit: null } } }), null)
})

/* ---------------------------------------------------------------- engine */

test('deepMerge replaces arrays and merges nested objects', () => {
  const merged = deepMerge(
    { services: { doubao: { quota: { endpoint: 'a', manual: { used: 1 } } } }, list: [1, 2] },
    { services: { doubao: { quota: { endpoint: 'b' } } }, list: [3] },
  )
  assert.equal(merged.services.doubao.quota.endpoint, 'b')
  assert.equal(merged.services.doubao.quota.manual.used, 1)
  assert.deepEqual(merged.list, [3])
})

test('sanitizePatch drops unknown services and fields, keeps manual values', () => {
  const sanitized = sanitizePatch({
    refreshSeconds: 20,
    evil: { hacked: true },
    services: {
      doubao: { quota: { endpoint: ' https://x/y ', token: 't', manual: { used: '5', limit: 10, unit: '次' } } },
      unknown: { quota: { endpoint: 'https://evil' } },
    },
  }, new Set(['doubao', 'workbuddy']))
  assert.equal(sanitized.refreshSeconds, 20)
  assert.equal(sanitized.evil, undefined)
  assert.equal(sanitized.services.unknown, undefined)
  assert.equal(sanitized.services.doubao.quota.endpoint, 'https://x/y')
  assert.equal(sanitized.services.doubao.quota.manual.used, 5)
  assert.equal(sanitizePatch({ nothing: true }, new Set(['doubao'])), null)
})

test('sanitizePatch can clear manual values with null', () => {
  const sanitized = sanitizePatch({ services: { doubao: { quota: { manual: { used: null, limit: null } } } } }, new Set(['doubao']))
  assert.deepEqual(sanitized.services.doubao.quota.manual, { used: null, limit: null })
})

test('sanitizePatch keeps and can clear the dshtoken API endpoint', () => {
  const sanitized = sanitizePatch({
    dshtoken: { dailyLimit: 10, apiEndpoint: '  http://127.0.0.1:8765/api/v1/token/usage  ' },
  }, new Set(['doubao']))
  assert.equal(sanitized.dshtoken.dailyLimit, 10)
  assert.equal(sanitized.dshtoken.apiEndpoint, 'http://127.0.0.1:8765/api/v1/token/usage')

  const cleared = sanitizePatch({ dshtoken: { apiEndpoint: '' } }, new Set(['doubao']))
  assert.equal(cleared.dshtoken.apiEndpoint, '')
})

console.log(`\n${passed} checks passed`)
