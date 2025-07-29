const express = require("express")
const mongoose = require("mongoose")
const cors = require("cors")
const helmet = require("helmet")
const rateLimit = require("express-rate-limit")
const promClient = require("prom-client")
const winston = require("winston")
const amqp = require("amqplib")
const redis = require("redis")
const cron = require("node-cron")
require("dotenv").config()

const app = express()
const PORT = process.env.PORT || 3007

// Prometheus metrics
const register = new promClient.Registry()
promClient.collectDefaultMetrics({ register })

const analyticsQueries = new promClient.Counter({
  name: "analytics_queries_total",
  help: "Total number of analytics queries processed",
  labelNames: ["type", "status"],
})

const dataProcessingTime = new promClient.Histogram({
  name: "analytics_processing_duration_seconds",
  help: "Time taken to process analytics data",
  labelNames: ["operation"],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
})

register.registerMetric(analyticsQueries)
register.registerMetric(dataProcessingTime)

// Logger setup
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
  ],
})

// Middleware
app.use(helmet())
app.use(cors())
app.use(express.json({ limit: "10mb" }))

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
})
app.use(limiter)

// MongoDB connection
mongoose
  .connect(process.env.MONGODB_URI || "mongodb://mongodb:27017/skillsync_analytics", {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => logger.info("Connected to MongoDB"))
  .catch((err) => logger.error("MongoDB connection error:", err))

// Redis client for caching
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || "redis://redis:6379",
})
redisClient.connect().catch(console.error)

// Analytics Event Schema
const analyticsEventSchema = new mongoose.Schema({
  eventType: { type: String, required: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, index: true },
  sessionId: String,
  data: Object,
  metadata: {
    userAgent: String,
    ipAddress: String,
    referrer: String,
    timestamp: { type: Date, default: Date.now, index: true },
    source: String,
  },
  processed: { type: Boolean, default: false, index: true },
  createdAt: { type: Date, default: Date.now, expires: 2592000 }, // 30 days TTL
})

// Add compound indexes for efficient querying
analyticsEventSchema.index({ eventType: 1, "metadata.timestamp": -1 })
analyticsEventSchema.index({ userId: 1, "metadata.timestamp": -1 })
analyticsEventSchema.index({ processed: 1, "metadata.timestamp": -1 })

const AnalyticsEvent = mongoose.model("AnalyticsEvent", analyticsEventSchema)

// Daily Analytics Summary Schema
const dailySummarySchema = new mongoose.Schema({
  date: { type: Date, required: true, unique: true },
  metrics: {
    totalUsers: Number,
    activeUsers: Number,
    newUsers: Number,
    totalProjects: Number,
    newProjects: Number,
    totalMatches: Number,
    newMatches: Number,
    totalNotifications: Number,
    notificationsSent: Number,
    pageViews: Number,
    uniqueVisitors: Number,
    averageSessionDuration: Number,
    bounceRate: Number,
  },
  topSkills: [{ skill: String, count: Number }],
  topProjects: [{ projectId: String, views: Number }],
  userEngagement: {
    totalSessions: Number,
    averageSessionLength: Number,
    pagesPerSession: Number,
  },
  conversionMetrics: {
    signupRate: Number,
    projectCreationRate: Number,
    matchAcceptanceRate: Number,
  },
  createdAt: { type: Date, default: Date.now },
})

const DailySummary = mongoose.model("DailySummary", dailySummarySchema)

// User Behavior Analytics Schema
const userBehaviorSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  date: { type: Date, required: true },
  metrics: {
    sessionsCount: Number,
    totalDuration: Number, // in seconds
    pagesViewed: Number,
    actionsPerformed: Number,
    projectsViewed: Number,
    projectsCreated: Number,
    applicationsSubmitted: Number,
    matchesViewed: Number,
    notificationsReceived: Number,
    notificationsRead: Number,
  },
  engagement: {
    score: Number, // 0-100
    level: { type: String, enum: ["low", "medium", "high", "very_high"] },
    factors: [String],
  },
  lastUpdated: { type: Date, default: Date.now },
})

