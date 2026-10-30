/**
 * Usage Watch — Host 引擎。
 *
 * 负责：
 *   - 累计 DSH Token 用量（由 index.js 的 llm/stream 监听喂进来）
 *   - 定时探测豆包 / WorkBuddy 进程，拉取配置的额度接口
 *   - 持久化到 %USERPROFILE%\.dsh\usage-watch\state.json（含今日/历史 token 与设置）
 *   - 组装浏览器要的 State JSON
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { normalizeConfig, publicConfig } from './config.js'
import { createTracker, dayKey } from './tracker.js'
import { aggregateService, createProbe } from './probe.js'
import { decorateQuota, fetchQuota, manualQuota, normalizeEndpointUrl } from './quota.js'

const STORE_VERSION = 1
const SAVE_DEBOUNCE_MS = 2500
const TOKEN_API_TIMEOUT_MS = 4000
/** 自动拉起本地 token 接口的最小间隔（避免接口真坏了时每轮都启动进程）。 */
const TOKEN_SERVICE_RETRY_MS = 120000
export const DEFAULT_STORE_FILE = join(homedir(), '.dsh', 'usage-watch', 'state.json')

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clone(value) {
  if (!isObject(value) && !Array.isArray(value)) return value
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return {}
  }
}

/** 深合并：对象递归合并，数组/标量整体替换。 */
export function deepMerge(base, patch) {
  if (!isObject(base)) return clone(patch)
  if (!isObject(patch)) return clone(base)
  const result = clone(base)
  for (const key of Object.keys(patch)) {
    const value = patch[key]
    if (isObject(value) && isObject(result[key])) result[key] = deepMerge(result[key], value)
    else if (value !== undefined) result[key] = clone(value)
  }
  return result
}

function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text.length > maxLength ? text.slice(0, maxLength) : text
}

function cleanManualNumber(value) {
  if (value === null) return null
  const parsed = finiteNumber(value)
  if (parsed === undefined) return undefined
  return Math.max(0, Math.min(1e15, parsed))
}

/**
 * 只接受设置页会写的字段，其他一律丢弃（防止把任意结构写进 state.json）。
 * 返回 null 表示没有任何可应用的字段。
 */
export function sanitizePatch(patch, knownServiceIds) {
  if (!isObject(patch)) return null
  const result = {}

  const refreshSeconds = finiteNumber(patch.refreshSeconds)
  if (refreshSeconds !== undefined) result.refreshSeconds = Math.min(300, Math.max(10, Math.round(refreshSeconds)))

  if (isObject(patch.dshtoken)) {
    const dshtoken = {}
    const dailyLimit = finiteNumber(patch.dshtoken.dailyLimit)
    if (dailyLimit !== undefined) dshtoken.dailyLimit = Math.max(0, Math.min(1e12, Math.round(dailyLimit)))
    const apiEndpoint = cleanText(patch.dshtoken.apiEndpoint, 2048)
    if (apiEndpoint !== undefined) dshtoken.apiEndpoint = apiEndpoint
    if (Object.keys(dshtoken).length) result.dshtoken = dshtoken
  }

  if (isObject(patch.tokenService)) {
    const tokenService = {}
    if (typeof patch.tokenService.autoStart === 'boolean') tokenService.autoStart = patch.tokenService.autoStart
    const startScript = cleanText(patch.tokenService.startScript, 2048)
    if (startScript !== undefined) tokenService.startScript = startScript
    if (Object.keys(tokenService).length) result.tokenService = tokenService
  }

  if (isObject(patch.services)) {
    const services = {}
    for (const id of Object.keys(patch.services)) {
      if (!knownServiceIds.has(id)) continue
      const incoming = patch.services[id]
      if (!isObject(incoming)) continue
      const cleanedService = {}
      const tokenEndpoint = cleanText(incoming.tokenEndpoint, 2048)
      if (tokenEndpoint !== undefined) cleanedService.tokenEndpoint = tokenEndpoint
      if (isObject(incoming.quota)) {
        const quota = incoming.quota
        const clean = {}
        const endpoint = cleanText(quota.endpoint, 2048)
        if (endpoint !== undefined) clean.endpoint = endpoint
        const token = cleanText(quota.token, 4096)
        if (token !== undefined) clean.token = token
        const tokenHeader = cleanText(quota.tokenHeader, 64)
        if (tokenHeader !== undefined) clean.tokenHeader = tokenHeader
        if (isObject(quota.fields)) {
          const fields = {}
          for (const key of ['used', 'limit', 'unit', 'resetAt', 'note']) {
            const text = cleanText(quota.fields[key], 200)
            if (text !== undefined) fields[key] = text
          }
          if (Object.keys(fields).length) clean.fields = fields
        }
        if (isObject(quota.manual)) {
          const manual = {}
          for (const key of ['used', 'limit']) {
            const value = cleanManualNumber(quota.manual[key])
            if (value !== undefined) manual[key] = value
          }
          const unit = cleanText(quota.manual.unit, 32)
          if (unit !== undefined) manual.unit = unit
          if (Object.keys(manual).length) clean.manual = manual
        }
        if (Object.keys(clean).length) cleanedService.quota = clean
      }
      if (Object.keys(cleanedService).length) services[id] = cleanedService
    }
    if (Object.keys(services).length) result.services = services
  }

  return Object.keys(result).length ? result : null
}

