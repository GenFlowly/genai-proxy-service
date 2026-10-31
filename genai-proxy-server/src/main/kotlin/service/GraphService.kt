package com.genflowly.service

import com.genflowly.DynamoDBConstants.DELETED_AT_KEY
import com.genflowly.DynamoDBConstants.GRAPH_CATEGORY_KEY
import com.genflowly.DynamoDBConstants.GRAPH_EDGES_KEY
import com.genflowly.DynamoDBConstants.GRAPH_ENTRY_POINT_KEY
import com.genflowly.DynamoDBConstants.GRAPH_ID_KEY
import com.genflowly.DynamoDBConstants.GRAPH_IS_DEFAULT_KEY
import com.genflowly.DynamoDBConstants.GRAPH_LAYOUT_KEY
import com.genflowly.DynamoDBConstants.GRAPH_MAX_ITERATIONS_KEY
import com.genflowly.DynamoDBConstants.GRAPH_NAME_KEY
import com.genflowly.DynamoDBConstants.GRAPH_NODE_IDS_KEY
import com.genflowly.DynamoDBConstants.SYSTEM_GRAPH_OWNER
import com.genflowly.DynamoDBConstants.LATEST_VERSION_KEY
import com.genflowly.DynamoDBConstants.NODE_CONFIG_KEY
import com.genflowly.DynamoDBConstants.NODE_ID_KEY
import com.genflowly.DynamoDBConstants.NODE_NAME_KEY
import com.genflowly.DynamoDBConstants.NODE_TYPE_KEY
import com.genflowly.DynamoDBConstants.VERSION_KEY
import com.genflowly.GENERATION_NODE_TYPE
import com.genflowly.models.AgentCategory
import com.genflowly.models.GenerationNodeConfig
import com.genflowly.models.NodeModelPreference
import com.genflowly.SYSTEM_SCOPE
import com.genflowly.repository.CacheVersionRepository
import com.genflowly.repository.GraphRepository
import com.genflowly.repository.InstructionRepository
import com.genflowly.repository.RequestAgentMapRepository
import com.genflowly.models.api.AgentNodeResponse
import com.genflowly.models.api.AgentResponse
import com.genflowly.models.api.CreateAgentRequest
import com.genflowly.models.api.CreateGraphAgentRequest
import com.genflowly.models.api.NewAgentNode
import com.genflowly.models.api.CreateCustomerGraphRequest
import com.genflowly.models.api.CreateGraphNodeRequest
import com.genflowly.models.api.CustomerGraphResponse
import com.genflowly.models.api.CustomerGraphVersionResponse
import com.genflowly.models.api.GetCustomerAgentsResponse
import com.genflowly.models.api.GraphNodeResponse
import com.genflowly.models.api.GraphNodeVersionResponse
import com.genflowly.models.api.UpdateAgentNodePatch
import com.genflowly.models.api.UpdateAgentRequest
import com.genflowly.models.api.UpdateCustomerGraphRequest
import com.genflowly.models.api.UpdateGraphNodeRequest
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import mu.KotlinLogging
import software.amazon.awssdk.services.dynamodb.model.AttributeValue

private val logger = KotlinLogging.logger {}

/** Thrown when a non-admin tries to edit a System-owned agent in place (→ HTTP 403). */
class SystemAgentEditForbiddenException(graphId: String) : RuntimeException(
    "Agent '$graphId' is a shared System agent and is read-only — fork it to edit."
)

