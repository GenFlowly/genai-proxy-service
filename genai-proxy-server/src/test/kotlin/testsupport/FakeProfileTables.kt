package com.genflowly.testsupport

import io.mockk.every
import io.mockk.mockk
import software.amazon.awssdk.services.dynamodb.DynamoDbClient
import software.amazon.awssdk.services.dynamodb.model.AttributeValue
import software.amazon.awssdk.services.dynamodb.model.CancellationReason
import software.amazon.awssdk.services.dynamodb.model.ConditionalCheckFailedException
import software.amazon.awssdk.services.dynamodb.model.DeleteItemRequest
import software.amazon.awssdk.services.dynamodb.model.DeleteItemResponse
import software.amazon.awssdk.services.dynamodb.model.GetItemRequest
import software.amazon.awssdk.services.dynamodb.model.GetItemResponse
import software.amazon.awssdk.services.dynamodb.model.PutItemRequest
import software.amazon.awssdk.services.dynamodb.model.PutItemResponse
import software.amazon.awssdk.services.dynamodb.model.QueryRequest
import software.amazon.awssdk.services.dynamodb.model.QueryResponse
import software.amazon.awssdk.services.dynamodb.model.TransactWriteItemsRequest
import software.amazon.awssdk.services.dynamodb.model.TransactWriteItemsResponse
import software.amazon.awssdk.services.dynamodb.model.TransactionCanceledException
import software.amazon.awssdk.services.dynamodb.model.UpdateItemRequest
import software.amazon.awssdk.services.dynamodb.model.UpdateItemResponse

/**
 * The CustomerProfile (sub, client; customerIdIndex) and UsernameLookup
 * (username) tables in memory, behind a mocked DynamoDbClient. Supports
 * exactly what CustomerProfileRepository's onboarding, reads, username
 * backfill and deletion re-key send - the conditions they use included -
 * and records every UsernameLookup write.
 */
class FakeProfileTables {
    val client: DynamoDbClient = mockk()
    val profiles = linkedMapOf<Pair<String, String>, MutableMap<String, AttributeValue>>()
    val usernames = linkedMapOf<String, Map<String, AttributeValue>>()
    val usernameWrites = mutableListOf<String>()

    fun s(v: String): AttributeValue = AttributeValue.builder().s(v).build()

    fun addProfile(sub: String, client: String, customerId: String, name: String, username: String?) {
        profiles[sub to client] = buildMap {
            put("sub", s(sub)); put("client", s(client)); put("customerId", s(customerId)); put("name", s(name))
            put("email", s("$customerId@example.com"))
            put("isDiscoverable", AttributeValue.builder().bool(true).build())
            username?.let { put("username", s(it)) }
        }.toMutableMap()
        username?.let { usernames[it] = mapOf("username" to s(it), "recordType" to s("USER"), "customerId" to s(customerId)) }
    }

    private fun profileKey(key: Map<String, AttributeValue>) = key["sub"]!!.s() to key["client"]!!.s()

    /** Evaluates the handful of condition forms the repository uses. */
    private fun holds(
        condition: String?,
        item: Map<String, AttributeValue>?,
        names: Map<String, String>?,
        values: Map<String, AttributeValue>?
    ): Boolean {
        if (condition == null) return true
        fun name(token: String) = names?.get(token) ?: token
        return condition.split(" OR ").any { clause ->
            val c = clause.trim()
            when {
                c.startsWith("attribute_not_exists(") -> item == null || !item.containsKey(name(c.substringAfter("(").substringBefore(")")))
                c.startsWith("attribute_exists(") -> item != null && item.containsKey(name(c.substringAfter("(").substringBefore(")")))
                " = " in c -> {
                    val (left, right) = c.split(" = ").map { it.trim() }
                    item != null && item[name(left)]?.s() == values?.get(right)?.s()
                }
                else -> error("Unsupported condition in fake: $c")
            }
        }
    }