function errorMessage(error) {
  if (!error) return 'unknown error'
  if (typeof error === 'string') return error
  if (error.message) return String(error.message)
  return String(error)
}

function tokenCount(value) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number >= 0 ? number : 0
}

function tokenCredit(value) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number !== 0 ? number : 0
}

function tokenBucket(raw) {
  if (!isObject(raw)) return null
  const inputTokens = tokenCount(raw.inputTokens ?? raw.promptTokens)
  const outputTokens = tokenCount(raw.outputTokens ?? raw.completionTokens)
  const reportedTotal = tokenCount(raw.totalTokens)
  return {
    date: typeof raw.date === 'string' ? raw.date : '',
    inputTokens,
    outputTokens,
    totalTokens: reportedTotal > 0 ? reportedTotal : inputTokens + outputTokens,
    cacheReadTokens: tokenCount(raw.cacheReadTokens),
    cacheWriteTokens: tokenCount(raw.cacheWriteTokens),
    reasoningTokens: tokenCount(raw.reasoningTokens),
    requests: tokenCount(raw.requests),
    credit: tokenCredit(raw.credit),
  }
}

/**
 * 解析 token 接口响应，支持两种真实接口：
 *   1. token-usage-api（/api/v1/token/usage）：{ today, allTime, days, lastCall }
 *   2. WorkBuddy metrics（/api/metrics?days=7）：{ usage: { window, totals, daily[] } }
 * 缺少用量字段视为不可用，交由调用方回退到本机统计。
 */
