/**
 * Usage Watch — Windows 进程探测（豆包 / WorkBuddy 等桌面应用的运行状态）。
 *
 * 只读取进程表：进程名、工作集、累计 CPU 时间、启动时间。不改动任何进程。
 * CPU 百分比来自两次采样的差值，第一次采样为 null（面板显示「—」）。
 */

import { execFile } from 'node:child_process'

const CPU_SAMPLE_MIN_MS = 800

export function isProbeSupported() {
  return process.platform === 'win32'
}

function quotePowerShell(text) {
  return `'${String(text).replace(/'/g, "''")}'`
}

export function buildScript(processNames) {
  const names = processNames.map(quotePowerShell).join(', ')
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$names = @(${names})`,
    "$rows = @(Get-Process -Name $names -ErrorAction SilentlyContinue | Select-Object Id, ProcessName, WorkingSet64, CPU, StartTime)",
    "$rows | ConvertTo-Json -Compress",
  ].join('; ')
}

export function runPowerShell(script, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const message = (stderr && String(stderr).trim()) || error.message || String(error)
          reject(new Error(message))
          return
        }
        resolve(String(stdout || ''))
      },
    )
  })
}

function toNumber(value) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : 0
}

function parseStartTime(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || value.trim() === '') return null
  // ConvertTo-Json 可能给 7 位小数秒（.1234567）；ECMAScript 只接受 3 位。
  const normalized = value.replace(/(\.\d{3})\d+/, '$1')
  const parsed = Date.parse(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

/** 解析 PowerShell 的 ConvertTo-Json 输出（单条记录时是对象而不是数组）。 */
export function parseProcessRows(raw) {
  const text = String(raw || '').trim()
  if (!text) return []
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const list = Array.isArray(parsed) ? parsed : [parsed]
  const rows = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const name = typeof item.ProcessName === 'string' ? item.ProcessName : ''
    if (!name) continue
    rows.push({
      pid: toNumber(item.Id),
      name,
      nameLower: name.toLowerCase(),
      workingSet: toNumber(item.WorkingSet64),
      cpuSeconds: toNumber(item.CPU),
      startTime: parseStartTime(item.StartTime),
    })
  }
  return rows
}

/** 把一次采样结果聚合成一个服务的运行状态。 */
export function aggregateService(rows, processNames, at) {
  const wanted = new Set(processNames.map((name) => name.toLowerCase()))
  const matched = rows.filter((row) => wanted.has(row.nameLower))
  if (!matched.length) {
    return {
      running: false,
      processCount: 0,
      memoryMB: 0,
      cpuPercent: null,
      uptimeSeconds: null,
      checkedAt: at,
      processes: [],
    }
  }
  const memoryBytes = matched.reduce((sum, row) => sum + row.workingSet, 0)
  const cpuSamples = matched.map((row) => row.cpuPercent).filter((value) => typeof value === 'number')
  const starts = matched.map((row) => row.startTime).filter((value) => typeof value === 'number')
  return {
    running: true,
    processCount: matched.length,
    memoryMB: Math.round((memoryBytes / (1024 * 1024)) * 10) / 10,
    cpuPercent: cpuSamples.length ? Math.round(cpuSamples.reduce((sum, value) => sum + value, 0) * 10) / 10 : null,
    uptimeSeconds: starts.length ? Math.max(0, Math.round((at - Math.min(...starts)) / 1000)) : null,
    checkedAt: at,
    processes: matched.map((row) => ({
      pid: row.pid,
      name: row.name,
      memoryMB: Math.round((row.workingSet / (1024 * 1024)) * 10) / 10,
    })),
  }
}

export function createProbe(options = {}) {
  const supported = isProbeSupported()
  const run = typeof options.run === 'function' ? options.run : runPowerShell
  const clock = typeof options.clock === 'function' ? options.clock : Date.now
  /** pid -> { cpuSeconds, at } */
  let previous = new Map()

  async function sample(processNames) {
    const at = clock()
    if (!supported) {
      return { supported: false, error: null, at, rows: [], services: {} }
    }
    const names = [...new Set(processNames.filter((name) => typeof name === 'string' && name.trim()))]
    if (!names.length) return { supported: true, error: null, at, rows: [], services: {} }

    let raw = ''
    let error = null
    try {
      raw = await run(buildScript(names))
    } catch (failure) {
      error = failure && failure.message ? failure.message : String(failure)
    }

    const rows = error ? [] : parseProcessRows(raw)
    const nextPrevious = new Map()
    for (const row of rows) {
      const before = previous.get(row.pid)
      if (
        before &&
        at - before.at >= CPU_SAMPLE_MIN_MS &&
        row.cpuSeconds >= before.cpuSeconds
      ) {
        const seconds = (at - before.at) / 1000
        row.cpuPercent = Math.max(0, Math.round((((row.cpuSeconds - before.cpuSeconds) / seconds) * 100) * 10) / 10)
      } else {
        row.cpuPercent = null
      }
      nextPrevious.set(row.pid, { cpuSeconds: row.cpuSeconds, at })
    }
    previous = nextPrevious

    const services = {}
    for (const name of names) {
      services[name] = aggregateService(rows, [name], at)
    }
    return { supported: true, error, at, rows, services }
  }

  function reset() {
    previous = new Map()
  }

  return { supported, sample, reset }
}
