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
import com.genflowly.repository.GraphRepository
import models.api.AgentNodeResponse
import models.api.AgentResponse
import models.api.CreateCustomerGraphRequest
import models.api.CreateGraphNodeRequest
import models.api.CustomerGraphResponse
import models.api.CustomerGraphVersionResponse
import models.api.GetCustomerAgentsResponse
import models.api.GraphNodeResponse
import models.api.GraphNodeVersionResponse
import models.api.UpdateAgentNodePatch
import models.api.UpdateAgentRequest
import models.api.UpdateCustomerGraphRequest
import models.api.UpdateGraphNodeRequest
import mu.KotlinLogging
import software.amazon.awssdk.services.dynamodb.model.AttributeValue

private val logger = KotlinLogging.logger {}

class GraphService(private val graphRepository: GraphRepository) {

    // ─── Graph Nodes ──────────────────────────────────────────────────────────

    suspend fun createGraphNode(customerId: String, req: CreateGraphNodeRequest): GraphNodeResponse {
        val nodeId = generateNodeId()
        graphRepository.createCustomerGraphNode(customerId, nodeId, req.nodeType, req.name, req.config)
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
        val current = graphRepository.getCustomerGraphNode(nodeId)
            ?: error("Graph node $nodeId not found")
        requireOwnership(current, customerId, "node", nodeId)

        val updated = graphRepository.updateCustomerGraphNode(
            nodeId = nodeId,
            nodeType = req.nodeType ?: current[NODE_TYPE_KEY]!!.s(),
            name = req.name ?: current[NODE_NAME_KEY]!!.s(),
            config = req.config ?: current[NODE_CONFIG_KEY]!!.s(),
        )
        return nodeItemToResponse(updated)
    }

    suspend fun getGraphNode(customerId: String, nodeId: String): GraphNodeResponse {
        val item = graphRepository.getCustomerGraphNode(nodeId)
            ?: error("Graph node $nodeId not found")
        requireOwnership(item, customerId, "node", nodeId)
        return nodeItemToResponse(item)
    }

    suspend fun deleteGraphNode(customerId: String, nodeId: String) {
        val item = graphRepository.getCustomerGraphNode(nodeId)
            ?: error("Graph node $nodeId not found")
        requireOwnership(item, customerId, "node", nodeId)
        graphRepository.deleteCustomerGraphNode(nodeId)
    }

    suspend fun listGraphNodes(customerId: String): List<GraphNodeResponse> =
        graphRepository.listCustomerGraphNodes(customerId).map { nodeItemToResponse(it) }