userBehaviorSchema.index({ userId: 1, date: -1 }, { unique: true })

const UserBehavior = mongoose.model("UserBehavior", userBehaviorSchema)

// RabbitMQ Connection
let rabbitConnection = null
let rabbitChannel = null

async function connectRabbitMQ() {
  try {
    const rabbitmqUrl = process.env.RABBITMQ_URL || "amqp://admin:password123@rabbitmq:5672"
    rabbitConnection = await amqp.connect(rabbitmqUrl)
    rabbitChannel = await rabbitConnection.createChannel()

    await rabbitChannel.assertExchange("skill_sync_events", "topic", { durable: true })
    await rabbitChannel.assertQueue("analytics_events", { durable: true })

    // Bind to all events for analytics
    await rabbitChannel.bindQueue("analytics_events", "skill_sync_events", "*")

    logger.info("Connected to RabbitMQ")

    // Start consuming events
    consumeAnalyticsEvents()
  } catch (error) {
    logger.error("RabbitMQ connection error:", error)
    setTimeout(connectRabbitMQ, 5000)
  }
}

// Consume events for analytics processing
async function consumeAnalyticsEvents() {
  await rabbitChannel.consume("analytics_events", async (msg) => {
    if (msg) {
      try {
        const event = JSON.parse(msg.content.toString())
        await processAnalyticsEvent(event)
        rabbitChannel.ack(msg)
      } catch (error) {
        logger.error("Error processing analytics event:", error)
        rabbitChannel.nack(msg, false, false)
      }
    }
  })
}

async function processAnalyticsEvent(event) {
  try {
    const analyticsEvent = new AnalyticsEvent({
      eventType: event.type,
      userId: event.data.userId,
      data: event.data,
      metadata: {
        timestamp: new Date(event.timestamp),
        source: event.source,
      },
    })

    await analyticsEvent.save()
    logger.info(`Analytics event processed: ${event.type}`)
  } catch (error) {
    logger.error("Error saving analytics event:", error)
  }
}

// Analytics processing functions
async function calculateDailyMetrics(date) {
  const start = Date.now()

  try {
    const startOfDay = new Date(date)
    startOfDay.setHours(0, 0, 0, 0)

    const endOfDay = new Date(date)
    endOfDay.setHours(23, 59, 59, 999)

    // Get events for the day
    const dayEvents = await AnalyticsEvent.find({
      "metadata.timestamp": { $gte: startOfDay, $lte: endOfDay },
    })

    // Calculate metrics
    const metrics = {
      totalUsers: await getUserCount(startOfDay, endOfDay),
      activeUsers: await getActiveUserCount(startOfDay, endOfDay),
      newUsers: await getNewUserCount(startOfDay, endOfDay),
      totalProjects: await getProjectCount(startOfDay, endOfDay),
      newProjects: await getNewProjectCount(startOfDay, endOfDay),
      totalMatches: await getMatchCount(startOfDay, endOfDay),
      newMatches: await getNewMatchCount(startOfDay, endOfDay),
      pageViews: dayEvents.filter((e) => e.eventType === "page_view").length,
      uniqueVisitors: new Set(dayEvents.map((e) => e.userId).filter(Boolean)).size,
    }

    // Calculate engagement metrics
    const userEngagement = await calculateUserEngagement(startOfDay, endOfDay)
    const conversionMetrics = await calculateConversionMetrics(startOfDay, endOfDay)
    const topSkills = await getTopSkills(startOfDay, endOfDay)
    const topProjects = await getTopProjects(startOfDay, endOfDay)

    // Save daily summary
    await DailySummary.findOneAndUpdate(
      { date: startOfDay },
      {
        metrics,
        topSkills,
        topProjects,
        userEngagement,
        conversionMetrics,
      },
      { upsert: true, new: true },
    )

    dataProcessingTime.labels("daily_metrics").observe((Date.now() - start) / 1000)
    logger.info(`Daily metrics calculated for ${date.toISOString().split("T")[0]}`)
  } catch (error) {
    logger.error("Error calculating daily metrics:", error)
  }
}

