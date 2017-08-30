const bunyan = require('bunyan')
const bunyanFormat = require('bunyan-format')
const sentryStream = require('bunyan-sentry-stream')
const cacheManager = require('cache-manager')
const createApp = require('github-app')
const createWebhook = require('github-webhook-handler')
const Raven = require('raven')

const createRobot = require('./lib/robot')
const createServer = require('./lib/server')
const serializers = require('./lib/serializers')

const cache = cacheManager.caching({
  store: 'memory',
  ttl: 60 * 60 // 1 hour
})

const logger = bunyan.createLogger({
  name: 'PRobot',
  level: process.env.LOG_LEVEL || 'debug',
  stream: bunyanFormat({outputMode: process.env.LOG_FORMAT || 'short'}),
  serializers
})

// Log all unhandled rejections
process.on('unhandledRejection', logger.error.bind(logger))

module.exports = (options = {}) => {
  const webhook = createWebhook({path: options.webhookPath || '/', secret: options.secret || 'development'})
  const app = createApp({
    id: options.id,
    cert: options.cert,
    debug: process.env.LOG_LEVEL === 'trace'
  })
  const server = createServer(webhook)

  // Log all received webhooks
  webhook.on('*', event => {
    logger.trace(event, 'webhook received')
    receive(event)
  })

  // Log all webhook errors
  webhook.on('error', logger.error.bind(logger))

  // Deprecate SENTRY_URL
  if (process.env.SENTRY_URL && !process.env.SENTRY_DSN) {
    process.env.SENTRY_DSN = process.env.SENTRY_URL
    console.warn('DEPRECATED: the `SENTRY_URL` key is now called `SENTRY_DSN`. Use of `SENTRY_URL` is deprecated and will be removed in 0.11.0')
  }

  // If sentry is configured, report all logged errors
  if (process.env.SENTRY_DSN) {
    Raven.disableConsoleAlerts()
    Raven.config(process.env.SENTRY_DSN, {
      autoBreadcrumbs: true
    }).install({})

    logger.addStream(sentryStream(Raven))
  }

  const robots = []

  function receive (event) {
    return Promise.all(robots.map(robot => robot.receive(event)))
  }

  return {
    server,
    webhook,
    receive,
    logger,

    start () {
      server.listen(options.port)
      logger.trace('Listening on http://localhost:' + options.port)
    },

    load (plugin) {
      const robot = createRobot({app, cache, logger, catchErrors: true})

      // Connect the router from the robot to the server
      server.use(robot.router)

      // Initialize the plugin
      plugin(robot)
      robots.push(robot)

      return robot
    }
  }
}

module.exports.createRobot = createRobot
