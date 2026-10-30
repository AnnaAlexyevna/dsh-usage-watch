/**
 * Usage Watch — 配置归一化。
 *
 * 三个数据源共用一套「服务」模型：
 *   - id          稳定标识（doubao / workbuddy / …）
 *   - label       展示名
 *   - processes   Windows 进程名（Get-Process 不区分大小写）
 *   - quota       额度：手动录入 或 HTTP 接口
 *
 * 默认值只描述「能真实探测到什么」，不编造任何用量。
 */

const DEFAULT_SERVICES = Object.freeze([
  Object.freeze({ id: 'doubao', label: '豆包', processes: Object.freeze(['Doubao']) }),
  Object.freeze({ id: 'workbuddy', label: 'WorkBuddy', processes: Object.freeze(['WorkBuddy', 'workbuddy']) }),
])

const DEFAULT_FIELDS = Object.freeze({
  used: 'used',
  limit: 'limit',
  unit: 'unit',
  resetAt: 'resetAt',
  note: 'note',
})

/**
 * 本地 DSH Token 用量接口（token-usage-api/server.mjs，读的是本插件写出的 state.json）。
 * 配置成空字符串表示「只用本机统计、不调用接口」。
 */
export const DEFAULT_TOKEN_API_ENDPOINT = 'http://127.0.0.1:8765/api/v1/token/usage'

/**
 * WorkBuddy 本机 metrics 接口（WorkBuddy 自己的 python 进程监听，返回 credit 用量）。
 * 它随 WorkBuddy 起停，可能不可用；不可用时面板只提示，不会编造数字。
 */
export const DEFAULT_WORKBUDDY_METRICS_ENDPOINT = 'http://127.0.0.1:8787/api/metrics?days=7'

/**
 * 「接口掉线时自动拉起本地 token 服务」用的启动脚本（Windows PowerShell）。
 * 默认留空 = 不自动拉起（不同机器的脚本路径不同）；要用时在插件设置里填自己的
 * start-api.ps1 路径，例如 'D:\\DSH-Workspace\\token-usage-api\\start-api.ps1'。
 */
export const DEFAULT_TOKEN_SERVICE_START_SCRIPT = ''

