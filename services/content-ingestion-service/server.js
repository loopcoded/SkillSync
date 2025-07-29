const express = require("express")
const mongoose = require("mongoose")
const cors = require("cors")
const helmet = require("helmet")
const rateLimit = require("express-rate-limit")
const promClient = require("prom-client")
const winston = require("winston")
const amqp = require("amqplib")
const axios = require("axios")
require("dotenv").config()

const app = express()
const PORT = process.env.PORT || 3004

// Prometheus metrics
const register = new promClient.Registry()
promClient.collectDefaultMetrics({ register })

const contentIngested = new promClient.Counter({
  name: "content_ingested_total",
  help: "Total number of content items ingested",
  labelNames: ["type", "source"],
})

const processingTime = new promClient.Histogram({
  name: "content_processing_duration_seconds",
  help: "Time taken to process content",
  buckets: [0.1, 0.5, 1, 2, 5, 10],
})

register.registerMetric(contentIngested)
register.registerMetric(processingTime)

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
  max: 100,
})
app.use(limiter)

// MongoDB connection
mongoose
  .connect(process.env.MONGODB_URI || "mongodb://mongodb:27017/skillsync_content", {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => logger.info("Connected to MongoDB"))
  .catch((err) => logger.error("MongoDB connection error:", err))

// Content Source Schema
const contentSourceSchema = new mongoose.Schema({
  name: { type: String, required: true },
  url: { type: String, required: true },
  type: { type: String, enum: ["rss", "api", "scraper", "manual"], required: true },
  isActive: { type: Boolean, default: true },
  lastFetched: Date,
  fetchInterval: { type: Number, default: 3600 }, // seconds
  config: {
    apiKey: String,
    headers: Object,
    selectors: Object, // For scraping
  },
  createdAt: { type: Date, default: Date.now },
})

const ContentSource = mongoose.model("ContentSource", contentSourceSchema)

// Raw Content Schema
const rawContentSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: String,
  url: { type: String, required: true },
  content: String, // Full content if available
  author: String,
  publishedAt: Date,
  source: { type: String, required: true },
  sourceId: String, // ID from the source system
  type: { type: String, enum: ["article", "course", "tutorial", "documentation", "video", "podcast"] },
  tags: [String],
  metadata: Object, // Additional metadata from source
  processed: { type: Boolean, default: false },
  processingError: String,
  createdAt: { type: Date, default: Date.now },
})

// Add index for efficient querying
rawContentSchema.index({ source: 1, sourceId: 1 }, { unique: true })
rawContentSchema.index({ processed: 1, createdAt: -1 })

const RawContent = mongoose.model("RawContent", rawContentSchema)

// RabbitMQ Connection
let rabbitConnection = null
let rabbitChannel = null

async function connectRabbitMQ() {
  try {
    const rabbitmqUrl = process.env.RABBITMQ_URL || "amqp://admin:password123@rabbitmq:5672"
    rabbitConnection = await amqp.connect(rabbitmqUrl)
    rabbitChannel = await rabbitConnection.createChannel()

    await rabbitChannel.assertExchange("skill_sync_events", "topic", { durable: true })
    await rabbitChannel.assertQueue("content_processing", { durable: true })

    logger.info("Connected to RabbitMQ")
  } catch (error) {
    logger.error("RabbitMQ connection error:", error)
    setTimeout(connectRabbitMQ, 5000)
  }
}

// Content processing functions
async function processContent(rawContent) {
  const start = Date.now()

  try {
    // Extract skills and keywords from content
    const extractedData = await extractContentData(rawContent)

    // Publish to matching service for processing
    await publishContentEvent("content.ingested", {
      id: rawContent._id,
      title: rawContent.title,
      description: rawContent.description,
      url: rawContent.url,
      type: rawContent.type,
      source: rawContent.source,
      skills: extractedData.skills,
      difficulty: extractedData.difficulty,
      tags: [...(rawContent.tags || []), ...extractedData.tags],
      publishedAt: rawContent.publishedAt,
    })

    // Mark as processed
    rawContent.processed = true
    rawContent.processingError = null
    await rawContent.save()

    contentIngested.labels(rawContent.type || "unknown", rawContent.source).inc()
    processingTime.observe((Date.now() - start) / 1000)

    logger.info(`Processed content: ${rawContent.title}`)
  } catch (error) {
    logger.error(`Error processing content ${rawContent._id}:`, error)
    rawContent.processingError = error.message
    await rawContent.save()
  }
}

