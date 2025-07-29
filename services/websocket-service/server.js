const express = require("express")
const http = require("http")
const socketIo = require("socket.io")
const mongoose = require("mongoose")
const cors = require("cors")
const helmet = require("helmet")
const promClient = require("prom-client")
const winston = require("winston")
const jwt = require("jsonwebtoken")
const amqp = require("amqplib")
const redis = require("redis")
require("dotenv").config()

const app = express()
const server = http.createServer(app)
const PORT = process.env.PORT || 3006

// Prometheus metrics
const register = new promClient.Registry()
promClient.collectDefaultMetrics({ register })

const activeConnections = new promClient.Gauge({
  name: "websocket_active_connections",
  help: "Number of active WebSocket connections",
  labelNames: ["room"],
})

const messagesProcessed = new promClient.Counter({
  name: "websocket_messages_total",
  help: "Total number of WebSocket messages processed",
  labelNames: ["type", "room"],
})

const eventsBroadcast = new promClient.Counter({
  name: "websocket_events_broadcast_total",
  help: "Total number of events broadcast via WebSocket",
  labelNames: ["event_type"],
})

register.registerMetric(activeConnections)
register.registerMetric(messagesProcessed)
register.registerMetric(eventsBroadcast)

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

// Redis client for pub/sub and session management
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || "redis://redis:6379",
})

const redisSubscriber = redis.createClient({
  url: process.env.REDIS_URL || "redis://redis:6379",
})

redisClient.connect().catch(console.error)
redisSubscriber.connect().catch(console.error)

// Middleware
app.use(helmet())
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS?.split(",") || ["http://localhost:3000"],
    credentials: true,
  }),
)
app.use(express.json())

// MongoDB connection
mongoose
  .connect(process.env.MONGODB_URI || "mongodb://mongodb:27017/skillsync_realtime", {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => logger.info("Connected to MongoDB"))
  .catch((err) => logger.error("MongoDB connection error:", err))

// Real-time Session Schema
const realtimeSessionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  socketId: { type: String, required: true },
  rooms: [String],
  userAgent: String,
  ipAddress: String,
  connectedAt: { type: Date, default: Date.now },
  lastActivity: { type: Date, default: Date.now },
  isActive: { type: Boolean, default: true },
})

const RealtimeSession = mongoose.model("RealtimeSession", realtimeSessionSchema)

// Real-time Event Schema
const realtimeEventSchema = new mongoose.Schema({
  type: { type: String, required: true },
  room: String,
  userId: mongoose.Schema.Types.ObjectId,
  data: Object,
  timestamp: { type: Date, default: Date.now },
  processed: { type: Boolean, default: false },
})

const RealtimeEvent = mongoose.model("RealtimeEvent", realtimeEventSchema)

// Socket.IO setup with authentication
const io = socketIo(server, {
  cors: {
    origin: process.env.ALLOWED_ORIGINS?.split(",") || ["http://localhost:3000"],
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"],
})

// Authentication middleware for Socket.IO
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token || socket.handshake.headers.authorization?.split(" ")[1]

    if (!token) {
      return next(new Error("Authentication token required"))
    }

    // Verify JWT token
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "your-secret-key")

    // Check if token is blacklisted
    const isBlacklisted = await redisClient.get(`blacklist:${token}`)
    if (isBlacklisted) {
      return next(new Error("Token has been revoked"))
    }

    socket.userId = decoded.id
    socket.userRole = decoded.role || "user"
    socket.username = decoded.username

    logger.info(`User ${socket.username} (${socket.userId}) authenticated for WebSocket`)
    next()
  } catch (error) {
    logger.error("WebSocket authentication failed:", error)
    next(new Error("Authentication failed"))
  }
})

// Connection tracking
const connectionRooms = new Map()

