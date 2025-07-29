@echo off
echo Setting up Skill Sync Platform...

echo Installing dependencies for all services...
cd services\user-profile-service && npm install && cd ..\..
cd services\project-ideas-service && npm install && cd ..\..
cd services\matching-service && npm install && cd ..\..
cd services\content-ingestion-service && npm install && cd ..\..
cd services\notification-service && npm install && cd ..\..
cd services\websocket-service && npm install && cd ..\..
cd services\analytics-service && npm install && cd ..\..
cd services\api-gateway && npm install && cd ..\..

echo Starting infrastructure services...
docker-compose up -d mongodb redis rabbitmq

echo Waiting for services to be ready...
timeout /t 10

echo Building and starting all services...
docker-compose build
docker-compose up -d

echo Setup complete! Services are starting...
echo Check status with: docker-compose ps
echo View logs with: docker-compose logs -f

pause