async function extractContentData(rawContent) {
  const text = `${rawContent.title} ${rawContent.description || ""} ${rawContent.content || ""}`.toLowerCase()

  // Skill extraction using keyword matching
  const skillKeywords = {
    javascript: ["javascript", "js", "node.js", "nodejs", "react", "vue", "angular"],
    python: ["python", "django", "flask", "pandas", "numpy", "tensorflow"],
    java: ["java", "spring", "hibernate", "maven", "gradle"],
    docker: ["docker", "container", "containerization"],
    kubernetes: ["kubernetes", "k8s", "orchestration"],
    aws: ["aws", "amazon web services", "ec2", "s3", "lambda"],
    "machine learning": ["machine learning", "ml", "ai", "artificial intelligence", "neural network"],
    devops: ["devops", "ci/cd", "continuous integration", "continuous deployment"],
    database: ["database", "sql", "mongodb", "postgresql", "mysql", "redis"],
    frontend: ["frontend", "html", "css", "ui", "ux", "responsive"],
    backend: ["backend", "api", "server", "microservices"],
  }

  const extractedSkills = []
  for (const [skill, keywords] of Object.entries(skillKeywords)) {
    if (keywords.some((keyword) => text.includes(keyword))) {
      extractedSkills.push(skill)
    }
  }

  // Difficulty estimation based on keywords
  const difficultyKeywords = {
    Beginner: ["beginner", "introduction", "getting started", "basics", "fundamentals", "tutorial"],
    Intermediate: ["intermediate", "practical", "hands-on", "building", "creating"],
    Advanced: ["advanced", "expert", "professional", "optimization", "performance", "architecture"],
    Expert: ["expert", "mastery", "deep dive", "internals", "advanced patterns"],
  }

  let difficulty = "Intermediate" // Default
  for (const [level, keywords] of Object.entries(difficultyKeywords)) {
    if (keywords.some((keyword) => text.includes(keyword))) {
      difficulty = level
      break
    }
  }

  // Extract additional tags
  const tagKeywords = [
    "tutorial",
    "guide",
    "best practices",
    "tips",
    "tricks",
    "patterns",
    "architecture",
    "design",
    "testing",
    "security",
    "performance",
    "scalability",
  ]

  const extractedTags = tagKeywords.filter((tag) => text.includes(tag))

  return {
    skills: extractedSkills,
    difficulty: difficulty,
    tags: extractedTags,
  }
}

async function publishContentEvent(eventType, data) {
  try {
    if (rabbitChannel) {
      const event = {
        type: eventType,
        data: data,
        timestamp: new Date().toISOString(),
        source: "content-ingestion-service",
      }

      await rabbitChannel.publish("skill_sync_events", eventType, Buffer.from(JSON.stringify(event)))
      logger.info(`Published event: ${eventType}`)
    }
  } catch (error) {
    logger.error("Error publishing event:", error)
  }
}

// Content fetching functions
async function fetchFromDevTo() {
  try {
    const response = await axios.get("https://dev.to/api/articles?per_page=20&top=7")
    const articles = response.data

    for (const article of articles) {
      try {
        await RawContent.findOneAndUpdate(
          { source: "dev.to", sourceId: article.id.toString() },
          {
            title: article.title,
            description: article.description,
            url: article.url,
            author: article.user.name,
            publishedAt: new Date(article.published_at),
            source: "dev.to",
            sourceId: article.id.toString(),
            type: "article",
            tags: article.tag_list,
            metadata: {
              readingTime: article.reading_time_minutes,
              reactions: article.public_reactions_count,
              comments: article.comments_count,
            },
          },
          { upsert: true, new: true },
        )
      } catch (error) {
        if (error.code !== 11000) {
          // Ignore duplicate key errors
          logger.error(`Error saving article ${article.id}:`, error)
        }
      }
    }

    logger.info(`Fetched ${articles.length} articles from Dev.to`)
  } catch (error) {
    logger.error("Error fetching from Dev.to:", error)
  }
}

