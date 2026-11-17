# Stage 1: Build
FROM gradle:8.5-jdk17 AS build
WORKDIR /app

# Copy gradle files
COPY build.gradle.kts settings.gradle.kts gradle.properties ./
COPY gradle ./gradle

# Download dependencies (cached layer)
RUN gradle dependencies --no-daemon

# Copy source code
COPY src ./src

# Build the application
RUN gradle buildFatJar --no-daemon

# Stage 2: Runtime
# Switched to non-Alpine (Amazon Linux 2) to fix DNS/Network hangs
FROM amazoncorretto:17

WORKDIR /app

# Copy the built JAR from build stage
COPY --from=build /app/build/libs/*-all.jar app.jar

# Expose the port your Ktor app runs on
EXPOSE 8080

# Set JVM options (optional but recommended)
ENV JAVA_OPTS="-Xmx512m -Xms256m"

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Run the application
ENTRYPOINT ["sh", "-c", "java $JAVA_OPTS -jar app.jar"]