io.on("connection", async (socket) => {
  logger.info(`User ${socket.username} connected with socket ${socket.id}`)

  try {
    // Create session record
    const session = new RealtimeSession({
      userId: socket.userId,
      socketId: socket.id,
      userAgent: socket.handshake.headers["user-agent"],
      ipAddress: socket.handshake.address,
    })
    await session.save()

    // Join user to their personal room
    const personalRoom = `user:${socket.userId}`
    socket.join(personalRoom)
    connectionRooms.set(socket.id, new Set([personalRoom]))

    activeConnections.labels(personalRoom).inc()

    // Handle room joining
    socket.on("join_room", async (data) => {
      try {
        const { room, type } = data

        // Validate room access
        if (await canJoinRoom(socket.userId, room, type)) {
          socket.join(room)

          const userRooms = connectionRooms.get(socket.id) || new Set()
          userRooms.add(room)
          connectionRooms.set(socket.id, userRooms)

          activeConnections.labels(room).inc()

          // Update session
          await RealtimeSession.findOneAndUpdate(
            { socketId: socket.id },
            {
              $addToSet: { rooms: room },
              lastActivity: new Date(),
            },
          )

          socket.emit("room_joined", { room, success: true })
          socket.to(room).emit("user_joined", {
            userId: socket.userId,
            username: socket.username,
            room,
          })

          logger.info(`User ${socket.username} joined room ${room}`)
        } else {
          socket.emit("room_join_error", { room, error: "Access denied" })
        }
      } catch (error) {
        logger.error("Error joining room:", error)
        socket.emit("room_join_error", { room: data.room, error: "Internal error" })
      }
    })

    // Handle leaving rooms
    socket.on("leave_room", async (data) => {
      try {
        const { room } = data
        socket.leave(room)

        const userRooms = connectionRooms.get(socket.id) || new Set()
        userRooms.delete(room)
        connectionRooms.set(socket.id, userRooms)

        activeConnections.labels(room).dec()

        socket.to(room).emit("user_left", {
          userId: socket.userId,
          username: socket.username,
          room,
        })

        logger.info(`User ${socket.username} left room ${room}`)
      } catch (error) {
        logger.error("Error leaving room:", error)
      }
    })

    // Handle real-time messaging
    socket.on("send_message", async (data) => {
      try {
        const { room, message, type = "chat" } = data

        // Validate user is in room
        if (!socket.rooms.has(room)) {
          socket.emit("message_error", { error: "Not in room" })
          return
        }

        const messageData = {
          id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          userId: socket.userId,
          username: socket.username,
          message,
          type,
          timestamp: new Date(),
          room,
        }

        // Store message
        const event = new RealtimeEvent({
          type: "message",
          room,
          userId: socket.userId,
          data: messageData,
        })
        await event.save()

        // Broadcast to room
        io.to(room).emit("new_message", messageData)
        messagesProcessed.labels("chat", room).inc()

        logger.info(`Message sent by ${socket.username} in room ${room}`)
      } catch (error) {
        logger.error("Error sending message:", error)
        socket.emit("message_error", { error: "Failed to send message" })
      }
    })

    // Handle typing indicators
    socket.on("typing_start", (data) => {
      const { room } = data
      if (socket.rooms.has(room)) {
        socket.to(room).emit("user_typing", {
          userId: socket.userId,
          username: socket.username,
          room,
        })
      }
    })

    socket.on("typing_stop", (data) => {
      const { room } = data
      if (socket.rooms.has(room)) {
        socket.to(room).emit("user_stopped_typing", {
          userId: socket.userId,
          username: socket.username,
          room,
        })
      }
    })

    // Handle project collaboration events
    socket.on("project_update", async (data) => {
      try {
        const { projectId, updateType, updateData } = data
        const room = `project:${projectId}`

        if (socket.rooms.has(room)) {
          const collaborationEvent = {
            type: "project_collaboration",
            projectId,
            updateType,
            updateData,
            userId: socket.userId,
            username: socket.username,
            timestamp: new Date(),
          }

          // Store event
          const event = new RealtimeEvent({
            type: "project_update",
            room,
            userId: socket.userId,
            data: collaborationEvent,
          })
          await event.save()

          // Broadcast to project team
          socket.to(room).emit("project_updated", collaborationEvent)
          messagesProcessed.labels("project_update", room).inc()
        }
      } catch (error) {
        logger.error("Error handling project update:", error)
      }
    })

    // Handle presence updates
    socket.on("update_presence", async (data) => {
      try {
        const { status, activity } = data

        // Update session
        await RealtimeSession.findOneAndUpdate(
          { socketId: socket.id },
          {
            lastActivity: new Date(),
            "data.status": status,
            "data.activity": activity,
          },
        )

        // Broadcast presence to all user's rooms
        const userRooms = connectionRooms.get(socket.id) || new Set()
        userRooms.forEach((room) => {
          socket.to(room).emit("presence_updated", {
            userId: socket.userId,
            username: socket.username,
            status,
            activity,
            timestamp: new Date(),
          })
        })
      } catch (error) {
        logger.error("Error updating presence:", error)
      }
    })

    // Handle disconnection
    socket.on("disconnect", async (reason) => {
      logger.info(`User ${socket.username} disconnected: ${reason}`)

      try {
        // Update session
        await RealtimeSession.findOneAndUpdate(
          { socketId: socket.id },
          {
            isActive: false,
            disconnectedAt: new Date(),
            disconnectReason: reason,
          },
        )

        // Decrement connection counts
        const userRooms = connectionRooms.get(socket.id) || new Set()
        userRooms.forEach((room) => {
          activeConnections.labels(room).dec()
          socket.to(room).emit("user_disconnected", {
            userId: socket.userId,
            username: socket.username,
            room,
          })
        })

        connectionRooms.delete(socket.id)
      } catch (error) {
        logger.error("Error handling disconnect:", error)
      }
    })
  } catch (error) {
    logger.error("Error in socket connection:", error)
    socket.disconnect()
  }
})