async function calculateUserBehaviorMetrics(userId, date) {
  try {
    const startOfDay = new Date(date)
    startOfDay.setHours(0, 0, 0, 0)

    const endOfDay = new Date(date)
    endOfDay.setHours(23, 59, 59, 999)

    const userEvents = await AnalyticsEvent.find({
      userId: userId,
      "metadata.timestamp": { $gte: startOfDay, $lte: endOfDay },
    })

    const metrics = {
      sessionsCount: await getSessionCount(userId, startOfDay, endOfDay),
      totalDuration: await getTotalSessionDuration(userId, startOfDay, endOfDay),
      pagesViewed: userEvents.filter((e) => e.eventType === "page_view").length,
      actionsPerformed: userEvents.length,
      projectsViewed: userEvents.filter((e) => e.eventType === "project_view").length,
      projectsCreated: userEvents.filter((e) => e.eventType === "project_created").length,
      applicationsSubmitted: userEvents.filter((e) => e.eventType === "application_submitted").length,
      matchesViewed: userEvents.filter((e) => e.eventType === "match_viewed").length,
      notificationsReceived: userEvents.filter((e) => e.eventType === "notification_received").length,
      notificationsRead: userEvents.filter((e) => e.eventType === "notification_read").length,
    }

    const engagement = calculateEngagementScore(metrics)

    await UserBehavior.findOneAndUpdate(
      { userId, date: startOfDay },
      { metrics, engagement },
      { upsert: true, new: true },
    )

    logger.info(`User behavior metrics calculated for user ${userId}`)
  } catch (error) {
    logger.error("Error calculating user behavior metrics:", error)
  }
}

function calculateEngagementScore(metrics) {
  let score = 0
  const factors = []

  // Session frequency (0-25 points)
  if (metrics.sessionsCount >= 5) {
    score += 25
    factors.push("high_session_frequency")
  } else if (metrics.sessionsCount >= 2) {
    score += 15
    factors.push("medium_session_frequency")
  } else if (metrics.sessionsCount >= 1) {
    score += 5
    factors.push("low_session_frequency")
  }

  // Session duration (0-25 points)
  const avgDuration = metrics.totalDuration / (metrics.sessionsCount || 1)
  if (avgDuration >= 1800) {
    // 30 minutes
    score += 25
    factors.push("long_sessions")
  } else if (avgDuration >= 600) {
    // 10 minutes
    score += 15
    factors.push("medium_sessions")
  } else if (avgDuration >= 60) {
    // 1 minute
    score += 5
    factors.push("short_sessions")
  }

  // Content engagement (0-25 points)
  if (metrics.projectsViewed >= 10) {
    score += 25
    factors.push("high_content_engagement")
  } else if (metrics.projectsViewed >= 5) {
    score += 15
    factors.push("medium_content_engagement")
  } else if (metrics.projectsViewed >= 1) {
    score += 5
    factors.push("low_content_engagement")
  }

  // Action engagement (0-25 points)
  const actionScore = metrics.projectsCreated * 10 + metrics.applicationsSubmitted * 5 + metrics.notificationsRead * 1

  if (actionScore >= 50) {
    score += 25
    factors.push("high_action_engagement")
  } else if (actionScore >= 20) {
    score += 15
    factors.push("medium_action_engagement")
  } else if (actionScore >= 5) {
    score += 5
    factors.push("low_action_engagement")
  }

  let level = "low"
  if (score >= 80) level = "very_high"
  else if (score >= 60) level = "high"
  else if (score >= 30) level = "medium"

  return { score, level, factors }
}

