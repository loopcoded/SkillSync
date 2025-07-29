const express = require("express")
const mongoose = require("mongoose")
const axios = require("axios")
const cors = require("cors")
const helmet = require("helmet")
const rateLimit = require("express-rate-limit")
const Joi = require("joi")
const amqp = require("amqplib")
const promClient = require("prom-client")
const winston = require("winston")
const { v4: uuidv4 } = require("uuid")
require("dotenv").config()

const app = express()
const PORT = process.env.PORT || 3002

// Logging setup
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console(), new winston.transports.File({ filename: "logs/project-service.log" })],
})

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

// Middleware
app.use(helmet())
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS?.split(",") || ["http://localhost:3000"],
    credentials: true,
  }),
)

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
})
app.use(limiter)

app.use(express.json({ limit: "10mb" }))

// Middleware to track metrics
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

// Project Schema
const projectSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String, required: true },
  category: { type: String, required: true },
  difficulty: { type: String, enum: ["Beginner", "Intermediate", "Advanced"], required: true },
  estimatedDuration: { type: String, required: true },
  requiredSkills: [String],
  optionalSkills: [String],
  learningObjectives: [String],
  resources: [
    {
      title: String,
      url: String,
      type: { type: String, enum: ["documentation", "tutorial", "video", "article", "tool"] },
    },
  ],
  tags: [String],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  collaborators: [
    {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      role: { type: String, enum: ["owner", "collaborator", "contributor"] },
      joinedAt: { type: Date, default: Date.now },
    },
  ],
  status: {
    type: String,
    enum: ["draft", "active", "completed", "archived"],
    default: "draft",
  },
  visibility: {
    type: String,
    enum: ["public", "private", "team"],
    default: "public",
  },
  stats: {
    views: { type: Number, default: 0 },
    likes: { type: Number, default: 0 },
    forks: { type: Number, default: 0 },
    completions: { type: Number, default: 0 },
  },
  milestones: [
    {
      title: String,
      description: String,
      dueDate: Date,
      completed: { type: Boolean, default: false },
      completedAt: Date,
    },
  ],
  repository: {
    url: String,
    branch: String,
    isPrivate: { type: Boolean, default: false },
  },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
})

const Project = mongoose.model("Project", projectSchema)

// RabbitMQ connection
let channel
async function connectRabbitMQ() {
  try {
    const connection = await amqp.connect(process.env.RABBITMQ_URL || "amqp://localhost")
    channel = await connection.createChannel()

    await channel.assertExchange("project_events", "topic", { durable: true })
    await channel.assertQueue("project_created", { durable: true })
    await channel.assertQueue("project_updated", { durable: true })

    logger.info("Connected to RabbitMQ")
  } catch (error) {
    logger.error("RabbitMQ connection error:", error)
  }
}

// Validation schemas
const projectCreateSchema = Joi.object({
  title: Joi.string().required(),
  description: Joi.string().required(),
  category: Joi.string().required(),
  difficulty: Joi.string().valid("Beginner", "Intermediate", "Advanced").required(),
  estimatedDuration: Joi.string().required(),
  requiredSkills: Joi.array().items(Joi.string()).required(),
  optionalSkills: Joi.array().items(Joi.string()),
  learningObjectives: Joi.array().items(Joi.string()),
  resources: Joi.array().items(
    Joi.object({
      title: Joi.string().required(),
      url: Joi.string().uri().required(),
      type: Joi.string().valid("documentation", "tutorial", "video", "article", "tool").required(),
    }),
  ),
  tags: Joi.array().items(Joi.string()),
  visibility: Joi.string().valid("public", "private", "team"),
  milestones: Joi.array().items(
    Joi.object({
      title: Joi.string().required(),
      description: Joi.string(),
      dueDate: Joi.date(),
    }),
  ),
  repository: Joi.object({
    url: Joi.string().uri(),
    branch: Joi.string(),
    isPrivate: Joi.boolean(),
  }),
})

// Routes
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    service: "project-ideas-service",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  })
})

app.get("/metrics", async (req, res) => {
  res.set("Content-Type", register.contentType)
  res.end(await register.metrics())
})

