package com.genflowly.service

import com.genflowly.DynamoDBConstants.DELETED_AT_KEY
import com.genflowly.DynamoDBConstants.GRAPH_EDGES_KEY
import com.genflowly.DynamoDBConstants.GRAPH_ENTRY_POINT_KEY
import com.genflowly.DynamoDBConstants.GRAPH_ID_KEY
import com.genflowly.DynamoDBConstants.GRAPH_IS_DEFAULT_KEY
import com.genflowly.DynamoDBConstants.GRAPH_MAX_ITERATIONS_KEY
import com.genflowly.DynamoDBConstants.GRAPH_NAME_KEY
import com.genflowly.DynamoDBConstants.GRAPH_NODE_IDS_KEY
import com.genflowly.DynamoDBConstants.LATEST_VERSION_KEY
import com.genflowly.DynamoDBConstants.NODE_CONFIG_KEY
import com.genflowly.DynamoDBConstants.NODE_ID_KEY
import com.genflowly.DynamoDBConstants.NODE_NAME_KEY
import com.genflowly.DynamoDBConstants.NODE_TYPE_KEY
import com.genflowly.DynamoDBConstants.VERSION_KEY
import com.genflowly.providers.DynamoDBProvider
import models.api.CreateCustomerGraphRequest
import models.api.CreateGraphNodeRequest
import models.api.CustomerGraphResponse
import models.api.CustomerGraphVersionResponse
import models.api.GraphNodeResponse
import models.api.GraphNodeVersionResponse
import models.api.UpdateCustomerGraphRequest
import models.api.UpdateGraphNodeRequest
import mu.KotlinLogging
import software.amazon.awssdk.services.dynamodb.model.AttributeValue

private val logger = KotlinLogging.logger {}

class GraphService(private val dynamoDBProvider: DynamoDBProvider) {

    // ─── Graph Nodes ──────────────────────────────────────────────────────────

    suspend fun createGraphNode(customerId: String, req: CreateGraphNodeRequest): GraphNodeResponse {
        val nodeId = generateNodeId()
        dynamoDBProvider.createCustomerGraphNode(customerId, nodeId, req.nodeType, req.name, req.config)
        logger.info { "Created graph node $nodeId for customer $customerId" }
        return GraphNodeResponse(
            nodeId = nodeId,
            nodeType = req.nodeType,
            name = req.name,
            config = req.config,
            version = 0,
            latestVersion = 1,
        )
    }

    suspend fun updateGraphNode(customerId: String, nodeId: String, req: UpdateGraphNodeRequest): GraphNodeResponse {
        val current = dynamoDBProvider.getCustomerGraphNode(nodeId)
            ?: error("Graph node $nodeId not found")
        requireOwnership(current, customerId, "node", nodeId)

        val updated = dynamoDBProvider.updateCustomerGraphNode(
            nodeId = nodeId,
            nodeType = req.nodeType ?: current[NODE_TYPE_KEY]!!.s(),
            name = req.name ?: current[NODE_NAME_KEY]!!.s(),
            config = req.config ?: current[NODE_CONFIG_KEY]!!.s(),
        )
        return nodeItemToResponse(updated)
    }

    suspend fun getGraphNode(customerId: String, nodeId: String): GraphNodeResponse {
        val item = dynamoDBProvider.getCustomerGraphNode(nodeId)
            ?: error("Graph node $nodeId not found")
        requireOwnership(item, customerId, "node", nodeId)
        return nodeItemToResponse(item)
    }

    suspend fun deleteGraphNode(customerId: String, nodeId: String) {
        val item = dynamoDBProvider.getCustomerGraphNode(nodeId)
            ?: error("Graph node $nodeId not found")
        requireOwnership(item, customerId, "node", nodeId)
        dynamoDBProvider.deleteCustomerGraphNode(nodeId)
    }

    suspend fun listGraphNodes(customerId: String): List<GraphNodeResponse> =
        dynamoDBProvider.listCustomerGraphNodes(customerId).map { nodeItemToResponse(it) }