// Room access control
async function canJoinRoom(userId, room, type) {
  try {
    // Personal rooms
    if (room.startsWith(`user:${userId}`)) {
      return true
    }

    // Project rooms - check if user is team member
    if (room.startsWith("project:")) {
      const projectId = room.split(":")[1]
      // Would check with project service if user is team member
      return true // Simplified for demo
    }

    // Matching rooms - check if user has matches
    if (room.startsWith("matching:")) {
      return true // Simplified for demo
    }

    // Public rooms
    if (type === "public") {
      return true
    }

    return false
  } catch (error) {
    logger.error("Error checking room access:", error)
    return false
  }
}

// RabbitMQ Connection for external events
let rabbitConnection = null
let rabbitChannel = null

async function connectRabbitMQ() {
  try {
    const rabbitmqUrl = process.env.RABBITMQ_URL || "amqp://admin:password123@rabbitmq:5672"
    rabbitConnection = await amqp.connect(rabbitmqUrl)
    rabbitChannel = await rabbitConnection.createChannel()

    await rabbitChannel.assertExchange("skill_sync_events", "topic", { durable: true })
    await rabbitChannel.assertQueue("websocket_events", { durable: true })

    // Bind to events that should trigger real-time updates
    await rabbitChannel.bindQueue("websocket_events", "skill_sync_events", "matching.completed")
    await rabbitChannel.bindQueue("websocket_events", "skill_sync_events", "project.updated")
    await rabbitChannel.bindQueue("websocket_events", "skill_sync_events", "notification.sent")

    logger.info("Connected to RabbitMQ")

    // Start consuming events
    consumeExternalEvents()
  } catch (error) {
    logger.error("RabbitMQ connection error:", error)
    setTimeout(connectRabbitMQ, 5000)
  }
}

// Consume external events and broadcast via WebSocket
async function consumeExternalEvents() {
  await rabbitChannel.consume("websocket_events", async (msg) => {
    if (msg) {
      try {
        const event = JSON.parse(msg.content.toString())
        await broadcastExternalEvent(event)
        rabbitChannel.ack(msg)
      } catch (error) {
        logger.error("Error processing external event:", error)
        rabbitChannel.nack(msg, false, false)
      }
    }
  })
}

