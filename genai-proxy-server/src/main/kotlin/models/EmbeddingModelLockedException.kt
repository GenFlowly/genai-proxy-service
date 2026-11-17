package com.genflowly.models

/**
 * A save tried to change the customer's embedding model after it was chosen.
 * Search only works when all data is embedded with one model, so the first
 * choice is final. [lockedModel] is the model already chosen (null if the
 * stored item couldn't be read back).
 */
class EmbeddingModelLockedException(val lockedModel: String?) :
    RuntimeException("The embedding model is locked to $lockedModel")
