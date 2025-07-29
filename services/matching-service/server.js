const express = require("express")
const mongoose = require("mongoose")
const cors = require("cors")
const helmet = require("helmet")
const rateLimit = require("express-rate-limit")
const Joi = require("joi")
const amqp = require("amqplib")
const winston = require("winston")
const promClient = require("prom-client")
const axios = require("axios")
const cron = require("node-cron")

const app = express()
const PORT = process.env.PORT || 3003

// Prometheus metrics
const register = new promClient.Registry()
promClient.collectDefaultMetrics({ register })

const matchingRequestsTotal = new promClient.Counter({
  name: "matching_requests_total",
  help: "Total number of matching requests",
  labelNames: ["type", "status"],
})
register.registerMetric(matchingRequestsTotal)

// Logger setup
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "logs/matching-service.log" }),
  ],
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
  windowMs: 15 * 60 * 1000,
  max: 100,
})
app.use(limiter)

app.use(express.json({ limit: "10mb" }))

// MongoDB connection
mongoose
  .connect(process.env.MONGODB_URI || "mongodb://localhost:27017/skillsync", {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => logger.info("Connected to MongoDB"))
  .catch((err) => logger.error("MongoDB connection error:", err))

// Match Schema
const matchSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  projectId: { type: mongoose.Schema.Types.ObjectId, required: true },
  matchScore: { type: Number, required: true, min: 0, max: 100 },
  matchFactors: {
    skillMatch: { type: Number, min: 0, max: 100 },
    experienceMatch: { type: Number, min: 0, max: 100 },
    availabilityMatch: { type: Number, min: 0, max: 100 },
    locationMatch: { type: Number, min: 0, max: 100 },
    interestMatch: { type: Number, min: 0, max: 100 },
  },
  matchReasons: [String],
  status: {
    type: String,
    enum: ["pending", "viewed", "interested", "applied", "rejected"],
    default: "pending",
  },
  feedback: {
    rating: { type: Number, min: 1, max: 5 },
    comment: String,
    helpful: Boolean,
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
})

const Match = mongoose.model("Match", matchSchema)

// RabbitMQ connection
let channel
async function connectRabbitMQ() {
  try {
    const connection = await amqp.connect(process.env.RABBITMQ_URL || "amqp://localhost")
    channel = await connection.createChannel()

    await channel.assertExchange("matching_events", "topic", { durable: true })
    await channel.assertQueue("match_created", { durable: true })
    await channel.assertQueue("user_events", { durable: true })
    await channel.assertQueue("project_events", { durable: true })

    // Listen for user and project events
    await channel.bindQueue("user_events", "user_events", "user.*")
    await channel.bindQueue("project_events", "project_events", "project.*")

    // Consume user events
    channel.consume("user_events", async (msg) => {
      if (msg) {
        try {
          const eventData = JSON.parse(msg.content.toString())
          await handleUserEvent(eventData, msg.fields.routingKey)
          channel.ack(msg)
        } catch (error) {
          logger.error("Error processing user event:", error)
          channel.nack(msg, false, false)
        }
      }
    })

    // Consume project events
    channel.consume("project_events", async (msg) => {
      if (msg) {
        try {
          const eventData = JSON.parse(msg.content.toString())
          await handleProjectEvent(eventData, msg.fields.routingKey)
          channel.ack(msg)
        } catch (error) {
          logger.error("Error processing project event:", error)
          channel.nack(msg, false, false)
        }
      }
    })

    logger.info("Connected to RabbitMQ")
  } catch (error) {
    logger.error("RabbitMQ connection error:", error)
  }
}

// Event handlers
async function handleUserEvent(eventData, routingKey) {
  logger.info(`Processing user event: ${routingKey}`, eventData)

  if (routingKey === "user.created" || routingKey === "user.updated") {
    // Trigger matching for the user
    await generateMatchesForUser(eventData.userId)
  }
}

async function handleProjectEvent(eventData, routingKey) {
  logger.info(`Processing project event: ${routingKey}`, eventData)

  if (routingKey === "project.created") {
    // Trigger matching for the project
    await generateMatchesForProject(eventData.projectId)
  }
}