class GraphService(
    private val graphRepository: GraphRepository,
    private val instructionRepository: InstructionRepository,
    private val requestAgentMapRepository: RequestAgentMapRepository,
    private val cacheVersionService: CacheVersionService,
) {

    private val nodeConfigJson = kotlinx.serialization.json.Json {
        encodeDefaults = false
        ignoreUnknownKeys = true
    }

    // The /agents and /request-agents client caches are version-gated: every
    // mutation of graphs, nodes or map entries in this service must bump the
    // matching counter or clients serve stale data until the next bump.
    private suspend fun bumpAgentsVersion(ownerId: String) {
        if (ownerId == SYSTEM_GRAPH_OWNER) {
            cacheVersionService.bumpSystem(CacheVersionRepository.Resource.AGENTS)
        } else {
            cacheVersionService.bumpCustomer(ownerId, CacheVersionRepository.Resource.AGENTS)
        }
    }

    private suspend fun bumpRequestAgentsVersion(ownerId: String) {
        if (ownerId == SYSTEM_GRAPH_OWNER) {
            cacheVersionService.bumpSystem(CacheVersionRepository.Resource.REQUEST_AGENTS)
        } else {
            cacheVersionService.bumpCustomer(ownerId, CacheVersionRepository.Resource.REQUEST_AGENTS)
        }
    }

    // ─── Generation agents (1-node graphs behind the request-agent map) ───────

    /**
     * Creates a 1-node GENERATION agent owned by [customerId]: a graph whose
     * single node references the instruction holding the system-prompt
     * template. Used by the admin panel for the global request-agent map, and
     * later by customers building their own agents.
     *
     * @throws IllegalArgumentException on a blank name or missing instruction.
     */
    suspend fun createGenerationAgent(customerId: String, req: CreateAgentRequest): AgentResponse {
        require(req.name.isNotBlank()) { "name must not be blank" }
        require(req.thinkingLevel == null || req.thinkingLevel in setOf("none", "low", "medium", "high")) {
            "thinkingLevel must be one of none|low|medium|high"
        }
        val instructionVersion = req.instructionVersion
            ?: instructionRepository.getLatestInstructionVersion(req.instructionId)
        requireNotNull(instructionVersion) { "instruction ${req.instructionId} not found" }
        requireNotNull(instructionRepository.getInstruction(req.instructionId, instructionVersion)) {
            "instruction ${req.instructionId} v$instructionVersion not found"
        }

        val nodeConfig = GenerationNodeConfig(
            instructionId = req.instructionId,
            instructionVersion = req.instructionVersion,
            inputTemplate = req.inputTemplate,
            outputFormat = req.outputFormat,
            modelPreference = req.modelPreference?.let {
                NodeModelPreference(vendor = it.aiVendor.name, model = it.model)
            },
            maxTokens = req.maxTokens,
            thinkingLevel = req.thinkingLevel
        )
        val configJson = nodeConfigJson.encodeToString(GenerationNodeConfig.serializer(), nodeConfig)

        val category = (req.category?.let { AgentCategory.parse(it) } ?: AgentCategory.CONVERSATION).name
        val nodeId = com.genflowly.models.generateNodeId()
        val graphId = com.genflowly.models.generateGraphId()
        val edges = """{"edges":[{"from":"$nodeId","to":"__end__"}]}"""
        graphRepository.createCustomerGraphNode(customerId, nodeId, GENERATION_NODE_TYPE, req.name, configJson)
        graphRepository.createCustomerGraph(
            customerId = customerId,
            graphId = graphId,
            name = req.name,
            isDefault = false,
            nodeIds = listOf(nodeId),
            edges = edges,
            entryPoint = nodeId,
            maxIterations = 1,
            category = category,
        )
        logger.info { "Created generation agent $graphId ('${req.name}') → instruction ${req.instructionId} for $customerId" }
        bumpAgentsVersion(customerId)

        return AgentResponse(
            graphId = graphId,
            name = req.name,
            isDefault = false,
            entryPoint = nodeId,
            maxIterations = 1,
            edges = edges,
            category = category,
            nodes = listOf(
                AgentNodeResponse(nodeId = nodeId, nodeType = GENERATION_NODE_TYPE, name = req.name, config = configJson)
            ),
            createdAt = null,
            updatedAt = null,
        )
    }

    // ─── System-published default graph ───────────────────────────────────────
    //
    // There is no per-customer seeding. The admin panel authors and publishes a
    // single default graph owned by SYSTEM_GRAPH_OWNER; every customer without
    // an own default graph is served that graph (isSystem=true in responses).
    // Customers never edit System graphs in place — they fork explicitly via
    // [forkAgent] and edit the fork.

    /** The published System default graph, hydrated, or null when unpublished. */
    suspend fun getSystemDefaultAgentOrNull(): AgentResponse? {
        val item = graphRepository.getDefaultCustomerGraph(SYSTEM_GRAPH_OWNER) ?: return null
        val systemNodes = graphRepository.listCustomerGraphNodes(SYSTEM_GRAPH_OWNER)
            .associateBy { it[NODE_ID_KEY]?.s() ?: "" }
        return agentResponseFrom(item, systemNodes, isSystem = true)
    }

    /**
     * Publishes the System default graph for the first time (admin only).
     * @throws IllegalArgumentException when one is already published.
     */
    suspend fun publishSystemDefaultGraph(req: CreateGraphAgentRequest): AgentResponse {
        require(graphRepository.getDefaultCustomerGraph(SYSTEM_GRAPH_OWNER) == null) {
            "A System default graph is already published — update it instead."
        }
        return createGraphAgent(SYSTEM_GRAPH_OWNER, req.copy(isDefault = true), isSystem = true)
    }

    /**
     * Publishes a NON-default System-owned agent (admin only): a shared
     * template every customer sees read-only in their agent picker (e.g. the
     * agent-loop template) and forks explicitly via [forkAgent] — the same
     * ownership model as the default graph, minus the "served to graphless
     * customers" role. isDefault is pinned to false so this can never displace
     * the System default graph and flip graphless customers to a different
     * behavior.
     */
    suspend fun publishSystemAgent(req: CreateGraphAgentRequest): AgentResponse =
        createGraphAgent(SYSTEM_GRAPH_OWNER, req.copy(isDefault = false), isSystem = true)

    /**
     * Seeder variant of [publishSystemAgent]: every id (graph, nodes) is
     * supplied by the caller and the graph's live row is written with a
     * conditional create, so racing instances writing identical ids/content
     * cannot produce duplicates. Returns the (created or already-present)
     * hydrated agent.
     */
    suspend fun publishSeededSystemAgent(
        req: CreateGraphAgentRequest,
        graphId: String,
        nodeIdByTempId: Map<String, String>,
    ): AgentResponse {
        require(req.name.isNotBlank()) { "name must not be blank" }
        require(req.nodes.isNotEmpty()) { "A graph needs at least one node." }
        validateTempIds(req.nodes)
        req.nodes.forEach { require(it.tempId in nodeIdByTempId) { "node '${it.tempId}' is missing a seeded nodeId" } }

        val edges = substituteNodeIds(req.edges, nodeIdByTempId)
        val entryPoint = nodeIdByTempId[req.entryPoint] ?: req.entryPoint
        val nodeIds = req.nodes.map { nodeIdByTempId.getValue(it.tempId) }
        val nodeTypeById = req.nodes.associate { nodeIdByTempId.getValue(it.tempId) to it.nodeType }
        val configById = req.nodes.associate { nodeIdByTempId.getValue(it.tempId) to it.config }

        GraphValidationService.validateAgentUpdate(
            nodeIds          = nodeIds,
            nodeTypeById     = nodeTypeById,
            entryPoint       = entryPoint,
            edgesJson        = edges,
            maxIterations    = req.maxIterations,
            name             = req.name,
            isDefault        = false,
            isOnlyGraph      = false,
            nodePatchConfigs = configById,
        )
        configById.forEach { (nodeId, config) ->
            validateInstructionRef(nodeId, config, nodeTypeById[nodeId])
        }

        req.nodes.forEach { node ->
            graphRepository.createCustomerGraphNode(
                customerId = SYSTEM_GRAPH_OWNER,
                nodeId = nodeIdByTempId.getValue(node.tempId),
                nodeType = node.nodeType,
                name = node.name,
                config = node.config,
            )
        }
        val created = graphRepository.createCustomerGraphIfAbsent(
            customerId = SYSTEM_GRAPH_OWNER,
            graphId = graphId,
            name = req.name,
            isDefault = false,
            nodeIds = nodeIds,
            edges = edges,
            entryPoint = entryPoint,
            maxIterations = req.maxIterations,
            layout = req.layout,
            category = req.category?.let { AgentCategory.parse(it).name },
        )
        if (!created) {
            logger.info { "Seeded graph $graphId already exists — another instance won; reusing it" }
        } else {
            logger.info { "Published seeded System agent $graphId ('${req.name}')" }
        }
        // Node rows above are rewritten even when the graph row already
        // existed, so the bump is unconditional — over-invalidation is safe,
        // a missed node-content change is not.
        bumpAgentsVersion(SYSTEM_GRAPH_OWNER)

        val item = graphRepository.getCustomerGraph(graphId)
            ?: throw IllegalStateException("Seeded graph $graphId not readable after creation.")
        val nodeById = graphRepository.listCustomerGraphNodes(SYSTEM_GRAPH_OWNER)
            .associateBy { it[NODE_ID_KEY]?.s() ?: "" }
        return agentResponseFrom(item, nodeById, isSystem = true)
    }

    /**
     * Applies an agent update to the published System default graph (admin only).
     * isDefault is pinned to true — the System graph must stay the default.
     * @throws IllegalStateException when no System graph is published yet.
     */
    suspend fun updateSystemDefaultGraph(req: UpdateAgentRequest): AgentResponse {
        val item = graphRepository.getDefaultCustomerGraph(SYSTEM_GRAPH_OWNER)
            ?: throw IllegalStateException("No System default graph is published yet.")
        val graphId = item[GRAPH_ID_KEY]?.s()
            ?: throw IllegalStateException("System default graph is missing its graphId.")
        return applyAgentUpdate(item, SYSTEM_GRAPH_OWNER, graphId, req.copy(isDefault = null), isSystem = true)
    }

    /**
     * Clones a System graph (and all its nodes) into a customer-owned copy.
     * Returns the new live graph item plus the System-nodeId → cloned-nodeId
     * map.
     */
    private suspend fun forkSystemGraph(
        customerId: String,
        systemGraph: Map<String, AttributeValue>,
        nameOverride: String? = null,
        /** Resolved category for the fork; pass it in because the source row may predate categories. */
        category: String? = null,
    ): Pair<Map<String, AttributeValue>, Map<String, String>> {
        val oldNodeIds = systemGraph[GRAPH_NODE_IDS_KEY]?.l()?.map { it.s() } ?: emptyList()
        val systemNodes = graphRepository.listCustomerGraphNodes(SYSTEM_GRAPH_OWNER)
            .associateBy { it[NODE_ID_KEY]?.s() ?: "" }

        val idMap = oldNodeIds.associateWith { com.genflowly.models.generateNodeId() }
        oldNodeIds.forEach { oldId ->
            val node = systemNodes[oldId]
                ?: throw IllegalStateException("System graph references missing node '$oldId'.")
            graphRepository.createCustomerGraphNode(
                customerId = customerId,
                nodeId = idMap.getValue(oldId),
                nodeType = node[NODE_TYPE_KEY]?.s() ?: "",
                name = node[NODE_NAME_KEY]?.s() ?: "",
                config = node[NODE_CONFIG_KEY]?.s() ?: "{}",
            )
        }

        val newGraphId = com.genflowly.models.generateGraphId()
        graphRepository.createCustomerGraph(
            customerId = customerId,
            graphId = newGraphId,
            name = nameOverride ?: systemGraph[GRAPH_NAME_KEY]?.s() ?: "Default Graph",
            // A fork of the System default graph replaces it as the customer's
            // default; forks of other System agents (request-type generators)
            // stay non-default and take effect via the per-customer map entry.
            isDefault = systemGraph[GRAPH_IS_DEFAULT_KEY]?.bool() ?: false,
            nodeIds = oldNodeIds.map { idMap.getValue(it) },
            edges = substituteNodeIds(systemGraph[GRAPH_EDGES_KEY]?.s() ?: "{}", idMap),
            entryPoint = idMap[systemGraph[GRAPH_ENTRY_POINT_KEY]?.s()]
                ?: throw IllegalStateException("System graph has an invalid entryPoint."),
            maxIterations = systemGraph[GRAPH_MAX_ITERATIONS_KEY]?.n()?.toInt() ?: 10,
            layout = systemGraph[GRAPH_LAYOUT_KEY]?.s()?.let { substituteNodeIds(it, idMap) },
            category = category ?: systemGraph[GRAPH_CATEGORY_KEY]?.s(),
        )
        logger.info { "Forked System graph into $newGraphId for customer $customerId" }
        val forked = graphRepository.getCustomerGraph(newGraphId)
            ?: throw IllegalStateException("Forked graph $newGraphId not readable after creation.")
        return forked to idMap
    }

    /**
     * Explicitly forks a System (shared) agent into a customer-owned copy named
     * `<agent-name>-<version>-forked` (version = the source's latest at fork
     * time). The fork inherits the source's category; for request-type agents
     * the customer's map overrides are mirrored onto the fork so it takes
     * effect; a fork of the System default graph becomes the customer's
     * default. This is the ONLY way for non-admins to derive an editable copy
     * — direct edits of System agents are rejected (see [updateAgent]).
     *
     * @throws IllegalStateException when the graph is missing or not System-owned (→ 404).
     */
    suspend fun forkAgent(customerId: String, graphId: String): AgentResponse {
        val source = graphRepository.getCustomerGraph(graphId)
            ?: throw IllegalStateException("Agent (graph) '$graphId' not found.")
        if (source["customerId"]?.s() != SYSTEM_GRAPH_OWNER) {
            // Only System agents are forkable; anything else reads as not-found
            // (customers fork their own agents by just editing them).
            throw IllegalStateException("Agent (graph) '$graphId' not found.")
        }

        val requestTypeByGraphId = (
            requestAgentMapRepository.listMapEntries(SYSTEM_SCOPE) +
                requestAgentMapRepository.listMapEntries(customerId)
            ).associate { it.graphId to it.requestType }
        val version = source[LATEST_VERSION_KEY]?.n()?.toInt() ?: 1
        val sourceName = source[GRAPH_NAME_KEY]?.s() ?: "Agent"
        val category = source[GRAPH_CATEGORY_KEY]?.s()
            ?: requestTypeByGraphId[graphId]?.let { AgentCategory.categoryForRequestType(it)?.name }
            ?: AgentCategory.CONVERSATION.name

        val (forked, _) = forkSystemGraph(
            customerId = customerId,
            systemGraph = source,
            nameOverride = "$sourceName-$version-forked",
            category = category,
        )
        val forkedId = forked[GRAPH_ID_KEY]?.s()
            ?: throw IllegalStateException("Forked graph is missing its graphId.")

        // Forking a request-type agent only takes effect through the map:
        // mirror every SYSTEM mapping of the original as a per-customer
        // override pointing at the fork. (The default graph needs no map —
        // its fork wins by being the customer's isDefault graph.)
        if (source[GRAPH_IS_DEFAULT_KEY]?.bool() != true) {
            val mirroredEntries = requestAgentMapRepository.listMapEntries(SYSTEM_SCOPE)
                .filter { it.graphId == graphId }
            mirroredEntries.forEach { entry ->
                requestAgentMapRepository.putMapEntry(
                    entry.copy(scope = customerId, graphId = forkedId, updatedBy = customerId)
                )
                logger.info {
                    "Customer $customerId override: ${entry.requestType} → fork $forkedId of $graphId"
                }
            }
            if (mirroredEntries.isNotEmpty()) bumpRequestAgentsVersion(customerId)
        }
        bumpAgentsVersion(customerId)

        val nodeById = graphRepository.listCustomerGraphNodes(customerId)
            .associateBy { it[NODE_ID_KEY]?.s() ?: "" }
        return agentResponseFrom(forked, nodeById, isSystem = false)
    }

    /**
     * Deletes an agent: the graph and every node it owns. Deleting an owned
     * default graph is allowed — the customer falls back to the System
     * default graph (i.e. this doubles as "reset to default").
     * @throws IllegalStateException when not found / not owned (→ 404).
     */
    suspend fun deleteAgent(customerId: String, graphId: String) {
        val graph = graphRepository.getCustomerGraph(graphId)
        // Not-owned deliberately reads as not-found (no resource-existence
        // leak) and also shields System-owned graphs from customer deletes.
        if (graph == null || graph["customerId"]?.s() != customerId) {
            throw IllegalStateException("Agent (graph) '$graphId' not found.")
        }

        val nodeIds = graph[GRAPH_NODE_IDS_KEY]?.l()?.map { it.s() } ?: emptyList()
        nodeIds.forEach { graphRepository.deleteCustomerGraphNode(it) }
        graphRepository.deleteCustomerGraph(graphId)

        // Drop this customer's request-type overrides that pointed at the
        // deleted graph — resolution reverts to the System mapping.
        val removedOverrides = requestAgentMapRepository.listMapEntries(customerId)
            .filter { it.graphId == graphId }
        removedOverrides.forEach { requestAgentMapRepository.deleteMapEntry(customerId, it.requestType) }
        if (removedOverrides.isNotEmpty()) bumpRequestAgentsVersion(customerId)
        bumpAgentsVersion(customerId)

        logger.info { "Deleted agent $graphId (+${nodeIds.size} node(s)) for customer $customerId" }
    }

    // ─── Graph Nodes ──────────────────────────────────────────────────────────

    suspend fun createGraphNode(customerId: String, req: CreateGraphNodeRequest): GraphNodeResponse {
        val nodeId = com.genflowly.models.generateNodeId()
        graphRepository.createCustomerGraphNode(customerId, nodeId, req.nodeType, req.name, req.config)
        logger.info { "Created graph node $nodeId for customer $customerId" }
        bumpAgentsVersion(customerId)
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
        bumpAgentsVersion(customerId)
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
        bumpAgentsVersion(customerId)
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
        bumpAgentsVersion(customerId)
        return nodeItemToResponse(updated)
    }

    // ─── Graphs ───────────────────────────────────────────────────────────────

    suspend fun createGraph(customerId: String, req: CreateCustomerGraphRequest): CustomerGraphResponse {
        val graphId = com.genflowly.models.generateGraphId()
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
        bumpAgentsVersion(customerId)
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
        bumpAgentsVersion(customerId)
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
        bumpAgentsVersion(customerId)
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
        bumpAgentsVersion(customerId)
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

        // Graphs backing internal request flows (title/persona/memory
        // generators) are tagged with their request type so pickers can
        // exclude them; both the System scope and the customer's own
        // fork overrides are consulted.
        val requestTypeByGraphId = (
            requestAgentMapRepository.listMapEntries(SYSTEM_SCOPE) +
                requestAgentMapRepository.listMapEntries(customerId)
            ).associate { it.graphId to it.requestType }

        val ownAgents = graphs.map { graphItem ->
            agentResponseFrom(graphItem, nodeById, isSystem = false, requestTypeByGraphId)
        }

        // System-owned agents follow the instruction ownership model: they are
        // visible to every customer read-only, and editing one forks it into a
        // customer-owned copy. ALL accessible agents are always listed — the
        // customer picks which one to converse with; the System default is
        // shown even when the customer has a default fork of their own.
        val systemGraphs = graphRepository.listCustomerGraphs(SYSTEM_GRAPH_OWNER)
        val agents = mutableListOf<AgentResponse>()
        if (systemGraphs.isNotEmpty()) {
            val systemNodeById = graphRepository.listCustomerGraphNodes(SYSTEM_GRAPH_OWNER)
                .associateBy { it[NODE_ID_KEY]?.s() ?: "" }
            systemGraphs.forEach { graphItem ->
                val isDefaultGraph = graphItem[GRAPH_IS_DEFAULT_KEY]?.bool() ?: false
                val response = agentResponseFrom(graphItem, systemNodeById, isSystem = true, requestTypeByGraphId)
                if (isDefaultGraph) agents.add(0, response) else agents.add(response)
            }
        }
        // Own agents go after the System default but before the System
        // request agents, keeping the primary chat agent on top.
        val insertAt = if (agents.firstOrNull()?.isDefault == true) 1 else 0
        agents.addAll(insertAt, ownAgents)

        logger.info { "Fetched ${agents.size} agent(s) for customer $customerId" }
        return GetCustomerAgentsResponse(agents = agents)
    }

    /**
     * A single agent, hydrated. Resolves the customer's own graphs and, as a
     * read-only fallback, the System-published default graph.
     * @throws IllegalStateException when not found / not owned (→ 404).
     */
    suspend fun getAgent(customerId: String, graphId: String): AgentResponse {
        val item = graphRepository.getCustomerGraph(graphId)
            ?: throw IllegalStateException("Agent (graph) '$graphId' not found.")
        val owner = item["customerId"]?.s()
        val isSystem = owner == SYSTEM_GRAPH_OWNER
        if (!isSystem && owner != customerId) {
            throw IllegalStateException("Agent (graph) '$graphId' not found.")
        }
        val nodeById = graphRepository.listCustomerGraphNodes(if (isSystem) SYSTEM_GRAPH_OWNER else customerId)
            .associateBy { it[NODE_ID_KEY]?.s() ?: "" }
        // Same map getCustomerAgents builds, so requestType/category fallback
        // behave identically whether an agent is listed or fetched directly.
        val requestTypeByGraphId = (
            requestAgentMapRepository.listMapEntries(SYSTEM_SCOPE) +
                requestAgentMapRepository.listMapEntries(customerId)
            ).associate { it.graphId to it.requestType }
        return agentResponseFrom(item, nodeById, isSystem = isSystem, requestTypeByGraphId)
    }

    // ─── Create Agent (multi-node graph from the visual editor) ───────────────

    /**
     * Creates a multi-node agent graph authored in the visual editor. Node
     * references in entryPoint/edges/layout use client tempIds, which are
     * replaced with generated nodeIds before validation.
     *
     * @throws IllegalArgumentException on structural validation failure → HTTP 400.
     */
    suspend fun createGraphAgent(
        ownerId: String,
        req: CreateGraphAgentRequest,
        isSystem: Boolean = false,
    ): AgentResponse {
        require(req.name.isNotBlank()) { "name must not be blank" }
        require(req.nodes.isNotEmpty()) { "A graph needs at least one node." }
        validateTempIds(req.nodes)

        val idMap = req.nodes.associate { it.tempId to com.genflowly.models.generateNodeId() }
        val edges = substituteNodeIds(req.edges, idMap)
        val layout = req.layout?.let { substituteNodeIds(it, idMap) }
        val entryPoint = idMap[req.entryPoint] ?: req.entryPoint
        val nodeIds = req.nodes.map { idMap.getValue(it.tempId) }
        val nodeTypeById = req.nodes.associate { idMap.getValue(it.tempId) to it.nodeType }
        val configById = req.nodes.associate { idMap.getValue(it.tempId) to it.config }

        GraphValidationService.validateAgentUpdate(
            nodeIds          = nodeIds,
            nodeTypeById     = nodeTypeById,
            entryPoint       = entryPoint,
            edgesJson        = edges,
            maxIterations    = req.maxIterations,
            name             = req.name,
            isDefault        = req.isDefault,
            isOnlyGraph      = false,
            nodePatchConfigs = configById,
        )
        configById.forEach { (nodeId, config) ->
            validateInstructionRef(nodeId, config, nodeTypeById[nodeId])
        }

        req.nodes.forEach { node ->
            graphRepository.createCustomerGraphNode(
                customerId = ownerId,
                nodeId = idMap.getValue(node.tempId),
                nodeType = node.nodeType,
                name = node.name,
                config = node.config,
            )
        }
        val graphId = com.genflowly.models.generateGraphId()
        graphRepository.createCustomerGraph(
            customerId = ownerId,
            graphId = graphId,
            name = req.name,
            isDefault = req.isDefault,
            nodeIds = nodeIds,
            edges = edges,
            entryPoint = entryPoint,
            maxIterations = req.maxIterations,
            layout = layout,
            category = (req.category?.let { AgentCategory.parse(it) } ?: AgentCategory.CONVERSATION).name,
        )
        logger.info { "Created graph agent $graphId ('${req.name}', ${nodeIds.size} node(s)) for $ownerId" }
        bumpAgentsVersion(ownerId)

        val nodeById = graphRepository.listCustomerGraphNodes(ownerId)
            .associateBy { it[NODE_ID_KEY]?.s() ?: "" }
        val created = graphRepository.getCustomerGraph(graphId)
            ?: throw IllegalStateException("Graph $graphId not readable after creation.")
        return agentResponseFrom(created, nodeById, isSystem = isSystem)
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
     * @throws SystemAgentEditForbiddenException when a non-admin targets a System agent → HTTP 403.
     */
    suspend fun updateAgent(
        customerId: String,
        graphId: String,
        req: UpdateAgentRequest,
        /**
         * True when the caller passed the admin allowlist: admins edit
         * System-owned agents in place (they ARE the System operator);
         * for everyone else System agents are strictly read-only.
         */
        isAdmin: Boolean = false,
    ): AgentResponse {
        val currentGraph = graphRepository.getCustomerGraph(graphId)
            ?: throw IllegalStateException("Agent (graph) '$graphId' not found.")
        val owner = currentGraph["customerId"]?.s()

        if (owner == SYSTEM_GRAPH_OWNER && isAdmin) {
            // isDefault is left untouched (null): the System default graph
            // must stay default, and request-type agents must stay non-default.
            return applyAgentUpdate(currentGraph, SYSTEM_GRAPH_OWNER, graphId, req.copy(isDefault = null), isSystem = true)
        }

        // System agents are read-only for customers; deriving an editable copy
        // happens only through the explicit [forkAgent] flow.
        if (owner == SYSTEM_GRAPH_OWNER) {
            throw SystemAgentEditForbiddenException(graphId)
        }

        requireOwnership(currentGraph, customerId, "graph", graphId)
        return applyAgentUpdate(currentGraph, customerId, graphId, req, isSystem = false)
    }

    /**
     * Core agent-update logic shared by customer edits and admin edits of the
     * System default graph. Ownership must already be established by callers.
     */
    private suspend fun applyAgentUpdate(
        currentGraph: Map<String, AttributeValue>,
        ownerId: String,
        graphId: String,
        req: UpdateAgentRequest,
        isSystem: Boolean,
    ): AgentResponse {
        val currentNodeIds = currentGraph[GRAPH_NODE_IDS_KEY]?.l()?.map { it.s() } ?: emptyList()

        val allOwnerNodes = graphRepository.listCustomerGraphNodes(ownerId)
        val nodeById = allOwnerNodes
            .filter { it[NODE_ID_KEY]?.s() in currentNodeIds }
            .associateBy { it[NODE_ID_KEY]?.s() ?: "" }

        // ── Structural changes: removals and additions ────────────────────────
        val removeSet = (req.removeNodeIds ?: emptyList()).toSet()
        removeSet.forEach { rid ->
            require(rid in currentNodeIds) { "removeNodeIds: node '$rid' is not part of graph '$graphId'." }
        }
        val addNodes = req.addNodes ?: emptyList()
        validateTempIds(addNodes)
        addNodes.forEach { n ->
            require(n.tempId !in currentNodeIds) { "addNodes: tempId '${n.tempId}' collides with an existing nodeId." }
        }
        val idMap = addNodes.associate { it.tempId to com.genflowly.models.generateNodeId() }

        val finalNodeIds = currentNodeIds.filter { it !in removeSet } + addNodes.map { idMap.getValue(it.tempId) }

        val nodeTypeById: Map<String, String> =
            nodeById.filterKeys { it !in removeSet }.mapValues { (_, item) -> item[NODE_TYPE_KEY]?.s() ?: "" } +
            addNodes.associate { idMap.getValue(it.tempId) to it.nodeType }

        // ── Merge request over current values (tempIds → real ids) ────────────
        val mergedName        = req.name ?: currentGraph[GRAPH_NAME_KEY]?.s() ?: ""
        val mergedIsDefault   = req.isDefault ?: currentGraph[GRAPH_IS_DEFAULT_KEY]?.bool() ?: false
        val mergedMaxIter     = req.maxIterations ?: currentGraph[GRAPH_MAX_ITERATIONS_KEY]?.n()?.toInt() ?: 10
        val mergedEntryPoint  = req.entryPoint?.let { idMap[it] ?: it }
            ?: currentGraph[GRAPH_ENTRY_POINT_KEY]?.s() ?: ""
        val mergedEdges       = req.edges?.let { substituteNodeIds(it, idMap) }
            ?: currentGraph[GRAPH_EDGES_KEY]?.s() ?: "{}"
        val mergedLayout      = req.layout?.let { substituteNodeIds(it, idMap) }
        // Validate (→ 400) before any write; null keeps the stored category.
        val patchedCategory   = req.category?.let { AgentCategory.parse(it).name }

        // Per-node config validation set: patches on surviving nodes + new nodes.
        val nodePatchConfigs: Map<String, String> = buildMap {
            req.nodes?.forEach { patch ->
                require(patch.nodeId !in removeSet) {
                    "Node '${patch.nodeId}' is being removed and patched in the same request."
                }
                patch.config?.let { put(patch.nodeId, it) }
            }
            addNodes.forEach { put(idMap.getValue(it.tempId), it.config) }
        }

        // Determine whether this is the owner's only graph (for the isDefault guard).
        val isOnlyGraph = isSystem || graphRepository.listCustomerGraphs(ownerId).size == 1

        // ── Validate the merged, post-structural state ────────────────────────
        GraphValidationService.validateAgentUpdate(
            nodeIds          = finalNodeIds,
            nodeTypeById     = nodeTypeById,
            entryPoint       = mergedEntryPoint,
            edgesJson        = mergedEdges,
            maxIterations    = mergedMaxIter,
            name             = req.name,
            isDefault        = req.isDefault,
            isOnlyGraph      = isOnlyGraph,
            nodePatchConfigs = nodePatchConfigs,
        )
        nodePatchConfigs.forEach { (nodeId, config) ->
            validateInstructionRef(nodeId, config, nodeTypeById[nodeId])
        }

        // ── Apply: create added nodes, patch nodes, remove nodes, patch graph ─
        addNodes.forEach { n ->
            graphRepository.createCustomerGraphNode(
                customerId = ownerId,
                nodeId = idMap.getValue(n.tempId),
                nodeType = n.nodeType,
                name = n.name,
                config = n.config,
            )
        }
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
        removeSet.forEach { graphRepository.deleteCustomerGraphNode(it) }

        val updatedGraph = graphRepository.updateCustomerGraph(
            graphId       = graphId,
            name          = mergedName,
            isDefault     = mergedIsDefault,
            nodeIds       = finalNodeIds,
            edges         = mergedEdges,
            entryPoint    = mergedEntryPoint,
            maxIterations = mergedMaxIter,
            layout        = mergedLayout,
            // null keeps the stored category (repo-level merge, like layout)
            category      = patchedCategory,
        )
        logger.info { "Updated agent $graphId for $ownerId (${addNodes.size} added, ${removeSet.size} removed node(s))" }
        bumpAgentsVersion(ownerId)
        // A System agent's name shows up as platformAgentName in
        // /request-agents — a System-side edit must invalidate that cache too.
        if (ownerId == SYSTEM_GRAPH_OWNER) bumpRequestAgentsVersion(SYSTEM_GRAPH_OWNER)

        // ── Re-fetch updated nodes and build hydrated response ────────────────
        val refreshedById = graphRepository.listCustomerGraphNodes(ownerId)
            .associateBy { it[NODE_ID_KEY]?.s() ?: "" }
        return agentResponseFrom(updatedGraph, refreshedById, isSystem = isSystem)
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    private val tempIdPattern = Regex("^[A-Za-z0-9_-]+$")

    private fun validateTempIds(nodes: List<NewAgentNode>) {
        val seen = mutableSetOf<String>()
        nodes.forEach { n ->
            require(tempIdPattern.matches(n.tempId)) {
                "tempId '${n.tempId}' is invalid — use only letters, digits, '-' and '_'."
            }
            require(n.tempId != "__end__") { "tempId must not be '__end__'." }
            require(seen.add(n.tempId)) { "Duplicate tempId '${n.tempId}'." }
            require(n.nodeType.isNotBlank()) { "Node '${n.tempId}' is missing nodeType." }
            require(n.name.isNotBlank()) { "Node '${n.tempId}' is missing a name." }
        }
    }

    /**
     * Replaces node-id references inside a JSON blob (edges or layout) by
     * substituting each map key as an exact JSON string token ("<id>"). Safe
     * because ids only appear as full string values / object keys in those
     * blobs, and both temp and real ids never contain quotes.
     */
    private fun substituteNodeIds(json: String, idMap: Map<String, String>): String {
        var result = json
        idMap.forEach { (from, to) -> result = result.replace("\"$from\"", "\"$to\"") }
        return result
    }

    /**
     * Validates the instruction reference in a node config, when present.
     * GENERATION nodes must have a fully valid [GenerationNodeConfig] with a
     * resolvable instruction; for every other node type instruction_id /
     * instruction_version are optional but must resolve when provided.
     */
    private suspend fun validateInstructionRef(nodeId: String, configJson: String, nodeType: String?) {
        if (nodeType == GENERATION_NODE_TYPE) {
            val config = try {
                nodeConfigJson.decodeFromString(GenerationNodeConfig.serializer(), configJson)
            } catch (e: Exception) {
                throw IllegalArgumentException(
                    "Node '$nodeId' config is not a valid GENERATION config: ${e.message}"
                )
            }
            requireInstructionExists(nodeId, config.instructionId, config.instructionVersion)
            return
        }
        val obj = try {
            jsonParser.parseToJsonElement(configJson).jsonObject
        } catch (e: Exception) {
            return // JSON validity is enforced by GraphValidationService
        }
        val instructionId = (obj["instruction_id"] as? JsonPrimitive)?.contentOrNull ?: return
        val pinnedVersion = (obj["instruction_version"] as? JsonPrimitive)?.intOrNull
        requireInstructionExists(nodeId, instructionId, pinnedVersion)
    }

    private suspend fun requireInstructionExists(nodeId: String, instructionId: String, pinnedVersion: Int?) {
        val version = pinnedVersion
            ?: instructionRepository.getLatestInstructionVersion(instructionId)
            ?: throw IllegalArgumentException("Node '$nodeId': instruction $instructionId not found.")
        requireNotNull(instructionRepository.getInstruction(instructionId, version)) {
            "Node '$nodeId': instruction $instructionId v$version not found."
        }
    }

    /** Display name of the instruction referenced by a node config, or null. */
    private suspend fun instructionNameFor(configJson: String): String? = try {
        val obj = jsonParser.parseToJsonElement(configJson).jsonObject
        (obj["instruction_id"] as? JsonPrimitive)?.contentOrNull?.let { id ->
            val version = (obj["instruction_version"] as? JsonPrimitive)?.intOrNull
                ?: instructionRepository.getLatestInstructionVersion(id)
            version?.let { instructionRepository.getInstruction(id, it)?.name }
        }
    } catch (e: Exception) {
        null
    }

    /** Builds a hydrated [AgentResponse] from a live graph item + the owner's nodes. */
    private suspend fun agentResponseFrom(
        graphItem: Map<String, AttributeValue>,
        nodeById: Map<String, Map<String, AttributeValue>>,
        isSystem: Boolean,
        requestTypeByGraphId: Map<String, String> = emptyMap(),
    ): AgentResponse {
        val nodeIds = graphItem[GRAPH_NODE_IDS_KEY]?.l()?.map { it.s() } ?: emptyList()
        val hydratedNodes = nodeIds.mapNotNull { nid ->
            nodeById[nid]?.let { nodeItem ->
                val config = nodeItem[NODE_CONFIG_KEY]?.s() ?: "{}"
                AgentNodeResponse(
                    nodeId = nodeItem[NODE_ID_KEY]?.s() ?: nid,
                    nodeType = nodeItem[NODE_TYPE_KEY]?.s() ?: "",
                    name = nodeItem[NODE_NAME_KEY]?.s() ?: "",
                    config = config,
                    instructionName = instructionNameFor(config),
                )
            }
        }
        val graphId = graphItem[GRAPH_ID_KEY]?.s() ?: ""
        // Graphs created before categories carry no attribute: derive from the
        // request-agent map when referenced (so a memory/title agent never
        // defaults into the conversation picker), else CONVERSATION.
        val category = graphItem[GRAPH_CATEGORY_KEY]?.s()
            ?: requestTypeByGraphId[graphId]?.let { AgentCategory.categoryForRequestType(it)?.name }
            ?: AgentCategory.CONVERSATION.name
        return AgentResponse(
            graphId = graphId,
            name = graphItem[GRAPH_NAME_KEY]?.s() ?: "",
            isDefault = graphItem[GRAPH_IS_DEFAULT_KEY]?.bool() ?: false,
            entryPoint = graphItem[GRAPH_ENTRY_POINT_KEY]?.s() ?: "",
            maxIterations = graphItem[GRAPH_MAX_ITERATIONS_KEY]?.n()?.toInt() ?: 10,
            edges = graphItem[GRAPH_EDGES_KEY]?.s() ?: "{}",
            layout = graphItem[GRAPH_LAYOUT_KEY]?.s(),
            isSystem = isSystem,
            requestType = requestTypeByGraphId[graphId],
            category = category,
            nodes = hydratedNodes,
            createdAt = graphItem["createdAt"]?.s(),
            updatedAt = graphItem["updatedAt"]?.s(),
        )
    }

    private val jsonParser = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }

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
