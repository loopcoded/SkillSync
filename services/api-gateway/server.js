const express = require("express")
const { createProxyMiddleware } = require("http-proxy-middleware")
const cors = require("cors")
const helmet = require("helmet")
const rateLimit = require("express-rate-limit")
const promClient = require("prom-client")
const winston = require("winston")
const jwt = require("jsonwebtoken")
const redis = require("redis")
require("dotenv").config()

const app = express()
const PORT = process.env.PORT || 8080

// Prometheus metrics
const register = new promClient.Registry()
promClient.collectDefaultMetrics({ register })

const httpRequestsTotal = new promClient.Counter({
  name: "gateway_http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "service", "status_code"],
})

const httpRequestDuration = new promClient.Histogram({
  name: "gateway_http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "service"],
  buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10],
})

const activeConnections = new promClient.Gauge({
  name: "gateway_active_connections",
  help: "Number of active connections",
})

register.registerMetric(httpRequestsTotal)
register.registerMetric(httpRequestDuration)
register.registerMetric(activeConnections)

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

// Redis client for caching and rate limiting
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || "redis://redis:6379",
})

redisClient.on("error", (err) => {
  logger.error("Redis Client Error", err)
})

redisClient.connect().catch(console.error)

// Middleware
app.use(helmet())
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS?.split(",") || ["http://localhost:3000"],
    credentials: true,
  }),
)
app.use(express.json({ limit: "10mb" }))

// Global rate limiting
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // limit each IP to 1000 requests per windowMs
  message: "Too many requests from this IP, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
})
app.use(globalLimiter)

// Service-specific rate limiting
const serviceLimiters = {
  users: rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: "Too many requests to user service",
  }),
  projects: rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    message: "Too many requests to project service",
  }),
  matching: rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: "Too many requests to matching service",
  }),
  notifications: rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 150,
    message: "Too many requests to notification service",
  }),
}

// Connection tracking
let connectionCount = 0

app.use((req, res, next) => {
  connectionCount++
  activeConnections.set(connectionCount)

  res.on("finish", () => {
    connectionCount--
    activeConnections.set(connectionCount)
  })

  next()
})

// Request logging and metrics
app.use((req, res, next) => {
  const start = Date.now()

  res.on("finish", () => {
    const duration = (Date.now() - start) / 1000
    const service = getServiceFromPath(req.path)

    httpRequestsTotal.labels(req.method, req.path, service, res.statusCode).inc()
    httpRequestDuration.labels(req.method, req.path, service).observe(duration)

    logger.info({
      method: req.method,
      url: req.url,
      statusCode: res.statusCode,
      duration: `${duration}s`,
      service: service,
      userAgent: req.get("User-Agent"),
      ip: req.ip,
    })
  })

  next()
})

// Authentication middleware
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers["authorization"]
  const token = authHeader && authHeader.split(" ")[1]

  if (!token) {
    return res.status(401).json({ error: "Access token required" })
  }

  try {
    // Check if token is blacklisted
    const isBlacklisted = await redisClient.get(`blacklist:${token}`)
    if (isBlacklisted) {
      return res.status(401).json({ error: "Token has been revoked" })
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || "your-secret-key")
    req.user = decoded
    next()
  } catch (error) {
    logger.error("Token verification failed:", error)
    return res.status(403).json({ error: "Invalid or expired token" })
  }
}

// Optional authentication (for public endpoints)
const optionalAuth = async (req, res, next) => {
  const authHeader = req.headers["authorization"]
  const token = authHeader && authHeader.split(" ")[1]

  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || "your-secret-key")
      req.user = decoded
    } catch (error) {
      // Continue without authentication
      logger.warn("Optional auth failed:", error.message)
    }
  }

  next()
}

// Cache middleware
const cacheMiddleware = (duration = 300) => {
  return async (req, res, next) => {
    if (req.method !== "GET") {
      return next()
    }

    const cacheKey = `cache:${req.originalUrl}`

    try {
      const cachedResponse = await redisClient.get(cacheKey)
      if (cachedResponse) {
        logger.info(`Cache hit for ${req.originalUrl}`)
        return res.json(JSON.parse(cachedResponse))
      }
    } catch (error) {
      logger.error("Cache read error:", error)
    }

    // Override res.json to cache the response
    const originalJson = res.json
    res.json = function (data) {
      // Cache successful responses
      if (res.statusCode === 200) {
        redisClient.setEx(cacheKey, duration, JSON.stringify(data)).catch((err) => {
          logger.error("Cache write error:", err)
        })
      }
      return originalJson.call(this, data)
    }

    next()
  }
}