async function fetchFromGitHubTrending() {
  try {
    // Simulate fetching trending repositories (GitHub API requires authentication for higher limits)
    const mockRepos = [
      {
        id: "trending-1",
        name: "awesome-microservices",
        description: "A curated list of microservice architecture patterns and best practices",
        url: "https://github.com/example/awesome-microservices",
        language: "JavaScript",
        stars: 1500,
      },
      {
        id: "trending-2",
        name: "kubernetes-learning-path",
        description: "Complete learning path for Kubernetes from beginner to expert",
        url: "https://github.com/example/kubernetes-learning-path",
        language: "YAML",
        stars: 2300,
      },
      {
        id: "trending-3",
        name: "react-best-practices-2024",
        description: "Modern React patterns and best practices for 2024",
        url: "https://github.com/example/react-best-practices-2024",
        language: "TypeScript",
        stars: 890,
      },
    ]

    for (const repo of mockRepos) {
      try {
        await RawContent.findOneAndUpdate(
          { source: "github", sourceId: repo.id },
          {
            title: repo.name,
            description: repo.description,
            url: repo.url,
            source: "github",
            sourceId: repo.id,
            type: "documentation",
            tags: [repo.language?.toLowerCase()].filter(Boolean),
            metadata: {
              stars: repo.stars,
              language: repo.language,
            },
            publishedAt: new Date(),
          },
          { upsert: true, new: true },
        )
      } catch (error) {
        if (error.code !== 11000) {
          logger.error(`Error saving repo ${repo.id}:`, error)
        }
      }
    }

    logger.info(`Fetched ${mockRepos.length} repositories from GitHub`)
  } catch (error) {
    logger.error("Error fetching from GitHub:", error)
  }
}

// Scheduled content fetching
async function runContentFetching() {
  logger.info("Starting content fetching cycle")

  await fetchFromDevTo()
  await fetchFromGitHubTrending()

  // Process unprocessed content
  const unprocessedContent = await RawContent.find({ processed: false }).limit(50)

  for (const content of unprocessedContent) {
    await processContent(content)
  }

  logger.info(`Content fetching cycle completed. Processed ${unprocessedContent.length} items.`)
}

// Routes

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    service: "content-ingestion-service",
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

// Get content sources
app.get("/api/content/sources", async (req, res) => {
  try {
    const sources = await ContentSource.find().sort({ createdAt: -1 })
    res.json({ sources })
  } catch (error) {
    logger.error("Error fetching content sources:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Add content source
app.post("/api/content/sources", async (req, res) => {
  try {
    const { name, url, type, config } = req.body

    const source = new ContentSource({
      name,
      url,
      type,
      config: config || {},
    })

    await source.save()
    res.status(201).json(source)
  } catch (error) {
    logger.error("Error creating content source:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Get raw content
app.get("/api/content/raw", async (req, res) => {
  try {
    const { page = 1, limit = 20, source, processed } = req.query
    const query = {}

    if (source) query.source = source
    if (processed !== undefined) query.processed = processed === "true"

    const content = await RawContent.find(query)
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)

    const total = await RawContent.countDocuments(query)

    res.json({
      content,
      totalPages: Math.ceil(total / limit),
      currentPage: Number.parseInt(page),
      total,
    })
  } catch (error) {
    logger.error("Error fetching raw content:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Manual content ingestion
app.post("/api/content/ingest", async (req, res) => {
  try {
    const { title, description, url, type, source, tags } = req.body

    const content = new RawContent({
      title,
      description,
      url,
      type: type || "article",
      source: source || "manual",
      sourceId: `manual-${Date.now()}`,
      tags: tags || [],
      publishedAt: new Date(),
    })

    await content.save()
    await processContent(content)

    res.status(201).json(content)
  } catch (error) {
    logger.error("Error ingesting content:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Trigger content fetching
app.post("/api/content/fetch", async (req, res) => {
  try {
    // Run content fetching in background
    setImmediate(runContentFetching)
    res.json({ message: "Content fetching initiated" })
  } catch (error) {
    logger.error("Error triggering content fetch:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Get content statistics
app.get("/api/content/stats", async (req, res) => {
  try {
    const stats = await RawContent.aggregate([
      {
        $group: {
          _id: null,
          totalContent: { $sum: 1 },
          processedContent: {
            $sum: { $cond: ["$processed", 1, 0] },
          },
          pendingContent: {
            $sum: { $cond: ["$processed", 0, 1] },
          },
        },
      },
    ])

    const sourceStats = await RawContent.aggregate([
      { $group: { _id: "$source", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])

    const typeStats = await RawContent.aggregate([
      { $group: { _id: "$type", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ])

    res.json({
      overview: stats[0] || { totalContent: 0, processedContent: 0, pendingContent: 0 },
      bySources: sourceStats,
      byTypes: typeStats,
    })
  } catch (error) {
    logger.error("Error fetching content statistics:", error)
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

// Schedule content fetching every hour
setInterval(runContentFetching, 60 * 60 * 1000) // 1 hour

// Run initial content fetch after startup
setTimeout(runContentFetching, 10000) // 10 seconds after startup

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
  logger.info(`Content Ingestion Service running on port ${PORT}`)
})

module.exports = app
