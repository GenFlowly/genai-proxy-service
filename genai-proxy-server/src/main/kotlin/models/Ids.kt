package models

import java.util.UUID

/** Prefixed random ids used across the customer domain. */

fun generateCustomerId(): String {
    val uuid = UUID.randomUUID().toString().replace("-", "").take(12).uppercase()
    return "CU$uuid"
}

fun generateInstructionId(): String {
    val uuid = UUID.randomUUID().toString().replace("-", "").take(12).uppercase()
    return "INS$uuid"
}

fun generateNodeId(): String {
    val uuid = UUID.randomUUID().toString().replace("-", "").take(12).uppercase()
    return "NOD$uuid"
}

fun generateGraphId(): String {
    val uuid = UUID.randomUUID().toString().replace("-", "").take(12).uppercase()
    return "GRP$uuid"
}
