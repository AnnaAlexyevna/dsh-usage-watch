/**
 * Usage Watch — 额度来源。
 *
 * 两种真实来源：
 *   1. manual   —— 用户在「设置」里填入的已用/上限（比如从应用自带的用量页抄下来）；
 *   2. endpoint —— 用户自己提供的 HTTP 接口：GET 返回 JSON，字段路径可配置。
 *
 * 没有配置时返回 null（面板显示「未接入额度」），绝不编造数字。
 */

const DEFAULT_TIMEOUT_MS = 8000

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function pickPath(source, path) {
  if (!isObject(source) || typeof path !== 'string' || path.trim() === '') return undefined
  let current = source
  for (const part of path.split('.')) {
    if (current === null || current === undefined) return undefined
    if (!isObject(current) && !Array.isArray(current)) return undefined
    current = current[part]
  }
  return current
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const text = value.trim().replace(/,/g, '')
    if (!text) return null
    const match = text.match(/^-?\d+(\.\d+)?/)
    if (!match) return null
    const parsed = Number(match[0])
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function toTextValue(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function firstNumber(source, paths) {
  for (const path of paths) {
    const value = toNumber(pickPath(source, path))
    if (value !== null) return value
  }
  return null
}

function firstText(source, paths) {
  for (const path of paths) {
    const value = pickPath(source, path)
    const text = toTextValue(value)
    if (text) return text
  }
  return ''
}

const USED_FALLBACKS = ['used', 'usage', 'usedTokens', 'tokensUsed', 'consumed', 'used_tokens', 'totalUsed', 'usedAmount']
const LIMIT_FALLBACKS = ['limit', 'quota', 'total', 'max', 'tokensLimit', 'limitTokens', 'totalLimit', 'quotaTotal']
const UNIT_FALLBACKS = ['unit', 'units']
const RESET_FALLBACKS = ['resetAt', 'reset_at', 'resetTime', 'resetsAt']
const NOTE_FALLBACKS = ['note', 'message', 'status', 'plan']

/**
 * 把接口返回的 JSON 解析成 { used, limit, unit, resetAt, note }。
 * 字段路径优先；路径取不到时退回常见字段名。返回 { error } 表示无法识别。
 */
export function parseQuotaPayload(payload, fields = {}) {
  if (!isObject(payload) && !Array.isArray(payload)) {
    return { error: '接口返回的不是 JSON 对象' }
  }
  const used = firstNumber(payload, [fields.used, ...USED_FALLBACKS].filter(Boolean))
  const limit = firstNumber(payload, [fields.limit, ...LIMIT_FALLBACKS].filter(Boolean))
  if (used === null && limit === null) {
    // 常见误填：把 DSH Token 的 8765 接口 / health 填进了额度接口。
    if (payload.stateOk !== undefined || payload.stateFile !== undefined) {
      return { error: '这是 token 服务的健康检查地址（/health），不返回额度数字' }
    }
    if (isObject(payload.today) || isObject(payload.allTime) || payload.service === 'dsh-token-usage-api') {
      return { error: '这是 DSH Token 的用量接口，不是额度接口；豆包 / WorkBuddy 的额度请填应用自己的接口或手动值' }
    }
    return { error: '接口 JSON 里找不到 used / limit 字段' }
  }
  return {
    used,
    limit,
    unit: firstText(payload, [fields.unit, ...UNIT_FALLBACKS].filter(Boolean)),
    resetAt: firstText(payload, [fields.resetAt, ...RESET_FALLBACKS].filter(Boolean)),
    note: firstText(payload, [fields.note, ...NOTE_FALLBACKS].filter(Boolean)),
  }
}

function buildHeaders(quota) {
  const headers = { accept: 'application/json' }
  const token = String(quota.token || '').trim()
  if (!token) return headers
  const header = String(quota.tokenHeader || 'Authorization').trim() || 'Authorization'
  if (/^authorization$/i.test(header)) {
    headers[header] = /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`
  } else {
    headers[header] = token
  }
  return headers
}

/** 用户可能只填 `127.0.0.1:8765/usage`；补上 http:// 再去请求。 */
export function normalizeEndpointUrl(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return text
  return `http://${text}`
}

/** GET 一个服务配置的额度接口；失败时抛 Error（调用方决定如何降级）。 */
export async function fetchQuota(service, options = {}) {
  const quota = service && service.quota
  const endpoint = normalizeEndpointUrl(quota && quota.endpoint)
  if (!endpoint) throw new Error('未配置额度接口')
  const fetchImpl = options.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new Error('当前 Host 没有 fetch 实现')
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: buildHeaders(quota),
      signal: controller.signal,
      cache: 'no-store',
    })
  } catch (error) {
    const reason = error && error.name === 'AbortError' ? `请求超时（${timeoutMs}ms）` : error && error.message ? error.message : String(error)
    throw new Error(`额度接口请求失败：${reason}`)
  } finally {
    clearTimeout(timer)
  }
  if (!response || !response.ok) {
    throw new Error(`额度接口返回 HTTP ${response ? response.status : '???'}`)
  }
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new Error('额度接口返回的内容不是合法 JSON')
  }
  const parsed = parseQuotaPayload(payload, quota.fields)
  if (parsed.error) throw new Error(parsed.error)
  return parsed
}

/** 手动填写值 → 与接口同一形状；没有可用数字时返回 null。 */
export function manualQuota(service) {
  const manual = service && service.quota && service.quota.manual
  if (!manual) return null
  const used = typeof manual.used === 'number' && Number.isFinite(manual.used) ? manual.used : null
  const limit = typeof manual.limit === 'number' && Number.isFinite(manual.limit) && manual.limit > 0 ? manual.limit : null
  if (used === null && limit === null) return null
  return {
    used,
    limit,
    unit: typeof manual.unit === 'string' ? manual.unit : '',
    resetAt: '',
    note: '',
  }
}

/** 统一给额度补上百分比、来源和更新时间。 */
export function decorateQuota(raw, source, updatedAt) {
  if (!raw) return null
  const used = typeof raw.used === 'number' ? raw.used : null
  const limit = typeof raw.limit === 'number' && raw.limit > 0 ? raw.limit : null
  return {
    source,
    used,
    limit,
    unit: typeof raw.unit === 'string' ? raw.unit : '',
    resetAt: typeof raw.resetAt === 'string' ? raw.resetAt : '',
    note: typeof raw.note === 'string' ? raw.note : '',
    percent: limit !== null && used !== null ? Math.max(0, Math.min(999, (used / limit) * 100)) : null,
    updatedAt,
  }
}