// Create project
app.post("/api/projects", async (req, res) => {
  try {
    const { error, value } = projectCreateSchema.validate(req.body)
    if (error) {
      return res.status(400).json({ error: error.details[0].message })
    }

    const project = new Project({
      ...value,
      createdBy: req.headers["user-id"] || null,
      collaborators: req.headers["user-id"] ? [{ userId: req.headers["user-id"], role: "owner" }] : [],
    })

    await project.save()

    // Publish project created event
    if (channel) {
      const eventData = {
        projectId: project._id,
        title: project.title,
        category: project.category,
        requiredSkills: project.requiredSkills,
        createdBy: project.createdBy,
        timestamp: new Date().toISOString(),
      }

      await channel.publish("project_events", "project.created", Buffer.from(JSON.stringify(eventData)))
    }

    logger.info(`Project created: ${project.title}`)

    res.status(201).json({
      message: "Project created successfully",
      project,
    })
  } catch (error) {
    logger.error("Create project error:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Get all projects
app.get("/api/projects", async (req, res) => {
  try {
    const { page = 1, limit = 20, category, difficulty, skills, tags, search, status = "active" } = req.query

    const query = {
      isActive: true,
      status: status,
      visibility: "public",
    }

    if (category) {
      query.category = category
    }

    if (difficulty) {
      query.difficulty = difficulty
    }

    if (skills) {
      const skillsArray = skills.split(",").map((skill) => skill.trim())
      query.requiredSkills = { $in: skillsArray }
    }

    if (tags) {
      const tagsArray = tags.split(",").map((tag) => tag.trim())
      query.tags = { $in: tagsArray }
    }

    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
        { tags: { $in: [new RegExp(search, "i")] } },
      ]
    }

    const projects = await Project.find(query)
      .populate("createdBy", "profile.firstName profile.lastName")
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)

    const total = await Project.countDocuments(query)

    res.json({
      projects,
      pagination: {
        current: page,
        pages: Math.ceil(total / limit),
        total,
      },
    })
  } catch (error) {
    logger.error("Get projects error:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Get project by ID
app.get("/api/projects/:id", async (req, res) => {
  try {
    const project = await Project.findById(req.params.id)
      .populate("createdBy", "profile.firstName profile.lastName profile.avatar")
      .populate("collaborators.userId", "profile.firstName profile.lastName profile.avatar")

    if (!project) {
      return res.status(404).json({ error: "Project not found" })
    }

    // Increment view count
    project.stats.views += 1
    await project.save()

    res.json(project)
  } catch (error) {
    logger.error("Get project error:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Update project
app.put("/api/projects/:id", async (req, res) => {
  try {
    const project = await Project.findById(req.params.id)
    if (!project) {
      return res.status(404).json({ error: "Project not found" })
    }

    // Check if user is owner or collaborator
    const userId = req.headers["user-id"]
    const isOwner = project.createdBy?.toString() === userId
    const isCollaborator = project.collaborators.some(
      (collab) => collab.userId.toString() === userId && ["owner", "collaborator"].includes(collab.role),
    )

    if (!isOwner && !isCollaborator) {
      return res.status(403).json({ error: "Not authorized to update this project" })
    }

    // Update project
    Object.assign(project, req.body)
    project.updatedAt = new Date()
    await project.save()

    // Publish project updated event
    if (channel) {
      const eventData = {
        projectId: project._id,
        title: project.title,
        updatedBy: userId,
        timestamp: new Date().toISOString(),
      }

      await channel.publish("project_events", "project.updated", Buffer.from(JSON.stringify(eventData)))
    }

    logger.info(`Project updated: ${project.title}`)

    res.json({
      message: "Project updated successfully",
      project,
    })
  } catch (error) {
    logger.error("Update project error:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Join project
app.post("/api/projects/:id/join", async (req, res) => {
  try {
    const project = await Project.findById(req.params.id)
    if (!project) {
      return res.status(404).json({ error: "Project not found" })
    }

    const userId = req.headers["user-id"]
    if (!userId) {
      return res.status(401).json({ error: "User ID required" })
    }

    // Check if already a collaborator
    const existingCollaborator = project.collaborators.find((collab) => collab.userId.toString() === userId)

    if (existingCollaborator) {
      return res.status(409).json({ error: "Already a collaborator" })
    }

    // Add as collaborator
    project.collaborators.push({
      userId: userId,
      role: "contributor",
    })

    await project.save()

    logger.info(`User ${userId} joined project: ${project.title}`)

    res.json({
      message: "Successfully joined project",
      project,
    })
  } catch (error) {
    logger.error("Join project error:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Get project categories
app.get("/api/projects/meta/categories", async (req, res) => {
  try {
    const categories = await Project.distinct("category", { isActive: true })
    res.json(categories)
  } catch (error) {
    logger.error("Get categories error:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Get popular skills
app.get("/api/projects/meta/skills", async (req, res) => {
  try {
    const skills = await Project.aggregate([
      { $match: { isActive: true } },
      { $unwind: "$requiredSkills" },
      { $group: { _id: "$requiredSkills", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 50 },
    ])

    res.json(skills.map((skill) => skill._id))
  } catch (error) {
    logger.error("Get skills error:", error)
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
  logger.info(`Project Ideas Service running on port ${PORT}`)
  await connectRabbitMQ()
})

module.exports = app
