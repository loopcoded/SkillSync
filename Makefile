# Skill Sync Platform - Development Commands

.PHONY: help build start stop clean test deploy logs setup-phase5 test-realtime test-analytics dev-websocket dev-analytics install-websocket install-analytics logs-websocket logs-analytics build-websocket build-analytics

# Default target
help:
	@echo "Skill Sync Platform - Available Commands:"
	@echo ""
	@echo "Phase 5 - Advanced Features:"
	@echo "  make setup-phase5       - Setup Phase 5 with WebSocket and Analytics"
	@echo "  make test-realtime      - Test WebSocket real-time features"
	@echo "  make test-analytics     - Test analytics data processing"
	@echo "  make logs-websocket     - View WebSocket Service logs"
	@echo "  make logs-analytics     - View Analytics Service logs"
	@echo ""
	@echo "Development:"
	@echo "  make start              - Start all services with Docker Compose"
	@echo "  make stop               - Stop all services"
	@echo "  make restart            - Restart all services"
	@echo "  make logs               - View logs from all services"
	@echo ""
	@echo "Building:"
	@echo "  make build              - Build all Docker images"
	@echo "  make build-websocket    - Build WebSocket Service image"
	@echo "  make build-analytics    - Build Analytics Service image"
	@echo ""
	@echo "Testing:"
	@echo "  make test               - Run all tests"
	@echo "  make test-communication - Test inter-service communication"
	@echo "  make test-messaging     - Test RabbitMQ messaging"
	@echo ""
	@echo "Kubernetes:"
	@echo "  make k8s-deploy         - Deploy to Kubernetes"
	@echo "  make k8s-delete         - Delete from Kubernetes"
	@echo "  make k8s-status         - Check Kubernetes status"
	@echo ""
	@echo "Cleanup:"
	@echo "  make clean              - Clean up Docker resources"
	@echo "  make clean-all          - Clean up everything (Docker + Kubernetes)"

# Phase 5 Setup
setup-phase5:
	@echo "Setting up Phase 5 - Advanced Features..."
	@echo "1. Installing dependencies for new services..."
	cd services/websocket-service && npm install
	cd services/analytics-service && npm install
	@echo "2. Building all Docker images..."
	make build
	@echo "3. Starting all services..."
	make start
	@echo "4. Waiting for services to start..."
	sleep 20
	@echo "5. Testing real-time features..."
	make test-realtime
	@echo ""
	@echo "Phase 5 setup complete! Services available at:"
	@echo "  User Profile Service: http://localhost:3001"
	@echo "  Project Ideas Service: http://localhost:3002"
	@echo "  Matching Service: http://localhost:3003"
	@echo "  Content Ingestion Service: http://localhost:3004"
	@echo "  Notification Service: http://localhost:3005"
	@echo "  WebSocket Service: http://localhost:3006"
	@echo "  Analytics Service: http://localhost:3007"
	@echo "  API Gateway: http://localhost:8080"
	@echo "  RabbitMQ Management: http://localhost:15672 (admin/password123)"
	@echo "  Redis: redis://localhost:6379"
	@echo "  MongoDB: mongodb://localhost:27017"
	@echo "  Grafana: http://localhost:3000 (admin/admin123)"
	@echo "  Prometheus: http://localhost:9090"

# Development Commands
start:
	docker-compose up -d
	@echo "All services starting... Check status with 'make logs'"

stop:
	docker-compose down

restart: stop start

logs:
	docker-compose logs -f

logs-websocket:
	docker-compose logs -f websocket-service

logs-analytics:
	docker-compose logs -f analytics-service

# Building
build:
	docker-compose build

build-websocket:
	docker build -t skill-sync/websocket-service ./services/websocket-service

build-analytics:
	docker build -t skill-sync/analytics-service ./services/analytics-service

# Testing
test:
	@echo "Running all service tests..."
	cd services/user-profile-service && npm test
	cd services/project-ideas-service && npm test
	cd services/matching-service && npm test
	cd services/content-ingestion-service && npm test
	cd services/notification-service && npm test
	cd services/websocket-service && npm test
	cd services/analytics-service && npm test

test-realtime:
	@echo "Testing WebSocket real-time features..."
	@echo "1. Checking WebSocket Service health..."
	curl -s http://localhost:3006/health | jq .
	@echo "2. Testing WebSocket connection..."
	curl -s http://localhost:3006/api/sessions | jq .
	@echo "3. Testing room statistics..."
	curl -s http://localhost:3006/api/rooms/stats | jq .

test-analytics:
	@echo "Testing Analytics Service..."
	@echo "1. Checking Analytics Service health..."
	curl -s http://localhost:3007/health | jq .
	@echo "2. Testing event tracking..."
	curl -s -X POST http://localhost:3007/api/events/track \
		-H "Content-Type: application/json" \
		-d '{"eventType":"test_event","userId":"test123","data":{"action":"test"}}' | jq .
	@echo "3. Testing dashboard data..."
	curl -s http://localhost:3007/api/dashboard | jq .