// Helper functions for metrics calculation
async function getUserCount(start, end) {
  // This would query the user service or user events
  return 1000 // Placeholder
}

async function getActiveUserCount(start, end) {
  const activeUsers = await AnalyticsEvent.distinct("userId", {
    "metadata.timestamp": { $gte: start, $lte: end },
  })
  return activeUsers.length
}

async function getNewUserCount(start, end) {
  const newUserEvents = await AnalyticsEvent.countDocuments({
    eventType: "user_created",
    "metadata.timestamp": { $gte: start, $lte: end },
  })
  return newUserEvents
}

async function getProjectCount(start, end) {
  return 500 // Placeholder - would query project service
}

async function getNewProjectCount(start, end) {
  const newProjects = await AnalyticsEvent.countDocuments({
    eventType: "project_created",
    "metadata.timestamp": { $gte: start, $lte: end },
  })
  return newProjects
}

async function getMatchCount(start, end) {
  return 2000 // Placeholder - would query matching service
}

async function getNewMatchCount(start, end) {
  const newMatches = await AnalyticsEvent.countDocuments({
    eventType: "matching.completed",
    "metadata.timestamp": { $gte: start, $lte: end },
  })
  return newMatches
}

async function calculateUserEngagement(start, end) {
  const sessions = await AnalyticsEvent.aggregate([
    {
      $match: {
        eventType: "session_start",
        "metadata.timestamp": { $gte: start, $lte: end },
      },
    },
    {
      $group: {
        _id: null,
        totalSessions: { $sum: 1 },
        averageSessionLength: { $avg: "$data.duration" },
      },
    },
  ])

  return sessions[0] || { totalSessions: 0, averageSessionLength: 0, pagesPerSession: 0 }
}

async function calculateConversionMetrics(start, end) {
  // Calculate various conversion rates
  return {
    signupRate: 0.15,
    projectCreationRate: 0.25,
    matchAcceptanceRate: 0.35,
  }
}

async function getTopSkills(start, end) {
  const skills = await AnalyticsEvent.aggregate([
    {
      $match: {
        eventType: "skill_added",
        "metadata.timestamp": { $gte: start, $lte: end },
      },
    },
    {
      $group: {
        _id: "$data.skillName",
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1 } },
    { $limit: 10 },
    {
      $project: {
        skill: "$_id",
        count: 1,
        _id: 0,
      },
    },
  ])

  return skills
}

async function getTopProjects(start, end) {
  const projects = await AnalyticsEvent.aggregate([
    {
      $match: {
        eventType: "project_view",
        "metadata.timestamp": { $gte: start, $lte: end },
      },
    },
    {
      $group: {
        _id: "$data.projectId",
        views: { $sum: 1 },
      },
    },
    { $sort: { views: -1 } },
    { $limit: 10 },
    {
      $project: {
        projectId: "$_id",
        views: 1,
        _id: 0,
      },
    },
  ])

  return projects
}

async function getSessionCount(userId, start, end) {
  const sessions = await AnalyticsEvent.countDocuments({
    userId: userId,
    eventType: "session_start",
    "metadata.timestamp": { $gte: start, $lte: end },
  })
  return sessions
}

async function getTotalSessionDuration(userId, start, end) {
  const sessions = await AnalyticsEvent.aggregate([
    {
      $match: {
        userId: userId,
        eventType: "session_end",
        "metadata.timestamp": { $gte: start, $lte: end },
      },
    },
    {
      $group: {
        _id: null,
        totalDuration: { $sum: "$data.duration" },
      },
    },
  ])

  return sessions[0]?.totalDuration || 0
}

// Scheduled jobs
cron.schedule("0 1 * * *", async () => {
  // Run daily at 1 AM
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)

  logger.info("Starting daily metrics calculation")
  await calculateDailyMetrics(yesterday)
})