    init {
        every { client.getItem(any<GetItemRequest>()) } answers {
            val req = firstArg<GetItemRequest>()
            val item = when (req.tableName()) {
                "CustomerProfile" -> profiles[profileKey(req.key())]
                "UsernameLookup" -> usernames[req.key()["username"]!!.s()]
                else -> error("Unexpected table ${req.tableName()}")
            }
            GetItemResponse.builder().item(item ?: emptyMap()).build()
        }
        every { client.query(any<QueryRequest>()) } answers {
            val req = firstArg<QueryRequest>()
            require(req.tableName() == "CustomerProfile") { "Unexpected query on ${req.tableName()}" }
            val items = if (req.indexName() == "customerIdIndex") {
                val cid = req.expressionAttributeValues()[":cid"]!!.s()
                profiles.values.filter { it["customerId"]?.s() == cid }
            } else {
                val sub = req.expressionAttributeValues()[":sub"]!!.s()
                profiles.values.filter { it["sub"]?.s() == sub }
            }
            QueryResponse.builder().items(items.map { it.toMap() }.take(req.limit() ?: Int.MAX_VALUE)).build()
        }
        every { client.putItem(any<PutItemRequest>()) } answers {
            val req = firstArg<PutItemRequest>()
            when (req.tableName()) {
                "UsernameLookup" -> {
                    val username = req.item()["username"]!!.s()
                    if (!holds(req.conditionExpression(), usernames[username], req.expressionAttributeNames(), req.expressionAttributeValues())) {
                        throw ConditionalCheckFailedException.builder().message("taken").build()
                    }
                    usernameWrites += username
                    usernames[username] = req.item()
                }
                "CustomerProfile" -> profiles[profileKey(req.item())] = req.item().toMutableMap()
                else -> error("Unexpected table ${req.tableName()}")
            }
            PutItemResponse.builder().build()
        }
        every { client.updateItem(any<UpdateItemRequest>()) } answers {
            val req = firstArg<UpdateItemRequest>()
            require(req.tableName() == "CustomerProfile") { "Unexpected update on ${req.tableName()}" }
            val item = profiles[profileKey(req.key())]
            if (!holds(req.conditionExpression(), item, req.expressionAttributeNames(), req.expressionAttributeValues())) {
                throw ConditionalCheckFailedException.builder().message("condition").build()
            }
            val target = item ?: mutableMapOf<String, AttributeValue>().also { profiles[profileKey(req.key())] = it }
            // "SET a = :x, b = if_not_exists(b, :y)" style assignments
            Regex("""(#?\w+)\s*=\s*(if_not_exists\([^)]*\)|:\w+)""").findAll(req.updateExpression()).forEach { m ->
                val left = m.groupValues[1]
                val right = m.groupValues[2]
                val attr = req.expressionAttributeNames()?.get(left) ?: left
                val placeholder = Regex(":[A-Za-z0-9_]+").findAll(right).last().value
                if (!right.startsWith("if_not_exists") || !target.containsKey(attr)) {
                    target[attr] = req.expressionAttributeValues()[placeholder]!!
                }
            }
            UpdateItemResponse.builder().build()
        }
        every { client.deleteItem(any<DeleteItemRequest>()) } answers {
            val req = firstArg<DeleteItemRequest>()
            when (req.tableName()) {
                "UsernameLookup" -> {
                    val username = req.key()["username"]!!.s()
                    if (!holds(req.conditionExpression(), usernames[username], req.expressionAttributeNames(), req.expressionAttributeValues())) {
                        throw ConditionalCheckFailedException.builder().message("condition").build()
                    }
                    usernames.remove(username)
                }
                "CustomerProfile" -> profiles.remove(profileKey(req.key()))
                else -> error("Unexpected table ${req.tableName()}")
            }
            DeleteItemResponse.builder().build()
        }
        every { client.transactWriteItems(any<TransactWriteItemsRequest>()) } answers {
            val req = firstArg<TransactWriteItemsRequest>()
            // All conditions first, then all writes (all or nothing)
            val ok = req.transactItems().all { tx ->
                when {
                    tx.put() != null -> {
                        val p = tx.put()
                        val existing = if (p.tableName() == "CustomerProfile") profiles[profileKey(p.item())] else usernames[p.item()["username"]!!.s()]
                        holds(p.conditionExpression(), existing, p.expressionAttributeNames(), p.expressionAttributeValues())
                    }
                    tx.delete() != null -> {
                        val d = tx.delete()
                        val existing = if (d.tableName() == "CustomerProfile") profiles[profileKey(d.key())] else usernames[d.key()["username"]!!.s()]
                        holds(d.conditionExpression(), existing, d.expressionAttributeNames(), d.expressionAttributeValues())
                    }
                    else -> error("Unsupported transact item")
                }
            }
            if (!ok) {
                throw TransactionCanceledException.builder()
                    .cancellationReasons(CancellationReason.builder().code("ConditionalCheckFailed").build())
                    .message("cancelled").build()
            }
            for (tx in req.transactItems()) {
                tx.put()?.let { p ->
                    if (p.tableName() == "CustomerProfile") profiles[profileKey(p.item())] = p.item().toMutableMap()
                    else { usernameWrites += p.item()["username"]!!.s(); usernames[p.item()["username"]!!.s()] = p.item() }
                }
                tx.delete()?.let { d ->
                    if (d.tableName() == "CustomerProfile") profiles.remove(profileKey(d.key()))
                    else usernames.remove(d.key()["username"]!!.s())
                }
            }
            TransactWriteItemsResponse.builder().build()
        }
    }
}
