
plugins {
    kotlin("jvm") version "2.0.21"
    kotlin("plugin.serialization") version "2.0.21"
    id("io.ktor.plugin") version "3.0.0"
    application
}

group = "com.genflowly"
version = "0.0.1"

application {
    mainClass = "io.ktor.server.netty.EngineMain"
}

repositories {
    mavenCentral()
    maven {
        name = "GitHubPackages"
        url = uri("https://maven.pkg.github.com/genflowly/ai-caller-lib")
        credentials {
            username = "nkirit"
            password = "***REDACTED***"
        }
    }
}

dependencies {
    implementation("io.ktor:ktor-server-core-jvm")
    implementation("io.ktor:ktor-server-netty")
    implementation("io.ktor:ktor-server-core")
    implementation("io.ktor:ktor-server-config-yaml")
    testImplementation("io.ktor:ktor-server-test-host")

    implementation("io.ktor:ktor-server-cors:3.0.0")
    implementation("io.ktor:ktor-server-call-logging:3.0.0")

    // OpenAPI spec generation from routes + Swagger UI
    implementation("io.github.smiley4:ktor-openapi:5.1.0")
    implementation("io.github.smiley4:ktor-swagger-ui:5.1.0")
    // Compile-time access to the OpenAPI model for the postBuild spec hook
    // (transitive runtime dep of ktor-openapi; version matched to its parser)
    implementation("io.swagger.core.v3:swagger-models:2.2.26")
    api("io.ktor:ktor-server-content-negotiation:3.0.0")
    api("io.ktor:ktor-serialization-kotlinx-json:3.0.0")

    // Ktor Client
    implementation("io.ktor:ktor-client-core:3.0.0")
    implementation("io.ktor:ktor-client-cio:3.0.0")
    implementation("io.ktor:ktor-client-content-negotiation:3.0.0")


    implementation("io.insert-koin:koin-ktor:3.5.6") // or latest stable
    implementation("io.insert-koin:koin-logger-slf4j:3.5.6")

    // Kotlin‑logging (nice DSL) + SLF4J API
    implementation("io.github.microutils:kotlin-logging-jvm:3.0.5")
    // Logback classic (SLF4J implementation)
    runtimeOnly("ch.qos.logback:logback-classic:1.5.13")

    implementation(platform("software.amazon.awssdk:bom:2.25.42"))
    // DynamoDB client
    implementation("software.amazon.awssdk:dynamodb")
    implementation("software.amazon.awssdk:kms")
    implementation("software.amazon.awssdk:lambda")
    // Core HTTP client (Netty works well in Ktor)
    implementation("software.amazon.awssdk:url-connection-client")

    implementation("com.genflowly:ai-caller-lib:0.0.34")

    implementation("io.ktor:ktor-server-auth-jvm:3.0.0")
    implementation("io.ktor:ktor-server-auth-jwt-jvm:3.0.0")

    // Voice session relay: client <-> proxy <-> retrieval-server WebSockets
    implementation("io.ktor:ktor-server-websockets:3.0.0")
    implementation("io.ktor:ktor-client-websockets:3.0.0")

    // ✅ Auth0 JWK
    implementation("com.auth0:jwks-rsa:0.22.1")
}

