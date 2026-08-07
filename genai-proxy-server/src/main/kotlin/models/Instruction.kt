
package models

import kotlinx.serialization.Serializable

@Serializable
data class Instruction(
    val id: String,
    val creator: String,
    val name: String,
    val instructions: String,
    val version: Int? = null,
    val icon: String? = null,
    val color: String? = null,
    val tags: List<String>? = null,
    val category: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null
)
