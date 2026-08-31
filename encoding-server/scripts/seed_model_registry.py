#!/usr/bin/env python3
"""
Seed the EmbeddingModelRegistry DynamoDB table with per-model chunking params.

The table is read by parse_and_chunk (realtime) and the notes accumulator
(batch) at chunking time; per-request chunkSize/chunkOverlap overrides beat
these rows, and missing rows fall back to code defaults (1000/200 tokens).

Usage:
    python scripts/seed_model_registry.py [--table EmbeddingModelRegistry] [--region us-east-1]

Idempotent: put_item overwrites existing rows. Tune values here or edit rows
directly in DynamoDB — changes take effect on the next lambda cold start
(values are cached per process).
"""
import argparse

import boto3

# (modelType, modelName, chunkSize tokens, chunkOverlap tokens)
SEED_MODELS = [
    ("voyage", "voyage-4-large", 1000, 200),
    ("voyage", "voyage-4", 1000, 200),
    # Contextualized model: chunks are embedded with whole-document visibility,
    # so overlap is less useful; kept for parity until tuned.
    ("voyage", "voyage-context-4", 1000, 200),
    ("sentence-transformer", "all-MiniLM-L6-v2", 1000, 200),
    ("openai", "text-embedding-3-small", 1000, 200),
]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--table", default="EmbeddingModelRegistry")
    parser.add_argument("--region", default="us-east-1")
    args = parser.parse_args()

    client = boto3.client("dynamodb", region_name=args.region)
    for model_type, model_name, chunk_size, chunk_overlap in SEED_MODELS:
        client.put_item(
            TableName=args.table,
            Item={
                "modelType": {"S": model_type},
                "modelName": {"S": model_name},
                "chunkSize": {"N": str(chunk_size)},
                "chunkOverlap": {"N": str(chunk_overlap)},
            },
        )
        print(f"seeded {model_type}/{model_name}: chunkSize={chunk_size} chunkOverlap={chunk_overlap}")


if __name__ == "__main__":
    main()