    suspend fun getGraphNodeVersions(customerId: String, nodeId: String): List<GraphNodeVersionResponse> {
        val current = dynamoDBProvider.getCustomerGraphNode(nodeId)
            ?: error("Graph node $nodeId not found")
        requireOwnership(current, customerId, "node", nodeId)
        return dynamoDBProvider.getCustomerGraphNodeVersions(nodeId).map { item ->
            GraphNodeVersionResponse(
                nodeId = item[NODE_ID_KEY]?.s() ?: nodeId,
                version = item[VERSION_KEY]?.n()?.toInt() ?: 0,
                nodeType = item[NODE_TYPE_KEY]?.s() ?: "",
                name = item[NODE_NAME_KEY]?.s() ?: "",
                config = item[NODE_CONFIG_KEY]?.s() ?: "{}",
                createdAt = item["createdAt"]?.s() ?: "",
            )
        }
    }

    suspend fun rollbackGraphNode(customerId: String, nodeId: String, toVersion: Int): GraphNodeResponse {
        val current = dynamoDBProvider.getCustomerGraphNode(nodeId)
            ?: error("Graph node $nodeId not found")
        requireOwnership(current, customerId, "node", nodeId)
        val updated = dynamoDBProvider.rollbackCustomerGraphNode(nodeId, toVersion)
        return nodeItemToResponse(updated)
    }

    // ─── Graphs ───────────────────────────────────────────────────────────────

    suspend fun createGraph(customerId: String, req: CreateCustomerGraphRequest): CustomerGraphResponse {
        val graphId = generateGraphId()
        dynamoDBProvider.createCustomerGraph(
            customerId = customerId,
            graphId = graphId,
            name = req.name,
            isDefault = req.isDefault,
            nodeIds = req.nodeIds,
            edges = req.edges,
            entryPoint = req.entryPoint,
            maxIterations = req.maxIterations ?: 10,
        )
        logger.info { "Created graph $graphId for customer $customerId" }
        return CustomerGraphResponse(
            graphId = graphId,
            name = req.name,
            isDefault = req.isDefault,
            nodeIds = req.nodeIds,
            edges = req.edges,
            entryPoint = req.entryPoint,
            maxIterations = req.maxIterations ?: 10,
            version = 0,
            latestVersion = 1,
        )
    }

    suspend fun updateGraph(customerId: String, graphId: String, req: UpdateCustomerGraphRequest): CustomerGraphResponse {
        val current = dynamoDBProvider.getCustomerGraph(graphId)
            ?: error("Graph $graphId not found")
        requireOwnership(current, customerId, "graph", graphId)

        val updated = dynamoDBProvider.updateCustomerGraph(
            graphId = graphId,
            name = req.name ?: current[GRAPH_NAME_KEY]!!.s(),
            isDefault = req.isDefault ?: current[GRAPH_IS_DEFAULT_KEY]!!.bool(),
            nodeIds = req.nodeIds ?: current[GRAPH_NODE_IDS_KEY]!!.l().map { it.s() },
            edges = req.edges ?: current[GRAPH_EDGES_KEY]!!.s(),
            entryPoint = req.entryPoint ?: current[GRAPH_ENTRY_POINT_KEY]!!.s(),
            maxIterations = req.maxIterations ?: current[GRAPH_MAX_ITERATIONS_KEY]?.n()?.toInt() ?: 10,
        )
        return graphItemToResponse(updated)
    }

    suspend fun getGraph(customerId: String, graphId: String): CustomerGraphResponse {
        val item = dynamoDBProvider.getCustomerGraph(graphId)
            ?: error("Graph $graphId not found")
        requireOwnership(item, customerId, "graph", graphId)
        return graphItemToResponse(item)
    }

    suspend fun deleteGraph(customerId: String, graphId: String) {
        val item = dynamoDBProvider.getCustomerGraph(graphId)
            ?: error("Graph $graphId not found")
        requireOwnership(item, customerId, "graph", graphId)
        dynamoDBProvider.deleteCustomerGraph(graphId)
    }