export function normalizeTokenApiPayload(payload, options = {}) {
  if (!isObject(payload)) throw new Error('token 接口返回的不是 JSON 对象')

  // WorkBuddy 本机 metrics 接口：credit / promptTokens / completionTokens / daily[]
  if (isObject(payload.usage)) {
    const usage = payload.usage
    const totalsRaw = isObject(usage.totals)
      ? usage.totals
      : (isObject(usage.windowTotals) ? usage.windowTotals : null)
    const daily = Array.isArray(usage.daily) ? usage.daily : []
    const days = {}
    for (const entry of daily) {
      if (!isObject(entry)) continue
      const key = typeof entry.date === 'string' ? entry.date : ''
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue
      const bucket = tokenBucket(entry)
      if (bucket) {
        bucket.date = key
        days[key] = bucket
      }
    }
    if (!totalsRaw && !Object.keys(days).length) {
      throw new Error('接口 JSON 里既没有 usage.totals 也没有 usage.daily')
    }
    const now = Number.isFinite(options.now) ? options.now : Date.now()
    const todayKey = dayKey(now)
    const today = days[todayKey] || tokenBucket({ date: todayKey })
    const allTime = totalsRaw ? tokenBucket(totalsRaw) : null
    const window = isObject(usage.window)
      ? {
          days: tokenCount(usage.window.days),
          since: typeof usage.window.since === 'string' ? usage.window.since : '',
        }
      : null
    return {
      service: typeof payload.service === 'string' ? payload.service : 'workbuddy-metrics',
      updatedAt: Date.parse(payload.generatedAt) || 0,
      today,
      allTime,
      days,
      lastCall: null,
      trackingSince: 0,
      window,
    }
  }

  const today = tokenBucket(payload.today)
  if (!today) throw new Error('token 接口 JSON 缺少 today 字段')
  const allTime = tokenBucket(payload.allTime)
  const days = {}
  if (isObject(payload.days)) {
    for (const key of Object.keys(payload.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue
      const bucket = tokenBucket(payload.days[key])
      if (bucket) days[key] = bucket
    }
  }
  let lastCall = null
  if (isObject(payload.lastCall)) {
    const bucket = tokenBucket(payload.lastCall)
    lastCall = {
      ...bucket,
      at: tokenCount(payload.lastCall.at),
      provider: typeof payload.lastCall.provider === 'string' ? payload.lastCall.provider : '',
      model: typeof payload.lastCall.model === 'string' ? payload.lastCall.model : '',
      sessionId: typeof payload.lastCall.sessionId === 'string' ? payload.lastCall.sessionId : '',
      purpose: typeof payload.lastCall.purpose === 'string' ? payload.lastCall.purpose : '',
    }
  }
  return {
    service: typeof payload.service === 'string' ? payload.service : '',
    updatedAt: tokenCount(payload.updatedAt),
    today,
    allTime,
    days,
    lastCall,
    trackingSince: tokenCount(payload.trackingSince),
    window: null,
  }
}

export function createEngine(options = {}) {
  const clock = typeof options.clock === 'function' ? options.clock : Date.now
  const logger = options.logger || { info() {}, warn() {}, debug() {} }
  const storeFile = typeof options.storeFile === 'string' && options.storeFile ? options.storeFile : DEFAULT_STORE_FILE
  const fetchImpl = options.fetchImpl
  /** 拉起本地接口用的进程启动器；Host 注入，测试不注入即不自动启动。 */
  const spawnProcess = typeof options.spawnProcess === 'function' ? options.spawnProcess : null
  const tokenServiceWaitMs = Number.isFinite(options.tokenServiceWaitMs) ? options.tokenServiceWaitMs : 1500
  const baseConfig = isObject(options.config) ? clone(options.config) : {}

  const tracker = createTracker({ retentionDays: 60, clock })
  const probe = options.probe || createProbe({ clock })

  let savedConfig = {}
  let resolved = normalizeConfig(deepMerge(baseConfig, savedConfig))
  let startedAt = clock()
  let sequence = 0
  let loaded = false
  let timer = null
  let saveTimer = null
  let refreshing = null
  let disposed = false
  let probeSupported = probe.supported
  let lastProbeError = null
  /** 最近一次 token-usage-api 观测：{ ok, endpoint, at, error, data } */
  let tokenApi = null
  /** token-usage-api 自动拉起：上次尝试时间 / 最近错误 / 是否拉起过。 */
  let tokenServiceAttemptAt = 0
  let tokenServiceError = null
  let tokenServiceStarted = false
  /** 按日累计的服务活跃时长：{ days: { 'YYYY-MM-DD': { doubao: 秒 } } } */
  const activeTime = { days: {} }
  let lastProbeAt = null
  /** id -> { status, probeError, quota, quotaError, activeSince } */
  const runtime = new Map()

  function runtimeOf(id) {
    let entry = runtime.get(id)
    if (!entry) {
      entry = { status: null, probeError: null, quota: null, quotaError: null, activeSince: null, tokenUsage: null }
      runtime.set(id, entry)
    }
    return entry
  }

  function serviceIds() {
    return new Set(resolved.services.map((service) => service.id))
  }

  /** 本机统计快照：token 接口不可用时的同源回退（同一份 state.json，不编造数字）。 */
  function localTokenPayload(at = clock()) {
    const snapshot = tracker.snapshot(at)
    return {
      source: 'local',
      updatedAt: at,
      today: snapshot.today,
      allTime: snapshot.allTime,
      lastCall: snapshot.lastCall,
      trackingSince: snapshot.trackingSince,
    }
  }

  function isLoopbackEndpoint(endpoint) {
    try {
      const url = new URL(endpoint)
      return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1' || url.hostname === '[::1]'
    } catch {
      return false
    }
  }

  function tokenEndpoints() {
    const list = []
    const dsEndpoint = normalizeEndpointUrl(resolved.dshtoken.apiEndpoint)
    if (dsEndpoint) list.push(dsEndpoint)
    for (const service of resolved.services) {
      const endpoint = normalizeEndpointUrl(service.tokenEndpoint)
      if (endpoint && !list.includes(endpoint)) list.push(endpoint)
    }
    return list
  }

  function delay(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      if (timer && typeof timer.unref === 'function') timer.unref()
    })
  }

  /**
   * 8765 的 token 接口是独立进程，不随 DSH 重启自动起来。接口不通时按配置
   * 用 start-api.ps1 拉起一次（2 分钟内不重复尝试）。
   * 返回 true 表示刚尝试过启动，调用方应重试一次拉取。
   */
  async function ensureTokenService() {
    if (!spawnProcess) return false
    if (!resolved.tokenService.autoStart) return false
    const now = clock()
    if (tokenServiceAttemptAt && now - tokenServiceAttemptAt < TOKEN_SERVICE_RETRY_MS) return false
    const script = resolved.tokenService.startScript
    if (!script) {
      tokenServiceError = '未配置自动启动脚本'
      return false
    }
    // 只对自己机器上的 loopback 接口做自动拉起，避免误触外部服务。
    if (!tokenEndpoints().some(isLoopbackEndpoint)) return false
    if (!existsSync(script)) {
      tokenServiceAttemptAt = now
      tokenServiceError = `找不到启动脚本：${script}`
      return false
    }
    tokenServiceAttemptAt = now
    try {
      const child = spawnProcess('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
        cwd: dirname(script),
      })
      if (child && typeof child.on === 'function') {
        child.on('error', (error) => {
          tokenServiceError = `启动 token 接口失败：${errorMessage(error)}`
        })
      }
      if (child && typeof child.unref === 'function') child.unref()
      tokenServiceStarted = true
      tokenServiceError = null
      logger.info(`usage-watch: token 接口不可用，已尝试自动启动 ${script}`)
      await delay(tokenServiceWaitMs)
      return true
    } catch (error) {
      tokenServiceError = `启动 token 接口失败：${errorMessage(error)}`
      logger.warn(`usage-watch: ${tokenServiceError}`)
      return false
    }
  }

  function scheduleSave() {
    if (disposed) return
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      void persist()
    }, SAVE_DEBOUNCE_MS)
    if (saveTimer && typeof saveTimer.unref === 'function') saveTimer.unref()
  }

  async function persist() {
    const payload = {
      version: STORE_VERSION,
      updatedAt: clock(),
      config: savedConfig,
      tokens: tracker.serialize(),
      activeTime: { days: activeTime.days },
      diagnostics: buildDiagnostics(),
    }
    try {
      await mkdir(dirname(storeFile), { recursive: true })
      const tempFile = `${storeFile}.${process.pid}.tmp`
      await writeFile(tempFile, JSON.stringify(payload, null, 2), 'utf8')
      await rename(tempFile, storeFile)
    } catch (error) {
      logger.warn(`usage-watch: 保存 state 失败: ${errorMessage(error)}`)
    }
  }

  /** 落盘用的最后观测快照：面板之外也能从 state.json 诊断探测 / 额度问题。 */
  function buildDiagnostics() {
    const todayKey = dayKey(clock())
    const todayActive = isObject(activeTime.days[todayKey]) ? activeTime.days[todayKey] : {}
    return {
      savedAt: clock(),
      sequence,
      probeSupported,
      probeError: lastProbeError,
      services: resolved.services.map((service) => {
        const entry = runtimeOf(service.id)
        return {
          id: service.id,
          running: entry.status ? Boolean(entry.status.running) : null,
          processCount: entry.status ? entry.status.processCount : 0,
          memoryMB: entry.status ? entry.status.memoryMB : null,
          todayActiveSeconds: Math.round(todayActive[service.id] || 0),
          tokenUsageOk: entry.tokenUsage ? entry.tokenUsage.ok : null,
          quotaSource: entry.quota ? entry.quota.source : null,
          quotaError: entry.quotaError || null,
        }
      }),
      tokenApi: tokenApi
        ? {
            endpoint: tokenApi.endpoint,
            ok: tokenApi.ok,
            at: tokenApi.at,
            error: tokenApi.error,
            source: tokenApi.data ? (tokenApi.data.source || 'api') : null,
          }
        : null,
      tokenService: {
        autoStart: resolved.tokenService.autoStart,
        startScript: resolved.tokenService.startScript,
        attemptedAt: tokenServiceAttemptAt || null,
        started: tokenServiceStarted,
        error: tokenServiceError,
      },
    }
  }

  async function load() {
    let parsed = null
    try {
      const text = await readFile(storeFile, 'utf8')
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
    if (isObject(parsed)) {
      if (isObject(parsed.config)) savedConfig = parsed.config
      if (isObject(parsed.tokens)) tracker.hydrate(parsed.tokens)
      if (isObject(parsed.activeTime) && isObject(parsed.activeTime.days)) {
        for (const key of Object.keys(parsed.activeTime.days)) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue
          const day = parsed.activeTime.days[key]
          if (!isObject(day)) continue
          const clean = {}
          for (const id of Object.keys(day)) {
            const seconds = Number(day[id])
            if (Number.isFinite(seconds) && seconds > 0) clean[id] = Math.round(seconds)
          }
          activeTime.days[key] = clean
        }
      }
    }
    resolved = normalizeConfig(deepMerge(baseConfig, savedConfig))
    runtime.clear()
    loaded = true
    return parsed !== null
  }

  function activeTimeDay(at) {
    const key = dayKey(at)
    if (!isObject(activeTime.days[key])) activeTime.days[key] = {}
    return activeTime.days[key]
  }

  function pruneActiveTime(at) {
    const cutoff = dayKey(at - 60 * 24 * 60 * 60 * 1000)
    for (const key of Object.keys(activeTime.days)) {
      if (key < cutoff) delete activeTime.days[key]
    }
  }

  /**
   * 按探测采样累计每个服务「真的在运行」的时长，作为没有 token 接口的应用的
   * 真实「使用情况」。粒度 = refreshSeconds；两次采样之间关掉再打开会按整段计入
   * （单次最多 120s），不追求秒级精确。
   */
  function accumulateActiveTime(at) {
    const seconds = lastProbeAt ? Math.max(0, Math.min((at - lastProbeAt) / 1000, 120)) : 0
    const day = activeTimeDay(at)
    for (const service of resolved.services) {
      const entry = runtimeOf(service.id)
      const running = Boolean(entry.status && entry.status.running)
      if (!running) {
        entry.activeSince = null
        continue
      }
      if (seconds > 0) {
        day[service.id] = Math.round(((day[service.id] || 0) + seconds) * 10) / 10
      }
      if (!entry.activeSince) entry.activeSince = at - Math.round(seconds * 1000)
    }
    lastProbeAt = at
    pruneActiveTime(at)
  }

  async function collectProbe() {
    const names = [...new Set(resolved.services.flatMap((service) => service.processes))]
    const sample = await probe.sample(names)
    probeSupported = sample.supported
    lastProbeError = sample.error || null
    for (const service of resolved.services) {
      const entry = runtimeOf(service.id)
      if (!sample.supported) {
        entry.status = null
        entry.probeError = null
        continue
      }
      if (sample.error) {
        // 探测本身失败：不要冒充「未运行」，保持 null 让面板显示探测异常。
        entry.status = null
        entry.probeError = sample.error
        continue
      }
      entry.status = aggregateService(sample.rows, service.processes, sample.at)
      entry.probeError = null
    }
    accumulateActiveTime(sample.at)
  }

  async function collectQuota() {
    for (const service of resolved.services) {
      const entry = runtimeOf(service.id)
      const manual = manualQuota(service)
      if (service.quota.enabled === false) {
        entry.quota = null
        entry.quotaError = null
        continue
      }
      if (!service.quota.endpoint) {
        entry.quota = manual ? decorateQuota(manual, 'manual', clock()) : null
        entry.quotaError = null
        continue
      }
      try {
        const payload = await fetchQuota(service, { fetchImpl })
        entry.quota = decorateQuota(payload, 'endpoint', clock())
        entry.quotaError = null
      } catch (error) {
        entry.quotaError = errorMessage(error)
        // 接口挂了：有手动值就退回手动值，否则保留上一次成功的数据。
        if (manual) entry.quota = decorateQuota(manual, 'manual', clock())
      }
    }
  }

  /**
   * 调用 token-usage-api（默认 127.0.0.1:8765）。它读的就是本插件的 state.json，
   * 所以数据同源；成功时面板显示接口值，失败时自动回退到本机统计。
   */
  async function collectTokenApi() {
    const endpoint = normalizeEndpointUrl(resolved.dshtoken.apiEndpoint)
    if (!endpoint) {
      tokenApi = null
      return
    }
    const at = clock()
    try {
      const impl = fetchImpl || globalThis.fetch
      if (typeof impl !== 'function') throw new Error('当前 Host 没有 fetch 实现')
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TOKEN_API_TIMEOUT_MS)
      if (timer && typeof timer.unref === 'function') timer.unref()
      let response
      try {
        response = await impl(endpoint, {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: controller.signal,
          cache: 'no-store',
        })
      } finally {
        clearTimeout(timer)
      }
      if (!response || !response.ok) throw new Error(`接口返回 HTTP ${response ? response.status : '???'}`)
      const payload = await response.json()
      tokenApi = { ok: true, endpoint, at, error: null, data: normalizeTokenApiPayload(payload, { now: at }) }
    } catch (error) {
      const reason = error && error.name === 'AbortError' ? `请求超时（${TOKEN_API_TIMEOUT_MS}ms）` : errorMessage(error)
      // 接口挂了也要看得见用量：回退到本机统计（tracker 实时数据），而不是整块消失。
      tokenApi = {
        ok: false,
        endpoint,
        at,
        error: reason,
        data: (tokenApi && tokenApi.data) || localTokenPayload(at),
      }
    }
  }

  /**
   * 每个服务可选的「token 用量接口」（豆包默认用 8765 接口）。
   * 成功时卡片显示接口返回的 today.totalTokens；失败只提示，不影响其他数据。
   */
  async function collectServiceTokens() {
    for (const service of resolved.services) {
      const entry = runtimeOf(service.id)
      const endpoint = normalizeEndpointUrl(service.tokenEndpoint)
      if (!endpoint) {
        entry.tokenUsage = null
        continue
      }
      const at = clock()
      try {
        const impl = fetchImpl || globalThis.fetch
        if (typeof impl !== 'function') throw new Error('当前 Host 没有 fetch 实现')
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), TOKEN_API_TIMEOUT_MS)
        if (timer && typeof timer.unref === 'function') timer.unref()
        let response
        try {
          response = await impl(endpoint, {
            method: 'GET',
            headers: { accept: 'application/json' },
            signal: controller.signal,
            cache: 'no-store',
          })
        } finally {
          clearTimeout(timer)
        }
        if (!response || !response.ok) throw new Error(`接口返回 HTTP ${response ? response.status : '???'}`)
        const payload = await response.json()
        const data = normalizeTokenApiPayload(payload, { now: at })
        entry.tokenUsage = {
          ok: true,
          endpoint,
          at,
          error: null,
          service: data.service,
          today: data.today,
          allTime: data.allTime,
          window: data.window || null,
          fallback: false,
        }
      } catch (error) {
        const reason = error && error.name === 'AbortError' ? `请求超时（${TOKEN_API_TIMEOUT_MS}ms）` : errorMessage(error)
        const previous = entry.tokenUsage
        // 只有「和 DSH Token 卡同一个接口」时才允许用本机统计兜底，避免把别的数据冒充这个服务的用量。
        const sameSource = endpoint === normalizeEndpointUrl(resolved.dshtoken.apiEndpoint)
        const local = sameSource ? localTokenPayload(at) : null
        entry.tokenUsage = {
          ok: false,
          endpoint,
          at,
          error: reason,
          service: previous ? previous.service : '',
          today: local ? local.today : (previous ? previous.today : null),
          allTime: local ? local.allTime : (previous ? previous.allTime : null),
          window: local ? null : (previous && previous.window ? previous.window : null),
          fallback: Boolean(local),
        }
      }
    }
  }

  async function refreshRuntime() {
    if (refreshing) return refreshing
    refreshing = (async () => {
      try {
        await collectProbe()
      } catch (error) {
        logger.warn(`usage-watch: 进程探测失败: ${errorMessage(error)}`)
        lastProbeError = errorMessage(error)
      }
      try {
        await collectQuota()
      } catch (error) {
        logger.warn(`usage-watch: 额度刷新失败: ${errorMessage(error)}`)
      }
      try {
        await collectTokenApi()
      } catch (error) {
        logger.warn(`usage-watch: token 接口刷新失败: ${errorMessage(error)}`)
      }
      try {
        await collectServiceTokens()
      } catch (error) {
        logger.warn(`usage-watch: 服务 token 接口刷新失败: ${errorMessage(error)}`)
      }
      // 接口掉线时尝试自动拉起本机 token 服务（token-usage-api），成功后立刻重试一次。
      const tokenDown =
        (tokenApi && tokenApi.ok === false) ||
        resolved.services.some((service) => {
          if (!service.tokenEndpoint) return false
          const usage = runtimeOf(service.id).tokenUsage
          return Boolean(usage && usage.ok === false)
        })
      if (tokenDown && (await ensureTokenService())) {
        try {
          await collectTokenApi()
          await collectServiceTokens()
        } catch (error) {
          logger.warn(`usage-watch: token 服务重启后重试失败: ${errorMessage(error)}`)
        }
      }
      sequence += 1
      scheduleSave()
    })()
    try {
      await refreshing
    } finally {
      refreshing = null
    }
  }

  function recordUsage(requestOptions, usage) {
    try {
      tracker.record(requestOptions, usage)
      sequence += 1
      scheduleSave()
    } catch (error) {
      logger.debug(`usage-watch: 记录 token 用量失败: ${errorMessage(error)}`)
    }
  }

  function buildState() {
    const at = clock()
    const snapshot = tracker.snapshot(at)
    const todayKey = dayKey(at)
    const todayActive = isObject(activeTime.days[todayKey]) ? activeTime.days[todayKey] : {}
    const dsToday = snapshot.today
    const dailyLimit = resolved.dshtoken.dailyLimit
    const dsQuota = dailyLimit > 0
      ? decorateQuota(
          {
            used: dsToday.totalTokens,
            limit: dailyLimit,
            unit: 'tokens',
          },
          'budget',
          at,
        )
      : null

    const services = resolved.services.map((service) => {
      const entry = runtimeOf(service.id)
      const status = entry.status
      return {
        id: service.id,
        label: service.label,
        processes: service.processes.slice(),
        running: status ? Boolean(status.running) : null,
        processCount: status ? status.processCount : 0,
        memoryMB: status ? status.memoryMB : null,
        cpuPercent: status ? status.cpuPercent : null,
        uptimeSeconds: status ? status.uptimeSeconds : null,
        checkedAt: status ? status.checkedAt : null,
        todayActiveSeconds: Math.round(todayActive[service.id] || 0),
        activeSeconds: entry.activeSince ? Math.max(0, Math.round((at - entry.activeSince) / 1000)) : 0,
        tokenUsage: entry.tokenUsage,
        probeError: entry.probeError || null,
        quota: entry.quota,
        quotaError: entry.quotaError || null,
      }
    })

    return {
      ok: true,
      version: STORE_VERSION,
      generatedAt: at,
      startedAt,
      sequence,
      loaded,
      config: publicConfig(resolved),
      dshtoken: {
        ...snapshot,
        dailyLimit,
        quota: dsQuota,
        api: tokenApi
          ? {
              endpoint: tokenApi.endpoint,
              ok: tokenApi.ok,
              at: tokenApi.at,
              error: tokenApi.error,
              data: tokenApi.data,
            }
          : null,
      },
      services,
      probe: {
        supported: probeSupported,
        error: lastProbeError,
      },
    }
  }

  function start() {
    if (startedAt) sequence += 1
    startedAt = clock()
    const intervalMs = Math.max(10, Math.min(300, resolved.refreshSeconds)) * 1000
    timer = setInterval(() => {
      void refreshRuntime()
    }, intervalMs)
    if (timer && typeof timer.unref === 'function') timer.unref()

    void (async () => {
      try {
        await load()
      } catch (error) {
        logger.warn(`usage-watch: 读取 state 失败: ${errorMessage(error)}`)
      }
      try {
        await refreshRuntime()
      } catch (error) {
        logger.warn(`usage-watch: 首次刷新失败: ${errorMessage(error)}`)
      }
      // 配置里的 refreshSeconds 可能在 state.json 里被改过，重设定时器。
      const nextIntervalMs = Math.max(10, Math.min(300, resolved.refreshSeconds)) * 1000
      if (nextIntervalMs !== intervalMs && timer) {
        clearInterval(timer)
        timer = setInterval(() => {
          void refreshRuntime()
        }, nextIntervalMs)
        if (timer && typeof timer.unref === 'function') timer.unref()
      }
    })()
  }

  function stop() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  function dispose() {
    disposed = true
    stop()
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    void persist()
  }

  async function refresh() {
    await refreshRuntime()
    return buildState()
  }

  async function patchConfig(patch) {
    const sanitized = sanitizePatch(patch, serviceIds())
    if (!sanitized) {
      const error = new Error('没有可应用的设置字段')
      error.status = 400
      throw error
    }
    savedConfig = deepMerge(savedConfig, sanitized)
    resolved = normalizeConfig(deepMerge(baseConfig, savedConfig))
    sequence += 1
    scheduleSave()
    void refreshRuntime()
    return buildState()
  }

  return {
    start,
    stop,
    dispose,
    refresh,
    buildState,
    patchConfig,
    recordUsage,
    get config() {
      return resolved
    },
    get storeFile() {
      return storeFile
    },
  }
}
