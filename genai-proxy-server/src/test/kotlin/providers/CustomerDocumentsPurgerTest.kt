package com.genflowly.providers

import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.test.runTest
import software.amazon.awssdk.services.s3.S3Client
import software.amazon.awssdk.services.s3.model.DeleteMarkerEntry
import software.amazon.awssdk.services.s3.model.DeleteObjectsRequest
import software.amazon.awssdk.services.s3.model.DeleteObjectsResponse
import software.amazon.awssdk.services.s3.model.ListObjectVersionsRequest
import software.amazon.awssdk.services.s3.model.ListObjectVersionsResponse
import software.amazon.awssdk.services.s3.model.ObjectVersion
import software.amazon.awssdk.services.s3.model.S3Error
import software.amazon.awssdk.services.s3.paginators.ListObjectVersionsIterable
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/**
 * The versioned customer-documents bucket: every version and delete marker
 * under the customer's prefix is deleted by version id, not just hidden.
 */
class CustomerDocumentsPurgerTest {

    private val s3 = mockk<S3Client>()
    private val deletes = mutableListOf<DeleteObjectsRequest>()
    private val listings = mutableListOf<ListObjectVersionsRequest>()

    init {
        every { s3.listObjectVersionsPaginator(any<ListObjectVersionsRequest>()) } answers {
            ListObjectVersionsIterable(s3, firstArg())
        }
        every { s3.listObjectVersions(any<ListObjectVersionsRequest>()) } answers {
            listings += firstArg<ListObjectVersionsRequest>()
            ListObjectVersionsResponse.builder()
                .versions(
                    ObjectVersion.builder().key("CU1/notes/N1.json").versionId("v1").build(),
                    ObjectVersion.builder().key("CU1/notes/N1.json").versionId("v2").build(),
                )
                .deleteMarkers(DeleteMarkerEntry.builder().key("CU1/notes/N2.json").versionId("m1").build())
                .isTruncated(false)
                .build()
        }
        every { s3.deleteObjects(any<DeleteObjectsRequest>()) } answers {
            deletes += firstArg<DeleteObjectsRequest>()
            DeleteObjectsResponse.builder().build()
        }
    }

    @Test
    fun `deletes every version and delete marker under the customer's prefix`() = runTest {
        val deleted = CustomerDocumentsPurger(s3, "genflowly-development-customer-documents").purgeCustomer("CU1")

        assertEquals(3, deleted)
        assertEquals("CU1/", listings.single().prefix())
        val objects = deletes.single().delete().objects()
        assertEquals(listOf("v1", "v2", "m1"), objects.map { it.versionId() })
        assertEquals("genflowly-development-customer-documents", deletes.single().bucket())
    }

    @Test
    fun `versions S3 refuses to delete fail the purge`() = runTest {
        every { s3.deleteObjects(any<DeleteObjectsRequest>()) } returns DeleteObjectsResponse.builder()
            .errors(S3Error.builder().key("CU1/notes/N1.json").code("AccessDenied").build())
            .build()

        assertFailsWith<IllegalStateException> {
            CustomerDocumentsPurger(s3, "bucket").purgeCustomer("CU1")
        }
    }

    @Test
    fun `without a bucket nothing is touched`() = runTest {
        assertEquals(0, CustomerDocumentsPurger(s3, null).purgeCustomer("CU1"))
        verify(exactly = 0) { s3.listObjectVersions(any<ListObjectVersionsRequest>()) }
    }
}
