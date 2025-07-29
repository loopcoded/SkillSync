const express = require("express")
const mongoose = require("mongoose")
const cors = require("cors")
const helmet = require("helmet")
const rateLimit = require("express-rate-limit")
const promClient = require("prom-client")
const winston = require("winston")
const amqp = require("amqplib")
const nodemailer = require("nodemailer")
const webpush = require("web-push")
require("dotenv").config()

const app = express()
const PORT = process.env.PORT || 3005

// Prometheus metrics
const register = new promClient.Registry()
promClient.collectDefaultMetrics({ register })

const notificationsSent = new promClient.Counter({
  name: "notifications_sent_total",
  help: "Total number of notifications sent",
  labelNames: ["type", "channel", "status"],
})

const notificationProcessingTime = new promClient.Histogram({
  name: "notification_processing_duration_seconds",
  help: "Time taken to process notifications",
  labelNames: ["type"],
  buckets: [0.1, 0.5, 1, 2, 5, 10],
})

const eventProcessingTime = new promClient.Histogram({
  name: "event_processing_duration_seconds",
  help: "Time taken to process events from message queue",
  labelNames: ["event_type"],
  buckets: [0.1, 0.5, 1, 2, 5, 10],
})

register.registerMetric(notificationsSent)
register.registerMetric(notificationProcessingTime)
register.registerMetric(eventProcessingTime)

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
  max: 200,
})
app.use(limiter)

// MongoDB connection
mongoose
  .connect(process.env.MONGODB_URI || "mongodb://mongodb:27017/skillsync_notifications", {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => logger.info("Connected to MongoDB"))
  .catch((err) => logger.error("MongoDB connection error:", err))

// Notification Schema
const notificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  type: {
    type: String,
    enum: [
      "project_match",
      "application_received",
      "application_accepted",
      "project_update",
      "content_recommendation",
      "system",
    ],
    required: true,
  },
  title: { type: String, required: true },
  message: { type: String, required: true },
  data: Object, // Additional data for the notification
  channels: {
    email: {
      enabled: { type: Boolean, default: false },
      sent: { type: Boolean, default: false },
      sentAt: Date,
      error: String,
    },
    push: {
      enabled: { type: Boolean, default: false },
      sent: { type: Boolean, default: false },
      sentAt: Date,
      error: String,
    },
    inApp: {
      enabled: { type: Boolean, default: true },
      read: { type: Boolean, default: false },
      readAt: Date,
    },
  },
  priority: { type: String, enum: ["low", "medium", "high", "urgent"], default: "medium" },
  status: { type: String, enum: ["pending", "processing", "sent", "failed"], default: "pending" },
  scheduledFor: Date, // For scheduled notifications
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
})

// Add indexes for efficient querying
notificationSchema.index({ userId: 1, createdAt: -1 })
notificationSchema.index({ status: 1, scheduledFor: 1 })
notificationSchema.index({ type: 1, createdAt: -1 })

const Notification = mongoose.model("Notification", notificationSchema)

// User Notification Preferences Schema
const notificationPreferencesSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
  preferences: {
    project_match: {
      email: { type: Boolean, default: true },
      push: { type: Boolean, default: true },
      inApp: { type: Boolean, default: true },
    },
    application_received: {
      email: { type: Boolean, default: true },
      push: { type: Boolean, default: true },
      inApp: { type: Boolean, default: true },
    },
    application_accepted: {
      email: { type: Boolean, default: true },
      push: { type: Boolean, default: true },
      inApp: { type: Boolean, default: true },
    },
    project_update: {
      email: { type: Boolean, default: false },
      push: { type: Boolean, default: true },
      inApp: { type: Boolean, default: true },
    },
    content_recommendation: {
      email: { type: Boolean, default: false },
      push: { type: Boolean, default: false },
      inApp: { type: Boolean, default: true },
    },
    system: {
      email: { type: Boolean, default: true },
      push: { type: Boolean, default: false },
      inApp: { type: Boolean, default: true },
    },
  },
  emailFrequency: { type: String, enum: ["immediate", "daily", "weekly", "never"], default: "immediate" },
  quietHours: {
    enabled: { type: Boolean, default: false },
    start: { type: String, default: "22:00" },
    end: { type: String, default: "08:00" },
    timezone: { type: String, default: "UTC" },
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
})

const NotificationPreferences = mongoose.model("NotificationPreferences", notificationPreferencesSchema)

