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
1. Create AWS account.
2. Go to IAM and create a User - "Temp". Attach "Administrator" Inline 
   Policy to it. [warning - not a good practice but works]
3. Open the newly created user "Temp" and create access key credentials 
4. Install AWS CLI
5. Set the aws access key and secret access key to AWS profile in Mac - You 
   will need it to bootstrap the cdk and for deploying Bootstrap stack
    `aws configure --profile production`
6. Go to genai-proxy-server-cdk 
7. From local CLI Run `AWS_PROFILE=production STAGE=production 
AUTH0_SPA_DOMAIN=dummy AUTH0_SPA_CLIENT_ID=dummy AUTH0_API_AUDIENCE=dummy \
    cdk bootstrap aws://<YOUR_AWS_ACCOUNT_ID>/us-east-1`
8. Go to encoding-server-cdk
9. From local CLI Run `AWS_PROFILE=production STAGE=production 
AUTH0_SPA_DOMAIN=dummy AUTH0_SPA_CLIENT_ID=dummy AUTH0_API_AUDIENCE=dummy \
    cdk bootstrap aws://<YOUR_AWS_ACCOUNT_ID>/us-east-1`
10. Go to genai-proxy-server-cdk
11. From local CLI Run `AWS_PROFILE=production STAGE=production 
AUTH0_SPA_DOMAIN=dummy AUTH0_SPA_CLIENT_ID=dummy AUTH0_API_AUDIENCE=dummy \
    cdk deploy BootstrapStack`
12. **The deployment will be stuck until you do this** It will create the 
    certificate for ECS 
    Service. Go to AWS Console > 
    Certificate Manager > <CertificateName> . You will CNANE record and value
13. Copy the CNAME record and value and go to Cloudflare DNS records and 
    this key value pair for CNAME type
14. Once the deployment is complete - it will print AWS Credentials for Github 
    Actions - 
    Access Key and
    Secret Access Key *1 and *2
### 2. Netlify Setup
1. Create Netlify account
2. Make a zip of `genai-react-app`
3. Upload the zip for first time setup
4. Go to Accounts > Search for "Personal Access Token"
5. Create a Personal Access Token with no expiration and store it somewhere 
   safe, we 
   will 
   need it *3
6. Go to the project created and copy the site id *4
### 3. Auth0 Setup
1. Create Auth0 account
2. Create a new Application - Single Page Application
3. Set Allowed callback URLS - `https://www.genflowly.com` and 
   `https://genflowly.com` OR respective stage URLs
4. Set Allowed logout URLS - `https://www.genflowly.com` and
   `https://genflowly.com` OR respective stage URLs
5. Set Allowed Web Origins - `https://www.genflowly.com` and
   `https://genflowly.com` OR respective stage URLs
6. Set Allowed CORS Origins - `https://www.genflowly.com` and
   `https://genflowly.com` OR respective stage URLs
7. Allow Cross Origin Authentication
8. Create a new API
9. Set Identifier (Identifiers follow URL pattern but are not actual URLS) - 
   Prod - `https://api.genflowly.com` , Development - `https://api-development.genflowly.com`
10. In Application Access tabs, set User Access as Authorized, set Client 
    Access as Authorized
11. Copy the API Audience *4
### 4. Cloudflare Setup
1. Create cloudflare account and complete domain setup
2. Create DNS record for CNAME provided earlier at #13 of AWS Setup. This 
   is required for HTTPS Certificate
3. Add Workers in Compute. For development, the ELB_ENDPOINT will be 
   `api-development.genflowly.com`
4. For Production - In workers, set Custom domains to `www.genflowly.com` 
   and `genflowly.com`
5. For Development - In workers, set Route as `development.genflowly.com/*`
6. For Development / subdomain stages ONLY - Create a DNS record to route 
   requests to workers - Type: CNAME, Name: development, Target: development.
   genflowly.workers.dev, Proxied: True
7. For all environment - Create a DNS record to route api requests to ELB - 
   Type : CNAME , Name: api (api-development), Target: The ELB URL Printed 
   after CDK deployment of ECS stack. Refer to Github Actions Setup #14
    
### 5. Github Actions Setup
1. Go to repository settings > Secrets and Variables > Actions 
2. Create a new environment
3. Add following secrets -
4. `AUTH0_API_AUDIENCE`
5. `AUTH0_SPA_CLIENT_ID`
6. `AUTH0_SPA_DOMAIN`
7. `AWS_ACCESS_KEY_ID`
8. `AWS_REGION`
9. `AWS_SECRET_ACCESS_KEY`
10. `NETLIFY_AUTH_TOKEN`
11. `NETLIFY_SITE_ID`
12. `ZILLIZ_ENDPOINT`
13. `ZILLIZ_TOKEN`
14. After 1st deployment of `Proxy Service` is complete, the `Deploy ECS 
Stack` step will print the ELB URL. Copy this and put in Cloudflare DNS records 
### 6. Milvus Setup
1. Create Zilliz account


## Gotchas 
1. Deleting DDB Cloudformation stack doesn't delete the tables created.



## Misc Scripts / Code

### Cloudflare Workers
```js
/**
 * This Cloudflare Worker routes requests to the appropriate destination based on the URL path.
 * Requests to /api are forwarded to an EC2 instance, while all other requests are forwarded to a Netlify app.
 */

const ELB_ENDPOINT = 'api.genflowly.com'; // USE api-development.genflowly.com for development
const NETLIFY_ENDPOINT = 'genflowly-prod.netlify.app'; // update for development

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    let targetUrl;

        // ✅ Handle CORS preflight at the edge
        if (request.method === "OPTIONS") {
          return new Response(null, {
            status: 204,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type, Authorization",
              "Access-Control-Max-Age": "86400",
            },
          });
        }


    if (url.pathname.startsWith("/api")) {
      // Route /api requests to EC2
      targetUrl = new URL(request.url);
      targetUrl.hostname = ELB_ENDPOINT;



    } else {
      // Route everything else to Netlify
      targetUrl = new URL(request.url);
      targetUrl.hostname = NETLIFY_ENDPOINT;
    }

    console.log({
      incoming: url.pathname,
      outgoing: targetUrl.toString(),
    });

    const response = await fetch(
      new Request(targetUrl.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: "manual",
      })
    );

    // ✅ Add CORS headers to API responses
    if (url.pathname.startsWith("/api")) {
      const newHeaders = new Headers(response.headers);
      newHeaders.set("Access-Control-Allow-Origin", "*");

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    }

    return response;
  },
};


```