    suspend fun getGraphNodeVersions(customerId: String, nodeId: String): List<GraphNodeVersionResponse> {
        val current = graphRepository.getCustomerGraphNode(nodeId)
            ?: error("Graph node $nodeId not found")
        requireOwnership(current, customerId, "node", nodeId)
        return graphRepository.getCustomerGraphNodeVersions(nodeId).map { item ->
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
        val current = graphRepository.getCustomerGraphNode(nodeId)
            ?: error("Graph node $nodeId not found")
        requireOwnership(current, customerId, "node", nodeId)
        val updated = graphRepository.rollbackCustomerGraphNode(nodeId, toVersion)
        return nodeItemToResponse(updated)
    }

    // ─── Graphs ───────────────────────────────────────────────────────────────

    suspend fun createGraph(customerId: String, req: CreateCustomerGraphRequest): CustomerGraphResponse {
        val graphId = generateGraphId()
        graphRepository.createCustomerGraph(
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
        val current = graphRepository.getCustomerGraph(graphId)
            ?: error("Graph $graphId not found")
        requireOwnership(current, customerId, "graph", graphId)

        val updated = graphRepository.updateCustomerGraph(
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
        val item = graphRepository.getCustomerGraph(graphId)
            ?: error("Graph $graphId not found")
        requireOwnership(item, customerId, "graph", graphId)
        return graphItemToResponse(item)
    }

    suspend fun deleteGraph(customerId: String, graphId: String) {
        val item = graphRepository.getCustomerGraph(graphId)
            ?: error("Graph $graphId not found")
        requireOwnership(item, customerId, "graph", graphId)
        graphRepository.deleteCustomerGraph(graphId)
    }

    suspend fun listGraphs(customerId: String): List<CustomerGraphResponse> =
        graphRepository.listCustomerGraphs(customerId).map { graphItemToResponse(it) }

    suspend fun getGraphVersions(customerId: String, graphId: String): List<CustomerGraphVersionResponse> {
        val current = graphRepository.getCustomerGraph(graphId)
            ?: error("Graph $graphId not found")
        requireOwnership(current, customerId, "graph", graphId)
        return graphRepository.getCustomerGraphVersions(graphId).map { item ->
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
        val current = graphRepository.getCustomerGraph(graphId)
            ?: error("Graph $graphId not found")
        requireOwnership(current, customerId, "graph", graphId)
        val updated = graphRepository.rollbackCustomerGraph(graphId, toVersion)
        return graphItemToResponse(updated)
    }

    // ─── Agents (hydrated graph + nodes view) ────────────────────────────────

    /**
     * Returns all of the customer's graphs, each with its nodes fully hydrated.
     * A single [listCustomerGraphNodes] call fetches all the customer's nodes and
     * they are then grouped per graph in memory — efficient for the typical case
     * of customers owning a small number of graphs and nodes.
     */
    suspend fun getCustomerAgents(customerId: String): GetCustomerAgentsResponse {
        val graphs = graphRepository.listCustomerGraphs(customerId)
        // One round-trip to fetch all nodes for this customer.
        val allNodes = graphRepository.listCustomerGraphNodes(customerId)
        val nodeById = allNodes.associateBy { it[NODE_ID_KEY]?.s() ?: "" }

        val agents = graphs.map { graphItem ->
            val nodeIds = graphItem[GRAPH_NODE_IDS_KEY]?.l()?.map { it.s() } ?: emptyList()
            val hydratedNodes = nodeIds.mapNotNull { nid ->
                nodeById[nid]?.let { nodeItem ->
                    AgentNodeResponse(
                        nodeId = nodeItem[NODE_ID_KEY]?.s() ?: nid,
                        nodeType = nodeItem[NODE_TYPE_KEY]?.s() ?: "",
                        name = nodeItem[NODE_NAME_KEY]?.s() ?: "",
                        config = nodeItem[NODE_CONFIG_KEY]?.s() ?: "{}",
                    )
                }
            }
            AgentResponse(
                graphId = graphItem[GRAPH_ID_KEY]?.s() ?: "",
                name = graphItem[GRAPH_NAME_KEY]?.s() ?: "",
                isDefault = graphItem[GRAPH_IS_DEFAULT_KEY]?.bool() ?: false,
                entryPoint = graphItem[GRAPH_ENTRY_POINT_KEY]?.s() ?: "",
                maxIterations = graphItem[GRAPH_MAX_ITERATIONS_KEY]?.n()?.toInt() ?: 10,
                edges = graphItem[GRAPH_EDGES_KEY]?.s() ?: "{}",
                nodes = hydratedNodes,
                createdAt = graphItem["createdAt"]?.s(),
                updatedAt = graphItem["updatedAt"]?.s(),
            )
        }
        logger.info { "Fetched ${agents.size} agent(s) for customer $customerId" }
        return GetCustomerAgentsResponse(agents = agents)
    }

    // ─── Update Agent (graph + nodes, with structural validation) ─────────────

    /**
     * Atomically edit an agent's graph-level fields and/or per-node configs.
     *
     * Applies a partial (PATCH-style) update:
     *  - Graph fields absent from [req] keep their current DDB values.
     *  - Only nodes listed in [req.nodes] are updated; others are untouched.
     *
     * All structural invariants (entryPoint, edge references, reachability,
     * cycle safety, valid JSON configs, etc.) are validated BEFORE any write.
     *
     * @throws IllegalArgumentException on structural validation failure → mapped to HTTP 400.
     * @throws IllegalStateException    if the graph is not found or not owned → mapped to HTTP 404.
     */
    suspend fun updateAgent(
        customerId: String,
        graphId: String,
        req: UpdateAgentRequest,
    ): AgentResponse {
        // ── 1. Load current graph ─────────────────────────────────────────────
        val currentGraph = graphRepository.getCustomerGraph(graphId)
            ?: throw IllegalStateException("Agent (graph) '$graphId' not found.")
        requireOwnership(currentGraph, customerId, "graph", graphId)

        val nodeIds = currentGraph[GRAPH_NODE_IDS_KEY]?.l()?.map { it.s() } ?: emptyList()

        // ── 2. Load all nodes belonging to this graph ─────────────────────────
        val allCustomerNodes = graphRepository.listCustomerGraphNodes(customerId)
        val nodeById = allCustomerNodes
            .filter { it[NODE_ID_KEY]?.s() in nodeIds }
            .associateBy { it[NODE_ID_KEY]?.s() ?: "" }

        val nodeTypeById: Map<String, String> = nodeById.mapValues { (_, item) ->
            item[NODE_TYPE_KEY]?.s() ?: ""
        }

        // ── 3. Merge request over current values ──────────────────────────────
        val mergedName        = req.name        ?: currentGraph[GRAPH_NAME_KEY]?.s() ?: ""
        val mergedIsDefault   = req.isDefault   ?: currentGraph[GRAPH_IS_DEFAULT_KEY]?.bool() ?: false
        val mergedMaxIter     = req.maxIterations ?: currentGraph[GRAPH_MAX_ITERATIONS_KEY]?.n()?.toInt() ?: 10
        val mergedEntryPoint  = req.entryPoint  ?: currentGraph[GRAPH_ENTRY_POINT_KEY]?.s() ?: ""
        val mergedEdges       = req.edges       ?: currentGraph[GRAPH_EDGES_KEY]?.s() ?: "{}"

        // Collect per-node config patches for validation.
        val nodePatchConfigs: Map<String, String> = req.nodes
            ?.mapNotNull { patch -> patch.config?.let { patch.nodeId to it } }
            ?.toMap() ?: emptyMap()

        // Determine whether this is the customer's only graph (for isDefault guard).
        val allGraphs = graphRepository.listCustomerGraphs(customerId)
        val isOnlyGraph = allGraphs.size == 1

        // ── 4. Validate merged state ──────────────────────────────────────────
        GraphValidationService.validateAgentUpdate(
            nodeIds          = nodeIds,
            nodeTypeById     = nodeTypeById,
            entryPoint       = mergedEntryPoint,
            edgesJson        = mergedEdges,
            maxIterations    = mergedMaxIter,
            name             = req.name,
            isDefault        = req.isDefault,
            isOnlyGraph      = isOnlyGraph,
            nodePatchConfigs = nodePatchConfigs,
        )

        // ── 5. Apply node patches ─────────────────────────────────────────────
        req.nodes?.forEach { patch ->
            val existingNode = nodeById[patch.nodeId]
                ?: throw IllegalArgumentException("Node '${patch.nodeId}' is not part of graph '$graphId'.")
            if (patch.name != null || patch.config != null) {
                graphRepository.updateCustomerGraphNode(
                    nodeId   = patch.nodeId,
                    nodeType = existingNode[NODE_TYPE_KEY]?.s() ?: "",
                    name     = patch.name   ?: existingNode[NODE_NAME_KEY]?.s()   ?: "",
                    config   = patch.config ?: existingNode[NODE_CONFIG_KEY]?.s() ?: "{}",
                )
                logger.info { "Updated node ${patch.nodeId} for agent $graphId" }
            }
        }

        // ── 6. Apply graph patch ──────────────────────────────────────────────
        val updatedGraph = graphRepository.updateCustomerGraph(
            graphId       = graphId,
            name          = mergedName,
            isDefault     = mergedIsDefault,
            nodeIds       = nodeIds,       // nodeIds are immutable via this endpoint
            edges         = mergedEdges,
            entryPoint    = mergedEntryPoint,
            maxIterations = mergedMaxIter,
        )
        logger.info { "Updated agent $graphId for customer $customerId" }

        // ── 7. Re-fetch updated nodes and build hydrated response ─────────────
        val refreshedNodes = graphRepository.listCustomerGraphNodes(customerId)
            .filter { it[NODE_ID_KEY]?.s() in nodeIds }
        val refreshedById = refreshedNodes.associateBy { it[NODE_ID_KEY]?.s() ?: "" }

        val hydratedNodes = nodeIds.mapNotNull { nid ->
            refreshedById[nid]?.let { item ->
                AgentNodeResponse(
                    nodeId   = item[NODE_ID_KEY]?.s()   ?: nid,
                    nodeType = item[NODE_TYPE_KEY]?.s() ?: "",
                    name     = item[NODE_NAME_KEY]?.s() ?: "",
                    config   = item[NODE_CONFIG_KEY]?.s() ?: "{}",
                )
            }
        }

        return AgentResponse(
            graphId       = updatedGraph[GRAPH_ID_KEY]?.s()                    ?: graphId,
            name          = updatedGraph[GRAPH_NAME_KEY]?.s()                  ?: "",
            isDefault     = updatedGraph[GRAPH_IS_DEFAULT_KEY]?.bool()         ?: false,
            entryPoint    = updatedGraph[GRAPH_ENTRY_POINT_KEY]?.s()           ?: "",
            maxIterations = updatedGraph[GRAPH_MAX_ITERATIONS_KEY]?.n()?.toInt() ?: 10,
            edges         = updatedGraph[GRAPH_EDGES_KEY]?.s()                 ?: "{}",
            nodes         = hydratedNodes,
            createdAt     = updatedGraph["createdAt"]?.s(),
            updatedAt     = updatedGraph["updatedAt"]?.s(),
        )
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