    suspend fun listGraphs(customerId: String): List<CustomerGraphResponse> =
        dynamoDBProvider.listCustomerGraphs(customerId).map { graphItemToResponse(it) }

    suspend fun getGraphVersions(customerId: String, graphId: String): List<CustomerGraphVersionResponse> {
        val current = dynamoDBProvider.getCustomerGraph(graphId)
            ?: error("Graph $graphId not found")
        requireOwnership(current, customerId, "graph", graphId)
        return dynamoDBProvider.getCustomerGraphVersions(graphId).map { item ->
            CustomerGraphVersionResponse(
                graphId = item[GRAPH_ID_KEY]?.s() ?: graphId,
                version = item[VERSION_KEY]?.n()?.toInt() ?: 0,
                name = item[GRAPH_NAME_KEY]?.s() ?: "",
                isDefault = item[GRAPH_IS_DEFAULT_KEY]?.bool() ?: false,
                nodeIds = item[GRAPH_NODE_IDS_KEY]?.l()?.map { it.s() } ?: emptyList(),
                edges = item[GRAPH_EDGES_KEY]?.s() ?: "{}",
                entryPoint = item[GRAPH_ENTRY_POINT_KEY]?.s() ?: "",
                maxIterations = item[GRAPH_MAX_ITERATIONS_KEY]?.n()?.toInt() ?: 10,
                createdAt = item["createdAt"]?.s() ?: "",
            )
        }
    }

    suspend fun rollbackGraph(customerId: String, graphId: String, toVersion: Int): CustomerGraphResponse {
        val current = dynamoDBProvider.getCustomerGraph(graphId)
            ?: error("Graph $graphId not found")
        requireOwnership(current, customerId, "graph", graphId)
        val updated = dynamoDBProvider.rollbackCustomerGraph(graphId, toVersion)
        return graphItemToResponse(updated)
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    private fun requireOwnership(item: Map<String, AttributeValue>, customerId: String, type: String, id: String) {
        val owner = item["customerId"]?.s()
        require(owner == customerId) { "$type $id not found" }
    }

    private fun nodeItemToResponse(item: Map<String, AttributeValue>) = GraphNodeResponse(
        nodeId = item[NODE_ID_KEY]?.s() ?: "",
        nodeType = item[NODE_TYPE_KEY]?.s() ?: "",
        name = item[NODE_NAME_KEY]?.s() ?: "",
        config = item[NODE_CONFIG_KEY]?.s() ?: "{}",
        version = item[VERSION_KEY]?.n()?.toInt() ?: 0,
        latestVersion = item[LATEST_VERSION_KEY]?.n()?.toInt() ?: 1,
        createdAt = item["createdAt"]?.s(),
        updatedAt = item["updatedAt"]?.s(),
    )

    private fun graphItemToResponse(item: Map<String, AttributeValue>) = CustomerGraphResponse(
        graphId = item[GRAPH_ID_KEY]?.s() ?: "",
        name = item[GRAPH_NAME_KEY]?.s() ?: "",
        isDefault = item[GRAPH_IS_DEFAULT_KEY]?.bool() ?: false,
        nodeIds = item[GRAPH_NODE_IDS_KEY]?.l()?.map { it.s() } ?: emptyList(),
        edges = item[GRAPH_EDGES_KEY]?.s() ?: "{}",
        entryPoint = item[GRAPH_ENTRY_POINT_KEY]?.s() ?: "",
        maxIterations = item[GRAPH_MAX_ITERATIONS_KEY]?.n()?.toInt() ?: 10,
        version = item[VERSION_KEY]?.n()?.toInt() ?: 0,
        latestVersion = item[LATEST_VERSION_KEY]?.n()?.toInt() ?: 1,
        createdAt = item["createdAt"]?.s(),
        updatedAt = item["updatedAt"]?.s(),
    )
}