// Service configuration
const services = {
  "user-profile": {
    target: process.env.USER_PROFILE_SERVICE_URL || "http://user-profile-service:3001",
    pathRewrite: { "^/api/users": "/api/users" },
  },
  "project-ideas": {
    target: process.env.PROJECT_IDEAS_SERVICE_URL || "http://project-ideas-service:3002",
    pathRewrite: { "^/api/projects": "/api/projects" },
  },
  matching: {
    target: process.env.MATCHING_SERVICE_URL || "http://matching-service:3003",
    pathRewrite: { "^/api/matches": "/api/matches" },
  },
  "content-ingestion": {
    target: process.env.CONTENT_INGESTION_SERVICE_URL || "http://content-ingestion-service:3004",
    pathRewrite: { "^/api/content": "/api/content" },
  },
  notification: {
    target: process.env.NOTIFICATION_SERVICE_URL || "http://notification-service:3005",
    pathRewrite: { "^/api/notifications": "/api/notifications" },
  },
}

// Helper function to determine service from path
function getServiceFromPath(path) {
  if (path.startsWith("/api/users")) return "user-profile"
  if (path.startsWith("/api/projects")) return "project-ideas"
  if (path.startsWith("/api/matches")) return "matching"
  if (path.startsWith("/api/content")) return "content-ingestion"
  if (path.startsWith("/api/notifications")) return "notification"
  return "unknown"
}

// Health check endpoint
app.get("/health", async (req, res) => {
  const healthChecks = await Promise.allSettled(
    Object.entries(services).map(async ([name, config]) => {
      try {
        const response = await fetch(`${config.target}/health`, { timeout: 5000 })
        return { service: name, status: response.ok ? "healthy" : "unhealthy" }
      } catch (error) {
        return { service: name, status: "unhealthy", error: error.message }
      }
    }),
  )

  const serviceHealth = healthChecks.map((result) => result.value || result.reason)

  res.json({
    status: "healthy",
    service: "api-gateway",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    services: serviceHealth,
    redis: redisClient.isOpen ? "connected" : "disconnected",
  })
})

// Metrics endpoint
app.get("/metrics", async (req, res) => {
  res.set("Content-Type", register.contentType)
  res.end(await register.metrics())
})

