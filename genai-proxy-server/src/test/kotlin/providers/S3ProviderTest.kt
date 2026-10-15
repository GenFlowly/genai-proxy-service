package com.genflowly.providers

import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.test.runTest
import mu.KLogger
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider
import software.amazon.awssdk.regions.Region
import software.amazon.awssdk.services.s3.S3Client
import software.amazon.awssdk.services.s3.model.CopyObjectRequest
import software.amazon.awssdk.services.s3.model.CopyObjectResponse
import software.amazon.awssdk.services.s3.model.DeleteObjectsRequest
import software.amazon.awssdk.services.s3.model.DeleteObjectsResponse
import software.amazon.awssdk.services.s3.model.GetObjectTaggingRequest
import software.amazon.awssdk.services.s3.model.GetObjectTaggingResponse
import software.amazon.awssdk.services.s3.model.ListObjectsV2Request
import software.amazon.awssdk.services.s3.model.ListObjectsV2Response
import software.amazon.awssdk.services.s3.model.PutObjectTaggingRequest
import software.amazon.awssdk.services.s3.model.PutObjectTaggingResponse
import software.amazon.awssdk.services.s3.model.S3Error
import software.amazon.awssdk.services.s3.model.S3Object
import software.amazon.awssdk.services.s3.model.Tag
import software.amazon.awssdk.services.s3.model.TaggingDirective
import software.amazon.awssdk.services.s3.presigner.S3Presigner
import java.net.URI
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * S3Provider's tagging, copy, batch-delete and list operations against a
 * mocked S3Client, and presignPut's tagging header against a real (offline)
 * presigner.
 */
class S3ProviderTest {

