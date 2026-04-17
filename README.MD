# Application website - https://genflowly.com


## Section 1: Structure 
### 1. genai-proxy-server
Kotlin app that acts as backend for all generation.
### 2. genai-proxy-server-cdk
CDK code that creates infrastructure for `genai-proxy-server` in AWS for `development` and 
`production` stages
### 3. genai-react-app
React Front end that lets you interact with application. Hosted on Netlify.
### 4. encoding-server
Python AWS lambdas that does chunking, encoding and storing in vector DB
### 5. encoding-server-cdk
CDK code that creates infrastructure for `encoding-server` in AWS for `development` and
`production` stages
### 6. encoding-library
Common abstractions related to embeddings in python

## Section 2: How to setup and deploy
### 1. AWS Setup
1. Create AWS account and a 
### 2. Netlify Setup
1. Create netlify
### 3. Auth0 Setup
1. Create Auth0 account
### 4. Cloudflare Setup
1. Create cloudflare account
### 5. Github Actions Setup
1. Create environment
### 6. Milvus Setup
1. Create Zilliz account


## Gotchas 
1. Deleting DDB Cloudformation stack doesn't delete the tables created.