// Push Subscription Schema
const pushSubscriptionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  endpoint: { type: String, required: true },
  keys: {
    p256dh: { type: String, required: true },
    auth: { type: String, required: true },
  },
  userAgent: String,
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
})

pushSubscriptionSchema.index({ userId: 1, endpoint: 1 }, { unique: true })

const PushSubscription = mongoose.model("PushSubscription", pushSubscriptionSchema)

// Email transporter setup
const emailTransporter = nodemailer.createTransporter({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: process.env.SMTP_PORT || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER || "noreply@skillsync.com",
    pass: process.env.SMTP_PASS || "your-app-password",
  },
})

// Web Push setup
webpush.setVapidDetails(
  "mailto:admin@skillsync.com",
  process.env.VAPID_PUBLIC_KEY || "your-vapid-public-key",
  process.env.VAPID_PRIVATE_KEY || "your-vapid-private-key",
)

// RabbitMQ Connection
let rabbitConnection = null
let rabbitChannel = null

async function connectRabbitMQ() {
  try {
    const rabbitmqUrl = process.env.RABBITMQ_URL || "amqp://admin:password123@rabbitmq:5672"
    rabbitConnection = await amqp.connect(rabbitmqUrl)
    rabbitChannel = await rabbitConnection.createChannel()

    await rabbitChannel.assertExchange("skill_sync_events", "topic", { durable: true })
    await rabbitChannel.assertQueue("notifications", { durable: true })

    // Bind to relevant events
    await rabbitChannel.bindQueue("notifications", "skill_sync_events", "matching.completed")
    await rabbitChannel.bindQueue("notifications", "skill_sync_events", "project.application")
    await rabbitChannel.bindQueue("notifications", "skill_sync_events", "project.updated")
    await rabbitChannel.bindQueue("notifications", "skill_sync_events", "user.created")

    logger.info("Connected to RabbitMQ")

    // Start consuming messages
    consumeNotificationEvents()
  } catch (error) {
    logger.error("RabbitMQ connection error:", error)
    setTimeout(connectRabbitMQ, 5000)
  }
}

// Message consumer
async function consumeNotificationEvents() {
  await rabbitChannel.consume("notifications", async (msg) => {
    if (msg) {
      const start = Date.now()
      try {
        const event = JSON.parse(msg.content.toString())
        logger.info(`Processing notification event: ${event.type}`)

        await processNotificationEvent(event)

        rabbitChannel.ack(msg)
        eventProcessingTime.labels(event.type).observe((Date.now() - start) / 1000)
      } catch (error) {
        logger.error("Error processing notification message:", error)
        rabbitChannel.nack(msg, false, false)
      }
    }
  })
}

// Event processors
async function processNotificationEvent(event) {
  switch (event.type) {
    case "matching.completed":
      await handleMatchingCompleted(event.data)
      break
    case "project.application":
      await handleProjectApplication(event.data)
      break
    case "project.updated":
      await handleProjectUpdated(event.data)
      break
    case "user.created":
      await handleUserCreated(event.data)
      break
    default:
      logger.warn(`Unknown notification event type: ${event.type}`)
  }
}

async function handleMatchingCompleted(data) {
  try {
    const { userId, matchCount, topMatches } = data

    if (matchCount > 0) {
      const notification = new Notification({
        userId: userId,
        type: "project_match",
        title: "New Project Matches Found!",
        message: `We found ${matchCount} projects that match your skills. Check them out!`,
        data: {
          matchCount,
          topMatches: topMatches.slice(0, 3), // Include top 3 matches
        },
        priority: "medium",
      })

      await notification.save()
      await processNotification(notification)
    }
  } catch (error) {
    logger.error("Error handling matching completed event:", error)
  }
}

async function handleProjectApplication(data) {
  try {
    const { projectId, applicantId, projectOwnerId, projectTitle } = data

    // Notify project owner
    const notification = new Notification({
      userId: projectOwnerId,
      type: "application_received",
      title: "New Project Application",
      message: `Someone applied to your project "${projectTitle}". Review their application now!`,
      data: {
        projectId,
        applicantId,
        projectTitle,
      },
      priority: "high",
    })

    await notification.save()
    await processNotification(notification)
  } catch (error) {
    logger.error("Error handling project application event:", error)
  }
}

