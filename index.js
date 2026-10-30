/**
 * Usage Watch（用量监控）— Host 半入口。
 *
 *  - 监听 `llm/stream` waterfall，在每次模型调用结束时结算真实 TokenUsage
 *  - 定时探测豆包 / WorkBuddy 进程（Get-Process），拉取用户配置的额度接口
 *  - 通过 `ctx.connection.fetch.register` 暴露 /api/usage-watch/* 路由
 *  - 定时器、监听、路由、落盘全部挂在 ctx.effect 上，卸载时自动清理
 */

import { spawn } from 'node:child_process'

import { createEngine } from './lib/engine.js'
import { buildRoutes } from './lib/routes.js'

export const name = 'usage-watch'

/** connection 是硬依赖（fetch 路由注册 + 浏览器鉴权）。 */
export const inject = ['connection']

function errorMessage(error) {
  if (!error) return 'unknown error'
  if (typeof error === 'string') return error
  if (error.message) return String(error.message)
  return String(error)
}

function createLogger(ctx) {
  let base = null
  try {
    base = typeof ctx.logger === 'function' ? ctx.logger('usage-watch') : ctx.logger
  } catch {
    base = null
  }
  const write = (level, args) => {
    try {
      const target = base && typeof base[level] === 'function' ? base[level] : null
      if (target) target.apply(base, args)
    } catch {
      /* 日志失败不影响业务 */
    }
  }
  return {
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    debug: (...args) => write('debug', args),
  }
}

/**
 * 包一层 llm/stream：把 chunk 原样往下传，只在一路流结束时把「最后一次 usage」
 * 记到引擎里。一个调用里可能多次出现 usage chunk（重试/分段），只结算一次，
 * 避免重复累加。
 */
export function wrapStream(options, next, engine) {
  return (async function* streamWithUsage() {
    let lastUsage = null
    try {
      const upstream = await next()
      for await (const chunk of upstream) {
        if (chunk && chunk.type === 'usage' && chunk.usage) lastUsage = chunk.usage
        yield chunk
      }
    } finally {
      if (lastUsage) engine.recordUsage(options, lastUsage)
    }
  })()
}

/**
 * Cordis Host 插件入口。
 * @param {import('cordis').Context} ctx
 * @param {object} [config] 插件配置（cordis.patch.yml 中的 config）
 */
export function apply(ctx, config) {
  const logger = createLogger(ctx)

  let engine
  try {
    // spawnProcess 让引擎在本地 token 接口掉线时能自己拉起 start-api.ps1。
    engine = createEngine({ config, logger, spawnProcess: spawn })
  } catch (error) {
    logger.warn(`usage-watch: 初始化引擎失败: ${errorMessage(error)}`)
    return
  }

  // 1) Token 用量来源：llm/stream waterfall。事件不存在时 ctx.on 也安全。
  ctx.effect(() => {
    let dispose = null
    try {
      dispose = ctx.on('llm/stream', (options, next) => wrapStream(options, next, engine))
    } catch (error) {
      logger.warn(`usage-watch: 监听 llm/stream 失败: ${errorMessage(error)}`)
    }
    return () => {
      if (typeof dispose === 'function') {
        try {
          dispose()
        } catch (error) {
          logger.debug(`usage-watch: 注销 llm/stream 失败: ${errorMessage(error)}`)
        }
      }
    }
  })

  // 2) 启动/停止进程探测、额度刷新、自动落盘的定时器
  ctx.effect(() => {
    try {
      engine.start()
    } catch (error) {
      logger.warn(`usage-watch: 启动引擎失败: ${errorMessage(error)}`)
    }
    return () => {
      try {
        engine.stop()
      } catch (error) {
        logger.debug(`usage-watch: 停止引擎失败: ${errorMessage(error)}`)
      }
    }
  })

  // 3) HTTP 路由
  ctx.effect(() => {
    const disposers = []
    let definitions = []
    try {
      definitions = buildRoutes(engine)
    } catch (error) {
      logger.warn(`usage-watch: 构建路由失败: ${errorMessage(error)}`)
    }
    for (const definition of definitions) {
      try {
        const dispose = ctx.connection.fetch.register(definition)
        if (typeof dispose === 'function') disposers.push(dispose)
      } catch (error) {
        logger.warn(`usage-watch: 注册路由失败 ${definition.path}: ${errorMessage(error)}`)
      }
    }
    return () => {
      for (const dispose of disposers.splice(0)) {
        try {
          const result = dispose()
          if (result && typeof result.catch === 'function') result.catch(() => {})
        } catch (error) {
          logger.debug(`usage-watch: 注销路由失败: ${errorMessage(error)}`)
        }
      }
    }
  })

  // 4) 卸载时把内存里的用量 flush 到 state.json
  ctx.effect(() => () => {
    try {
      engine.dispose()
    } catch (error) {
      logger.debug(`usage-watch: 释放引擎失败: ${errorMessage(error)}`)
    }
  })
}
