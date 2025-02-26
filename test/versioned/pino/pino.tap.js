/*
 * Copyright 2021 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

const tap = require('tap')
const { sink, once } = require('pino/test/helper')
const { truncate } = require('../../../lib/util/application-logging')
const helper = require('../../lib/agent_helper')
const { LOGGING } = require('../../../lib/metrics/names')

/**
 * Helper to format n log lines and add `\n`
 * to each line
 * This is because `asJson` appends \n to every log line
 * See: https://github.com/pinojs/pino/blob/master/lib/tools.js#L175
 */
function stringifyLines(logs) {
  logs = Array.isArray(logs) ? logs : [logs]
  return logs.map((log) => `${JSON.stringify(log)}\n`)
}

tap.Test.prototype.addAssert(
  'validateAnnotations',
  2,
  function assertCoreAnnotations({ line: logLine, message, level, config }) {
    this.equal(
      logLine['entity.name'],
      config.applications()[0],
      'should have entity name that matches app'
    )
    this.equal(logLine['entity.guid'], 'pino-guid', 'should have set entity guid')
    this.equal(logLine['entity.type'], 'SERVICE', 'should have entity type of SERVICE')
    this.equal(logLine.hostname, config.getHostnameSafe(), 'should have proper hostname')
    this.match(logLine.timestamp, /[\d]{10}/, 'should have proper unix timestamp')
    this.notOk(logLine.message.includes('NR-LINKING'), 'should not contain NR-LINKING metadata')
    if (message) {
      this.equal(logLine.message, message, 'message should be the same as log')
    }

    if (level) {
      this.equal(logLine.level, level, 'level should be string value not number')
    }
  }
)

// NOTE: pino adds hostname to log lines which is why we don't check it here
const contextKeys = ['entity.name', 'entity.type', 'entity.guid', 'trace.id', 'span.id']

