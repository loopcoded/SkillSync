const express = require("express")
const mongoose = require("mongoose")
const cors = require("cors")
const helmet = require("helmet")
const rateLimit = require("express-rate-limit")
const bcrypt = require("bcryptjs")
const jwt = require("jsonwebtoken")
const Joi = require("joi")
const amqp = require("amqplib")
const winston = require("winston")
const promClient = require("prom-client")

const app = express()
const PORT = process.env.PORT || 3001

// Prometheus metrics
const register = new promClient.Registry()
promClient.collectDefaultMetrics({ register })

const httpRequestDuration = new promClient.Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.1, 0.5, 1, 2, 5],
})
register.registerMetric(httpRequestDuration)

// Logger setup
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console(), new winston.transports.File({ filename: "logs/user-service.log" })],
})

// Middleware
app.use(helmet())
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS?.split(",") || ["http://localhost:3000"],
    credentials: true,
  }),
)

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
})
app.use(limiter)

app.use(express.json({ limit: "10mb" }))

// Request timing middleware
app.use((req, res, next) => {
  const start = Date.now()
  res.on("finish", () => {
    const duration = (Date.now() - start) / 1000
    httpRequestDuration.labels(req.method, req.route?.path || req.path, res.statusCode).observe(duration)
  })
  next()
})

// MongoDB connection
mongoose
  .connect(process.env.MONGODB_URI || "mongodb://localhost:27017/skillsync", {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => logger.info("Connected to MongoDB"))
  .catch((err) => logger.error("MongoDB connection error:", err))

// User Schema
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  profile: {
    firstName: String,
    lastName: String,
    bio: String,
    skills: [String],
    experience: String,
    location: String,
    avatar: String,
    linkedin: String,
    github: String,
    portfolio: String,
  },
  preferences: {
    projectTypes: [String],
    workStyle: String,
    availability: String,
    timezone: String,
  },
  stats: {
    projectsCompleted: { type: Number, default: 0 },
    rating: { type: Number, default: 0 },
    totalRatings: { type: Number, default: 0 },
  },
  isActive: { type: Boolean, default: true },
  lastLogin: Date,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
})

const User = mongoose.model("User", userSchema)

// RabbitMQ connection
let channel
async function connectRabbitMQ() {
  try {
    const connection = await amqp.connect(process.env.RABBITMQ_URL || "amqp://localhost")
    channel = await connection.createChannel()

    // Declare exchanges and queues
    await channel.assertExchange("user_events", "topic", { durable: true })
    await channel.assertQueue("user_created", { durable: true })
    await channel.assertQueue("user_updated", { durable: true })

    logger.info("Connected to RabbitMQ")
  } catch (error) {
    logger.error("RabbitMQ connection error:", error)
  }
}

// Validation schemas
const userRegistrationSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().min(8).required(),
  profile: Joi.object({
    firstName: Joi.string().required(),
    lastName: Joi.string().required(),
    bio: Joi.string(),
    skills: Joi.array().items(Joi.string()),
    experience: Joi.string(),
    location: Joi.string(),
    linkedin: Joi.string().uri(),
    github: Joi.string().uri(),
    portfolio: Joi.string().uri(),
  }),
})

const userUpdateSchema = Joi.object({
  profile: Joi.object({
    firstName: Joi.string(),
    lastName: Joi.string(),
    bio: Joi.string(),
    skills: Joi.array().items(Joi.string()),
    experience: Joi.string(),
    location: Joi.string(),
    avatar: Joi.string().uri(),
    linkedin: Joi.string().uri(),
    github: Joi.string().uri(),
    portfolio: Joi.string().uri(),
  }),
  preferences: Joi.object({
    projectTypes: Joi.array().items(Joi.string()),
    workStyle: Joi.string(),
    availability: Joi.string(),
    timezone: Joi.string(),
  }),
})

// Auth middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"]
  const token = authHeader && authHeader.split(" ")[1]

  if (!token) {
    return res.status(401).json({ error: "Access token required" })
  }

  jwt.verify(token, process.env.JWT_SECRET || "your-secret-key", (err, user) => {
    if (err) {
      return res.status(403).json({ error: "Invalid token" })
    }
    req.user = user
    next()
  })
}

// Routes
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    service: "user-profile-service",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  })
})

app.get("/metrics", async (req, res) => {
  res.set("Content-Type", register.contentType)
  res.end(await register.metrics())
})