// Matching Algorithm
class MatchingAlgorithm {
  static calculateSkillMatch(userSkills, requiredSkills, optionalSkills = []) {
    if (!userSkills || !requiredSkills) return 0

    const userSkillsLower = userSkills.map((skill) => skill.toLowerCase())
    const requiredSkillsLower = requiredSkills.map((skill) => skill.toLowerCase())
    const optionalSkillsLower = optionalSkills.map((skill) => skill.toLowerCase())

    // Required skills match (weighted 70%)
    const requiredMatches = requiredSkillsLower.filter((skill) => userSkillsLower.includes(skill)).length
    const requiredScore = (requiredMatches / requiredSkillsLower.length) * 70

    // Optional skills match (weighted 30%)
    const optionalMatches = optionalSkillsLower.filter((skill) => userSkillsLower.includes(skill)).length
    const optionalScore = optionalSkillsLower.length > 0 ? (optionalMatches / optionalSkillsLower.length) * 30 : 0

    return Math.min(100, requiredScore + optionalScore)
  }

  static calculateExperienceMatch(userExperience, projectDifficulty) {
    const experienceMap = {
      "Entry Level": 1,
      "Mid Level": 2,
      "Senior Level": 3,
      Expert: 4,
    }

    const difficultyMap = {
      Beginner: 1,
      Intermediate: 2,
      Advanced: 3,
    }

    const userLevel = experienceMap[userExperience] || 1
    const projectLevel = difficultyMap[projectDifficulty] || 1

    // Perfect match gets 100, each level difference reduces score
    const difference = Math.abs(userLevel - projectLevel)
    return Math.max(0, 100 - difference * 25)
  }

  static calculateAvailabilityMatch(userAvailability, projectDuration) {
    // Simplified availability matching
    const availabilityMap = {
      "Full-time": 100,
      "Part-time": 75,
      Weekends: 50,
      Flexible: 85,
    }

    return availabilityMap[userAvailability] || 50
  }

  static calculateLocationMatch(userLocation, projectLocation) {
    if (!userLocation || !projectLocation) return 50

    // Simple string matching - in real implementation, use geolocation
    if (userLocation.toLowerCase() === projectLocation.toLowerCase()) {
      return 100
    }

    // Check if same country/region
    const userParts = userLocation.split(",").map((part) => part.trim().toLowerCase())
    const projectParts = projectLocation.split(",").map((part) => part.trim().toLowerCase())

    const commonParts = userParts.filter((part) => projectParts.includes(part))
    return Math.min(100, (commonParts.length / Math.max(userParts.length, projectParts.length)) * 100)
  }

  static calculateInterestMatch(userPreferences, projectCategory, projectTags) {
    if (!userPreferences || !userPreferences.projectTypes) return 50

    let score = 0

    // Category match
    if (userPreferences.projectTypes.includes(projectCategory)) {
      score += 60
    }

    // Tags match
    if (projectTags && userPreferences.interests) {
      const matchingTags = projectTags.filter((tag) =>
        userPreferences.interests.some((interest) => interest.toLowerCase().includes(tag.toLowerCase())),
      )
      score += (matchingTags.length / projectTags.length) * 40
    }

    return Math.min(100, score)
  }

  static calculateOverallMatch(factors) {
    // Weighted average of all factors
    const weights = {
      skillMatch: 0.4,
      experienceMatch: 0.2,
      availabilityMatch: 0.15,
      locationMatch: 0.1,
      interestMatch: 0.15,
    }

    let totalScore = 0
    for (const [factor, score] of Object.entries(factors)) {
      totalScore += (score || 0) * (weights[factor] || 0)
    }

    return Math.round(totalScore)
  }

  static generateMatchReasons(factors, userProfile, project) {
    const reasons = []

    if (factors.skillMatch > 80) {
      reasons.push(`Strong skill match - you have ${Math.round(factors.skillMatch)}% of required skills`)
    }

    if (factors.experienceMatch > 75) {
      reasons.push("Your experience level aligns well with project difficulty")
    }

    if (factors.availabilityMatch > 80) {
      reasons.push("Your availability matches project requirements")
    }

    if (factors.locationMatch > 90) {
      reasons.push("You're in the same location as the project")
    }

    if (factors.interestMatch > 70) {
      reasons.push("This project matches your interests and preferences")
    }

    return reasons
  }
}