async function broadcastExternalEvent(event) {
  try {
    switch (event.type) {
      case "matching.completed":
        // Notify user of new matches
        const userRoom = `user:${event.data.userId}`
        io.to(userRoom).emit("new_matches", {
          matchCount: event.data.matchCount,
          topMatches: event.data.topMatches,
          timestamp: new Date(),
        })
        eventsBroadcast.labels("new_matches").inc()
        break

      case "project.updated":
        // Notify project team of updates
        const projectRoom = `project:${event.data.projectId}`
        io.to(projectRoom).emit("project_external_update", {
          projectId: event.data.projectId,
          updateType: event.data.updateType,
          timestamp: new Date(),
        })
        eventsBroadcast.labels("project_update").inc()
        break

      case "notification.sent":
        // Real-time notification delivery
        const notificationRoom = `user:${event.data.userId}`
        io.to(notificationRoom).emit("new_notification", {
          notification: event.data.notification,
          timestamp: new Date(),
        })
        eventsBroadcast.labels("notification").inc()
        break
    }
  } catch (error) {
    logger.error("Error broadcasting external event:", error)
  }
}

// REST API endpoints
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    service: "websocket-service",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    activeConnections: io.engine.clientsCount,
    rabbitmq: rabbitConnection ? "connected" : "disconnected",
    redis: redisClient.isOpen ? "connected" : "disconnected",
  })
})

app.get("/metrics", async (req, res) => {
  res.set("Content-Type", register.contentType)
  res.end(await register.metrics())
})

// Get active sessions
app.get("/api/sessions", async (req, res) => {
  try {
    const sessions = await RealtimeSession.find({ isActive: true }).sort({ connectedAt: -1 }).limit(100)

    res.json({
      sessions,
      totalActive: sessions.length,
      totalConnections: io.engine.clientsCount,
    })
  } catch (error) {
    logger.error("Error fetching sessions:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Get room statistics
app.get("/api/rooms/stats", async (req, res) => {
  try {
    const roomStats = {}

    // Count connections per room
    for (const [socketId, rooms] of connectionRooms.entries()) {
      rooms.forEach((room) => {
        roomStats[room] = (roomStats[room] || 0) + 1
      })
    }

    res.json({
      rooms: roomStats,
      totalRooms: Object.keys(roomStats).length,
      totalConnections: io.engine.clientsCount,
    })
  } catch (error) {
    logger.error("Error fetching room stats:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Broadcast message to room (admin endpoint)
app.post("/api/broadcast", async (req, res) => {
  try {
    const { room, message, type = "system" } = req.body

    const broadcastData = {
      id: `broadcast_${Date.now()}`,
      message,
      type,
      timestamp: new Date(),
      room,
    }

    io.to(room).emit("broadcast_message", broadcastData)
    eventsBroadcast.labels("broadcast").inc()

    res.json({ success: true, broadcast: broadcastData })
  } catch (error) {
    logger.error("Error broadcasting message:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Error handling
app.use((error, req, res, next) => {
  logger.error("WebSocket service error:", error)
  res.status(500).json({ error: "Internal server error" })
})

// Initialize connections
connectRabbitMQ()

// Graceful shutdown
process.on("SIGTERM", () => {
  logger.info("SIGTERM received, shutting down gracefully")

  io.close(() => {
    logger.info("WebSocket server closed")
  })

  if (rabbitConnection) {
    rabbitConnection.close()
  }

  redisClient.quit()
  redisSubscriber.quit()

  mongoose.connection.close(() => {
    logger.info("MongoDB connection closed")
    process.exit(0)
  })
})

server.listen(PORT, () => {
  logger.info(`WebSocket Service running on port ${PORT}`)
  logger.info(`Socket.IO server ready for connections`)
})

module.exports = { app, server, io }