// Authentication endpoints
app.post("/api/auth/login", async (req, res) => {
  try {
    // Forward to user service for authentication
    const response = await fetch(`${services["user-profile"].target}/api/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req.body),
    })

    const data = await response.json()

    if (response.ok && data.token) {
      // Store user session in Redis
      await redisClient.setEx(`session:${data.user.id}`, 86400, JSON.stringify(data.user)) // 24 hours
    }

    res.status(response.status).json(data)
  } catch (error) {
    logger.error("Login error:", error)
    res.status(500).json({ error: "Authentication service unavailable" })
  }
})

app.post("/api/auth/logout", authenticateToken, async (req, res) => {
  try {
    const token = req.headers["authorization"].split(" ")[1]

    // Blacklist the token
    await redisClient.setEx(`blacklist:${token}`, 86400, "true") // 24 hours

    // Remove user session
    await redisClient.del(`session:${req.user.id}`)

    res.json({ message: "Logged out successfully" })
  } catch (error) {
    logger.error("Logout error:", error)
    res.status(500).json({ error: "Logout failed" })
  }
})

// Proxy configurations with different auth requirements

// Public endpoints (no auth required)
app.use(
  "/api/users",
  optionalAuth,
  serviceLimiters.users,
  cacheMiddleware(300), // 5 minutes cache
  createProxyMiddleware({
    target: services["user-profile"].target,
    changeOrigin: true,
    pathRewrite: services["user-profile"].pathRewrite,
    onError: (err, req, res) => {
      logger.error("User service proxy error:", err)
      res.status(503).json({ error: "User service unavailable" })
    },
  }),
)

app.use(
  "/api/projects",
  optionalAuth,
  serviceLimiters.projects,
  cacheMiddleware(180), // 3 minutes cache
  createProxyMiddleware({
    target: services["project-ideas"].target,
    changeOrigin: true,
    pathRewrite: services["project-ideas"].pathRewrite,
    onError: (err, req, res) => {
      logger.error("Project service proxy error:", err)
      res.status(503).json({ error: "Project service unavailable" })
    },
  }),
)

// Protected endpoints (auth required)
app.use(
  "/api/matches",
  authenticateToken,
  serviceLimiters.matching,
  createProxyMiddleware({
    target: services.matching.target,
    changeOrigin: true,
    pathRewrite: services.matching.pathRewrite,
    onProxyReq: (proxyReq, req) => {
      // Add user context to the request
      proxyReq.setHeader("X-User-ID", req.user.id)
      proxyReq.setHeader("X-User-Role", req.user.role || "user")
    },
    onError: (err, req, res) => {
      logger.error("Matching service proxy error:", err)
      res.status(503).json({ error: "Matching service unavailable" })
    },
  }),
)

app.use(
  "/api/content",
  optionalAuth,
  cacheMiddleware(600), // 10 minutes cache
  createProxyMiddleware({
    target: services["content-ingestion"].target,
    changeOrigin: true,
    pathRewrite: services["content-ingestion"].pathRewrite,
    onError: (err, req, res) => {
      logger.error("Content service proxy error:", err)
      res.status(503).json({ error: "Content service unavailable" })
    },
  }),
)

app.use(
  "/api/notifications",
  authenticateToken,
  serviceLimiters.notifications,
  createProxyMiddleware({
    target: services.notification.target,
    changeOrigin: true,
    pathRewrite: services.notification.pathRewrite,
    onProxyReq: (proxyReq, req) => {
      proxyReq.setHeader("X-User-ID", req.user.id)
    },
    onError: (err, req, res) => {
      logger.error("Notification service proxy error:", err)
      res.status(503).json({ error: "Notification service unavailable" })
    },
  }),
)

// WebSocket proxy for real-time features
const { createProxyMiddleware: createWsProxy } = require("http-proxy-middleware")

app.use(
  "/ws",
  createWsProxy({
    target: "ws://notification-service:3005",
    ws: true,
    changeOrigin: true,
    onError: (err, req, res) => {
      logger.error("WebSocket proxy error:", err)
    },
  }),
)

// API documentation endpoint
app.get("/api/docs", (req, res) => {
  res.json({
    title: "Skill Sync API Gateway",
    version: "1.0.0",
    description: "Centralized API Gateway for Skill Sync Platform",
    services: {
      "User Profile Service": {
        baseUrl: "/api/users",
        description: "User management and profiles",
        endpoints: [
          "GET /api/users - List users",
          "GET /api/users/:id - Get user by ID",
          "POST /api/users - Create user",
          "PUT /api/users/:id - Update user",
        ],
      },
      "Project Ideas Service": {
        baseUrl: "/api/projects",
        description: "Project management and collaboration",
        endpoints: [
          "GET /api/projects - List projects",
          "GET /api/projects/:id - Get project by ID",
          "POST /api/projects - Create project",
          "PUT /api/projects/:id - Update project",
        ],
      },
      "Matching Service": {
        baseUrl: "/api/matches",
        description: "AI-powered matching and recommendations",
        auth: "required",
        endpoints: [
          "GET /api/matches/user/:userId - Get user matches",
          "GET /api/matches/project/:projectId - Get project matches",
          "POST /api/matches/generate - Generate matches",
        ],
      },
      "Content Ingestion Service": {
        baseUrl: "/api/content",
        description: "Content processing and recommendations",
        endpoints: [
          "GET /api/content/raw - Get raw content",
          "POST /api/content/ingest - Ingest content",
          "GET /api/content/stats - Get content statistics",
        ],
      },
      "Notification Service": {
        baseUrl: "/api/notifications",
        description: "Multi-channel notifications",
        auth: "required",
        endpoints: [
          "GET /api/notifications/:userId - Get user notifications",
          "PUT /api/notifications/:id/read - Mark as read",
          "POST /api/notifications/send - Send notification",
        ],
      },
    },
    authentication: {
      type: "Bearer Token",
      header: "Authorization: Bearer <token>",
      endpoints: {
        login: "POST /api/auth/login",
        logout: "POST /api/auth/logout",
      },
    },
  })
})

// Error handling middleware
app.use((error, req, res, next) => {
  logger.error("Gateway error:", error)
  res.status(500).json({ error: "Internal gateway error" })
})

// 404 handler
app.use("*", (req, res) => {
  res.status(404).json({ error: "Endpoint not found" })
})

// Graceful shutdown
process.on("SIGTERM", () => {
  logger.info("SIGTERM received, shutting down gracefully")
  redisClient.quit()
  process.exit(0)
})

app.listen(PORT, () => {
  logger.info(`API Gateway running on port ${PORT}`)
  logger.info("Available services:", Object.keys(services))
})

module.exports = app