async function handleProjectUpdated(data) {
  try {
    const { projectId, projectTitle, teamMembers, updateType } = data

    // Notify all team members
    for (const memberId of teamMembers || []) {
      const notification = new Notification({
        userId: memberId,
        type: "project_update",
        title: "Project Update",
        message: `"${projectTitle}" has been updated. Check out the latest changes!`,
        data: {
          projectId,
          projectTitle,
          updateType,
        },
        priority: "low",
      })

      await notification.save()
      await processNotification(notification)
    }
  } catch (error) {
    logger.error("Error handling project updated event:", error)
  }
}

async function handleUserCreated(data) {
  try {
    const { userId, username } = data

    // Welcome notification
    const notification = new Notification({
      userId: userId,
      type: "system",
      title: "Welcome to Skill Sync!",
      message: `Hi ${username}! Welcome to Skill Sync. Start by exploring projects that match your skills.`,
      data: {
        isWelcome: true,
      },
      priority: "medium",
    })

    await notification.save()
    await processNotification(notification)

    // Create default notification preferences
    const preferences = new NotificationPreferences({
      userId: userId,
    })
    await preferences.save()
  } catch (error) {
    logger.error("Error handling user created event:", error)
  }
}

// Notification processing
async function processNotification(notification) {
  const start = Date.now()

  try {
    notification.status = "processing"
    await notification.save()

    // Get user preferences
    const preferences = await NotificationPreferences.findOne({ userId: notification.userId })
    const userPrefs = preferences?.preferences[notification.type] || {}

    // Check quiet hours
    if (preferences?.quietHours?.enabled && isInQuietHours(preferences.quietHours)) {
      // Schedule for later
      notification.scheduledFor = calculateNextSendTime(preferences.quietHours)
      notification.status = "pending"
      await notification.save()
      return
    }

    // Process each channel
    const results = await Promise.allSettled([
      userPrefs.email && notification.channels.email.enabled ? sendEmailNotification(notification) : Promise.resolve(),
      userPrefs.push && notification.channels.push.enabled ? sendPushNotification(notification) : Promise.resolve(),
      userPrefs.inApp && notification.channels.inApp.enabled
        ? processInAppNotification(notification)
        : Promise.resolve(),
    ])

    // Update notification status
    const hasFailures = results.some((result) => result.status === "rejected")
    notification.status = hasFailures ? "failed" : "sent"
    notification.updatedAt = new Date()
    await notification.save()

    notificationProcessingTime.labels(notification.type).observe((Date.now() - start) / 1000)
    logger.info(`Processed notification ${notification._id} for user ${notification.userId}`)
  } catch (error) {
    logger.error(`Error processing notification ${notification._id}:`, error)
    notification.status = "failed"
    await notification.save()
  }
}

async function sendEmailNotification(notification) {
  try {
    const emailTemplate = generateEmailTemplate(notification)

    await emailTransporter.sendMail({
      from: process.env.SMTP_FROM || "Skill Sync <noreply@skillsync.com>",
      to: notification.data.userEmail || "user@example.com", // Would get from user service
      subject: notification.title,
      html: emailTemplate,
    })

    notification.channels.email.sent = true
    notification.channels.email.sentAt = new Date()
    notificationsSent.labels(notification.type, "email", "success").inc()

    logger.info(`Email sent for notification ${notification._id}`)
  } catch (error) {
    notification.channels.email.error = error.message
    notificationsSent.labels(notification.type, "email", "failed").inc()
    logger.error(`Email failed for notification ${notification._id}:`, error)
    throw error
  }
}

async function sendPushNotification(notification) {
  try {
    const subscriptions = await PushSubscription.find({ userId: notification.userId, isActive: true })

    const pushPayload = JSON.stringify({
      title: notification.title,
      body: notification.message,
      icon: "/icon-192x192.png",
      badge: "/badge-72x72.png",
      data: {
        notificationId: notification._id,
        type: notification.type,
        ...notification.data,
      },
    })

    const pushPromises = subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: subscription.keys,
          },
          pushPayload,
        )
        return { success: true, subscriptionId: subscription._id }
      } catch (error) {
        if (error.statusCode === 410) {
          // Subscription expired, mark as inactive
          subscription.isActive = false
          await subscription.save()
        }
        return { success: false, error: error.message, subscriptionId: subscription._id }
      }
    })

    const results = await Promise.allSettled(pushPromises)
    const successCount = results.filter((r) => r.status === "fulfilled" && r.value.success).length

    if (successCount > 0) {
      notification.channels.push.sent = true
      notification.channels.push.sentAt = new Date()
      notificationsSent.labels(notification.type, "push", "success").inc()
    } else {
      notification.channels.push.error = "All push subscriptions failed"
      notificationsSent.labels(notification.type, "push", "failed").inc()
    }

    logger.info(`Push notification sent to ${successCount}/${subscriptions.length} subscriptions`)
  } catch (error) {
    notification.channels.push.error = error.message
    notificationsSent.labels(notification.type, "push", "failed").inc()
    logger.error(`Push notification failed for notification ${notification._id}:`, error)
    throw error
  }
}

