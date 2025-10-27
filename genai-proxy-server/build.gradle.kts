
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
            password = "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"
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

    // OpenAPI plugin
    implementation("io.ktor:ktor-server-openapi:3.0.0")
    implementation("io.ktor:ktor-server-swagger:3.0.0")
    api("io.ktor:ktor-server-content-negotiation:3.0.0")
    api("io.ktor:ktor-serialization-kotlinx-json:3.0.0")


    implementation("io.insert-koin:koin-ktor:3.5.6") // or latest stable
    implementation("io.insert-koin:koin-logger-slf4j:3.5.6")

    // Kotlin‑logging (nice DSL) + SLF4J API
    implementation("io.github.microutils:kotlin-logging-jvm:3.0.5")
    // Logback classic (SLF4J implementation)
    runtimeOnly("ch.qos.logback:logback-classic:1.5.6")

    implementation(platform("software.amazon.awssdk:bom:2.25.42"))
    // DynamoDB client
    implementation("software.amazon.awssdk:dynamodb")
    implementation("software.amazon.awssdk:kms")
    // Core HTTP client (Netty works well in Ktor)
    implementation("software.amazon.awssdk:url-connection-client")

    implementation("com.genflowly:ai-caller-lib:0.0.28")

    implementation("io.ktor:ktor-server-auth-jvm:3.0.0")
    implementation("io.ktor:ktor-server-auth-jwt-jvm:3.0.0")

    // ✅ Auth0 JWK
    implementation("com.auth0:jwks-rsa:0.22.1")
}