// Generate matches for a user
async function generateMatchesForUser(userId) {
  try {
    // Get user profile
    const userResponse = await axios.get(
      `${process.env.USER_PROFILE_SERVICE_URL || "http://localhost:3001"}/api/users/${userId}`,
    )
    const user = userResponse.data

    // Get active projects
    const projectsResponse = await axios.get(
      `${process.env.PROJECT_IDEAS_SERVICE_URL || "http://localhost:3002"}/api/projects?status=active&limit=100`,
    )
    const projects = projectsResponse.data.projects

    // Generate matches
    for (const project of projects) {
      // Skip if user is already a collaborator
      if (project.collaborators.some((collab) => collab.userId.toString() === userId)) {
        continue
      }

      // Check if match already exists
      const existingMatch = await Match.findOne({ userId, projectId: project._id })
      if (existingMatch) {
        continue
      }

      // Calculate match factors
      const factors = {
        skillMatch: MatchingAlgorithm.calculateSkillMatch(
          user.profile.skills,
          project.requiredSkills,
          project.optionalSkills,
        ),
        experienceMatch: MatchingAlgorithm.calculateExperienceMatch(user.profile.experience, project.difficulty),
        availabilityMatch: MatchingAlgorithm.calculateAvailabilityMatch(
          user.preferences?.availability,
          project.estimatedDuration,
        ),
        locationMatch: MatchingAlgorithm.calculateLocationMatch(user.profile.location, project.location),
        interestMatch: MatchingAlgorithm.calculateInterestMatch(user.preferences, project.category, project.tags),
      }

      const matchScore = MatchingAlgorithm.calculateOverallMatch(factors)

      // Only create matches above threshold
      if (matchScore >= 30) {
        const matchReasons = MatchingAlgorithm.generateMatchReasons(factors, user, project)

        const match = new Match({
          userId,
          projectId: project._id,
          matchScore,
          matchFactors: factors,
          matchReasons,
        })

        await match.save()

        // Publish match created event
        if (channel) {
          await channel.publish(
            "matching_events",
            "match.created",
            Buffer.from(
              JSON.stringify({
                matchId: match._id,
                userId,
                projectId: project._id,
                matchScore,
                timestamp: new Date().toISOString(),
              }),
            ),
          )
        }

        matchingRequestsTotal.labels("user", "success").inc()
      }
    }

    logger.info(`Generated matches for user: ${userId}`)
  } catch (error) {
    logger.error("Error generating matches for user:", error)
    matchingRequestsTotal.labels("user", "error").inc()
  }
}

// Generate matches for a project
async function generateMatchesForProject(projectId) {
  try {
    // Get project details
    const projectResponse = await axios.get(
      `${process.env.PROJECT_IDEAS_SERVICE_URL || "http://localhost:3002"}/api/projects/${projectId}`,
    )
    const project = projectResponse.data

    // Get users with relevant skills
    const skillsQuery = project.requiredSkills.join(",")
    const usersResponse = await axios.get(
      `${process.env.USER_PROFILE_SERVICE_URL || "http://localhost:3001"}/api/users/by-skills?skills=${skillsQuery}`,
    )
    const users = usersResponse.data

    // Generate matches
    for (const user of users) {
      // Check if match already exists
      const existingMatch = await Match.findOne({
        userId: user._id,
        projectId: project._id,
      })
      if (existingMatch) {
        continue
      }

      // Calculate match factors
      const factors = {
        skillMatch: MatchingAlgorithm.calculateSkillMatch(
          user.profile.skills,
          project.requiredSkills,
          project.optionalSkills,
        ),
        experienceMatch: MatchingAlgorithm.calculateExperienceMatch(user.profile.experience, project.difficulty),
        availabilityMatch: MatchingAlgorithm.calculateAvailabilityMatch(
          user.preferences?.availability,
          project.estimatedDuration,
        ),
        locationMatch: MatchingAlgorithm.calculateLocationMatch(user.profile.location, project.location),
        interestMatch: MatchingAlgorithm.calculateInterestMatch(user.preferences, project.category, project.tags),
      }

      const matchScore = MatchingAlgorithm.calculateOverallMatch(factors)

      // Only create matches above threshold
      if (matchScore >= 30) {
        const matchReasons = MatchingAlgorithm.generateMatchReasons(factors, user, project)

        const match = new Match({
          userId: user._id,
          projectId: project._id,
          matchScore,
          matchFactors: factors,
          matchReasons,
        })

        await match.save()

        // Publish match created event
        if (channel) {
          await channel.publish(
            "matching_events",
            "match.created",
            Buffer.from(
              JSON.stringify({
                matchId: match._id,
                userId: user._id,
                projectId: project._id,
                matchScore,
                timestamp: new Date().toISOString(),
              }),
            ),
          )
        }

        matchingRequestsTotal.labels("project", "success").inc()
      }
    }

    logger.info(`Generated matches for project: ${projectId}`)
  } catch (error) {
    logger.error("Error generating matches for project:", error)
    matchingRequestsTotal.labels("project", "error").inc()
  }
}

// Routes
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    service: "matching-service",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  })
})

app.get("/metrics", async (req, res) => {
  res.set("Content-Type", register.contentType)
  res.end(await register.metrics())
})

