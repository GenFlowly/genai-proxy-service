package com.genflowly.providers

import com.genflowly.config.AppConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.slf4j.LoggerFactory
import software.amazon.awssdk.regions.Region
import software.amazon.awssdk.services.sns.SnsClient
import software.amazon.awssdk.services.sns.model.PublishRequest

/** Emails the support inbox through the support SNS topic. Does nothing where SUPPORT_TOPIC_ARN is unset. */
class SnsNotifier(appConfig: AppConfig) {
    private val logger = LoggerFactory.getLogger(SnsNotifier::class.java)
    private val topicArn = appConfig.supportTopicArn
    private val stageTag = if (appConfig.isProduction) "" else "[${appConfig.environment}] "
    private val client: SnsClient? = topicArn?.let {
        SnsClient.builder().region(Region.of(appConfig.awsRegion)).build()
    }

    suspend fun notifySupport(subject: String, message: String) {
        val client = client ?: return logger.info("SUPPORT_TOPIC_ARN is not set; not emailing: {}", subject)
        withContext(Dispatchers.IO) {
            client.publish(
                PublishRequest.builder()
                    .topicArn(topicArn)
                    .subject((stageTag + subject).take(MAX_SUBJECT_CHARS))
                    .message(message)
                    .build()
            )
        }
    }

    private companion object {
        const val MAX_SUBJECT_CHARS = 100
    }
}
