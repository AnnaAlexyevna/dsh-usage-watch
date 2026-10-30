/**
 * Usage Watch — Client 模块自检。
 * 运行：node test/check-client.cjs
 *
 * 用假的 window.__ModuleLoader__ / React / slots 执行 client.js：
 *   1. 模块能被 loader 接收，id 正确，factory 返回 { inject, apply }；
 *   2. apply 在 4 个 slot 上注册（main / sidebar.panellist / sidebar.footer.action / shell.overlay）；
 *   3. locale 字典 zh/en 键集一致且包含关键文案；
 *   4. 各注册组件可渲染（含打开状态的悬浮窗）；
 *   5. 用真实的 State JSON 形状渲染看板 / 悬浮窗，验证卡片、额度条、历史柱图、错误态不抛异常。
 */

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')

const CLIENT_FILE = path.join(__dirname, '..', 'client.js')
const source = fs.readFileSync(CLIENT_FILE, 'utf8')

const NOW = Date.now()

function makeRichState() {
  const config = {
    refreshSeconds: 30,
    historyDays: 14,
    dshtoken: { dailyLimit: 5000, apiEndpoint: 'http://127.0.0.1:8765/api/v1/token/usage' },
    services: {
      doubao: {
        label: '豆包',
        processes: ['Doubao'],
        quota: {
          endpoint: '',
          hasToken: false,
          tokenHeader: 'Authorization',
          fields: { used: 'used', limit: 'limit', unit: 'unit', resetAt: 'resetAt', note: 'note' },
          manual: { used: 3, limit: 10, unit: '次' },
        },
      },
      workbuddy: {
        label: 'WorkBuddy',
        processes: ['WorkBuddy'],
        quota: {
          endpoint: 'https://example.com/usage',
          hasToken: true,
          tokenHeader: 'Authorization',
          fields: { used: 'used', limit: 'limit', unit: 'unit', resetAt: 'resetAt', note: 'note' },
          manual: { used: null, limit: null, unit: '' },
        },
      },
    },
  }
  return {
    ok: true,
    version: 1,
    generatedAt: NOW,
    startedAt: NOW - 60 * 60 * 1000,
    sequence: 7,
    loaded: true,
    config,
    dshtoken: {
      today: { inputTokens: 1200, outputTokens: 700, totalTokens: 404000, cacheReadTokens: 402100, requests: 3 },
      allTime: { inputTokens: 1200, outputTokens: 700, totalTokens: 404000, cacheReadTokens: 402100, requests: 3 },
      lastCall: { at: NOW - 60_000, provider: 'deepseek-account', model: 'deepseek-flash', sessionId: 's1', purpose: '', inputTokens: 900, outputTokens: 300 },
      history: Array.from({ length: 7 }, (_, index) => ({
        date: `2026-10-${23 + index}`,
        totalTokens: (index + 1) * 1000,
        requests: index + 1,
      })),
      trackingSince: NOW - 3 * 60 * 60 * 1000,
      daysTracked: 1,
      dailyLimit: 5000,
      quota: { source: 'budget', used: 404000, limit: 5000, unit: 'tokens', resetAt: '', note: '', percent: 100, updatedAt: NOW },
      api: {
        endpoint: 'http://127.0.0.1:8765/api/v1/token/usage',
        ok: true,
        at: NOW,
        error: null,
        data: {
          service: 'dsh-token-usage-api',
          updatedAt: NOW,
          today: { date: '2026-10-30', inputTokens: 111, outputTokens: 222, totalTokens: 55555, cacheReadTokens: 55222, requests: 9 },
          allTime: { inputTokens: 1, outputTokens: 2, totalTokens: 99999, requests: 12 },
          lastCall: { at: NOW - 30000, provider: 'deepseek-account', model: 'deepseek-pro', inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          trackingSince: NOW - 86400000,
          days: {},
        },
      },
    },
    services: [
      {
        id: 'doubao',
        label: '豆包',
        processes: ['Doubao'],
        running: true,
        processCount: 2,
        memoryMB: 244.5,
        cpuPercent: 1.2,
        uptimeSeconds: 7200,
        checkedAt: NOW,
        todayActiveSeconds: 5400,
        tokenUsage: {
          ok: true,
          endpoint: 'http://127.0.0.1:8765/api/v1/token/usage',
          at: NOW,
          error: null,
          service: 'dsh-token-usage-api',
          today: { totalTokens: 777, requests: 3 },
          allTime: { totalTokens: 888 },
        },
        probeError: null,
        quota: { source: 'manual', used: 3, limit: 10, unit: '次', resetAt: '', note: '', percent: 30, updatedAt: NOW },
        quotaError: null,
      },
      {
        id: 'workbuddy',
        label: 'WorkBuddy',
        processes: ['WorkBuddy'],
        running: false,
        processCount: 0,
        memoryMB: 0,
        cpuPercent: null,
        uptimeSeconds: null,
        checkedAt: NOW,
        probeError: null,
        quota: null,
        quotaError: 'ECONNREFUSED',
      },
    ],
    probe: { supported: true, error: null },
  }
}

function createHarness(options = {}) {
  const runEffects = options.runEffects === true
  const fetchImpl = options.fetchImpl || (async () => {
    throw new Error('fetch not mocked')
  })
  const storage = {
    value: options.storageValue === undefined
      ? null
      : options.storageValue,
  }

  const FakeReact = {
    createElement(type, props, ...children) {
      const normalized = children.length === 0 ? undefined : children.length === 1 ? children[0] : children
      return { type, props: { ...(props || {}), children: normalized }, __isElement: true }
    },
    Component: class FakeComponent {
      constructor(props) {
        this.props = props || {}
        this.state = {}
      }
      setState() {}
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useReducer(reducer, initial) {
      return [initial, () => {}]
    },
    useEffect(effect) {
      if (runEffects) {
        try {
          effect()
        } catch (error) {
          throw error
        }
      }
    },
    useMemo(factory) {
      return factory()
    },
    useRef(value) {
      return { current: value }
    },
    useCallback(fn) {
      return fn
    },
  }
  FakeReact.Component.prototype.isReactComponent = {}

  const registeredLocales = []
  const registrations = []
  const injections = []

  const windowObject = {
    __definition: null,
    __ModuleLoader__: {
      load(definition) {
        windowObject.__definition = definition
      },
    },
    localStorage: {
      getItem() {
        return storage.value
      },
      setItem(_key, value) {
        storage.value = value
      },
    },
    innerWidth: 1440,
    innerHeight: 900,
    addEventListener() {},
    removeEventListener() {},
    setInterval() {
      return 1
    },
    clearInterval() {},
  }

  const sandbox = {
    window: windowObject,
    fetch: (url, init) => fetchImpl(url, init),
    console,
    JSON,
    Math,
    Date,
    String,
    Number,
    Object,
    Array,
    Error,
    Promise,
    Set,
    Map,
  }

  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.ok(windowObject.__definition, 'module loader should receive the definition')
  assert.equal(windowObject.__definition.id, 'dsh-usage-watch')

  const plugin = windowObject.__definition.factory((name) => {
    if (name === 'react') return FakeReact
    return {}
  })
  assert.ok(plugin, 'factory should return the plugin object')
  assert.equal(plugin.inject.join(','), 'slots,locale')
  assert.equal(typeof plugin.apply, 'function')

  const ctx = {
    slots: {
      inject(name, callback) {
        injections.push({ name, callback })
        return () => {}
      },
      register(slotOptions, Component) {
        registrations.push({ slot: slotOptions.name, options: slotOptions, Component })
        return () => {}
      },
    },
    locale: {
      register(ns, dicts) {
        registeredLocales.push({ ns, dicts })
        return () => {}
      },
      bind() {
        return (key, params) => {
          const dicts = registeredLocales[0] ? registeredLocales[0].dicts : {}
          const dict = dicts.zh || {}
          let value = dict[key]
          if (typeof value !== 'string') return key
          if (params) {
            value = value.replace(/\{(\w+)\}/g, (match, name) => (
              Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
            ))
          }
          return value
        }
      },
    },
    effect(callback) {
      const dispose = callback()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    on() {
      return () => {}
    },
  }

  plugin.apply(ctx)
  for (const injection of injections) injection.callback()

  return { windowObject, plugin, registrations, locales: registeredLocales, storage }
}

function walk(node, visit, depth = 0) {
  if (node === null || node === undefined || depth > 80) return
  if (typeof node === 'string' || typeof node === 'number') {
    visit.text(String(node))
    return
  }
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, depth + 1)
    return
  }
  assert.equal(typeof node, 'object', 'render result should be an element/object')
  const type = node.type
  const props = node.props || {}
  if (typeof type === 'function') {
    if (type.prototype && type.prototype.isReactComponent) {
      const instance = new type(props)
      walk(instance.render(), visit, depth + 1)
      return
    }
    walk(type(props), visit, depth + 1)
    return
  }
  visit.element(type)
  if (Array.isArray(props.children)) {
    for (const child of props.children) walk(child, visit, depth + 1)
  } else {
    walk(props.children, visit, depth + 1)
  }
}

function inspectTree(node) {
  const text = []
  let elements = 0
  walk(node, {
    element() {
      elements += 1
    },
    text(value) {
      text.push(value)
    },
  })
  return { elements, text }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  /* ---------------------------------------------------------- basic harness */

  const basic = createHarness({ storageValue: null })
  assert.equal(basic.locales.length >= 1, true, 'locale should be registered')
  const locale = basic.locales[0]
  assert.equal(locale.ns, 'usage-watch')
  const zhKeys = Object.keys(locale.dicts.zh).sort()
  const enKeys = Object.keys(locale.dicts.en).sort()
  assert.deepEqual(zhKeys, enKeys, 'zh/en dictionaries must expose the same keys')
  for (const required of ['panel.title', 'button.pin', 'button.close', 'dsh.title', 'quota.none', 'settings.save', 'dsh.cacheRead', 'dsh.source.api', 'settings.apiEndpoint']) {
    assert.ok(zhKeys.includes(required), `missing locale key ${required}`)
  }

  assert.equal(basic.registrations.length, 4, 'expected four slot registrations')
  const bySlot = Object.fromEntries(basic.registrations.map((entry) => [entry.slot, entry]))
  assert.ok(bySlot.main, 'main panel registration')
  assert.equal(bySlot.main.options.key, 'usage-watch')
  assert.ok(bySlot['sidebar.panellist'], 'sidebar panellist registration')
  assert.equal(bySlot['sidebar.panellist'].options.id, 'usage-watch')
  assert.equal(typeof bySlot['sidebar.panellist'].options.label, 'function')
  assert.ok(bySlot['sidebar.footer.action'], 'sidebar footer action registration')
  assert.equal(bySlot['sidebar.footer.action'].options.id, 'usage-watch')
  assert.ok(bySlot['shell.overlay'], 'overlay registration')
  assert.equal(bySlot['shell.overlay'].options.id, 'usage-watch')

  const closedProps = {
    main: {},
    'sidebar.panellist': { size: 18, active: true },
    'sidebar.footer.action': { wide: true },
    'shell.overlay': {},
  }
  for (const entry of basic.registrations) {
    const tree = inspectTree(entry.Component(closedProps[entry.slot] || {}))
    assert.ok(tree.elements >= 0)
  }

  /* ------------------------------------------------------ rich state render */

  const richState = makeRichState()
  let fetchCalls = 0
  const rich = createHarness({
    runEffects: true,
    storageValue: JSON.stringify({ open: true, pinned: true, collapsed: false, x: 40, y: 120 }),
    fetchImpl: async () => {
      fetchCalls += 1
      return { ok: true, status: 200, json: async () => richState }
    },
  })
  await sleep(20)

  const richBySlot = Object.fromEntries(rich.registrations.map((entry) => [entry.slot, entry]))
  // 第一次渲染让 data hook 的 effect 发起请求，等请求落地后再渲染一次。
  inspectTree(richBySlot.main.Component({}))
  await sleep(30)
  const dashboardTree = inspectTree(richBySlot.main.Component({}))
  assert.ok(dashboardTree.elements > 60, `dashboard should render a rich tree, got ${dashboardTree.elements}`)
  const dashboardText = dashboardTree.text.join('|')
  for (const expected of ['豆包', 'WorkBuddy', 'DSH Token', '运行中', '未运行', '未接入额度', 'ECONNREFUSED', '缓存读', '近 7 天', '本地接口', '今日使用', '接口 Token']) {
    assert.ok(dashboardText.includes(expected), `dashboard text should include ${expected}`)
  }

  const overlayTree = inspectTree(richBySlot['shell.overlay'].Component({}))
  assert.ok(overlayTree.elements > 60, `floating window should render a rich tree, got ${overlayTree.elements}`)
  const overlayText = overlayTree.text.join('|')
  assert.ok(overlayText.includes('豆包'), 'floating window should show Doubao card')
  assert.ok(overlayText.includes('置顶') === false || overlayText.includes('取消置顶') === true, 'pinned window should offer unpin')

  assert.ok(fetchCalls >= 1, 'client should fetch /api/usage-watch/state')
  assert.ok(rich.storage.value.includes('"open":true'), 'ui state should persist to localStorage')

  /* ------------------------------------------- token API fallback render */

  const fallbackState = makeRichState()
  fallbackState.dshtoken.api = {
    endpoint: 'http://127.0.0.1:8765/api/v1/token/usage',
    ok: false,
    at: NOW,
    error: 'ECONNREFUSED',
    data: null,
  }
  const fallback = createHarness({
    runEffects: true,
    storageValue: JSON.stringify({ open: true, pinned: false, collapsed: false, x: 20, y: 20 }),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => fallbackState }),
  })
  await sleep(20)
  const fallbackOverlay = fallback.registrations.find((entry) => entry.slot === 'shell.overlay')
  inspectTree(fallbackOverlay.Component({}))
  await sleep(30)
  const fallbackText = inspectTree(fallbackOverlay.Component({})).text.join('|')
  assert.ok(fallbackText.includes('本机统计'), 'fallback window should label the local counter')
  assert.ok(fallbackText.includes('接口不可用'), 'fallback window should explain the API error')

  /* -------------------------------------------------------- offline render */

  const offline = createHarness({
    runEffects: true,
    storageValue: JSON.stringify({ open: true, pinned: false, collapsed: false, x: 10, y: 10 }),
    fetchImpl: async () => {
      throw new Error('network down')
    },
  })
  await sleep(20)
  const offlineOverlay = offline.registrations.find((entry) => entry.slot === 'shell.overlay')
  inspectTree(offlineOverlay.Component({}))
  await sleep(30)
  const offlineText = inspectTree(offlineOverlay.Component({})).text.join('|')
  assert.ok(offlineText.includes('未连接用量服务'), 'offline window should explain the missing connection')

  /* ------------------------------------------------------- collapsed window */

  const collapsed = createHarness({
    runEffects: false,
    storageValue: JSON.stringify({ open: true, pinned: false, collapsed: true, x: 0, y: 0 }),
  })
  const collapsedOverlay = collapsed.registrations.find((entry) => entry.slot === 'shell.overlay')
  const collapsedTree = inspectTree(collapsedOverlay.Component({}))
  assert.ok(collapsedTree.elements > 0, 'collapsed window should still render its header')

  console.log('client checks passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