    private val bucket = "test-bucket"
    private val s3 = mockk<S3Client>()
    private val presigner = S3Presigner.builder()
        .region(Region.US_EAST_1)
        .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create("AKIDEXAMPLE", "secret")))
        .build()
    private val provider = S3Provider(s3, presigner, mockk<KLogger>(relaxed = true), bucket)

    private fun keys(n: Int, prefix: String = "customers/c1/attachments/k") = (1..n).map { "$prefix$it" }

    private fun DeleteObjectsRequest.keys(): List<String> = delete().objects().map { it.key() }

    private fun errorsFor(vararg keys: String): DeleteObjectsResponse =
        DeleteObjectsResponse.builder()
            .errors(keys.map { S3Error.builder().key(it).code("InternalError").message("try again").build() })
            .build()

    private val ok: DeleteObjectsResponse = DeleteObjectsResponse.builder().build()

    // ── deleteObjects ─────────────────────────────────────────────────────────

    @Test
    fun `2,345 keys are deleted in exactly three quiet calls of 1000, 1000 and 345`() = runTest {
        val requests = mutableListOf<DeleteObjectsRequest>()
        every { s3.deleteObjects(capture(requests)) } returns ok
        val all = keys(2_345)

        val failed = provider.deleteObjects(all)

        assertEquals(emptyList(), failed)
        verify(exactly = 3) { s3.deleteObjects(any<DeleteObjectsRequest>()) }
        assertEquals(listOf(1_000, 1_000, 345), requests.map { it.keys().size })
        assertEquals(all, requests.flatMap { it.keys() })
        requests.forEach {
            assertEquals(bucket, it.bucket())
            assertTrue(it.delete().quiet())
        }
    }

    @Test
    fun `only the keys S3 reports in Errors are retried`() = runTest {
        val requests = mutableListOf<DeleteObjectsRequest>()
        every { s3.deleteObjects(capture(requests)) } returnsMany listOf(
            errorsFor("customers/c1/attachments/k2", "customers/c1/attachments/k4"),
            errorsFor("customers/c1/attachments/k4"),
            ok
        )

        val failed = provider.deleteObjects(keys(5))

        assertEquals(emptyList(), failed)
        assertEquals(
            listOf(
                keys(5),
                listOf("customers/c1/attachments/k2", "customers/c1/attachments/k4"),
                listOf("customers/c1/attachments/k4")
            ),
            requests.map { it.keys() }
        )
    }

    @Test
    fun `keys still failing after 5 attempts are returned, after exponential backoff`() = runTest {
        val requests = mutableListOf<DeleteObjectsRequest>()
        every { s3.deleteObjects(capture(requests)) } answers {
            // k2 never deletes; everything else succeeds on the first try
            if ("customers/c1/attachments/k2" in firstArg<DeleteObjectsRequest>().keys()) {
                errorsFor("customers/c1/attachments/k2")
            } else ok
        }

        val failed = provider.deleteObjects(keys(3))

        assertEquals(listOf("customers/c1/attachments/k2"), failed)
        assertEquals(S3Provider.DELETE_MAX_ATTEMPTS, requests.size)
        assertEquals(keys(3), requests.first().keys())
        requests.drop(1).forEach { assertEquals(listOf("customers/c1/attachments/k2"), it.keys()) }
        // 200 + 400 + 800 + 1600 ms between the five attempts (virtual time)
        assertEquals(3_000L, testScheduler.currentTime)
    }

    @Test
    fun `each batch retries only its own failures`() = runTest {
        val requests = mutableListOf<DeleteObjectsRequest>()
        val stuck = "customers/c1/attachments/k1500"
        every { s3.deleteObjects(capture(requests)) } answers {
            if (stuck in firstArg<DeleteObjectsRequest>().keys()) errorsFor(stuck) else ok
        }

        val failed = provider.deleteObjects(keys(2_345))

        assertEquals(listOf(stuck), failed)
        // batch 1: one call; batch 2: 1 + 4 retries of the stuck key only; batch 3: one call
        assertEquals(listOf(1_000, 1_000, 1, 1, 1, 1, 345), requests.map { it.keys().size })
    }

    @Test
    fun `an empty key list makes no call`() = runTest {
        assertEquals(emptyList(), provider.deleteObjects(emptyList()))
        verify(exactly = 0) { s3.deleteObjects(any<DeleteObjectsRequest>()) }
    }

    // ── listKeys ──────────────────────────────────────────────────────────────

    private fun page(vararg keys: String, next: String? = null): ListObjectsV2Response =
        ListObjectsV2Response.builder()
            .contents(keys.map { S3Object.builder().key(it).build() })
            .isTruncated(next != null)
            .nextContinuationToken(next)
            .build()

    @Test
    fun `listKeys follows continuation tokens to the last page`() = runTest {
        val requests = mutableListOf<ListObjectsV2Request>()
        every { s3.listObjectsV2(capture(requests)) } returnsMany listOf(
            page("p/a", "p/b", next = "t1"),
            page("p/c", next = "t2"),
            page("p/d")
        )

        val listed = provider.listKeys("p/")

        assertEquals(listOf("p/a", "p/b", "p/c", "p/d"), listed)
        assertEquals(listOf(null, "t1", "t2"), requests.map { it.continuationToken() })
        requests.forEach {
            assertEquals(bucket, it.bucket())
            assertEquals("p/", it.prefix())
        }
    }

    @Test
    fun `listKeys refuses a blank prefix`() = runTest {
        assertFailsWith<IllegalArgumentException> { provider.listKeys(" ") }
        verify(exactly = 0) { s3.listObjectsV2(any<ListObjectsV2Request>()) }
    }

    // ── tagging and copy ──────────────────────────────────────────────────────

    @Test
    fun `putObjectTagging sends the whole tag set`() = runTest {
        val requests = mutableListOf<PutObjectTaggingRequest>()
        every { s3.putObjectTagging(capture(requests)) } returns PutObjectTaggingResponse.builder().build()

        provider.putObjectTagging("customers/c1/attachments/a1", mapOf("retention" to "kept", "conv" to "conv-1"))

        val request = requests.single()
        assertEquals(bucket, request.bucket())
        assertEquals("customers/c1/attachments/a1", request.key())
        assertEquals(
            mapOf("retention" to "kept", "conv" to "conv-1"),
            request.tagging().tagSet().associate { it.key() to it.value() }
        )
    }

    @Test
    fun `getObjectTagging returns the tags as a map`() = runTest {
        val requests = mutableListOf<GetObjectTaggingRequest>()
        every { s3.getObjectTagging(capture(requests)) } returns GetObjectTaggingResponse.builder()
            .tagSet(Tag.builder().key("retention").value("pending").build())
            .build()

        val tags = provider.getObjectTagging("customers/c1/attachments/a1")

        assertEquals(mapOf("retention" to "pending"), tags)
        assertEquals("customers/c1/attachments/a1", requests.single().key())
        assertEquals(bucket, requests.single().bucket())
    }

    @Test
    fun `copyObject with tags replaces them on the copy`() = runTest {
        val requests = mutableListOf<CopyObjectRequest>()
        every { s3.copyObject(capture(requests)) } returns CopyObjectResponse.builder().build()

        provider.copyObject(
            "customers/c1/attachments/a1",
            "customers/c2/attachments/a2",
            mapOf("retention" to "kept", "conv" to "conv 2")
        )

        val request = requests.single()
        assertEquals(bucket, request.sourceBucket())
        assertEquals("customers/c1/attachments/a1", request.sourceKey())
        assertEquals(bucket, request.destinationBucket())
        assertEquals("customers/c2/attachments/a2", request.destinationKey())
        assertEquals(TaggingDirective.REPLACE, request.taggingDirective())
        assertEquals("retention=kept&conv=conv%202", request.tagging())
    }

    @Test
    fun `copyObject without tags keeps the source's tags`() = runTest {
        val requests = mutableListOf<CopyObjectRequest>()
        every { s3.copyObject(capture(requests)) } returns CopyObjectResponse.builder().build()

        provider.copyObject("customers/c1/attachments/a1", "customers/c1/attachments/a1-copy", null)

        val request = requests.single()
        assertEquals(TaggingDirective.COPY, request.taggingDirective())
        assertEquals(null, request.tagging())
    }

    // ── presignPut ────────────────────────────────────────────────────────────

    private fun signedHeaders(url: String): List<String> =
        URI(url).rawQuery.split("&")
            .first { it.startsWith("X-Amz-SignedHeaders=") }
            .substringAfter("=")
            .split("%3B", ";")

    @Test
    fun `presignPut with tagging signs the x-amz-tagging header`() = runTest {
        val url = provider.presignPut("customers/c1/attachments/a1", "application/pdf", tagging = "retention=pending")

        assertTrue("x-amz-tagging" in signedHeaders(url), url)
        // A signed header, not a query parameter: the client must send it
        assertFalse(URI(url).rawQuery.split("&").any { it.lowercase().startsWith("x-amz-tagging=") }, url)
    }

    @Test
    fun `presignPut without tagging signs only host and content-type, as before`() = runTest {
        val url = provider.presignPut("customers/c1/attachments/a1", "image/png")

        assertEquals(listOf("content-type", "host"), signedHeaders(url).sorted())
    }
}