async function processInAppNotification(notification) {
  try {
    // In-app notifications are just stored in the database
    // The frontend will poll or use WebSocket to get them
    notification.channels.inApp.enabled = true
    notificationsSent.labels(notification.type, "in-app", "success").inc()
    logger.info(`In-app notification processed for ${notification._id}`)
  } catch (error) {
    notificationsSent.labels(notification.type, "in-app", "failed").inc()
    throw error
  }
}

// Helper functions
function generateEmailTemplate(notification) {
  return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <title>${notification.title}</title>
        <style>
            body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { background: #3b82f6; color: white; padding: 20px; text-align: center; }
            .content { padding: 20px; background: #f9fafb; }
            .footer { padding: 20px; text-align: center; color: #666; font-size: 12px; }
            .button { display: inline-block; padding: 12px 24px; background: #3b82f6; color: white; text-decoration: none; border-radius: 6px; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>Skill Sync</h1>
            </div>
            <div class="content">
                <h2>${notification.title}</h2>
                <p>${notification.message}</p>
                ${notification.data?.projectTitle ? `<p><strong>Project:</strong> ${notification.data.projectTitle}</p>` : ""}
                <p><a href="https://skillsync.com/notifications" class="button">View in Skill Sync</a></p>
            </div>
            <div class="footer">
                <p>You received this email because you're subscribed to Skill Sync notifications.</p>
                <p><a href="https://skillsync.com/settings/notifications">Manage your notification preferences</a></p>
            </div>
        </div>
    </body>
    </html>
  `
}

function isInQuietHours(quietHours) {
  // Simplified quiet hours check
  const now = new Date()
  const currentHour = now.getHours()
  const startHour = Number.parseInt(quietHours.start.split(":")[0])
  const endHour = Number.parseInt(quietHours.end.split(":")[0])

  if (startHour > endHour) {
    // Quiet hours span midnight
    return currentHour >= startHour || currentHour < endHour
  } else {
    return currentHour >= startHour && currentHour < endHour
  }
}

function calculateNextSendTime(quietHours) {
  const now = new Date()
  const endHour = Number.parseInt(quietHours.end.split(":")[0])
  const nextSend = new Date(now)
  nextSend.setHours(endHour, 0, 0, 0)

  if (nextSend <= now) {
    nextSend.setDate(nextSend.getDate() + 1)
  }

  return nextSend
}

// Scheduled notification processor
async function processScheduledNotifications() {
  try {
    const now = new Date()
    const scheduledNotifications = await Notification.find({
      status: "pending",
      scheduledFor: { $lte: now },
    }).limit(100)

    for (const notification of scheduledNotifications) {
      await processNotification(notification)
    }

    if (scheduledNotifications.length > 0) {
      logger.info(`Processed ${scheduledNotifications.length} scheduled notifications`)
    }
  } catch (error) {
    logger.error("Error processing scheduled notifications:", error)
  }
}

// Routes

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    service: "notification-service",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    rabbitmq: rabbitConnection ? "connected" : "disconnected",
  })
})

// Metrics endpoint
app.get("/metrics", async (req, res) => {
  res.set("Content-Type", register.contentType)
  res.end(await register.metrics())
})

// Get notifications for a user
app.get("/api/notifications/:userId", async (req, res) => {
  try {
    const { userId } = req.params
    const { page = 1, limit = 20, unreadOnly = false } = req.query

    const query = { userId }
    if (unreadOnly === "true") {
      query["channels.inApp.read"] = false
    }

    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)

    const total = await Notification.countDocuments(query)
    const unreadCount = await Notification.countDocuments({
      userId,
      "channels.inApp.read": false,
    })

    res.json({
      notifications,
      totalPages: Math.ceil(total / limit),
      currentPage: Number.parseInt(page),
      total,
      unreadCount,
    })
  } catch (error) {
    logger.error("Error fetching notifications:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Mark notification as read
app.put("/api/notifications/:id/read", async (req, res) => {
  try {
    const notification = await Notification.findByIdAndUpdate(
      req.params.id,
      {
        "channels.inApp.read": true,
        "channels.inApp.readAt": new Date(),
        updatedAt: new Date(),
      },
      { new: true },
    )

    if (!notification) {
      return res.status(404).json({ error: "Notification not found" })
    }

    res.json(notification)
  } catch (error) {
    logger.error("Error marking notification as read:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Get notification preferences
app.get("/api/notifications/preferences/:userId", async (req, res) => {
  try {
    const preferences = await NotificationPreferences.findOne({ userId: req.params.userId })

    if (!preferences) {
      // Create default preferences
      const defaultPreferences = new NotificationPreferences({ userId: req.params.userId })
      await defaultPreferences.save()
      return res.json(defaultPreferences)
    }

    res.json(preferences)
  } catch (error) {
    logger.error("Error fetching notification preferences:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Update notification preferences
app.put("/api/notifications/preferences/:userId", async (req, res) => {
  try {
    const preferences = await NotificationPreferences.findOneAndUpdate(
      { userId: req.params.userId },
      { ...req.body, updatedAt: new Date() },
      { new: true, upsert: true },
    )

    res.json(preferences)
  } catch (error) {
    logger.error("Error updating notification preferences:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Subscribe to push notifications
app.post("/api/notifications/push/subscribe", async (req, res) => {
  try {
    const { userId, subscription } = req.body

    await PushSubscription.findOneAndUpdate(
      { userId, endpoint: subscription.endpoint },
      {
        userId,
        endpoint: subscription.endpoint,
        keys: subscription.keys,
        userAgent: req.get("User-Agent"),
        isActive: true,
      },
      { upsert: true, new: true },
    )

    res.json({ success: true })
  } catch (error) {
    logger.error("Error subscribing to push notifications:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Send manual notification
app.post("/api/notifications/send", async (req, res) => {
  try {
    const { userId, type, title, message, data, priority = "medium" } = req.body

    const notification = new Notification({
      userId,
      type: type || "system",
      title,
      message,
      data: data || {},
      priority,
    })

    await notification.save()
    await processNotification(notification)

    res.status(201).json(notification)
  } catch (error) {
    logger.error("Error sending manual notification:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Get notification statistics
app.get("/api/notifications/stats", async (req, res) => {
  try {
    const stats = await Notification.aggregate([
      {
        $group: {
          _id: null,
          totalNotifications: { $sum: 1 },
          sentNotifications: {
            $sum: { $cond: [{ $eq: ["$status", "sent"] }, 1, 0] },
          },
          failedNotifications: {
            $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] },
          },
        },
      },
    ])

    const typeStats = await Notification.aggregate([
      { $group: { _id: "$type", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])

    const channelStats = await Notification.aggregate([
      {
        $project: {
          emailSent: "$channels.email.sent",
          pushSent: "$channels.push.sent",
          inAppEnabled: "$channels.inApp.enabled",
        },
      },
      {
        $group: {
          _id: null,
          emailSent: { $sum: { $cond: ["$emailSent", 1, 0] } },
          pushSent: { $sum: { $cond: ["$pushSent", 1, 0] } },
          inAppSent: { $sum: { $cond: ["$inAppEnabled", 1, 0] } },
        },
      },
    ])

    res.json({
      overview: stats[0] || { totalNotifications: 0, sentNotifications: 0, failedNotifications: 0 },
      byType: typeStats,
      byChannel: channelStats[0] || { emailSent: 0, pushSent: 0, inAppSent: 0 },
    })
  } catch (error) {
    logger.error("Error fetching notification statistics:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Error handling middleware
app.use((error, req, res, next) => {
  logger.error("Unhandled error:", error)
  res.status(500).json({ error: "Internal server error" })
})

// 404 handler
app.use("*", (req, res) => {
  res.status(404).json({ error: "Route not found" })
})

// Initialize
connectRabbitMQ()

// Process scheduled notifications every minute
setInterval(processScheduledNotifications, 60 * 1000)

// Graceful shutdown
process.on("SIGTERM", () => {
  logger.info("SIGTERM received, shutting down gracefully")
  if (rabbitConnection) {
    rabbitConnection.close()
  }
  mongoose.connection.close(() => {
    logger.info("MongoDB connection closed")
    process.exit(0)
  })
})

app.listen(PORT, () => {
  logger.info(`Notification Service running on port ${PORT}`)
})

module.exports = app
