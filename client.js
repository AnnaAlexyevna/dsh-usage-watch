/**
 * Usage Watch（用量监控）— Client half（手写，无构建步骤）。
 *
 * 通过 window.__ModuleLoader__.load 注册工厂，只 require('react')。
 * 数据全部来自同源 /api/usage-watch/* 路由（Host 半提供）。
 *
 * 界面：
 *   - sidebar.panellist   左侧栏图标入口 → main 面板里的完整看板
 *   - sidebar.footer.action 左侧栏底部按钮 → 开关悬浮窗
 *   - shell.overlay       悬浮窗：可拖动标题栏移动、可置顶、可收起
 *
 * 所有资源（locale 字典、slot 注册）都通过 ctx.effect / slots.inject 管理，
 * 组件内定时器在 useEffect 清理函数里释放。
 */

window.__ModuleLoader__.load({
  id: 'dsh-usage-watch',
  factory(require) {
    'use strict';

    const React = require('react');
    const h = React.createElement;

    const NS = 'usage-watch';
    const API = '/api/usage-watch';
    const POLL_MS = 5000;
    const STORAGE_KEY = 'usage-watch.window.v1';
    const WINDOW_WIDTH = 372;

    /* ------------------------------------------------------------------ */
    /* Dictionaries (runtime copy for ctx.locale; locale/*.json holds meta) */
    /* ------------------------------------------------------------------ */

    const ZH = {
      'button.close': '关闭',
      'button.collapse': '收起',
      'button.expand': '展开',
      'button.openWindow': '打开悬浮窗',
      'button.pin': '置顶',
      'button.refresh': '刷新',
      'button.refreshing': '刷新中…',
      'button.resetPosition': '拖动标题栏移动（限制在窗口内）；双击复位位置',
      'button.settings': '设置',
      'button.settingsClose': '收起设置',
      'button.unpin': '取消置顶',
      'button.windowOpen': '关闭悬浮窗',
      'dsh.allTime': '累计 {value}',
      'dsh.apiFallback': '接口不可用，显示本机统计：{detail}',
      'dsh.budget': '今日预算 {limit}',
      'dsh.cacheRead': '缓存读',
      'dsh.source.api': '本地接口',
      'dsh.source.local': '本机统计',
      'dsh.history': '近 7 天',
      'dsh.input': '输入',
      'dsh.lastCall': '最近：{model} · {time}',
      'dsh.noCall': '还没有模型调用',
      'dsh.output': '输出',
      'dsh.requests': '调用',
      'dsh.since': '自 {time} 起统计',
      'dsh.title': 'DSH Token',
      'dsh.todayTokens': '今日',
      'duration.days': '{n} 天',
      'duration.hours': '{n} 小时',
      'duration.minutes': '{n} 分钟',
      'duration.seconds': '{n} 秒',
      'page.note': 'DSH Token 优先显示本地接口（默认 127.0.0.1:8765，接口不可用时自动回退本机 llm/stream 统计）；豆包 / WorkBuddy 的额度只有在你配置接口或手动数值后才显示，没有配置时不会出现任何编造的数字。',
      'page.subtitle': '左侧栏入口 + 可拖动、可置顶的悬浮窗',
      'page.title': 'AI 用量监控',
      'panel.offlineHint': '确认插件已启用后重试，或检查 Host 是否在运行。',
      'panel.offlineTitle': '未连接用量服务',
      'panel.stale': '连接中断，显示上次数据',
      'panel.subtitle': '豆包 · WorkBuddy · DSH Token',
      'panel.title': '用量监控',
      'probe.error': '进程探测失败：{detail}',
      'probe.unsupported': '当前平台不支持进程探测',
      'quota.error': '额度获取失败：{detail}',
      'quota.none': '未接入额度',
      'quota.noneHint': '可在设置里手动填已用/上限，或填一个查询接口',
      'quota.remaining': '剩余 {value}',
      'quota.reset': '重置于 {time}',
      'quota.source.budget': '预算',
      'quota.source.endpoint': '接口',
      'quota.source.manual': '手动',
      'quota.used': '已用 {used} / {limit}{unit}',
      'service.cpu': 'CPU {value}',
      'service.memory': '内存 {value}',
      'service.processes': '{n} 个进程',
      'service.running': '运行中',
      'service.stopped': '未运行',
      'service.interfaceToken': '接口 Token',
      'service.interfaceTokenError': 'Token 接口失败：{detail}',
      'service.interfaceTokenFallback': '接口未连接 · 显示本机统计',
      'service.interfaceTokenStale': '接口暂不可用 · 显示上次数据',
      'service.windowTotal': '近 {days} 天 {value}',
      'service.credit': 'credit {value}',
      'service.todayActive': '今日使用 {value}',
      'service.unknown': '未知',
      'service.unavailable': '额度不可用',
      'service.uptime': '已运行 {value}',
      'settings.apiEndpoint': 'DSH Token 接口 URL（留空 = 只用本机统计）',
      'settings.dailyLimit': 'DSH Token 每日预算（0 = 不设预算）',
      'settings.endpoint': '额度接口 URL（返回含 used / limit 的 JSON）',
      'settings.failed': '保存失败：{detail}',
      'settings.hint': '保存后立即生效，写入本机 .dsh/usage-watch/state.json',
      'settings.limit': '手动：上限',
      'settings.placeholderApi': 'http://127.0.0.1:8765/api/v1/token/usage',
      'settings.tokenServiceAutoStart': '接口掉线时自动拉起本地 token 服务（start-api.ps1）',
      'settings.placeholderEndpoint': 'https://example.com/usage',
      'settings.placeholderUnit': '次',
      'settings.tokenEndpoint': 'Token 用量接口 URL（可选，返回 today.totalTokens 的 JSON）',
      'settings.refresh': '进程 / 额度刷新间隔（秒）',
      'settings.save': '保存',
      'settings.saved': '已保存',
      'settings.saving': '保存中…',
      'settings.title': '设置',
      'settings.token': '接口 token（已保存时留空表示不修改）',
      'settings.tokenSaved': '已保存 token',
      'settings.unit': '单位',
      'settings.used': '手动：已用',
      'status.connecting': '连接中…',
      'status.live': '已连接',
      'status.updated': '更新于 {time}',
      'time.days': '{n} 天前',
      'time.hours': '{n} 小时前',
      'time.minutes': '{n} 分钟前',
      'time.now': '刚刚',
      'time.seconds': '{n} 秒前',
      'unit.token': 'token',
    };

    const EN = {
      'button.close': 'Close',
      'button.collapse': 'Collapse',
      'button.expand': 'Expand',
      'button.openWindow': 'Open floating window',
      'button.pin': 'Pin on top',
      'button.refresh': 'Refresh',
      'button.refreshing': 'Refreshing…',
      'button.resetPosition': 'Drag the title bar to move (kept inside the window); double-click to reset',
      'button.settings': 'Settings',
      'button.settingsClose': 'Hide settings',
      'button.unpin': 'Unpin',
      'button.windowOpen': 'Close floating window',
      'dsh.allTime': 'All time {value}',
      'dsh.apiFallback': 'API unavailable — showing local counter: {detail}',
      'dsh.budget': 'Daily budget {limit}',
      'dsh.cacheRead': 'Cache read',
      'dsh.source.api': 'Local API',
      'dsh.source.local': 'Local counter',
      'dsh.history': 'Last 7 days',
      'dsh.input': 'Input',
      'dsh.lastCall': 'Last: {model} · {time}',
      'dsh.noCall': 'No model call yet',
      'dsh.output': 'Output',
      'dsh.requests': 'Calls',
      'dsh.since': 'Tracking since {time}',
      'dsh.title': 'DSH Token',
      'dsh.todayTokens': 'Today',
      'duration.days': '{n}d',
      'duration.hours': '{n}h',
      'duration.minutes': '{n}m',
      'duration.seconds': '{n}s',
      'page.note': 'DSH token numbers come from the local token API first (default 127.0.0.1:8765) and fall back to the on-machine llm/stream counter when it is unavailable. Doubao / WorkBuddy quota appears only after you configure an endpoint or enter manual values — no invented numbers.',
      'page.subtitle': 'Sidebar entry plus a draggable, pinnable floating window',
      'page.title': 'AI Usage Monitor',
      'panel.offlineHint': 'Make sure the plugin is enabled and the Host is running, then retry.',
      'panel.offlineTitle': 'Not connected to Usage Watch',
      'panel.stale': 'Connection lost — showing the last snapshot',
      'panel.subtitle': 'Doubao · WorkBuddy · DSH Token',
      'panel.title': 'Usage Watch',
      'probe.error': 'Process probe failed: {detail}',
      'probe.unsupported': 'Process probing is not supported on this platform',
      'quota.error': 'Quota request failed: {detail}',
      'quota.none': 'No quota source',
      'quota.noneHint': 'Configure an endpoint or manual values in Settings',
      'quota.remaining': '{value} left',
      'quota.reset': 'Resets {time}',
      'quota.source.budget': 'Budget',
      'quota.source.endpoint': 'API',
      'quota.source.manual': 'Manual',
      'quota.used': '{used} / {limit}{unit} used',
      'service.cpu': 'CPU {value}',
      'service.memory': 'RAM {value}',
      'service.processes': '{n} processes',
      'service.running': 'Running',
      'service.stopped': 'Not running',
      'service.interfaceToken': 'Token API',
      'service.interfaceTokenError': 'Token API failed: {detail}',
      'service.interfaceTokenFallback': 'API offline · local stats',
      'service.interfaceTokenStale': 'API unavailable · last known values',
      'service.windowTotal': 'Last {days} days {value}',
      'service.credit': 'credit {value}',
      'service.todayActive': 'Used today {value}',
      'service.unknown': 'Unknown',
      'service.unavailable': 'Quota unavailable',
      'service.uptime': 'Up {value}',
      'settings.apiEndpoint': 'DSH Token API URL (blank = local counter only)',
      'settings.dailyLimit': 'DSH token daily budget (0 = none)',
      'settings.endpoint': 'Quota endpoint URL (JSON with used / limit)',
      'settings.failed': 'Could not save: {detail}',
      'settings.hint': 'Applies immediately; stored in .dsh/usage-watch/state.json',
      'settings.limit': 'Manual: limit',
      'settings.placeholderApi': 'http://127.0.0.1:8765/api/v1/token/usage',
      'settings.tokenServiceAutoStart': 'Auto-start local token service when the API is down (start-api.ps1)',
      'settings.placeholderEndpoint': 'https://example.com/usage',
      'settings.placeholderUnit': 'requests',
      'settings.tokenEndpoint': 'Token usage endpoint (optional, JSON with today.totalTokens)',
      'settings.refresh': 'Process / quota refresh interval (seconds)',
      'settings.save': 'Save',
      'settings.saved': 'Saved',
      'settings.saving': 'Saving…',
      'settings.title': 'Settings',
      'settings.token': 'Endpoint token (leave blank to keep the saved one)',
      'settings.tokenSaved': 'Token saved',
      'settings.unit': 'Unit',
      'settings.used': 'Manual: used',
      'status.connecting': 'Connecting…',
      'status.live': 'Connected',
      'status.updated': 'Updated {time}',
      'time.days': '{n}d ago',
      'time.hours': '{n}h ago',
      'time.minutes': '{n}m ago',
      'time.now': 'just now',
      'time.seconds': '{n}s ago',
      'unit.token': 'tokens',
    };

    /* ------------------------------------------------------------------ */
    /* Locale helpers                                                      */
    /* ------------------------------------------------------------------ */

    const FALLBACK_DICTS = { zh: ZH, en: EN };

    function currentLang() {
      try {
        const nav = typeof navigator !== 'undefined' ? navigator : null;
        const languages = nav && Array.isArray(nav.languages) ? nav.languages : null;
        const tag = (languages && languages[0]) || (nav && nav.language) || '';
        return /^zh/i.test(String(tag)) ? 'zh' : 'en';
      } catch (error) {
        return 'en';
      }
    }

    function interpolate(template, params) {
      if (!params) return template;
      return String(template).replace(/\{(\w+)\}/g, (match, name) => (
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
      ));
    }

    function fallbackT(key, params) {
      const lang = currentLang();
      const primary = FALLBACK_DICTS[lang] || EN;
      const secondary = lang === 'zh' ? EN : ZH;
      const raw = primary[key] !== undefined ? primary[key] : (secondary[key] !== undefined ? secondary[key] : key);
      return interpolate(raw, params);
    }

    function makeT(bound) {
      if (typeof bound !== 'function') return fallbackT;
      return function t(key, params) {
        try {
          const value = bound(key, params);
          if (typeof value === 'string' && value !== key) return value;
        } catch (error) {
          /* fall through */
        }
        return fallbackT(key, params);
      };
    }

    /* ------------------------------------------------------------------ */
    /* Formatting helpers                                                  */
    /* ------------------------------------------------------------------ */

    function isFiniteNumber(value) {
      return typeof value === 'number' && Number.isFinite(value);
    }

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value));
    }

    function trimDecimal(value) {
      return String(Number(value.toFixed(1)));
    }

    function formatTokens(value, lang) {
      const number = isFiniteNumber(value) ? value : 0;
      if (lang === 'zh') {
        if (number >= 1e8) return trimDecimal(number / 1e8) + ' 亿';
        if (number >= 1e4) return trimDecimal(number / 1e4) + ' 万';
        return String(Math.round(number));
      }
      if (number >= 1e9) return trimDecimal(number / 1e9) + 'B';
      if (number >= 1e6) return trimDecimal(number / 1e6) + 'M';
      if (number >= 1e3) return trimDecimal(number / 1e3) + 'k';
      return String(Math.round(number));
    }

    function formatNumber(value) {
      if (!isFiniteNumber(value)) return '—';
      try {
        return value.toLocaleString();
      } catch (error) {
        return String(value);
      }
    }

    function formatPercent(value) {
      if (!isFiniteNumber(value)) return '—';
      return (value >= 10 ? value.toFixed(0) : value.toFixed(1)) + '%';
    }

    function formatClock(timestamp) {
      if (!isFiniteNumber(timestamp) || timestamp <= 0) return '—';
      try {
        return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      } catch (error) {
        try {
          return new Date(timestamp).toISOString().slice(11, 19);
        } catch (inner) {
          return '—';
        }
      }
    }

    function formatShortDateTime(timestamp) {
      if (!isFiniteNumber(timestamp) || timestamp <= 0) return '—';
      const date = new Date(timestamp);
      const now = new Date();
      const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
      try {
        if (sameDay) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return date.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      } catch (error) {
        return '—';
      }
    }

    function relTime(timestamp, t) {
      if (!isFiniteNumber(timestamp) || timestamp <= 0) return '';
      const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
      if (seconds < 15) return t('time.now');
      if (seconds < 60) return t('time.seconds', { n: seconds });
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return t('time.minutes', { n: minutes });
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return t('time.hours', { n: hours });
      return t('time.days', { n: Math.floor(hours / 24) });
    }

    function formatDuration(seconds, t) {
      if (!isFiniteNumber(seconds) || seconds < 0) return '';
      if (seconds < 60) return t('duration.seconds', { n: Math.round(seconds) });
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return t('duration.minutes', { n: minutes });
      const hours = Math.floor(minutes / 60);
      if (hours < 24) {
        const rest = minutes % 60;
        return rest > 0
          ? t('duration.hours', { n: hours }) + ' ' + t('duration.minutes', { n: rest })
          : t('duration.hours', { n: hours });
      }
      return t('duration.days', { n: Math.floor(hours / 24) });
    }

    /* ------------------------------------------------------------------ */
    /* Window UI state (module store shared by sidebar + overlay + page)   */
    /* ------------------------------------------------------------------ */

    function loadUiState() {
      const defaults = { open: false, pinned: false, collapsed: false, x: null, y: null };
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return defaults;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return defaults;
        return {
          open: parsed.open === true,
          pinned: parsed.pinned === true,
          collapsed: parsed.collapsed === true,
          x: isFiniteNumber(parsed.x) ? parsed.x : null,
          y: isFiniteNumber(parsed.y) ? parsed.y : null,
        };
      } catch (error) {
        return defaults;
      }
    }

    function persistUiState(ui) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
          open: ui.open === true,
          pinned: ui.pinned === true,
          collapsed: ui.collapsed === true,
          x: isFiniteNumber(ui.x) ? Math.round(ui.x) : null,
          y: isFiniteNumber(ui.y) ? Math.round(ui.y) : null,
        }));
      } catch (error) {
        /* 隐私模式/配额满：位置不持久化也不影响功能 */
      }
    }

    let uiState = loadUiState();
    const uiSubscribers = new Set();

    function patchUiState(patch) {
      uiState = { ...uiState, ...patch };
      persistUiState(uiState);
      for (const subscriber of [...uiSubscribers]) {
        try {
          subscriber();
        } catch (error) {
          /* 单个订阅者失败不影响其他订阅者 */
        }
      }
    }

    function useUiState() {
      const [, bump] = React.useReducer((count) => count + 1, 0);
      React.useEffect(() => {
        uiSubscribers.add(bump);
        return () => {
          uiSubscribers.delete(bump);
        };
      }, []);
      return [uiState, patchUiState];
    }

    /* ------------------------------------------------------------------ */
    /* Data store (one shared poller regardless of how many views mount)   */
    /* ------------------------------------------------------------------ */

    const dataStore = {
      state: null,
      error: null,
      updatedAt: 0,
      version: 0,
      listeners: new Set(),
      timer: null,
      inflight: null,
    };

    function notifyData() {
      dataStore.version += 1;
      for (const listener of [...dataStore.listeners]) {
        try {
          listener();
        } catch (error) {
          /* ignore */
        }
      }
    }

    function requestState() {
      if (dataStore.inflight) return dataStore.inflight;
      dataStore.inflight = (async () => {
        try {
          const response = await fetch(`${API}/state`, { cache: 'no-store', credentials: 'same-origin' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const json = await response.json();
          if (!json || typeof json !== 'object') throw new Error('invalid state');
          dataStore.state = json;
          dataStore.error = null;
          dataStore.updatedAt = Date.now();
        } catch (error) {
          dataStore.error = error && error.message ? error.message : String(error);
        } finally {
          dataStore.inflight = null;
          notifyData();
        }
      })();
      return dataStore.inflight;
    }

    function postJson(path, body) {
      return fetch(`${API}${path}`, {
        method: 'POST',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
        cache: 'no-store',
      }).then(async (response) => {
        let json = null;
        try {
          json = await response.json();
        } catch (error) {
          json = null;
        }
        if (!response.ok || !json || json.ok === false) {
          const detail = (json && json.error) || `HTTP ${response.status}`;
          throw new Error(detail);
        }
        return json;
      });
    }

    async function triggerRefresh() {
      try {
        const json = await postJson('/refresh');
        if (json && typeof json === 'object') {
          dataStore.state = json;
          dataStore.error = null;
          dataStore.updatedAt = Date.now();
        }
      } catch (error) {
        dataStore.error = error && error.message ? error.message : String(error);
      }
      notifyData();
      return dataStore.state;
    }

    async function saveConfig(patch) {
      const json = await postJson('/config', { patch });
      if (json && typeof json === 'object') {
        dataStore.state = json;
        dataStore.error = null;
        dataStore.updatedAt = Date.now();
      }
      notifyData();
      return json;
    }

    function useUsageData() {
      const [snapshot, setSnapshot] = React.useState(() => ({
        state: dataStore.state,
        error: dataStore.error,
        updatedAt: dataStore.updatedAt,
        version: dataStore.version,
      }));

      React.useEffect(() => {
        const listener = () => {
          setSnapshot({
            state: dataStore.state,
            error: dataStore.error,
            updatedAt: dataStore.updatedAt,
            version: dataStore.version,
          });
        };
        dataStore.listeners.add(listener);
        if (dataStore.listeners.size === 1) {
          void requestState();
          dataStore.timer = window.setInterval(() => {
            void requestState();
          }, POLL_MS);
        }
        return () => {
          dataStore.listeners.delete(listener);
          if (dataStore.listeners.size === 0 && dataStore.timer !== null) {
            window.clearInterval(dataStore.timer);
            dataStore.timer = null;
          }
        };
      }, []);

      return snapshot;
    }

    /* ------------------------------------------------------------------ */
    /* Icons                                                               */
    /* ------------------------------------------------------------------ */

    function svgProps(size) {
      return {
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      };
    }

    function ChartIcon({ size = 16 }) {
      return h('svg', svgProps(size), h('path', { d: 'M3.2 13.2V8.8M8 13.2V4.2M12.8 13.2V6.6' }));
    }

    function PinIcon({ size = 16 }) {
      return h('svg', { ...svgProps(size), fill: 'currentColor', stroke: 'none' },
        h('path', { d: 'M6 1.8h4l-.45 2.9 2.55 2.55v1.15H8.75V12.8l-.75 1.1-.75-1.1V8.4H3.9V7.25L6.45 4.7z' })
      );
    }

    function ChevronIcon({ size = 16, up = false }) {
      return h('svg', svgProps(size), h('path', { d: up ? 'M4 9.5 8 5.5l4 4' : 'M4 6.5 8 10.5l4-4' }));
    }

    function CloseIcon({ size = 16 }) {
      return h('svg', svgProps(size), h('path', { d: 'M4 4l8 8M12 4l-8 8' }));
    }

    function RefreshIcon({ size = 16 }) {
      return h('svg', svgProps(size), h('path', { d: 'M12.8 8a4.8 4.8 0 1 1-1.4-3.4M12.8 2.2v3h-3' }));
    }

    function GearIcon({ size = 16 }) {
      return h('svg', svgProps(size),
        h('circle', { cx: 8, cy: 8, r: 2.3 }),
        h('path', { d: 'M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1' })
      );
    }

    function Dot({ tone, size = 8 }) {
      return h('span', {
        style: {
          display: 'inline-block',
          width: size + 'px',
          height: size + 'px',
          borderRadius: '50%',
          background: tone,
          flex: '0 0 auto',
        },
      });
    }

    function Bar({ percent, tone }) {
      const width = isFiniteNumber(percent) ? clamp(percent, 0, 100) : 0;
      return h('div', {
        style: {
          height: '6px',
          borderRadius: '999px',
          background: 'var(--dsw-alias-border-l1)',
          overflow: 'hidden',
        },
      }, h('div', {
        style: {
          width: width + '%',
          height: '100%',
          borderRadius: '999px',
          background: tone || 'var(--dsw-alias-brand-primary)',
          transition: 'width 300ms ease',
        },
      }));
    }

    /* ------------------------------------------------------------------ */
    /* Small shared pieces                                                 */
    /* ------------------------------------------------------------------ */

    const TONE = {
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
      brand: 'var(--dsw-alias-brand-primary)',
    };

    const TEXT_SECONDARY = { color: 'var(--dsw-alias-label-secondary)' };

    function IconButton({ title, onClick, children, active, danger }) {
      const [hover, setHover] = React.useState(false);
      return h('button', {
        type: 'button',
        title,
        'aria-label': title,
        'data-uw-nodrag': '1',
        onClick: (event) => {
          if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
          if (typeof onClick === 'function') onClick(event);
        },
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          width: '24px',
          height: '24px',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
          borderRadius: '6px',
          border: 'none',
          cursor: 'pointer',
          background: active
            ? 'color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent)'
            : (hover ? 'var(--dsw-alias-bg-layer-2)' : 'transparent'),
          color: active
            ? 'var(--dsw-alias-brand-primary)'
            : (danger && hover ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)'),
        },
      }, children);
    }

    function TextButton({ title, onClick, children, primary }) {
      const [hover, setHover] = React.useState(false);
      return h('button', {
        type: 'button',
        title,
        onClick,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '5px',
          padding: '4px 9px',
          borderRadius: '6px',
          border: primary ? 'none' : '1px solid var(--dsw-alias-border-l1)',
          background: primary
            ? (hover ? 'var(--dsw-alias-brand-primary)' : 'color-mix(in srgb, var(--dsw-alias-brand-primary) 88%, #000)')
            : (hover ? 'var(--dsw-alias-bg-layer-2)' : 'transparent'),
          color: primary ? '#fff' : 'var(--dsw-alias-label-primary)',
          cursor: 'pointer',
          fontSize: '11.5px',
          fontWeight: 500,
          whiteSpace: 'nowrap',
        },
      }, children);
    }

    function Field({ label, value, placeholder, onChange, type, width }) {
      return h('label', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: '3px',
          minWidth: 0,
          width: width || 'auto',
          flex: width ? '0 0 auto' : '1 1 0',
        },
      },
      h('span', { style: { fontSize: '10px', ...TEXT_SECONDARY } }, label),
      h('input', {
        type: type || 'text',
        value: value,
        placeholder: placeholder || '',
        onChange: (event) => onChange(event.target.value),
        style: {
          width: '100%',
          boxSizing: 'border-box',
          padding: '4px 7px',
          fontSize: '11px',
          color: 'var(--dsw-alias-label-primary)',
          background: 'var(--dsw-alias-bg-base)',
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: '6px',
          outline: 'none',
          fontFamily: 'inherit',
        },
      }));
    }

    class ViewBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }

      static getDerivedStateFromError() {
        return { failed: true };
      }

      componentDidCatch(error) {
        try {
          console.error('[usage-watch] view crashed', error);
        } catch (inner) {
          /* ignore */
        }
      }

      render() {
        if (this.state.failed) return null;
        return this.props.children;
      }
    }

    function guarded(Component) {
      return function UsageWatchGuarded(props) {
        return h(ViewBoundary, null, h(Component, props));
      };
    }

    /* ------------------------------------------------------------------ */
    /* Cards                                                               */
    /* ------------------------------------------------------------------ */

    function quotaLine(quota, t, lang) {
      if (!quota) return null;
      const unit = quota.unit ? ' ' + quota.unit : '';
      const parts = [];
      if (isFiniteNumber(quota.used) && isFiniteNumber(quota.limit) && quota.limit > 0) {
        parts.push(t('quota.used', {
          used: formatNumber(quota.used),
          limit: formatNumber(quota.limit),
          unit,
        }));
        const remaining = Math.max(0, quota.limit - quota.used);
        parts.push(t('quota.remaining', { value: formatNumber(Math.round(remaining)) + unit }));
      } else if (isFiniteNumber(quota.used)) {
        parts.push(t('quota.used', { used: formatNumber(quota.used), limit: '—', unit }));
      } else if (isFiniteNumber(quota.limit)) {
        parts.push(t('quota.remaining', { value: formatNumber(quota.limit) + unit }));
      }
      return parts.join(' · ');
    }

    function quotaSourceLabel(source, t) {
      if (source === 'endpoint') return t('quota.source.endpoint');
      if (source === 'manual') return t('quota.source.manual');
      if (source === 'budget') return t('quota.source.budget');
      return String(source || '');
    }

    function ServiceCard({ service, t, lang, large }) {
      const quota = service.quota;
      const running = service.running;
      const probeError = service.probeError;
      const tone = running === true ? TONE.success : (running === false ? TONE.idle : TONE.warn);
      const statusText = running === true
        ? t('service.running')
        : (running === false ? t('service.stopped') : t('service.unknown'));
      const metrics = [];
      if (running === true) {
        if (isFiniteNumber(service.memoryMB)) metrics.push(t('service.memory', { value: Math.round(service.memoryMB) + ' MB' }));
        if (isFiniteNumber(service.cpuPercent)) metrics.push(t('service.cpu', { value: formatPercent(service.cpuPercent) }));
        if (isFiniteNumber(service.uptimeSeconds)) metrics.push(t('service.uptime', { value: formatDuration(service.uptimeSeconds, t) }));
        if (service.processCount > 1) metrics.push(t('service.processes', { n: service.processCount }));
      } else if (running === false) {
        if (service.checkedAt) metrics.push(t('status.updated', { time: formatClock(service.checkedAt) }));
      }
      const todayActiveSeconds = isFiniteNumber(service.todayActiveSeconds) && service.todayActiveSeconds > 0
        ? service.todayActiveSeconds
        : 0;
      const todayActiveText = todayActiveSeconds > 0 ? formatDuration(todayActiveSeconds, t) : '';
      const tokenUsage = service.tokenUsage;
      const tokenToday = tokenUsage && tokenUsage.today ? tokenUsage.today : null;
      const tokenAllTime = tokenUsage && tokenUsage.allTime ? tokenUsage.allTime : null;
      const tokenWindowDays = tokenUsage && tokenUsage.window && isFiniteNumber(tokenUsage.window.days) && tokenUsage.window.days > 0
        ? tokenUsage.window.days
        : 0;
      const tokenFallback = Boolean(tokenUsage && tokenUsage.ok === false && tokenUsage.fallback);
      const tokenStale = Boolean(tokenUsage && tokenUsage.ok === false && !tokenUsage.fallback && tokenToday);
      const tokenStatusText = tokenUsage && tokenUsage.ok === false
        ? (tokenFallback
            ? t('service.interfaceTokenFallback')
            : t(tokenStale ? 'service.interfaceTokenStale' : 'service.interfaceTokenError', { detail: tokenUsage.error || '—' }))
        : '';
      const quotaPercent = quota && isFiniteNumber(quota.percent) ? quota.percent : null;

      return h('div', {
        style: {
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: '10px',
          padding: large ? '12px 14px' : '9px 11px',
          background: 'var(--dsw-alias-bg-layer-1)',
          display: 'flex',
          flexDirection: 'column',
          gap: '7px',
          minWidth: 0,
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '7px' } },
        h('div', {
          style: {
            width: '22px',
            height: '22px',
            borderRadius: '6px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--dsw-alias-bg-layer-2)',
            color: 'var(--dsw-alias-brand-primary)',
            flex: '0 0 auto',
          },
        }, h(ChartIcon, { size: 13 })),
        h('div', { style: { flex: '1 1 auto', minWidth: 0, fontSize: large ? '13px' : '12.5px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, service.label),
        h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '10.5px', ...TEXT_SECONDARY, flex: '0 0 auto' } },
          h(Dot, { tone, size: 6 }),
          statusText
        )
      ),
      metrics.length
        ? h('div', { style: { fontSize: '10.5px', ...TEXT_SECONDARY, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, metrics.join(' · '))
        : null,
      todayActiveText
        ? h('div', {
            title: t('service.todayActive', { value: todayActiveText }),
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: '5px',
              fontSize: large ? '13px' : '12px',
              fontWeight: 500,
              color: 'var(--dsw-alias-label-primary)',
            },
          },
          h(ChartIcon, { size: 12 }),
          h('span', null, t('service.todayActive', { value: todayActiveText }))
          )
        : null,
      tokenToday
        ? h('div', {
            title: (tokenUsage.service ? tokenUsage.service + ' · ' : '') + tokenUsage.endpoint,
            style: { display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap', fontSize: '11px' },
          },
          h('span', { style: { ...TEXT_SECONDARY } }, t('service.interfaceToken')),
          h('span', { style: { fontWeight: 650 } }, formatTokens(tokenToday.totalTokens, lang)),
          h('span', { style: { ...TEXT_SECONDARY } }, t('dsh.todayTokens')),
          isFiniteNumber(tokenToday.requests)
            ? h('span', { style: { ...TEXT_SECONDARY } }, t('dsh.requests') + ' ' + formatNumber(tokenToday.requests))
            : null,
          isFiniteNumber(tokenToday.credit) && tokenToday.credit > 0
            ? h('span', { style: { ...TEXT_SECONDARY } }, t('service.credit', { value: formatNumber(tokenToday.credit) }))
            : null,
          tokenAllTime
            ? h('span', { style: { ...TEXT_SECONDARY, marginLeft: 'auto' } },
                tokenWindowDays
                  ? t('service.windowTotal', { days: tokenWindowDays, value: formatTokens(tokenAllTime.totalTokens, lang) })
                  : t('dsh.allTime', { value: formatTokens(tokenAllTime.totalTokens, lang) }))
            : null
          )
        : null,
      tokenStatusText
        ? h('div', {
            title: tokenUsage.error || '',
            style: {
              fontSize: '10px',
              color: tokenFallback ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-state-warn-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          }, tokenStatusText)
        : null,
      quota
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px' } },
            quotaPercent !== null
              ? h(Bar, {
                  percent: quotaPercent,
                  tone: quotaPercent >= 90 ? TONE.error : (quotaPercent >= 70 ? TONE.warn : TONE.brand),
                })
              : null,
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '10.5px' } },
              h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, quotaLine(quota, t, lang) || ''),
              h('span', { style: { ...TEXT_SECONDARY, flex: '0 0 auto' } }, quotaSourceLabel(quota.source, t))
            ),
            quota.resetAt
              ? h('div', { style: { fontSize: '10px', ...TEXT_SECONDARY } }, t('quota.reset', { time: quota.resetAt }))
              : null
          )
        : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
            h('div', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' } }, t('quota.none')),
            h('div', { style: { fontSize: '10px', color: 'var(--dsw-alias-label-secondary)', opacity: 0.8 } }, t('quota.noneHint'))
          ),
      service.quotaError
        ? h('div', {
            title: service.quotaError,
            style: { fontSize: '10px', color: 'var(--dsw-alias-state-error-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, t('quota.error', { detail: service.quotaError }))
        : null,
      probeError
        ? h('div', {
            title: probeError,
            style: { fontSize: '10px', color: 'var(--dsw-alias-state-warn-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, t('probe.error', { detail: probeError }))
        : null
      );
    }

    function DshCard({ dshtoken, t, lang, large, connected }) {
      const api = dshtoken && dshtoken.api ? dshtoken.api : null;
      // 引擎在接口掉线时会给出同源本机数据（data.source === 'local'），数字仍然要显示。
      const apiData = api && api.data ? api.data : null;
      const today = apiData && apiData.today ? apiData.today : (dshtoken && dshtoken.today ? dshtoken.today : null);
      const allTime = apiData && apiData.allTime ? apiData.allTime : (dshtoken && dshtoken.allTime ? dshtoken.allTime : null);
      const history = dshtoken && Array.isArray(dshtoken.history) ? dshtoken.history : [];
      const lastCall = apiData && apiData.lastCall ? apiData.lastCall : (dshtoken ? dshtoken.lastCall : null);
      const trackingSince = apiData && isFiniteNumber(apiData.trackingSince) && apiData.trackingSince > 0
        ? apiData.trackingSince
        : (dshtoken ? dshtoken.trackingSince : null);
      const dailyLimit = dshtoken && isFiniteNumber(dshtoken.dailyLimit) ? dshtoken.dailyLimit : 0;
      const quota = dshtoken ? dshtoken.quota : null;
      const todayTokens = today && isFiniteNumber(today.totalTokens) ? today.totalTokens : 0;
      const maxHistory = history.reduce((max, entry) => Math.max(max, isFiniteNumber(entry.totalTokens) ? entry.totalTokens : 0), 0);
      const scale = Math.max(1, maxHistory);
      const quotaTone = quota && isFiniteNumber(quota.percent) && quota.percent >= 90
        ? TONE.error
        : (quota && isFiniteNumber(quota.percent) && quota.percent >= 70 ? TONE.warn : TONE.brand);
      const apiActive = Boolean(api && api.ok && apiData);
      const sourceLabel = apiActive ? t('dsh.source.api') : t('dsh.source.local');
      const sourceTitle = apiActive
        ? ((apiData.service ? apiData.service + ' · ' : '') + (api.endpoint || ''))
        : (api && api.error ? t('dsh.apiFallback', { detail: api.error }) : sourceLabel);

      return h('div', {
        style: {
          border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: '10px',
          padding: large ? '12px 14px' : '9px 11px',
          background: 'var(--dsw-alias-bg-layer-1)',
          display: 'flex',
          flexDirection: 'column',
          gap: '7px',
          minWidth: 0,
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '7px' } },
        h('div', {
          style: {
            width: '22px',
            height: '22px',
            borderRadius: '6px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent)',
            color: 'var(--dsw-alias-brand-primary)',
            flex: '0 0 auto',
          },
        }, h(ChartIcon, { size: 13 })),
        h('div', { style: { flex: '1 1 auto', minWidth: 0, fontSize: large ? '13px' : '12.5px', fontWeight: 600 } }, t('dsh.title')),
        h('span', {
          title: sourceTitle,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            fontSize: '10px',
            padding: '1px 6px',
            borderRadius: '999px',
            color: apiActive ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)',
            border: '1px solid var(--dsw-alias-border-l1)',
            flex: '0 0 auto',
          },
        }, h(Dot, { tone: apiActive ? TONE.success : (api && !api.ok ? TONE.warn : TONE.idle), size: 5 }), sourceLabel)
      ),
      api && !api.ok
        ? h('div', {
            title: api.error || '',
            style: {
              fontSize: '10px',
              color: 'var(--dsw-alias-state-warn-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          }, t('dsh.apiFallback', { detail: api.error || '—' }))
        : null,
      h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '6px', flexWrap: 'wrap' } },
        h('span', { style: { fontSize: large ? '24px' : '20px', fontWeight: 650, lineHeight: '1.1', letterSpacing: '-0.01em' } }, formatTokens(todayTokens, lang)),
        h('span', { style: { fontSize: '10.5px', ...TEXT_SECONDARY } }, t('unit.token') + ' · ' + t('dsh.todayTokens')),
        allTime
          ? h('span', { style: { fontSize: '10px', ...TEXT_SECONDARY, marginLeft: 'auto' } }, t('dsh.allTime', { value: formatTokens(allTime.totalTokens, lang) }))
          : null
      ),
      today
        ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px', fontSize: '10.5px', ...TEXT_SECONDARY } },
            h('span', null, t('dsh.input') + ' ' + formatTokens(today.inputTokens, lang)),
            today.cacheReadTokens > 0
              ? h('span', null, t('dsh.cacheRead') + ' ' + formatTokens(today.cacheReadTokens, lang))
              : null,
            h('span', null, t('dsh.output') + ' ' + formatTokens(today.outputTokens, lang)),
            h('span', null, t('dsh.requests') + ' ' + formatNumber(today.requests))
          )
        : null,
      quota && isFiniteNumber(quota.percent)
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
            h(Bar, { percent: quota.percent, tone: quotaTone }),
            h('div', { style: { fontSize: '10px', ...TEXT_SECONDARY } }, t('dsh.budget', { limit: formatTokens(quota.limit, lang) })),
          )
        : null,
      history.length >= 2
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
            h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: '3px', height: '24px' } },
              history.map((entry) => {
                const ratio = clamp((isFiniteNumber(entry.totalTokens) ? entry.totalTokens : 0) / scale, 0.04, 1);
                const todayKey = history.length ? history[history.length - 1].date : '';
                return h('div', {
                  key: entry.date,
                  title: entry.date + ' · ' + formatTokens(entry.totalTokens, lang) + ' ' + t('unit.token'),
                  style: {
                    flex: '1 1 0',
                    height: Math.round(ratio * 100) + '%',
                    minHeight: '2px',
                    borderRadius: '2px',
                    background: 'var(--dsw-alias-brand-primary)',
                    opacity: entry.date === todayKey ? 0.95 : 0.32,
                  },
                });
              })
            ),
            h('div', { style: { fontSize: '9.5px', ...TEXT_SECONDARY } }, t('dsh.history'))
          )
        : null,
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '10px', ...TEXT_SECONDARY, flexWrap: 'wrap' } },
        lastCall
          ? h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 } },
              t('dsh.lastCall', {
                model: lastCall.model || lastCall.provider || 'model',
                time: relTime(lastCall.at, t),
              }))
          : h('span', null, t('dsh.noCall')),
        trackingSince
          ? h('span', { style: { marginLeft: 'auto', flex: '0 0 auto' } }, t('dsh.since', { time: formatShortDateTime(trackingSince) }))
          : null
      )
      );
    }

    /* ------------------------------------------------------------------ */
    /* Settings form                                                       */
    /* ------------------------------------------------------------------ */

    function buildInitialForm(config) {
      const services = {};
      const configServices = config && config.services && typeof config.services === 'object' ? config.services : {};
      for (const id of Object.keys(configServices)) {
        const service = configServices[id] || {};
        const quota = service.quota || {};
        const manual = quota.manual || {};
        services[id] = {
          endpoint: typeof quota.endpoint === 'string' ? quota.endpoint : '',
          tokenEndpoint: typeof service.tokenEndpoint === 'string' ? service.tokenEndpoint : '',
          token: '',
          hasToken: quota.hasToken === true,
          used: isFiniteNumber(manual.used) ? String(manual.used) : '',
          limit: isFiniteNumber(manual.limit) ? String(manual.limit) : '',
          unit: typeof manual.unit === 'string' ? manual.unit : '',
        };
      }
      return {
        refreshSeconds: config && isFiniteNumber(config.refreshSeconds) ? String(config.refreshSeconds) : '30',
        dailyLimit: config && config.dshtoken && isFiniteNumber(config.dshtoken.dailyLimit) ? String(config.dshtoken.dailyLimit) : '0',
        apiEndpoint: config && config.dshtoken && typeof config.dshtoken.apiEndpoint === 'string' ? config.dshtoken.apiEndpoint : '',
        tokenServiceAutoStart: !(config && config.tokenService && config.tokenService.autoStart === false),
        tokenServiceScript: config && config.tokenService && typeof config.tokenService.startScript === 'string'
          ? config.tokenService.startScript
          : '',
        services,
      };
    }

    function SettingsForm({ state, t, onDone }) {
      const [form, setForm] = React.useState(() => buildInitialForm(state ? state.config : null));
      const [status, setStatus] = React.useState('');
      const [busy, setBusy] = React.useState(false);

      React.useEffect(() => {
        setForm(buildInitialForm(state ? state.config : null));
      }, [state && state.config ? JSON.stringify(state.config) : '']);

      function updateService(id, key, value) {
        setForm((current) => ({
          ...current,
          services: {
            ...current.services,
            [id]: { ...(current.services[id] || {}), [key]: value },
          },
        }));
      }

      function toNumberOrNull(text) {
        if (typeof text !== 'string' || text.trim() === '') return null;
        const parsed = Number(text);
        return Number.isFinite(parsed) ? parsed : null;
      }

      async function submit() {
        if (busy) return;
        setBusy(true);
        setStatus(t('settings.saving'));
        const patchServices = {};
        for (const id of Object.keys(form.services)) {
          const entry = form.services[id];
          const manual = {
            used: toNumberOrNull(entry.used),
            limit: toNumberOrNull(entry.limit),
            unit: typeof entry.unit === 'string' ? entry.unit.trim() : '',
          };
          const quota = {
            endpoint: typeof entry.endpoint === 'string' ? entry.endpoint.trim() : '',
            manual,
          };
          if (typeof entry.token === 'string' && entry.token.trim() !== '') quota.token = entry.token.trim();
          patchServices[id] = {
            quota,
            tokenEndpoint: typeof entry.tokenEndpoint === 'string' ? entry.tokenEndpoint.trim() : '',
          };
        }
        const patch = {
          refreshSeconds: toNumberOrNull(form.refreshSeconds),
          dshtoken: {
            dailyLimit: toNumberOrNull(form.dailyLimit) || 0,
            apiEndpoint: typeof form.apiEndpoint === 'string' ? form.apiEndpoint.trim() : '',
          },
          tokenService: {
            autoStart: Boolean(form.tokenServiceAutoStart),
            startScript: typeof form.tokenServiceScript === 'string' ? form.tokenServiceScript.trim() : '',
          },
          services: patchServices,
        };
        try {
          await saveConfig(patch);
          setStatus(t('settings.saved'));
          if (typeof onDone === 'function') onDone();
        } catch (error) {
          setStatus(t('settings.failed', { detail: error && error.message ? error.message : String(error) }));
        } finally {
          setBusy(false);
        }
      }

      const serviceIds = Object.keys(form.services);

      return h('div', {
        style: {
          border: '1px solid var(--dsw-alias-border-l1)',
          borderRadius: '10px',
          padding: '10px 11px',
          background: 'var(--dsw-alias-bg-layer-1)',
          display: 'flex',
          flexDirection: 'column',
          gap: '9px',
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px' } },
        h('div', { style: { fontSize: '12px', fontWeight: 600 } }, t('settings.title')),
        h('div', { style: { fontSize: '9.5px', ...TEXT_SECONDARY, flex: '1 1 auto', minWidth: 0 } }, t('settings.hint'))
      ),
      form.services && serviceIds.length
        ? serviceIds.map((id) => h('div', { key: id, style: { display: 'flex', flexDirection: 'column', gap: '5px', borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: '8px' } },
            h('div', { style: { fontSize: '11px', fontWeight: 600 } }, id),
            h(Field, {
              label: t('settings.endpoint'),
              value: form.services[id].endpoint,
              placeholder: t('settings.placeholderEndpoint'),
              onChange: (value) => updateService(id, 'endpoint', value),
            }),
            h(Field, {
              label: t('settings.tokenEndpoint'),
              value: form.services[id].tokenEndpoint,
              placeholder: t('settings.placeholderApi'),
              onChange: (value) => updateService(id, 'tokenEndpoint', value),
            }),
            h(Field, {
              label: form.services[id].hasToken ? t('settings.token') + ' · ' + t('settings.tokenSaved') : t('settings.token'),
              value: form.services[id].token,
              placeholder: '••••••',
              onChange: (value) => updateService(id, 'token', value),
            }),
            h('div', { style: { display: 'flex', gap: '6px' } },
              h(Field, { label: t('settings.used'), value: form.services[id].used, type: 'number', onChange: (value) => updateService(id, 'used', value) }),
              h(Field, { label: t('settings.limit'), value: form.services[id].limit, type: 'number', onChange: (value) => updateService(id, 'limit', value) }),
              h(Field, { label: t('settings.unit'), value: form.services[id].unit, placeholder: t('settings.placeholderUnit'), onChange: (value) => updateService(id, 'unit', value), width: '72px' })
            )
          ))
        : null,
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px', borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: '8px' } },
        h('div', { style: { display: 'flex', gap: '6px' } },
          h(Field, { label: t('settings.dailyLimit'), value: form.dailyLimit, type: 'number', onChange: (value) => setForm((current) => ({ ...current, dailyLimit: value })) }),
          h(Field, { label: t('settings.refresh'), value: form.refreshSeconds, type: 'number', onChange: (value) => setForm((current) => ({ ...current, refreshSeconds: value })) })
        ),
        h(Field, {
          label: t('settings.apiEndpoint'),
          value: form.apiEndpoint,
          placeholder: t('settings.placeholderApi'),
          onChange: (value) => setForm((current) => ({ ...current, apiEndpoint: value })),
        }),
        h('label', {
          title: form.tokenServiceScript || '',
          style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '10.5px', ...TEXT_SECONDARY, cursor: 'pointer' },
        },
          h('input', {
            type: 'checkbox',
            checked: form.tokenServiceAutoStart,
            onChange: (event) => setForm((current) => ({ ...current, tokenServiceAutoStart: Boolean(event.target.checked) })),
          }),
          t('settings.tokenServiceAutoStart')
        )
      ),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
        h('button', {
          type: 'button',
          disabled: busy,
          onClick: submit,
          style: {
            padding: '5px 12px',
            borderRadius: '6px',
            border: 'none',
            background: busy ? 'var(--dsw-alias-state-idle-primary)' : 'var(--dsw-alias-brand-primary)',
            color: '#fff',
            fontSize: '11.5px',
            fontWeight: 500,
            cursor: busy ? 'default' : 'pointer',
          },
        }, busy ? t('settings.saving') : t('settings.save')),
        status ? h('span', { style: { fontSize: '10px', ...TEXT_SECONDARY, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' } }, status) : null
      )
      );
    }

    /* ------------------------------------------------------------------ */
    /* Floating window                                                     */
    /* ------------------------------------------------------------------ */

    function OnlineBanner({ data, t }) {
      if (!data.error) return null;
      if (data.state) {
        return h('div', {
          style: {
            fontSize: '10px',
            padding: '3px 7px',
            borderRadius: '6px',
            color: 'var(--dsw-alias-state-warn-primary)',
            background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent)',
          },
        }, t('panel.stale'));
      }
      return h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: '3px',
          padding: '8px 9px',
          borderRadius: '8px',
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-layer-1)',
        },
      },
      h('div', { style: { fontSize: '11.5px', fontWeight: 600, color: 'var(--dsw-alias-state-error-primary)' } }, t('panel.offlineTitle')),
      h('div', { style: { fontSize: '10px', ...TEXT_SECONDARY } }, t('panel.offlineHint'))
      );
    }

    function FloatingWindow({ t }) {
      const [ui, patchUi] = useUiState();
      const data = useUsageData();
      const [showSettings, setShowSettings] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [dragging, setDragging] = React.useState(false);
      const [localPos, setLocalPos] = React.useState(null);
      const frameRef = React.useRef(null);
      const dragRef = React.useRef(null);
      const lastPosRef = React.useRef(null);

      const initialPos = React.useMemo(() => {
        const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1280;
        const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 800;
        if (isFiniteNumber(ui.x) && isFiniteNumber(ui.y)) {
          return {
            x: clamp(ui.x, 8, Math.max(8, viewportWidth - WINDOW_WIDTH - 8)),
            y: clamp(ui.y, 8, Math.max(8, viewportHeight - 64)),
          };
        }
        return {
          x: Math.max(8, viewportWidth - WINDOW_WIDTH - 24),
          y: Math.max(72, Math.round(viewportHeight * 0.16)),
        };
      }, [ui.x, ui.y]);

      const pos = localPos || initialPos;
      lastPosRef.current = pos;

      /**
       * 把窗口完整限制在应用视口内（四边至少留 8px）：
       * 拖动、窗口 resize、内容变高（展开设置 / 数据变长）时都会重新夹紧，
       * 不允许把窗口拖到只剩一条边、或让下半截跑出窗口外。
       */
      function fitIntoViewport() {
        if (dragging) return;
        const node = frameRef.current;
        if (!node || typeof window === 'undefined') return;
        const rect = node.getBoundingClientRect();
        const width = rect.width || WINDOW_WIDTH;
        const height = rect.height || 0;
        const next = {
          x: clamp(rect.left, 8, Math.max(8, window.innerWidth - width - 8)),
          y: clamp(rect.top, 8, Math.max(8, window.innerHeight - height - 8)),
        };
        if (Math.abs(next.x - rect.left) < 1 && Math.abs(next.y - rect.top) < 1) return;
        lastPosRef.current = next;
        setLocalPos(next);
        patchUiState({ x: next.x, y: next.y });
      }

      React.useEffect(() => {
        fitIntoViewport();
        const onResize = () => fitIntoViewport();
        window.addEventListener('resize', onResize);
        let observer = null;
        if (typeof ResizeObserver !== 'undefined' && frameRef.current) {
          observer = new ResizeObserver(() => fitIntoViewport());
          observer.observe(frameRef.current);
        }
        return () => {
          window.removeEventListener('resize', onResize);
          if (observer) observer.disconnect();
        };
      }, [ui.collapsed, showSettings, ui.pinned]);

      function onHeaderPointerDown(event) {
        if (event.button !== 0) return;
        const target = event.target;
        if (target && typeof target.closest === 'function' && target.closest('[data-uw-nodrag]')) return;
        const node = frameRef.current;
        const rect = node ? node.getBoundingClientRect() : { left: pos.x, top: pos.y };
        dragRef.current = {
          startX: event.clientX,
          startY: event.clientY,
          left: rect.left,
          top: rect.top,
        };
        setDragging(true);
        try {
          if (event.currentTarget && typeof event.currentTarget.setPointerCapture === 'function') {
            event.currentTarget.setPointerCapture(event.pointerId);
          }
        } catch (error) {
          /* ignore */
        }
        const move = (moveEvent) => {
          const drag = dragRef.current;
          if (!drag) return;
          const node = frameRef.current;
          const rect = node ? node.getBoundingClientRect() : null;
          const width = (rect && rect.width) || WINDOW_WIDTH;
          const height = (rect && rect.height) || 0;
          const next = {
            x: clamp(drag.left + (moveEvent.clientX - drag.startX), 8, Math.max(8, window.innerWidth - width - 8)),
            y: clamp(drag.top + (moveEvent.clientY - drag.startY), 8, Math.max(8, window.innerHeight - height - 8)),
          };
          lastPosRef.current = next;
          setLocalPos(next);
        };
        const finish = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', finish);
          window.removeEventListener('pointercancel', finish);
          dragRef.current = null;
          setDragging(false);
          const finalPos = lastPosRef.current;
          if (finalPos) patchUiState({ x: finalPos.x, y: finalPos.y });
          setLocalPos(null);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', finish);
        window.addEventListener('pointercancel', finish);
      }

      async function onRefresh() {
        if (busy) return;
        setBusy(true);
        try {
          await triggerRefresh();
        } finally {
          setBusy(false);
        }
      }

      const state = data.state;
      const dsh = state ? state.dshtoken : null;
      const services = state && Array.isArray(state.services) ? state.services : [];
      const connected = Boolean(state) && !data.error;
      const lang = currentLang();

      const frameStyle = {
        position: 'fixed',
        left: Math.round(pos.x) + 'px',
        top: Math.round(pos.y) + 'px',
        width: 'min(' + WINDOW_WIDTH + 'px, calc(100vw - 16px))',
        zIndex: ui.pinned ? 2147483000 : 2147482000,
        display: 'flex',
        flexDirection: 'column',
        maxHeight: 'min(76vh, 620px)',
        background: 'var(--dsw-alias-bg-overlay)',
        color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: '12px',
        boxShadow: ui.pinned ? '0 20px 60px rgba(0,0,0,0.34)' : '0 12px 36px rgba(0,0,0,0.24)',
        pointerEvents: 'auto',
        fontFamily: 'inherit',
        fontSize: '12px',
        lineHeight: '1.45',
        overflow: 'hidden',
        userSelect: dragging ? 'none' : 'auto',
      };

      return h('div', { ref: frameRef, style: frameStyle, 'data-usage-watch-window': '1' },
        h('header', {
          onPointerDown: onHeaderPointerDown,
          onDoubleClick: () => {
            patchUiState({ x: null, y: null });
            setLocalPos(null);
          },
          title: t('button.resetPosition'),
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '7px',
            padding: '8px 9px 8px 11px',
            background: 'var(--dsw-alias-bg-layer-1)',
            borderBottom: '1px solid var(--dsw-alias-border-l1)',
            cursor: dragging ? 'grabbing' : 'grab',
            touchAction: 'none',
            flex: '0 0 auto',
          },
        },
        h(Dot, { tone: connected ? TONE.success : (state ? TONE.warn : TONE.error), size: 7 }),
        h('div', { style: { flex: '1 1 auto', minWidth: 0 } },
          h('div', { style: { fontSize: '12.5px', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, t('panel.title')),
          h('div', { style: { fontSize: '10px', ...TEXT_SECONDARY, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, t('panel.subtitle'))
        ),
        h(IconButton, {
          title: ui.pinned ? t('button.unpin') : t('button.pin'),
          active: ui.pinned,
          onClick: () => patchUiState({ pinned: !ui.pinned }),
        }, h(PinIcon, { size: 14 })),
        h(IconButton, {
          title: ui.collapsed ? t('button.expand') : t('button.collapse'),
          onClick: () => patchUiState({ collapsed: !ui.collapsed }),
        }, h(ChevronIcon, { size: 14, up: Boolean(ui.collapsed) })),
        h(IconButton, {
          title: t('button.close'),
          danger: true,
          onClick: () => patchUiState({ open: false }),
        }, h(CloseIcon, { size: 14 }))
        ),
        ui.collapsed
          ? null
          : h('div', {
              style: {
                padding: '9px 10px 6px',
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: '7px',
                flex: '1 1 auto',
                minHeight: 0,
              },
            },
            h(OnlineBanner, { data, t }),
            h(DshCard, { dshtoken: dsh, t, lang, connected }),
            services.map((service) => h(ServiceCard, { key: service.id, service, t, lang })),
            showSettings ? h(SettingsForm, { state, t, onDone: () => setShowSettings(false) }) : null
            ),
        ui.collapsed
          ? null
          : h('footer', {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                padding: '5px 9px 7px',
                borderTop: '1px solid var(--dsw-alias-border-l1)',
                fontSize: '10px',
                ...TEXT_SECONDARY,
                flex: '0 0 auto',
              },
            },
            h('span', {
              style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              title: data.error || '',
            }, data.error ? t('panel.stale') : t('status.updated', { time: formatClock(data.updatedAt) })),
            h(IconButton, { title: t('button.refresh'), onClick: onRefresh }, h(RefreshIcon, { size: 13 })),
            h(IconButton, {
              title: showSettings ? t('button.settingsClose') : t('button.settings'),
              active: showSettings,
              onClick: () => setShowSettings((value) => !value),
            }, h(GearIcon, { size: 13 }))
            )
      );
    }

    /* ------------------------------------------------------------------ */
    /* Sidebar entries                                                     */
    /* ------------------------------------------------------------------ */

    function SidebarFooterEntry({ wide, t }) {
      const [ui, patchUi] = useUiState();
      const [hover, setHover] = React.useState(false);
      const active = ui.open === true;
      return h('button', {
        type: 'button',
        title: active ? t('button.windowOpen') : t('button.openWindow'),
        'aria-label': t('panel.title'),
        'aria-pressed': active,
        onClick: () => patchUiState({ open: !ui.open }),
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: wide ? 'flex-start' : 'center',
          gap: '8px',
          width: wide ? '100%' : '32px',
          height: '32px',
          padding: wide ? '0 8px' : '0',
          borderRadius: '8px',
          border: 'none',
          cursor: 'pointer',
          background: active
            ? 'color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent)'
            : (hover ? 'var(--dsw-alias-bg-layer-2)' : 'transparent'),
          color: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
          fontFamily: 'inherit',
          flex: '0 0 auto',
        },
      },
      h(ChartIcon, { size: 16 }),
      wide
        ? h('span', {
            style: {
              fontSize: '12px',
              color: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-primary)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              flex: '1 1 auto',
              textAlign: 'left',
            },
          }, t('panel.title'))
        : null
      );
    }

    function SidebarPanelIcon({ size, active, t }) {
      const dimension = isFiniteNumber(size) && size > 0 ? size : 18;
      return h('span', {
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: dimension + 'px',
          height: dimension + 'px',
          color: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
        },
      }, h(ChartIcon, { size: dimension }));
    }

    /* ------------------------------------------------------------------ */
    /* Full dashboard page (main panel)                                    */
    /* ------------------------------------------------------------------ */

    function DashboardPage({ t }) {
      const [ui, patchUi] = useUiState();
      const data = useUsageData();
      const [showSettings, setShowSettings] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const state = data.state;
      const lang = currentLang();
      const dsh = state ? state.dshtoken : null;
      const services = state && Array.isArray(state.services) ? state.services : [];
      const connected = Boolean(state) && !data.error;

      async function onRefresh() {
        if (busy) return;
        setBusy(true);
        try {
          await triggerRefresh();
        } finally {
          setBusy(false);
        }
      }

      return h('div', {
        style: {
          height: '100%',
          overflowY: 'auto',
          boxSizing: 'border-box',
          padding: '28px 32px 40px',
          background: 'var(--dsw-alias-bg-base)',
          color: 'var(--dsw-alias-label-primary)',
        },
      },
      h('div', { style: { maxWidth: '920px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '18px' } },
        h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' } },
          h('div', { style: { flex: '1 1 240px', minWidth: 0 } },
            h('h1', { style: { margin: 0, fontSize: '20px', fontWeight: 650, letterSpacing: '-0.01em', display: 'flex', alignItems: 'center', gap: '10px' } },
              t('page.title'),
              h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '10.5px', fontWeight: 400, ...TEXT_SECONDARY } },
                h(Dot, { tone: connected ? TONE.success : (state ? TONE.warn : TONE.error), size: 6 }),
                connected ? t('status.live') : (state ? t('panel.stale') : t('status.connecting'))
              )
            ),
            h('p', { style: { margin: '5px 0 0', fontSize: '12px', ...TEXT_SECONDARY } }, t('page.subtitle'))
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' } },
            h(TextButton, { primary: true, title: ui.open ? t('button.windowOpen') : t('button.openWindow'), onClick: () => patchUiState({ open: !ui.open }) },
              h(ChartIcon, { size: 13 }),
              ui.open ? t('button.windowOpen') : t('button.openWindow')
            ),
            h(TextButton, { title: t('button.refresh'), onClick: onRefresh }, h(RefreshIcon, { size: 13 }), busy ? t('button.refreshing') : t('button.refresh')),
            h(TextButton, { title: showSettings ? t('button.settingsClose') : t('button.settings'), onClick: () => setShowSettings((value) => !value) },
              h(GearIcon, { size: 13 }),
              showSettings ? t('button.settingsClose') : t('button.settings')
            )
          )
        ),
        data.error
          ? h('div', {
              style: {
                padding: '8px 12px',
                borderRadius: '8px',
                fontSize: '11.5px',
                color: 'var(--dsw-alias-state-error-primary)',
                background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 9%, transparent)',
              },
            }, data.error)
          : null,
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '12px' } },
          h(DshCard, { dshtoken: dsh, t, lang, large: true, connected }),
          services.map((service) => h(ServiceCard, { key: service.id, service, t, lang, large: true }))
        ),
        showSettings ? h(SettingsForm, { state, t, onDone: () => setShowSettings(false) }) : null,
        h('div', { style: { fontSize: '10.5px', ...TEXT_SECONDARY, lineHeight: '1.6', maxWidth: '720px' } }, t('page.note')),
        h('div', { style: { fontSize: '10px', ...TEXT_SECONDARY } },
          t('status.updated', { time: formatClock(data.updatedAt) })
        )
      )
      );
    }

    /* ------------------------------------------------------------------ */
    /* Plugin body                                                         */
    /* ------------------------------------------------------------------ */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        let boundLocale = null;

        try {
          const locale = ctx && ctx.locale;
          if (locale && typeof locale.register === 'function') {
            const disposers = [];
            const attempts = [
              () => locale.register(NS, { zh: ZH, en: EN }),
              () => locale.register(NS, { 'zh-CN': ZH, 'en-US': EN }),
            ];
            for (const attempt of attempts) {
              try {
                const dispose = attempt();
                if (typeof dispose === 'function') disposers.push(dispose);
              } catch (error) {
                try {
                  console.warn('[usage-watch] locale registration failed', error);
                } catch (inner) {
                  /* ignore */
                }
              }
            }
            if (typeof ctx.effect === 'function') {
              ctx.effect(() => () => {
                for (const dispose of disposers) {
                  try {
                    dispose();
                  } catch (error) {
                    /* ignore */
                  }
                }
              });
            }
            if (typeof locale.bind === 'function') {
              try {
                boundLocale = locale.bind(NS);
              } catch (error) {
                boundLocale = null;
              }
            }
          }
        } catch (error) {
          try {
            console.error('[usage-watch] locale setup failed', error);
          } catch (inner) {
            /* ignore */
          }
          boundLocale = null;
        }

        const t = makeT(boundLocale);

        const OverlayView = guarded(function UsageWatchOverlay() {
          const [ui] = useUiState();
          if (!ui.open) return null;
          return h(FloatingWindow, { t });
        });

        const FooterActionView = guarded(function UsageWatchFooterAction(props) {
          return h(SidebarFooterEntry, { wide: Boolean(props && props.wide), t });
        });

        const PanelIconView = guarded(function UsageWatchPanelIcon(props) {
          return h(SidebarPanelIcon, { size: props && props.size, active: Boolean(props && props.active), t });
        });

        const PageView = guarded(function UsageWatchPage() {
          return h(DashboardPage, { t });
        });

        function register(slotName, options, Component) {
          try {
            if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function' || typeof ctx.slots.register !== 'function') return false;
            ctx.slots.inject(slotName, () => ctx.slots.register({ name: slotName, ...options }, Component));
            return true;
          } catch (error) {
            try {
              console.error('[usage-watch] slot registration failed: ' + slotName, error);
            } catch (inner) {
              /* ignore */
            }
            return false;
          }
        }

        // 左侧栏图标入口 + 对应的 main 面板（完整看板）
        const pageRegistered = register('main', { key: 'usage-watch' }, PageView);
        if (pageRegistered) {
          register('sidebar.panellist', { id: 'usage-watch', order: 20, label: () => t('panel.title') }, PanelIconView);
        }

        // 左侧栏底部快捷开关（不改动主面板）
        register('sidebar.footer.action', { id: 'usage-watch', order: 10, label: () => t('panel.title') }, FooterActionView);

        // 悬浮窗：可拖动、可置顶
        register('shell.overlay', { id: 'usage-watch', order: 60 }, OverlayView);
      },
    };
  },
});