cron.schedule("0 */6 * * *", async () => {
  // Run every 6 hours - process user behavior metrics
  logger.info("Starting user behavior metrics calculation")

  const today = new Date()
  const activeUsers = await AnalyticsEvent.distinct("userId", {
    "metadata.timestamp": { $gte: new Date(today.getTime() - 24 * 60 * 60 * 1000) },
  })

  for (const userId of activeUsers.slice(0, 100)) {
    // Process in batches
    await calculateUserBehaviorMetrics(userId, today)
  }
})

// Routes

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    service: "analytics-service",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    rabbitmq: rabbitConnection ? "connected" : "disconnected",
    redis: redisClient.isOpen ? "connected" : "disconnected",
  })
})

// Metrics endpoint
app.get("/metrics", async (req, res) => {
  res.set("Content-Type", register.contentType)
  res.end(await register.metrics())
})

// Track custom event
app.post("/api/events/track", async (req, res) => {
  const start = Date.now()

  try {
    const { eventType, userId, data, metadata = {} } = req.body

    const event = new AnalyticsEvent({
      eventType,
      userId,
      data,
      metadata: {
        ...metadata,
        userAgent: req.get("User-Agent"),
        ipAddress: req.ip,
        timestamp: new Date(),
        source: "direct_api",
      },
    })

    await event.save()
    analyticsQueries.labels("track_event", "success").inc()
    dataProcessingTime.labels("track_event").observe((Date.now() - start) / 1000)

    res.status(201).json({ success: true, eventId: event._id })
  } catch (error) {
    logger.error("Error tracking event:", error)
    analyticsQueries.labels("track_event", "error").inc()
    res.status(500).json({ error: "Failed to track event" })
  }
})

// Get dashboard data
app.get("/api/dashboard", async (req, res) => {
  const start = Date.now()

  try {
    const { period = "7d" } = req.query
    const cacheKey = `dashboard:${period}`

    // Try cache first
    const cached = await redisClient.get(cacheKey)
    if (cached) {
      analyticsQueries.labels("dashboard", "cache_hit").inc()
      return res.json(JSON.parse(cached))
    }

    // Calculate date range
    const endDate = new Date()
    const startDate = new Date()

    switch (period) {
      case "1d":
        startDate.setDate(startDate.getDate() - 1)
        break
      case "7d":
        startDate.setDate(startDate.getDate() - 7)
        break
      case "30d":
        startDate.setDate(startDate.getDate() - 30)
        break
      default:
        startDate.setDate(startDate.getDate() - 7)
    }

    // Get recent daily summaries
    const summaries = await DailySummary.find({
      date: { $gte: startDate, $lte: endDate },
    }).sort({ date: -1 })

    // Calculate totals and trends
    const totalMetrics = summaries.reduce((acc, summary) => {
      Object.keys(summary.metrics).forEach((key) => {
        acc[key] = (acc[key] || 0) + (summary.metrics[key] || 0)
      })
      return acc
    }, {})

    // Get real-time metrics for today
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const todayEvents = await AnalyticsEvent.countDocuments({
      "metadata.timestamp": { $gte: today },
    })

    const activeUsersToday = await AnalyticsEvent.distinct("userId", {
      "metadata.timestamp": { $gte: today },
    })

    const dashboardData = {
      period,
      totalMetrics,
      todayMetrics: {
        events: todayEvents,
        activeUsers: activeUsersToday.length,
      },
      dailySummaries: summaries,
      trends: calculateTrends(summaries),
      lastUpdated: new Date(),
    }

    // Cache for 5 minutes
    await redisClient.setEx(cacheKey, 300, JSON.stringify(dashboardData))

    analyticsQueries.labels("dashboard", "success").inc()
    dataProcessingTime.labels("dashboard").observe((Date.now() - start) / 1000)

    res.json(dashboardData)
  } catch (error) {
    logger.error("Error fetching dashboard data:", error)
    analyticsQueries.labels("dashboard", "error").inc()
    res.status(500).json({ error: "Failed to fetch dashboard data" })
  }
})