// User registration
app.post("/api/users/register", async (req, res) => {
  try {
    const { error, value } = userRegistrationSchema.validate(req.body)
    if (error) {
      return res.status(400).json({ error: error.details[0].message })
    }

    const { email, password, profile } = value

    // Check if user exists
    const existingUser = await User.findOne({ email })
    if (existingUser) {
      return res.status(409).json({ error: "User already exists" })
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12)

    // Create user
    const user = new User({
      email,
      password: hashedPassword,
      profile,
    })

    await user.save()

    // Publish user created event
    if (channel) {
      const eventData = {
        userId: user._id,
        email: user.email,
        profile: user.profile,
        timestamp: new Date().toISOString(),
      }

      await channel.publish("user_events", "user.created", Buffer.from(JSON.stringify(eventData)))
    }

    // Generate JWT token
    const token = jwt.sign({ userId: user._id, email: user.email }, process.env.JWT_SECRET || "your-secret-key", {
      expiresIn: "24h",
    })

    logger.info(`User registered: ${email}`)

    res.status(201).json({
      message: "User registered successfully",
      token,
      user: {
        id: user._id,
        email: user.email,
        profile: user.profile,
      },
    })
  } catch (error) {
    logger.error("Registration error:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// User login
app.post("/api/users/login", async (req, res) => {
  try {
    const { email, password } = req.body

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" })
    }

    // Find user
    const user = await User.findOne({ email })
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" })
    }

    // Check password
    const isValidPassword = await bcrypt.compare(password, user.password)
    if (!isValidPassword) {
      return res.status(401).json({ error: "Invalid credentials" })
    }

    // Update last login
    user.lastLogin = new Date()
    await user.save()

    // Generate JWT token
    const token = jwt.sign({ userId: user._id, email: user.email }, process.env.JWT_SECRET || "your-secret-key", {
      expiresIn: "24h",
    })

    logger.info(`User logged in: ${email}`)

    res.json({
      message: "Login successful",
      token,
      user: {
        id: user._id,
        email: user.email,
        profile: user.profile,
        preferences: user.preferences,
        stats: user.stats,
      },
    })
  } catch (error) {
    logger.error("Login error:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Get user profile
app.get("/api/users/profile", authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select("-password")
    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }

    res.json(user)
  } catch (error) {
    logger.error("Get profile error:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Update user profile
app.put("/api/users/profile", authenticateToken, async (req, res) => {
  try {
    const { error, value } = userUpdateSchema.validate(req.body)
    if (error) {
      return res.status(400).json({ error: error.details[0].message })
    }

    const user = await User.findById(req.user.userId)
    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }

    // Update user fields
    if (value.profile) {
      user.profile = { ...user.profile, ...value.profile }
    }
    if (value.preferences) {
      user.preferences = { ...user.preferences, ...value.preferences }
    }
    user.updatedAt = new Date()

    await user.save()

    // Publish user updated event
    if (channel) {
      const eventData = {
        userId: user._id,
        email: user.email,
        profile: user.profile,
        preferences: user.preferences,
        timestamp: new Date().toISOString(),
      }

      await channel.publish("user_events", "user.updated", Buffer.from(JSON.stringify(eventData)))
    }

    logger.info(`User profile updated: ${user.email}`)

    res.json({
      message: "Profile updated successfully",
      user: {
        id: user._id,
        email: user.email,
        profile: user.profile,
        preferences: user.preferences,
        stats: user.stats,
      },
    })
  } catch (error) {
    logger.error("Update profile error:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Get users by skills
app.get("/api/users/by-skills", authenticateToken, async (req, res) => {
  try {
    const { skills } = req.query
    if (!skills) {
      return res.status(400).json({ error: "Skills parameter required" })
    }

    const skillsArray = skills.split(",").map((skill) => skill.trim())

    const users = await User.find({
      "profile.skills": { $in: skillsArray },
      _id: { $ne: req.user.userId },
      isActive: true,
    })
      .select("-password")
      .limit(20)

    res.json(users)
  } catch (error) {
    logger.error("Get users by skills error:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Search users
app.get("/api/users/search", authenticateToken, async (req, res) => {
  try {
    const { q, skills, location, experience } = req.query

    const query = {
      _id: { $ne: req.user.userId },
      isActive: true,
    }

    if (q) {
      query.$or = [
        { "profile.firstName": { $regex: q, $options: "i" } },
        { "profile.lastName": { $regex: q, $options: "i" } },
        { "profile.bio": { $regex: q, $options: "i" } },
      ]
    }

    if (skills) {
      const skillsArray = skills.split(",").map((skill) => skill.trim())
      query["profile.skills"] = { $in: skillsArray }
    }

    if (location) {
      query["profile.location"] = { $regex: location, $options: "i" }
    }

    if (experience) {
      query["profile.experience"] = experience
    }

    const users = await User.find(query)
      .select("-password")
      .sort({ "stats.rating": -1, "stats.projectsCompleted": -1 })
      .limit(50)

    res.json(users)
  } catch (error) {
    logger.error("Search users error:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Get user by ID
app.get("/api/users/:id", authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select("-password")
    if (!user) {
      return res.status(404).json({ error: "User not found" })
    }

    res.json(user)
  } catch (error) {
    logger.error("Get user by ID error:", error)
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

// Start server
app.listen(PORT, async () => {
  logger.info(`User Profile Service running on port ${PORT}`)
  await connectRabbitMQ()
})

module.exports = app