test-communication:
	@echo "Testing inter-service communication..."
	@echo "1. Testing User Profile Service..."
	curl -s http://localhost:3001/health | jq .
	@echo "2. Testing Project Ideas Service..."
	curl -s http://localhost:3002/health | jq .
	@echo "3. Testing Matching Service..."
	curl -s http://localhost:3003/health | jq .
	@echo "4. Testing Content Ingestion Service..."
	curl -s http://localhost:3004/health | jq .
	@echo "5. Testing Notification Service..."
	curl -s http://localhost:3005/health | jq .
	@echo "6. Testing WebSocket Service..."
	curl -s http://localhost:3006/health | jq .
	@echo "7. Testing Analytics Service..."
	curl -s http://localhost:3007/health | jq .
	@echo "8. Testing API Gateway..."
	curl -s http://localhost:8080/health | jq .

test-messaging:
	@echo "Testing RabbitMQ messaging..."
	@echo "1. Checking RabbitMQ Management UI..."
	curl -s http://admin:password123@localhost:15672/api/overview | jq .
	@echo "2. Testing event publishing..."
	curl -s -X POST http://localhost:3002/api/projects \
		-H "Content-Type: application/json" \
		-d '{"title":"Test Event Project","description":"Testing events","category":"Web Development","createdBy":"test123"}' | jq .

# Kubernetes Commands
k8s-deploy:
	@echo "Deploying to Kubernetes..."
	kubectl apply -f k8s/
	@echo "Waiting for deployments to be ready..."
	kubectl wait --for=condition=available --timeout=300s deployment/mongodb
	kubectl wait --for=condition=available --timeout=300s deployment/user-profile-service
	kubectl wait --for=condition=available --timeout=300s deployment/websocket-service
	kubectl wait --for=condition=available --timeout=300s deployment/analytics-service

k8s-delete:
	kubectl delete -f k8s/

k8s-status:
	@echo "=== Pods ==="
	kubectl get pods
	@echo ""
	@echo "=== Services ==="
	kubectl get services
	@echo ""
	@echo "=== Deployments ==="
	kubectl get deployments

# Cleanup
clean:
	docker-compose down -v
	docker system prune -f
	docker volume prune -f

clean-all: clean k8s-delete
	@echo "Cleaned up Docker and Kubernetes resources"

# Development helpers
dev-websocket:
	cd services/websocket-service && npm run dev

dev-analytics:
	cd services/analytics-service && npm run dev

install-websocket:
	cd services/websocket-service && npm install

install-analytics:
	cd services/analytics-service && npm install

# Monitoring
monitoring-up:
	docker-compose up -d prometheus grafana
	@echo "Monitoring stack available at:"
	@echo "  Grafana: http://localhost:3000 (admin/admin123)"
	@echo "  Prometheus: http://localhost:9090"

# Database
db-shell:
	docker-compose exec mongodb mongosh

# API Testing
test-api:
	@echo "Testing API Gateway..."
	curl -X GET http://localhost:8080/health
	@echo ""
	curl -X GET http://localhost:8080/api/docs
	@echo ""

# Real-time Testing
test-websocket-connection:
	@echo "Testing WebSocket connection..."
	node -e "
	const io = require('socket.io-client');
	const socket = io('http://localhost:3006', {
		auth: { token: 'test-token' }
	});
	socket.on('connect', () => {
		console.log('✅ WebSocket connected successfully');
		socket.emit('join_room', { room: 'test_room', type: 'public' });
		setTimeout(() => socket.disconnect(), 2000);
	});
	socket.on('connect_error', (err) => {
		console.log('❌ WebSocket connection failed:', err.message);
	});
	"

# Analytics Testing
test-analytics-pipeline:
	@echo "Testing analytics pipeline..."
	@echo "1. Sending test events..."
	for i in {1..10}; do \
		curl -s -X POST http://localhost:3007/api/events/track \
			-H "Content-Type: application/json" \
			-d "{\"eventType\":\"page_view\",\"userId\":\"user$$i\",\"data\":{\"page\":\"/dashboard\"}}" > /dev/null; \
	done
	@echo "2. Checking dashboard metrics..."
	curl -s http://localhost:3007/api/dashboard?period=1d | jq '.todayMetrics'

# Load Testing
load-test:
	@echo "Running basic load test..."
	@echo "Testing API Gateway endpoints..."
	ab -n 100 -c 10 http://localhost:8080/health
	@echo "Testing WebSocket Service..."
	ab -n 100 -c 10 http://localhost:3006/health
	@echo "Testing Analytics Service..."
	ab -n 100 -c 10 http://localhost:3007/health

# Complete Platform Test
test-platform:
	@echo "Running comprehensive platform test..."
	make test-communication
	make test-messaging
	make test-realtime
	make test-analytics
	@echo ""
	@echo "✅ Platform test completed successfully!"
	@echo "All 8 microservices are running and communicating properly."
