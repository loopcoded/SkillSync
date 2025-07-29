const request = require("supertest")
const mongoose = require("mongoose")
const app = require("../server")
const jest = require("jest") // Declare the jest variable

// Mock axios for inter-service communication
jest.mock("axios")
const axios = require("axios")

describe("Project Ideas Service", () => {
  beforeAll(async () => {
    const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/skillsync_projects_test"
    await mongoose.connect(mongoUri)
  })

  afterAll(async () => {
    await mongoose.connection.dropDatabase()
    await mongoose.connection.close()
  })

  beforeEach(async () => {
    await mongoose.connection.db.collection("projects").deleteMany({})

    // Mock user service responses
    axios.get.mockImplementation((url) => {
      if (url.includes("/api/users/")) {
        const userId = url.split("/").pop()
        return Promise.resolve({
          data: {
            _id: userId,
            username: `user${userId}`,
            email: `user${userId}@example.com`,
            profile: { firstName: "Test", lastName: "User" },
            skills: [
              { name: "JavaScript", level: "Advanced" },
              { name: "React", level: "Intermediate" },
            ],
          },
        })
      }
      if (url.includes("/api/users?skills=")) {
        return Promise.resolve({
          data: {
            users: [
              {
                _id: "user123",
                username: "developer1",
                skills: [{ name: "JavaScript", level: "Advanced" }],
              },
            ],
          },
        })
      }
      return Promise.reject(new Error("Not found"))
    })
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  describe("GET /health", () => {
    it("should return health status", async () => {
      const response = await request(app).get("/health").expect(200)

      expect(response.body).toHaveProperty("status", "healthy")
      expect(response.body).toHaveProperty("service", "project-ideas-service")
    })
  })

  describe("POST /api/projects", () => {
    it("should create a new project", async () => {
      const projectData = {
        title: "E-commerce Platform",
        description: "Building a modern e-commerce platform with React and Node.js",
        category: "Web Development",
        createdBy: "user123",
        requiredSkills: [
          { name: "JavaScript", level: "Advanced", importance: "Critical" },
          { name: "React", level: "Intermediate", importance: "Important" },
        ],
        teamSize: { min: 2, max: 5 },
        tags: ["e-commerce", "react", "nodejs"],
      }

      const response = await request(app).post("/api/projects").send(projectData).expect(201)

      expect(response.body).toHaveProperty("title", "E-commerce Platform")
      expect(response.body).toHaveProperty("category", "Web Development")
      expect(response.body).toHaveProperty("status", "Planning")
      expect(response.body.requiredSkills).toHaveLength(2)
      expect(response.body.creator).toHaveProperty("username", "useruser123")
    })

    it("should not create project with invalid creator", async () => {
      axios.get.mockRejectedValueOnce(new Error("User not found"))

      const projectData = {
        title: "Test Project",
        description: "Test description",
        category: "Web Development",
        createdBy: "invaliduser",
      }

      await request(app).post("/api/projects").send(projectData).expect(400)
    })
  })

  describe("GET /api/projects", () => {
    beforeEach(async () => {
      // Create test projects
      const projects = [
        {
          title: "Web App Project",
          description: "Building a web application",
          category: "Web Development",
          createdBy: new mongoose.Types.ObjectId(),
          requiredSkills: [{ name: "JavaScript", level: "Advanced" }],
          status: "Active",
          tags: ["web", "javascript"],
        },
        {
          title: "Mobile App Project",
          description: "Building a mobile application",
          category: "Mobile App",
          createdBy: new mongoose.Types.ObjectId(),
          requiredSkills: [{ name: "React Native", level: "Intermediate" }],
          status: "Planning",
          tags: ["mobile", "react-native"],
        },
      ]

      for (const projectData of projects) {
        await request(app).post("/api/projects").send(projectData)
      }
    })

    it("should get all projects", async () => {
      const response = await request(app).get("/api/projects").expect(200)

      expect(response.body).toHaveProperty("projects")
      expect(response.body.projects.length).toBeGreaterThan(0)
      expect(response.body).toHaveProperty("total")
      expect(response.body).toHaveProperty("totalPages")
    })

    it("should filter projects by category", async () => {
      const response = await request(app).get("/api/projects?category=Web Development").expect(200)

      expect(response.body.projects).toHaveLength(1)
      expect(response.body.projects[0].category).toBe("Web Development")
    })

    it("should filter projects by skills", async () => {
      const response = await request(app).get("/api/projects?skills=JavaScript").expect(200)

      expect(response.body.projects).toHaveLength(1)
      expect(response.body.projects[0].requiredSkills[0].name).toBe("JavaScript")
    })

    it("should search projects by title", async () => {
      const response = await request(app).get("/api/projects?search=Web App").expect(200)

      expect(response.body.projects).toHaveLength(1)
      expect(response.body.projects[0].title).toContain("Web App")
    })
  })

  describe("GET /api/projects/recommendations/:userId", () => {
    beforeEach(async () => {
      // Create a test project
      const projectData = {
        title: "JavaScript Project",
        description: "A project requiring JavaScript skills",
        category: "Web Development",
        createdBy: new mongoose.Types.ObjectId(),
        requiredSkills: [
          { name: "JavaScript", level: "Advanced" },
          { name: "React", level: "Intermediate" },
        ],
        status: "Active",
      }

      await request(app).post("/api/projects").send(projectData)
    })

    it("should get project recommendations for a user", async () => {
      const response = await request(app).get("/api/projects/recommendations/user123").expect(200)

      expect(response.body).toHaveProperty("recommendations")
      expect(response.body).toHaveProperty("userSkills")
      expect(response.body.recommendations).toHaveLength(1)
      expect(response.body.recommendations[0]).toHaveProperty("matchScore")
      expect(response.body.recommendations[0]).toHaveProperty("matchingSkills")
    })

    it("should return 404 for non-existent user", async () => {
      axios.get.mockRejectedValueOnce(new Error("User not found"))

      await request(app).get("/api/projects/recommendations/nonexistent").expect(404)
    })
  })

  describe("POST /api/projects/:id/apply", () => {
    let projectId

    beforeEach(async () => {
      const projectData = {
        title: "Test Project",
        description: "Test description",
        category: "Web Development",
        createdBy: new mongoose.Types.ObjectId(),
      }

      const response = await request(app).post("/api/projects").send(projectData)
      projectId = response.body._id
    })

    it("should allow user to apply to project", async () => {
      const applicationData = {
        userId: "applicant123",
        message: "I'm interested in joining this project",
      }

      await request(app).post(`/api/projects/${projectId}/apply`).send(applicationData).expect(201)
    })

    it("should not allow duplicate applications", async () => {
      const applicationData = {
        userId: "applicant123",
        message: "First application",
      }

      // First application should succeed
      await request(app).post(`/api/projects/${projectId}/apply`).send(applicationData).expect(201)

      // Second application should fail
      await request(app).post(`/api/projects/${projectId}/apply`).send(applicationData).expect(400)
    })
  })

  describe("GET /api/projects/stats", () => {
    beforeEach(async () => {
      // Create test projects with different statuses
      const projects = [
        {
          title: "Active Project 1",
          description: "Description",
          category: "Web Development",
          createdBy: new mongoose.Types.ObjectId(),
          status: "Active",
        },
        {
          title: "Completed Project 1",
          description: "Description",
          category: "Mobile App",
          createdBy: new mongoose.Types.ObjectId(),
          status: "Completed",
        },
      ]

      for (const projectData of projects) {
        await request(app).post("/api/projects").send(projectData)
      }
    })

    it("should return project statistics", async () => {
      const response = await request(app).get("/api/projects/stats").expect(200)

      expect(response.body).toHaveProperty("overview")
      expect(response.body).toHaveProperty("byCategory")
      expect(response.body).toHaveProperty("topSkills")
      expect(response.body.overview).toHaveProperty("totalProjects")
      expect(response.body.overview).toHaveProperty("activeProjects")
      expect(response.body.overview).toHaveProperty("completedProjects")
    })
  })
})