export const DEFAULT_CONFIG = Object.freeze({
  refreshSeconds: 30,
  historyDays: 14,
  dshtoken: Object.freeze({ dailyLimit: 0, apiEndpoint: DEFAULT_TOKEN_API_ENDPOINT }),
  tokenService: Object.freeze({ autoStart: true, startScript: DEFAULT_TOKEN_SERVICE_START_SCRIPT }),
  services: DEFAULT_SERVICES,
})

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function toText(value, fallback = '') {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return fallback
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function toInt(value, fallback, min, max) {
  const parsed = toNumber(value)
  const rounded = parsed === null ? fallback : Math.round(parsed)
  return Math.min(max, Math.max(min, rounded))
}

function toBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function normalizeFields(raw) {
  const input = isObject(raw) ? raw : {}
  const fields = {}
  for (const key of Object.keys(DEFAULT_FIELDS)) {
    const value = input[key]
    fields[key] = typeof value === 'string' ? value : DEFAULT_FIELDS[key]
  }
  return fields
}

export function normalizeQuota(raw) {
  const input = isObject(raw) ? raw : {}
  const manualInput = isObject(input.manual) ? input.manual : {}
  return {
    endpoint: toText(input.endpoint).trim(),
    token: toText(input.token),
    tokenHeader: toText(input.tokenHeader, 'Authorization').trim() || 'Authorization',
    fields: normalizeFields(input.fields),
    manual: {
      used: toNumber(manualInput.used),
      limit: toNumber(manualInput.limit),
      unit: toText(manualInput.unit),
    },
    // 接口返回数据里 used / limit 的候选字段（字段路径优先）
    enabled: toBool(input.enabled, true),
  }
}

function normalizeService(id, fallbackLabel, fallbackProcesses, raw) {
  const input = isObject(raw) ? raw : {}
  const processes = Array.isArray(input.processes)
    ? input.processes.map((name) => toText(name).trim()).filter(Boolean)
    : fallbackProcesses.slice()
  return {
    id,
    label: toText(input.label, fallbackLabel) || fallbackLabel,
    processes: processes.length ? processes : fallbackProcesses.slice(),
    // 可选的「token 用量接口」：豆包默认 8765 token 用量接口，WorkBuddy 默认它自己的 8787 metrics。
    tokenEndpoint: input.tokenEndpoint === undefined
      ? (id === 'doubao'
        ? DEFAULT_TOKEN_API_ENDPOINT
        : id === 'workbuddy' ? DEFAULT_WORKBUDDY_METRICS_ENDPOINT : '')
      : toText(input.tokenEndpoint).trim(),
    quota: normalizeQuota(input.quota),
  }
}

/**
 * 把 YAML / 设置页里的原始 config 归一化成引擎内部形态。
 * 未知服务会保留（在默认服务之后），方便用户自己加别的桌面应用。
 */
export function normalizeConfig(raw) {
  const input = isObject(raw) ? raw : {}
  const rawServices = isObject(input.services) ? input.services : {}
  const services = []
  const seen = new Set()

  for (const base of DEFAULT_SERVICES) {
    services.push(normalizeService(base.id, base.label, base.processes, rawServices[base.id]))
    seen.add(base.id)
  }
  for (const key of Object.keys(rawServices)) {
    if (seen.has(key)) continue
    if (!isObject(rawServices[key])) continue
    services.push(normalizeService(key, key, [key], rawServices[key]))
    seen.add(key)
  }

  const dshtokenInput = isObject(input.dshtoken) ? input.dshtoken : {}
  const dailyLimit = toNumber(dshtokenInput.dailyLimit)
  const apiEndpoint = dshtokenInput.apiEndpoint === undefined
    ? DEFAULT_TOKEN_API_ENDPOINT
    : toText(dshtokenInput.apiEndpoint, DEFAULT_TOKEN_API_ENDPOINT).trim()

  const tokenServiceInput = isObject(input.tokenService) ? input.tokenService : {}
  const tokenServiceStartScript = tokenServiceInput.startScript === undefined
    ? DEFAULT_TOKEN_SERVICE_START_SCRIPT
    : toText(tokenServiceInput.startScript).trim()

  return {
    refreshSeconds: toInt(input.refreshSeconds, DEFAULT_CONFIG.refreshSeconds, 10, 300),
    historyDays: toInt(input.historyDays, DEFAULT_CONFIG.historyDays, 3, 60),
    dshtoken: {
      dailyLimit: dailyLimit !== null && dailyLimit > 0 ? Math.round(dailyLimit) : 0,
      apiEndpoint,
    },
    tokenService: {
      autoStart: toBool(tokenServiceInput.autoStart, true),
      startScript: tokenServiceStartScript,
    },
    services,
  }
}

/** 发给浏览器的配置：绝不包含接口 token 原文。 */
export function publicConfig(config) {
  const services = {}
  for (const service of config.services) {
    services[service.id] = {
      label: service.label,
      processes: service.processes.slice(),
      tokenEndpoint: service.tokenEndpoint,
      quota: {
        endpoint: service.quota.endpoint,
        hasToken: Boolean(service.quota.token),
        tokenHeader: service.quota.tokenHeader,
        fields: { ...service.quota.fields },
        manual: { ...service.quota.manual },
      },
    }
  }
  return {
    refreshSeconds: config.refreshSeconds,
    historyDays: config.historyDays,
    dshtoken: {
      dailyLimit: config.dshtoken.dailyLimit,
      apiEndpoint: config.dshtoken.apiEndpoint,
    },
    tokenService: {
      autoStart: config.tokenService.autoStart,
      startScript: config.tokenService.startScript,
    },
    services,
  }
}