tap.test('Pino instrumentation', (t) => {
  t.autoend()
  let logger
  let stream
  let pino
  let agent

  function setupAgent(config) {
    agent = helper.instrumentMockedAgent(config)
    agent.config.entity_guid = 'pino-guid'
    pino = require('pino')
    stream = sink()
    logger = pino({ level: 'debug' }, stream)
    return agent.config
  }

  t.afterEach(() => {
    helper.unloadAgent(agent)
    Object.keys(require.cache).forEach((key) => {
      if (/pino/.test(key)) {
        delete require.cache[key]
      }
    })
  })

  t.test('logging disabled', async (t) => {
    setupAgent({ application_logging: { enabled: false } })
    const disabledLogger = pino({ level: 'info' }, stream)
    const message = 'logs are not enriched'
    disabledLogger.info(message)
    const line = await once(stream, 'data')
    t.equal(line.msg, message, 'msg should not change')
    t.equal(line.level, 30, 'level should not change')
    // pino by default includes hostname
    t.equal(line.hostname, agent.config.getHostnameSafe(), 'hostname should not change')
    // if application logging is enabled it renames this to `timestamp`
    t.ok(line.time, 'time should not change')
    contextKeys.forEach((key) => {
      t.notOk(line[key], `should not have ${key}`)
    })
    const metric = agent.metrics.getMetric(LOGGING.LIBS.PINO)
    t.notOk(metric, `should not create ${LOGGING.LIBS.PINO} metric when logging is disabled`)
    t.end()
  })

  t.test('logging enabled', (t) => {
    setupAgent({ application_logging: { enabled: true } })
    const metric = agent.metrics.getMetric(LOGGING.LIBS.PINO)
    t.equal(metric.callCount, 1, `should create ${LOGGING.LIBS.PINO} metric`)
    t.end()
  })

  t.test('local_decorating', (t) => {
    setupAgent({
      application_logging: {
        enabled: true,
        local_decorating: { enabled: true },
        forwarding: { enabled: false },
        metrics: { enabled: false }
      }
    })
    const message = 'pino decorating test'
    helper.runInTransaction(agent, 'pino-test', async () => {
      logger.info(message)
      const line = await once(stream, 'data')
      t.ok(line.message.includes('NR-LINKING'), 'should contain NR-LINKING metadata')
      contextKeys.forEach((key) => {
        t.notOk(line[key], `should not have ${key}`)
      })
      t.end()
    })
  })

  t.test('forwarding', (t) => {
    let config
    t.autoend()
    t.beforeEach(() => {
      config = setupAgent({
        application_logging: {
          enabled: true,
          local_decorating: { enabled: false },
          forwarding: { enabled: true },
          metrics: { enabled: false }
        }
      })
    })

    t.test('should have proper metadata outside of a transaction', async (t) => {
      const message = 'pino unit test'
      const level = 'info'
      logger[level](message)
      const line = await once(stream, 'data')
      t.validateAnnotations({ line, message, level, config })
      t.equal(agent.logs.getEvents().length, 1, 'should have 1 log in aggregator')
      t.same(agent.logs.getEvents(), stringifyLines(line), 'log should be same in aggregator')
      t.end()
    })

    t.test('should have proper error keys when error is present', async (t) => {
      const err = new Error('This is a test')
      const level = 'error'
      logger[level](err)
      const line = await once(stream, 'data')
      t.validateAnnotations({ line, config, message: err.message, level })
      t.equal(line['error.class'], 'Error', 'should have Error as error.class')
      t.equal(line['error.message'], err.message, 'should have proper error.message')
      t.equal(line['error.stack'], truncate(err.stack), 'should have proper error.stack')
      t.notOk(line.err, 'should not have err key')
      t.equal(agent.logs.getEvents().length, 1, 'should have 1 log in aggregator')
      t.same(agent.logs.getEvents(), stringifyLines(line), 'log should be same in aggregator')
      t.end()
    })

    t.test('should add proper trace info in transaction', (t) => {
      helper.runInTransaction(agent, 'pino-test', async (tx) => {
        const level = 'info'
        const message = 'My debug test'
        logger[level](message)
        const meta = agent.getLinkingMetadata()
        const line = await once(stream, 'data')
        t.validateAnnotations({ line, config, message, level })
        t.equal(line['trace.id'], meta['trace.id'])
        t.equal(line['span.id'], meta['span.id'])
        t.equal(
          agent.logs.getEvents().length,
          0,
          'should have not have log in aggregator while transaction is active'
        )
        tx.end()
        t.equal(
          agent.logs.getEvents().length,
          1,
          'should have log in aggregator after transaction ends'
        )
        t.same(agent.logs.getEvents(), stringifyLines(line), 'log should be same in aggregator')
        t.end()
      })
    })

    t.test(
      'should assign hostname from NR linking metadata when not defined as a core chinding',
      async (t) => {
        const localStream = sink()
        const localLogger = pino({ base: undefined }, localStream)
        const message = 'pino unit test'
        const level = 'info'
        localLogger[level](message)
        const line = await once(localStream, 'data')
        t.notOk(line.pid, 'should not have pid when overriding base chindings')
        t.validateAnnotations({ line, message, level, config })
        t.equal(agent.logs.getEvents().length, 1, 'should have 1 log in aggregator')
        t.same(agent.logs.getEvents(), stringifyLines(line), 'log should be same in aggregator')
        t.end()
      }
    )

    t.test('should properly handle child loggers', (t) => {
      const childLogger = logger.child({ module: 'child' })
      helper.runInTransaction(agent, 'pino-test', async (tx) => {
        const level = 'info'
        const message = 'My debug test'
        logger[level](message)
        const meta = agent.getLinkingMetadata()
        const line = await once(stream, 'data')
        t.validateAnnotations({ line, config, message, level })
        t.equal(line['trace.id'], meta['trace.id'])
        t.equal(line['span.id'], meta['span.id'])

        const childMessage = 'this is a child message'
        childLogger[level](childMessage)
        const childLine = await once(stream, 'data')
        t.validateAnnotations({ line: childLine, config, message: childMessage, level })
        t.equal(childLine['trace.id'], meta['trace.id'])
        t.equal(childLine['span.id'], meta['span.id'])
        t.equal(
          agent.logs.getEvents().length,
          0,
          'should have not have log in aggregator while transaction is active'
        )
        tx.end()
        t.equal(
          agent.logs.getEvents().length,
          2,
          'should have log in aggregator after transaction ends'
        )
        t.same(
          agent.logs.getEvents(),
          stringifyLines([childLine, line]),
          'log should be same in aggregator'
        )
        t.end()
      })
    })
  })

  t.test('forwarding + local decorating(favor forwarding)', async (t) => {
    const config = setupAgent({
      application_logging: {
        enabled: true,
        forwarding: { enabled: true },
        local_decorating: { enabled: true },
        metrics: { enabled: false }
      }
    })
    const level = 'info'
    const message = 'My debug test'
    logger[level](message)
    const meta = agent.getLinkingMetadata()
    const line = await once(stream, 'data')
    t.validateAnnotations({ line, config, message, level })
    t.equal(line['trace.id'], meta['trace.id'])
    t.equal(line['span.id'], meta['span.id'])
    t.equal(
      agent.logs.getEvents().length,
      1,
      'should have log in aggregator after transaction ends'
    )
    t.same(agent.logs.getEvents(), stringifyLines(line), 'log should be same in aggregator')
    t.end()
  })

  t.test('metrics', (t) => {
    t.autoend()

    t.test('should count logger metrics', (t) => {
      setupAgent({
        application_logging: {
          enabled: true,
          local_decorating: { enabled: false },
          forwarding: { enabled: false },
          metrics: { enabled: true }
        }
      })
      helper.runInTransaction(agent, 'pino-test', async () => {
        const logLevels = {
          debug: 20,
          info: 5,
          warn: 3,
          error: 2
        }
        for (const [logLevel, maxCount] of Object.entries(logLevels)) {
          for (let count = 0; count < maxCount; count++) {
            const msg = `This is log message #${count} at ${logLevel} level`
            logger[logLevel](msg)
          }
        }
        await once(stream, 'data')

        let grandTotal = 0
        for (const [logLevel, maxCount] of Object.entries(logLevels)) {
          grandTotal += maxCount
          const metricName = LOGGING.LEVELS[logLevel.toUpperCase()]
          const metric = agent.metrics.getMetric(metricName)
          t.ok(metric, `ensure ${metricName} exists`)
          t.equal(metric.callCount, maxCount, `ensure ${metricName} has the right value`)
        }
        const metricName = LOGGING.LINES
        const metric = agent.metrics.getMetric(metricName)
        t.ok(metric, `ensure ${metricName} exists`)
        t.equal(metric.callCount, grandTotal, `ensure ${metricName} has the right value`)
        t.end()
      })
    })

    const configValues = [
      {
        name: 'application_logging is not enabled',
        config: {
          application_logging: {
            enabled: false,
            metrics: { enabled: true },
            forwarding: { enabled: false },
            local_decorating: { enabled: false }
          }
        }
      },
      {
        name: 'application_logging.metrics is not enabled',
        config: {
          application_logging: {
            enabled: true,
            metrics: { enabled: false },
            forwarding: { enabled: false },
            local_decorating: { enabled: false }
          }
        }
      }
    ]
    configValues.forEach(({ name, config }) => {
      t.test(`should not count logger metrics when ${name}`, (t) => {
        setupAgent(config)
        helper.runInTransaction(agent, 'pino-test', async () => {
          logger.info('This is a log message test')
          await once(stream, 'data')

          const linesMetric = agent.metrics.getMetric(LOGGING.LINES)
          t.notOk(linesMetric, `should not create ${LOGGING.LINES} metric`)
          const levelMetric = agent.metrics.getMetric(LOGGING.LEVELS.INFO)
          t.notOk(levelMetric, `should not create ${LOGGING.LEVELS.INFO} metric`)
          t.end()
        })
      })
    })
  })
})
