#!/usr/bin/env bash
# Compiles the exact-pin lockfiles that the service images and CI install
# (requirements*.lock.txt). Resolution runs inside the SAME base images the
# Dockerfiles build FROM, so the resolved pins match the runtime platform
# (linux, CPython 3.11) — never run pip-compile on the host for these.
#
# Run after editing any requirements*.txt, commit the lock diff with it.
set -euo pipefail
cd "$(dirname "$0")/.."

RETRIEVAL_IMG="python:3.11-slim"
LAMBDA_IMG="public.ecr.aws/lambda/python:3.11"

compile() {
  local image="$1" dir="$2" req="$3"
  shift 3
  local lock="${req%.txt}.lock.txt"
  echo "--- ${dir}/${lock} (in ${image})"
  docker run --rm --platform linux/amd64 "$@" \
    -v "$PWD/${dir}:/src" -w /src --entrypoint /bin/sh "$image" -c \
    "pip install --quiet --disable-pip-version-check --upgrade pip pip-tools && \
     pip-compile --quiet --strip-extras --no-header --output-file ${lock} ${req}"
}

compile "$RETRIEVAL_IMG" retrieval-server requirements.txt

# The lambda Dockerfiles install with --only-binary=:all:; resolving under the
# same constraint keeps the lock installable there (and never builds sdists).
for req in requirements.txt requirements-parse-and-chunk.txt \
           requirements-create-and-store.txt requirements-store-embeddings.txt; do
  compile "$LAMBDA_IMG" encoding-server "$req" -e PIP_ONLY_BINARY=":all:"
done

echo "done"
