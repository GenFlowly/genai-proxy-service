package com.genflowly.models

import kotlinx.serialization.Serializable

/**
 * Access role on a shared entity (conversation or instruction).
 *
 * Serializes by name, so the wire format matches the historic
 * "OWNER"/"EDIT"/"VIEW" strings.
 */
@Serializable
enum class ShareRole {
    /** The entity's creator — full control, including delete. */
    OWNER,

    /** May modify and share the entity. */
    EDIT,

    /** Read-only access. */
    VIEW;

    /** True for the roles allowed to modify/share (OWNER and EDIT). */
    val canEdit: Boolean get() = this == OWNER || this == EDIT

    companion object {
        /**
         * Maps a stored role attribute to a [ShareRole]. Missing or unknown
         * values read as [VIEW] — the least-privileged role.
         */
        fun fromDb(value: String?): ShareRole =
            value?.let { runCatching { valueOf(it) }.getOrNull() } ?: VIEW
    }
}