// Get matches for user
app.get("/api/matches/user/:userId", async (req, res) => {
  try {
    const { userId } = req.params
    const { page = 1, limit = 20, minScore = 30 } = req.query

    const matches = await Match.find({
      userId,
      matchScore: { $gte: minScore },
    })
      .sort({ matchScore: -1, createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)

    // Get project details for each match
    const matchesWithProjects = await Promise.all(
      matches.map(async (match) => {
        try {
          const projectResponse = await axios.get(
            `${process.env.PROJECT_IDEAS_SERVICE_URL || "http://localhost:3002"}/api/projects/${match.projectId}`,
          )
          return {
            ...match.toObject(),
            project: projectResponse.data,
          }
        } catch (error) {
          logger.error("Error fetching project for match:", error)
          return match.toObject()
        }
      }),
    )

    const total = await Match.countDocuments({
      userId,
      matchScore: { $gte: minScore },
    })

    res.json({
      matches: matchesWithProjects,
      pagination: {
        current: page,
        pages: Math.ceil(total / limit),
        total,
      },
    })
  } catch (error) {
    logger.error("Get user matches error:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Get matches for project
app.get("/api/matches/project/:projectId", async (req, res) => {
  try {
    const { projectId } = req.params
    const { page = 1, limit = 20, minScore = 30 } = req.query

    const matches = await Match.find({
      projectId,
      matchScore: { $gte: minScore },
    })
      .sort({ matchScore: -1, createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)

    // Get user details for each match
    const matchesWithUsers = await Promise.all(
      matches.map(async (match) => {
        try {
          const userResponse = await axios.get(
            `${process.env.USER_PROFILE_SERVICE_URL || "http://localhost:3001"}/api/users/${match.userId}`,
          )
          return {
            ...match.toObject(),
            user: userResponse.data,
          }
        } catch (error) {
          logger.error("Error fetching user for match:", error)
          return match.toObject()
        }
      }),
    )

    const total = await Match.countDocuments({
      projectId,
      matchScore: { $gte: minScore },
    })

    res.json({
      matches: matchesWithUsers,
      pagination: {
        current: page,
        pages: Math.ceil(total / limit),
        total,
      },
    })
  } catch (error) {
    logger.error("Get project matches error:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Update match status
app.put("/api/matches/:matchId/status", async (req, res) => {
  try {
    const { matchId } = req.params
    const { status } = req.body

    if (!["pending", "viewed", "interested", "applied", "rejected"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" })
    }

    const match = await Match.findByIdAndUpdate(matchId, { status, updatedAt: new Date() }, { new: true })

    if (!match) {
      return res.status(404).json({ error: "Match not found" })
    }

    res.json({
      message: "Match status updated",
      match,
    })
  } catch (error) {
    logger.error("Update match status error:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Provide match feedback
app.post("/api/matches/:matchId/feedback", async (req, res) => {
  try {
    const { matchId } = req.params
    const { rating, comment, helpful } = req.body

    const match = await Match.findByIdAndUpdate(
      matchId,
      {
        feedback: { rating, comment, helpful },
        updatedAt: new Date(),
      },
      { new: true },
    )

    if (!match) {
      return res.status(404).json({ error: "Match not found" })
    }

    res.json({
      message: "Feedback submitted",
      match,
    })
  } catch (error) {
    logger.error("Submit feedback error:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Trigger manual matching
app.post("/api/matches/generate", async (req, res) => {
  try {
    const { userId, projectId } = req.body

    if (userId) {
      await generateMatchesForUser(userId)
    } else if (projectId) {
      await generateMatchesForProject(projectId)
    } else {
      return res.status(400).json({ error: "userId or projectId required" })
    }

    res.json({ message: "Matching process initiated" })
  } catch (error) {
    logger.error("Manual matching error:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Scheduled matching job (runs every hour)
cron.schedule("0 * * * *", async () => {
  logger.info("Running scheduled matching job")

  try {
    // Get recent users and projects for matching
    const recentUsers = await axios.get(
      `${process.env.USER_PROFILE_SERVICE_URL || "http://localhost:3001"}/api/users/recent`,
    )

    const recentProjects = await axios.get(
      `${process.env.PROJECT_IDEAS_SERVICE_URL || "http://localhost:3002"}/api/projects/recent`,
    )

    // Process in batches to avoid overwhelming the system
    // Implementation would batch process users and projects

    logger.info("Scheduled matching job completed")
  } catch (error) {
    logger.error("Scheduled matching job error:", error)
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
  logger.info(`Matching Service running on port ${PORT}`)
  await connectRabbitMQ()
})

module.exports = app
