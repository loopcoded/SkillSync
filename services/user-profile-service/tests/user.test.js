const request = require("supertest")
const mongoose = require("mongoose")
const app = require("../server")

describe("User Profile Service", () => {
  beforeAll(async () => {
    // Connect to test database
    const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/skillsync_test"
    await mongoose.connect(mongoUri)
  })

  afterAll(async () => {
    // Clean up and close connection
    await mongoose.connection.dropDatabase()
    await mongoose.connection.close()
  })

  beforeEach(async () => {
    // Clear users collection before each test
    await mongoose.connection.db.collection("users").deleteMany({})
  })

  describe("GET /health", () => {
    it("should return health status", async () => {
      const response = await request(app).get("/health").expect(200)

      expect(response.body).toHaveProperty("status", "healthy")
      expect(response.body).toHaveProperty("service", "user-profile-service")
    })
  })

  describe("POST /api/users", () => {
    it("should create a new user", async () => {
      const userData = {
        username: "testuser",
        email: "test@example.com",
        password: "password123",
        profile: {
          firstName: "Test",
          lastName: "User",
          bio: "Test bio",
        },
        skills: [{ name: "JavaScript", level: "Advanced", yearsOfExperience: 3 }],
        interests: ["Web Development", "AI"],
      }

      const response = await request(app).post("/api/users").send(userData).expect(201)

      expect(response.body).toHaveProperty("username", "testuser")
      expect(response.body).toHaveProperty("email", "test@example.com")
      expect(response.body).not.toHaveProperty("password")
      expect(response.body.skills).toHaveLength(1)
      expect(response.body.interests).toHaveLength(2)
    })

    it("should not create user with duplicate email", async () => {
      const userData = {
        username: "testuser1",
        email: "test@example.com",
        password: "password123",
      }

      // Create first user
      await request(app).post("/api/users").send(userData).expect(201)

      // Try to create second user with same email
      const duplicateUser = {
        username: "testuser2",
        email: "test@example.com",
        password: "password123",
      }

      await request(app).post("/api/users").send(duplicateUser).expect(400)
    })
  })

  describe("GET /api/users", () => {
    beforeEach(async () => {
      // Create test users
      const users = [
        {
          username: "user1",
          email: "user1@example.com",
          password: "password123",
          skills: [{ name: "JavaScript", level: "Advanced" }],
          profile: { location: "New York" },
        },
        {
          username: "user2",
          email: "user2@example.com",
          password: "password123",
          skills: [{ name: "Python", level: "Intermediate" }],
          profile: { location: "San Francisco" },
        },
      ]

      for (const userData of users) {
        await request(app).post("/api/users").send(userData)
      }
    })

    it("should get all users", async () => {
      const response = await request(app).get("/api/users").expect(200)

      expect(response.body).toHaveProperty("users")
      expect(response.body.users).toHaveLength(2)
      expect(response.body).toHaveProperty("total", 2)
    })

    it("should filter users by skills", async () => {
      const response = await request(app).get("/api/users?skills=JavaScript").expect(200)

      expect(response.body.users).toHaveLength(1)
      expect(response.body.users[0].username).toBe("user1")
    })

    it("should filter users by location", async () => {
      const response = await request(app).get("/api/users?location=San Francisco").expect(200)

      expect(response.body.users).toHaveLength(1)
      expect(response.body.users[0].username).toBe("user2")
    })
  })

  describe("GET /api/skills", () => {
    beforeEach(async () => {
      // Create users with various skills
      const users = [
        {
          username: "dev1",
          email: "dev1@example.com",
          password: "password123",
          skills: [
            { name: "JavaScript", level: "Advanced" },
            { name: "React", level: "Intermediate" },
          ],
        },
        {
          username: "dev2",
          email: "dev2@example.com",
          password: "password123",
          skills: [
            { name: "JavaScript", level: "Expert" },
            { name: "Node.js", level: "Advanced" },
          ],
        },
      ]

      for (const userData of users) {
        await request(app).post("/api/users").send(userData)
      }
    })

    it("should get aggregated skills with counts", async () => {
      const response = await request(app).get("/api/skills").expect(200)

      expect(response.body).toHaveLength(3)

      const jsSkill = response.body.find((skill) => skill.name === "JavaScript")
      expect(jsSkill).toHaveProperty("count", 2)

      const reactSkill = response.body.find((skill) => skill.name === "React")
      expect(reactSkill).toHaveProperty("count", 1)
    })
  })
})
