"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Users, MessageCircle, Activity, TrendingUp, Bell, Send, UserCheck, Wifi, WifiOff } from "lucide-react"
import { io, type Socket } from "socket.io-client"

interface Message {
  id: string
  userId: string
  username: string
  message: string
  timestamp: Date
  room: string
}

interface User {
  userId: string
  username: string
  status: "online" | "away" | "offline"
  activity?: string
}

interface Notification {
  id: string
  title: string
  message: string
  type: "info" | "success" | "warning" | "error"
  timestamp: Date
}

interface AnalyticsData {
  activeUsers: number
  totalMessages: number
  activeRooms: number
  systemLoad: number
}

export default function RealTimeDashboard() {
  const [socket, setSocket] = useState<Socket | null>(null)
  const [isConnected, setIsConnected] = useState(false)
  const [currentRoom, setCurrentRoom] = useState("general")
  const [messages, setMessages] = useState<Message[]>([])
  const [onlineUsers, setOnlineUsers] = useState<User[]>([])
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [analytics, setAnalytics] = useState<AnalyticsData>({
    activeUsers: 0,
    totalMessages: 0,
    activeRooms: 0,
    systemLoad: 0,
  })
  const [messageInput, setMessageInput] = useState("")
  const [username, setUsername] = useState("User" + Math.floor(Math.random() * 1000))
  const [isTyping, setIsTyping] = useState<string[]>([])

  useEffect(() => {
    // Initialize WebSocket connection
    const newSocket = io("http://localhost:3006", {
      auth: {
        token: "demo-token", // In real app, use actual JWT
      },
      transports: ["websocket", "polling"],
    })

    newSocket.on("connect", () => {
      setIsConnected(true)
      console.log("Connected to WebSocket server")

      // Join default room
      newSocket.emit("join_room", { room: currentRoom, type: "public" })
    })

    newSocket.on("disconnect", () => {
      setIsConnected(false)
      console.log("Disconnected from WebSocket server")
    })

    newSocket.on("connect_error", (error) => {
      console.error("Connection error:", error)
      setIsConnected(false)
    })

    // Message events
    newSocket.on("new_message", (message: Message) => {
      setMessages((prev) => [...prev, message].slice(-50)) // Keep last 50 messages
    })

    // User presence events
    newSocket.on("user_joined", (data: { userId: string; username: string; room: string }) => {
      setOnlineUsers((prev) => {
        const exists = prev.find((u) => u.userId === data.userId)
        if (!exists) {
          return [
            ...prev,
            {
              userId: data.userId,
              username: data.username,
              status: "online",
            },
          ]
        }
        return prev
      })

      addNotification({
        id: Date.now().toString(),
        title: "User Joined",
        message: `${data.username} joined the room`,
        type: "info",
        timestamp: new Date(),
      })
    })

    newSocket.on("user_left", (data: { userId: string; username: string; room: string }) => {
      setOnlineUsers((prev) => prev.filter((u) => u.userId !== data.userId))

      addNotification({
        id: Date.now().toString(),
        title: "User Left",
        message: `${data.username} left the room`,
        type: "info",
        timestamp: new Date(),
      })
    })

    // Typing indicators
    newSocket.on("user_typing", (data: { userId: string; username: string }) => {
      setIsTyping((prev) => {
        if (!prev.includes(data.username)) {
          return [...prev, data.username]
        }
        return prev
      })
    })

    newSocket.on("user_stopped_typing", (data: { userId: string; username: string }) => {
      setIsTyping((prev) => prev.filter((name) => name !== data.username))
    })

    // Real-time notifications
    newSocket.on("new_notification", (notification: Notification) => {
      addNotification(notification)
    })

    // Analytics updates
    newSocket.on("analytics_update", (data: AnalyticsData) => {
      setAnalytics(data)
    })

    // Project collaboration events
    newSocket.on("project_updated", (data: any) => {
      addNotification({
        id: Date.now().toString(),
        title: "Project Updated",
        message: `Project "${data.projectTitle}" has been updated`,
        type: "info",
        timestamp: new Date(),
      })
    })

    // Matching events
    newSocket.on("new_matches", (data: { matchCount: number }) => {
      addNotification({
        id: Date.now().toString(),
        title: "New Matches Found!",
        message: `You have ${data.matchCount} new project matches`,
        type: "success",
        timestamp: new Date(),
      })
    })

    setSocket(newSocket)

    // Simulate analytics updates
    const analyticsInterval = setInterval(() => {
      setAnalytics((prev) => ({
        activeUsers: Math.floor(Math.random() * 100) + 50,
        totalMessages: prev.totalMessages + Math.floor(Math.random() * 5),
        activeRooms: Math.floor(Math.random() * 20) + 10,
        systemLoad: Math.floor(Math.random() * 100),
      }))
    }, 5000)

    return () => {
      newSocket.close()
      clearInterval(analyticsInterval)
    }
  }, [currentRoom])

  const addNotification = (notification: Notification) => {
    setNotifications((prev) => [notification, ...prev].slice(0, 10)) // Keep last 10 notifications
  }

  const sendMessage = () => {
    if (socket && messageInput.trim()) {
      socket.emit("send_message", {
        room: currentRoom,
        message: messageInput,
        type: "chat",
      })
      setMessageInput("")
    }
  }

  const handleTyping = () => {
    if (socket) {
      socket.emit("typing_start", { room: currentRoom })

      // Stop typing after 2 seconds
      setTimeout(() => {
        socket?.emit("typing_stop", { room: currentRoom })
      }, 2000)
    }
  }

  const joinRoom = (room: string) => {
    if (socket && room !== currentRoom) {
      socket.emit("leave_room", { room: currentRoom })
      socket.emit("join_room", { room, type: "public" })
      setCurrentRoom(room)
      setMessages([])
    }
  }

  const formatTime = (date: Date) => {
    return new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-gray-900">Real-Time Dashboard</h1>
              <p className="text-gray-600">Live collaboration and analytics for Skill Sync</p>
            </div>
            <div className="flex items-center space-x-2">
              {isConnected ? (
                <Badge variant="default" className="bg-green-500">
                  <Wifi className="w-4 h-4 mr-1" />
                  Connected
                </Badge>
              ) : (
                <Badge variant="destructive">
                  <WifiOff className="w-4 h-4 mr-1" />
                  Disconnected
                </Badge>
              )}
              <span className="text-sm text-gray-500">as {username}</span>
            </div>
          </div>
        </div>

        {/* Analytics Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Active Users</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{analytics.activeUsers}</div>
              <p className="text-xs text-muted-foreground">
                <TrendingUp className="inline h-3 w-3 mr-1" />
                +12% from last hour
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Messages</CardTitle>
              <MessageCircle className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{analytics.totalMessages}</div>
              <p className="text-xs text-muted-foreground">Real-time messages sent</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Active Rooms</CardTitle>
              <Activity className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{analytics.activeRooms}</div>
              <p className="text-xs text-muted-foreground">Collaboration spaces</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">System Load</CardTitle>
              <Activity className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{analytics.systemLoad}%</div>
              <div className="w-full bg-gray-200 rounded-full h-2 mt-2">
                <div
                  className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${analytics.systemLoad}%` }}
                ></div>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Chat Section */}
          <div className="lg:col-span-2">
            <Card className="h-[600px] flex flex-col">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>Real-Time Chat</CardTitle>
                  <div className="flex space-x-2">
                    <Button
                      variant={currentRoom === "general" ? "default" : "outline"}
                      size="sm"
                      onClick={() => joinRoom("general")}
                    >
                      General
                    </Button>
                    <Button
                      variant={currentRoom === "project:123" ? "default" : "outline"}
                      size="sm"
                      onClick={() => joinRoom("project:123")}
                    >
                      Project #123
                    </Button>
                    <Button
                      variant={currentRoom === "matching" ? "default" : "outline"}
                      size="sm"
                      onClick={() => joinRoom("matching")}
                    >
                      Matching
                    </Button>
                  </div>
                </div>
                <CardDescription>
                  Room: {currentRoom} • {onlineUsers.length} users online
                </CardDescription>
              </CardHeader>

              <CardContent className="flex-1 flex flex-col">
                <ScrollArea className="flex-1 mb-4 border rounded-lg p-4">
                  {messages.length === 0 ? (
                    <div className="text-center text-gray-500 py-8">No messages yet. Start the conversation!</div>
                  ) : (
                    <div className="space-y-3">
                      {messages.map((message) => (
                        <div key={message.id} className="flex flex-col">
                          <div className="flex items-center space-x-2">
                            <span className="font-medium text-sm">{message.username}</span>
                            <span className="text-xs text-gray-500">{formatTime(message.timestamp)}</span>
                          </div>
                          <p className="text-sm mt-1">{message.message}</p>
                        </div>
                      ))}
                    </div>
                  )}

                  {isTyping.length > 0 && (
                    <div className="text-sm text-gray-500 italic mt-2">
                      {isTyping.join(", ")} {isTyping.length === 1 ? "is" : "are"} typing...
                    </div>
                  )}
                </ScrollArea>

                <div className="flex space-x-2">
                  <Input
                    placeholder="Type your message..."
                    value={messageInput}
                    onChange={(e) => {
                      setMessageInput(e.target.value)
                      handleTyping()
                    }}
                    onKeyPress={(e) => e.key === "Enter" && sendMessage()}
                    disabled={!isConnected}
                  />
                  <Button onClick={sendMessage} disabled={!isConnected || !messageInput.trim()}>
                    <Send className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {/* Online Users */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center">
                  <Users className="h-5 w-5 mr-2" />
                  Online Users ({onlineUsers.length})
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-32">
                  {onlineUsers.length === 0 ? (
                    <p className="text-sm text-gray-500">No users online</p>
                  ) : (
                    <div className="space-y-2">
                      {onlineUsers.map((user) => (
                        <div key={user.userId} className="flex items-center space-x-2">
                          <div
                            className={`w-2 h-2 rounded-full ${
                              user.status === "online"
                                ? "bg-green-500"
                                : user.status === "away"
                                  ? "bg-yellow-500"
                                  : "bg-gray-500"
                            }`}
                          />
                          <span className="text-sm">{user.username}</span>
                          {user.activity && <span className="text-xs text-gray-500">({user.activity})</span>}
                        </div>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </CardContent>
            </Card>

            {/* Real-time Notifications */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center">
                  <Bell className="h-5 w-5 mr-2" />
                  Live Notifications
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-64">
                  {notifications.length === 0 ? (
                    <p className="text-sm text-gray-500">No notifications</p>
                  ) : (
                    <div className="space-y-3">
                      {notifications.map((notification) => (
                        <div key={notification.id} className="border-l-4 border-blue-500 pl-3">
                          <div className="flex items-center justify-between">
                            <h4 className="text-sm font-medium">{notification.title}</h4>
                            <Badge
                              variant={
                                notification.type === "success"
                                  ? "default"
                                  : notification.type === "warning"
                                    ? "secondary"
                                    : notification.type === "error"
                                      ? "destructive"
                                      : "outline"
                              }
                            >
                              {notification.type}
                            </Badge>
                          </div>
                          <p className="text-xs text-gray-600 mt-1">{notification.message}</p>
                          <p className="text-xs text-gray-400 mt-1">{formatTime(notification.timestamp)}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </CardContent>
            </Card>

            {/* Quick Actions */}
            <Card>
              <CardHeader>
                <CardTitle>Quick Actions</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full justify-start bg-transparent"
                  onClick={() => {
                    addNotification({
                      id: Date.now().toString(),
                      title: "Test Notification",
                      message: "This is a test notification",
                      type: "info",
                      timestamp: new Date(),
                    })
                  }}
                >
                  <Bell className="h-4 w-4 mr-2" />
                  Send Test Notification
                </Button>

                <Button
                  variant="outline"
                  size="sm"
                  className="w-full justify-start bg-transparent"
                  onClick={() => {
                    if (socket) {
                      socket.emit("project_update", {
                        projectId: "123",
                        updateType: "status_change",
                        updateData: { status: "In Progress" },
                      })
                    }
                  }}
                >
                  <Activity className="h-4 w-4 mr-2" />
                  Simulate Project Update
                </Button>

                <Button
                  variant="outline"
                  size="sm"
                  className="w-full justify-start bg-transparent"
                  onClick={() => {
                    addNotification({
                      id: Date.now().toString(),
                      title: "New Match Found!",
                      message: "You have a 95% match with 'React Dashboard Project'",
                      type: "success",
                      timestamp: new Date(),
                    })
                  }}
                >
                  <UserCheck className="h-4 w-4 mr-2" />
                  Simulate New Match
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}
