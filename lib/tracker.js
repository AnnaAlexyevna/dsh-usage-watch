/**
 * Usage Watch — DSH Token 用量累计器。
 *
 * 数据来源是 Host 的 `llm/stream` waterfall：每个模型调用在流里带一个
 * `{ type: 'usage', usage: TokenUsage }` chunk。这里只在一次调用结束时
 * 结算一次「最后一次 usage」，避免同一调用里的多个 usage chunk 被重复累加。
 *
 * 只做纯计算 + 序列化；落盘由 engine 负责。
 */

const DAY_MS = 24 * 60 * 60 * 1000
const RETENTION_SLACK_DAYS = 3

function toCount(value) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

export function dayKey(timestamp) {
  const date = new Date(timestamp)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function emptyBucket() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    requests: 0,
  }
}

export function normalizeUsage(usage) {
  const input = toCount(usage && usage.inputTokens)
  const output = toCount(usage && usage.outputTokens)
  const reportedTotal = toCount(usage && usage.totalTokens)
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: reportedTotal > 0 ? reportedTotal : input + output,
    cacheReadTokens: toCount(usage && usage.cacheReadTokens),
    cacheWriteTokens: toCount(usage && usage.cacheWriteTokens),
    reasoningTokens: toCount(usage && usage.reasoningTokens),
  }
}

function addBucket(target, usage) {
  target.inputTokens += usage.inputTokens
  target.outputTokens += usage.outputTokens
  target.totalTokens += usage.totalTokens
  target.cacheReadTokens += usage.cacheReadTokens
  target.cacheWriteTokens += usage.cacheWriteTokens
  target.reasoningTokens += usage.reasoningTokens
}

function copyBucket(bucket) {
  return { ...bucket }
}

function sanitizeBucket(raw) {
  const bucket = emptyBucket()
  if (raw === null || typeof raw !== 'object') return bucket
  bucket.inputTokens = toCount(raw.inputTokens)
  bucket.outputTokens = toCount(raw.outputTokens)
  bucket.totalTokens = toCount(raw.totalTokens) || bucket.inputTokens + bucket.outputTokens
  bucket.cacheReadTokens = toCount(raw.cacheReadTokens)
  bucket.cacheWriteTokens = toCount(raw.cacheWriteTokens)
  bucket.reasoningTokens = toCount(raw.reasoningTokens)
  bucket.requests = toCount(raw.requests)
  return bucket
}

export function createTracker(options = {}) {
  const requestedRetention = Number.isFinite(options.retentionDays)
    ? options.retentionDays
    : options.historyDays
  const retentionDays = Number.isFinite(requestedRetention) && requestedRetention > 0 ? requestedRetention : 14
  const clock = typeof options.clock === 'function' ? options.clock : Date.now

  const days = new Map()
  let allTime = emptyBucket()
  let lastCall = null
  let trackingSince = clock()

  function prune(now) {
    const keep = retentionDays + RETENTION_SLACK_DAYS
    const cutoff = dayKey(now - keep * DAY_MS)
    for (const key of days.keys()) {
      if (key < cutoff) days.delete(key)
    }
  }

  function record(requestOptions, usage) {
    const now = clock()
    const normalized = normalizeUsage(usage)
    const key = dayKey(now)
    const bucket = days.get(key) || emptyBucket()
    addBucket(bucket, normalized)
    bucket.requests += 1
    days.set(key, bucket)
    addBucket(allTime, normalized)
    allTime.requests += 1
    lastCall = {
      at: now,
      provider: requestOptions && typeof requestOptions.provider === 'string' ? requestOptions.provider : '',
      model: requestOptions && typeof requestOptions.model === 'string' ? requestOptions.model : '',
      sessionId: requestOptions && typeof requestOptions.sessionId === 'string' ? requestOptions.sessionId : '',
      purpose: requestOptions && typeof requestOptions.purpose === 'string' ? requestOptions.purpose : '',
      ...normalized,
    }
    prune(now)
    return normalized
  }

  function today(at = clock()) {
    const bucket = days.get(dayKey(at))
    return bucket ? copyBucket(bucket) : emptyBucket()
  }

  /** 最近 N 天（含今天）的按日总量，按日期升序。 */
  function history(count = 7, at = clock()) {
    const size = Math.max(1, Math.min(retentionDays, Math.round(count)))
    const result = []
    for (let offset = size - 1; offset >= 0; offset -= 1) {
      const date = new Date(at)
      date.setHours(12, 0, 0, 0)
      date.setDate(date.getDate() - offset)
      const key = dayKey(date.getTime())
      const bucket = days.get(key) || emptyBucket()
      result.push({ date: key, totalTokens: bucket.totalTokens, requests: bucket.requests })
    }
    return result
  }

  function snapshot(at = clock()) {
    return {
      today: today(at),
      allTime: copyBucket(allTime),
      lastCall: lastCall ? { ...lastCall } : null,
      history: history(7, at),
      trackingSince,
      daysTracked: days.size,
    }
  }

  function serialize() {
    const serializedDays = {}
    for (const [key, bucket] of days) serializedDays[key] = copyBucket(bucket)
    return {
      days: serializedDays,
      allTime: copyBucket(allTime),
      lastCall: lastCall ? { ...lastCall } : null,
      trackingSince,
    }
  }

  function hydrate(raw) {
    if (raw === null || typeof raw !== 'object') return
    const rawDays = raw.days
    if (rawDays && typeof rawDays === 'object') {
      for (const key of Object.keys(rawDays)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue
        const bucket = sanitizeBucket(rawDays[key])
        if (Object.values(bucket).some((value) => value > 0)) days.set(key, bucket)
      }
    }
    allTime = sanitizeBucket(raw.allTime)
    if (Number.isFinite(raw.trackingSince) && raw.trackingSince > 0) trackingSince = raw.trackingSince
    if (raw.lastCall && typeof raw.lastCall === 'object') {
      const last = raw.lastCall
      lastCall = {
        at: toCount(last.at),
        provider: typeof last.provider === 'string' ? last.provider : '',
        model: typeof last.model === 'string' ? last.model : '',
        sessionId: typeof last.sessionId === 'string' ? last.sessionId : '',
        purpose: typeof last.purpose === 'string' ? last.purpose : '',
        ...sanitizeBucket(last),
      }
    }
    prune(clock())
  }

  return { record, today, history, snapshot, serialize, hydrate, get trackingSince() { return trackingSince } }
}