// Get user behavior analytics
app.get("/api/users/:userId/behavior", async (req, res) => {
  const start = Date.now()

  try {
    const { userId } = req.params
    const { days = 30 } = req.query

    const startDate = new Date()
    startDate.setDate(startDate.getDate() - days)

    const behavior = await UserBehavior.find({
      userId: userId,
      date: { $gte: startDate },
    }).sort({ date: -1 })

    const summary = behavior.reduce((acc, day) => {
      Object.keys(day.metrics).forEach((key) => {
        acc[key] = (acc[key] || 0) + (day.metrics[key] || 0)
      })
      return acc
    }, {})

    const avgEngagement = behavior.reduce((sum, day) => sum + day.engagement.score, 0) / behavior.length

    analyticsQueries.labels("user_behavior", "success").inc()
    dataProcessingTime.labels("user_behavior").observe((Date.now() - start) / 1000)

    res.json({
      userId,
      period: `${days}d`,
      dailyBehavior: behavior,
      summary,
      averageEngagement: avgEngagement || 0,
    })
  } catch (error) {
    logger.error("Error fetching user behavior:", error)
    analyticsQueries.labels("user_behavior", "error").inc()
    res.status(500).json({ error: "Failed to fetch user behavior" })
  }
})

// Get analytics reports
app.get("/api/reports/:reportType", async (req, res) => {
  const start = Date.now()

  try {
    const { reportType } = req.params
    const { startDate, endDate } = req.query

    let report = {}

    switch (reportType) {
      case "engagement":
        report = await generateEngagementReport(startDate, endDate)
        break
      case "conversion":
        report = await generateConversionReport(startDate, endDate)
        break
      case "retention":
        report = await generateRetentionReport(startDate, endDate)
        break
      default:
        return res.status(400).json({ error: "Invalid report type" })
    }

    analyticsQueries.labels("report", "success").inc()
    dataProcessingTime.labels("report").observe((Date.now() - start) / 1000)

    res.json(report)
  } catch (error) {
    logger.error("Error generating report:", error)
    analyticsQueries.labels("report", "error").inc()
    res.status(500).json({ error: "Failed to generate report" })
  }
})

// Helper functions for reports
async function generateEngagementReport(startDate, endDate) {
  // Implementation for engagement report
  return { reportType: "engagement", data: [] }
}

async function generateConversionReport(startDate, endDate) {
  // Implementation for conversion report
  return { reportType: "conversion", data: [] }
}

async function generateRetentionReport(startDate, endDate) {
  // Implementation for retention report
  return { reportType: "retention", data: [] }
}

function calculateTrends(summaries) {
  if (summaries.length < 2) return {}

  const latest = summaries[0]
  const previous = summaries[1]

  const trends = {}
  Object.keys(latest.metrics).forEach((key) => {
    const current = latest.metrics[key] || 0
    const prev = previous.metrics[key] || 0
    const change = prev === 0 ? 0 : ((current - prev) / prev) * 100
    trends[key] = {
      current,
      previous: prev,
      change: Math.round(change * 100) / 100,
      direction: change > 0 ? "up" : change < 0 ? "down" : "stable",
    }
  })

  return trends
}

// Error handling
app.use((error, req, res, next) => {
  logger.error("Analytics service error:", error)
  res.status(500).json({ error: "Internal server error" })
})

// Initialize
connectRabbitMQ()

// Graceful shutdown
process.on("SIGTERM", () => {
  logger.info("SIGTERM received, shutting down gracefully")

  if (rabbitConnection) {
    rabbitConnection.close()
  }

  redisClient.quit()

  mongoose.connection.close(() => {
    logger.info("MongoDB connection closed")
    process.exit(0)
  })
})

app.listen(PORT, () => {
  logger.info(`Analytics Service running on port ${PORT}`)
})

module.exports = app
