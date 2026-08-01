# Application website - https://genflowly.com


## Section 1: Structure 
### 1. genai-proxy-server
Kotlin app that acts as the core API backend. Hosted on **Fly.io** (`genai-proxy-server-<stage>`).
### 2. genai-proxy-server-cdk
AWS CDK code that manages the persistent data and security infrastructure in AWS (DynamoDB tables, KMS encryption keys, and programmatic IAM access users for GitHub Actions and Fly.io).
### 3. genai-react-app
React Front end that lets you interact with the application. Hosted on Netlify.
### 4. retrieval-server (Sidecar)
Python AI/ML service running Uvicorn that handles vector embeddings and retrieval. Hosted as a private internal service on **Fly.io** (`genai-retrieval-server-<stage>`).
### 5. encoding-server
Python AWS lambdas that do chunking, encoding, and storing in vector DB.
### 6. encoding-server-cdk
CDK code that creates infrastructure for `encoding-server` in AWS for `development` and `production` stages.
### 7. encoding-library
Common abstractions related to embeddings in Python.

## Section 2: How to setup and deploy

### 1. AWS Setup (Database, KMS & IAM Layer)
1. Create an AWS account.
2. Go to IAM and create a temporary administrative User or set up your local AWS profile credentials (`aws configure --profile production`).
3. Go to `genai-proxy-server-cdk` and install dependencies: `npm install`.
4. **Bootstrap AWS CDK v2** (Required once per AWS account/region):
   ```bash
   AWS_PROFILE=production STAGE=development npx aws-cdk@latest bootstrap aws://<YOUR_AWS_ACCOUNT_ID>/us-east-1
   ```
5. Deploy the CDK stacks to provision DynamoDB, KMS, and IAM Users:
   ```bash
   AWS_PROFILE=production STAGE=development npx aws-cdk@latest deploy --all
   ```
6. After `BootstrapStack` deploys, note down the printed `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` outputs. These are the deployment user credentials required for your GitHub Actions secrets.
7. Similarly, repeat steps 4-5 for `encoding-server-cdk` if deploying lambda infrastructure.

### 2. Fly.io Setup (Compute & Apps)
1. Install Fly.io CLI and authenticate:
   ```bash
   brew install flyctl
   flyctl auth login
   ```
2. Create the application containers for your stage (e.g., `development`):
   ```bash
   flyctl apps create genai-proxy-server-development
   flyctl apps create genai-retrieval-server-development
   ```
3. Allocate dedicated public IP addresses for the proxy server:
   ```bash
   flyctl ips allocate-v4 -a genai-proxy-server-development
   flyctl ips allocate-v6 -a genai-proxy-server-development
   ```
4. Check your assigned IP addresses at any time:
   ```bash
   flyctl ips list -a genai-proxy-server-development
   ```
5. Register your subdomain for SSL/TLS certificate creation in Fly.io:
   ```bash
   flyctl certs add api-development.genflowly.com -a genai-proxy-server-development
   ```

### 3. Cloudflare Setup (DNS & WAF)
1. In your Cloudflare Dashboard, select your domain (`genflowly.com`).
2. **Remove legacy records**: If you have any old CNAME records for `api-development` pointing to AWS ECS or load balancers, delete them.
3. **Add Fly.io DNS Records**:
   - Create an **A Record**: Name = `api-development`, Target = `your-fly-ipv4-address`, **Proxied = ON** (Orange Cloud ☁️).
   - Create an **AAAA Record**: Name = `api-development`, Target = `your-fly-ipv6-address`, **Proxied = ON** (Orange Cloud ☁️).
4. **⚠️ Critical SSL Setting**: Navigate to **SSL/TLS > Overview** in Cloudflare and set the encryption mode to **Full (Strict)** or **Full**. *(If left on "Flexible", Cloudflare and Fly.io will enter an infinite redirect loop).*
5. Check certificate validation progress in Fly.io:
   ```bash
   flyctl certs check api-development.genflowly.com -a genai-proxy-server-development
   ```

### 4. Netlify Setup (Frontend)
1. Create a Netlify account and upload/deploy `genai-react-app`.
2. In Netlify Account Settings, generate a "Personal Access Token" without expiration (`NETLIFY_AUTH_TOKEN`).
3. In your Netlify Site Settings, copy the Site ID (`NETLIFY_SITE_ID`).

### 5. Auth0 Setup (Authentication)
1. Create an Auth0 account and set up a Single Page Application (SPA).
2. Set Allowed Callback, Logout, Web Origins, and CORS URLs to your stage frontend URLs (e.g., `https://development.genflowly.com`).
3. Create an API identifier matching your backend endpoint (e.g., `https://api-development.genflowly.com`).
4. **Authorize Client Access**: In your Auth0 Dashboard > **Applications > APIs** > select your API > click **Machine to Machine Applications** (or **Application Access** tab) > find your SPA Application and toggle it **Authorized (ON)**.
5. **Enable Refresh Tokens**: In your API Settings tab, scroll down to **Access Settings** and check **Allow Offline Access** (required for `offline_access` scope).
6. Note down the API Audience, Client ID, and Domain for GitHub Actions secrets.


### 6. Github Actions CI/CD Setup
Go to your GitHub Repository > **Settings** > **Secrets and variables** > **Actions** and add the following repository secrets:
1. `FLY_API_TOKEN`: Generated via `flyctl tokens create deploy -x 999999h`
2. `AWS_ACCESS_KEY_ID`: From `BootstrapStack` output (for CDK CI/CD deployments)
3. `AWS_SECRET_ACCESS_KEY`: From `BootstrapStack` output
4. `AWS_REGION`: e.g., `us-east-1`
5. `AUTH0_API_AUDIENCE`
6. `AUTH0_SPA_CLIENT_ID`
7. `AUTH0_SPA_DOMAIN`
8. `NETLIFY_AUTH_TOKEN`
9. `NETLIFY_SITE_ID`
10. `ZILLIZ_ENDPOINT`
11. `ZILLIZ_TOKEN`

When you push to the `development` branch, GitHub Actions will automatically:
- Deploy any DynamoDB/KMS schema updates via AWS CDK.
- Fetch runtime AWS credentials from `FlyioIamStack` and inject them securely as Fly.io secrets.
- Build and deploy both `genai-proxy-server-development` and `genai-retrieval-server-development` to Fly.io!

### 7. Milvus Setup
1. Create a Zilliz Cloud account and get your endpoint and API token (`ZILLIZ_ENDPOINT`, `ZILLIZ_TOKEN`).


## Section 3: Deploying to Production

When you are ready to launch to Production, you must bootstrap and pre-provision the environment just like you did for Development, but using production parameters.

### 1. Bootstrap & Pre-provision AWS CDK for Production
If you are running this from AWS CloudShell (where you are already authenticated), you can dynamically fetch your account details to bootstrap the environment:
1. Fetch your Account ID and Region in CloudShell:
   ```bash
   export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
   export AWS_REGION=$AWS_REGION
   ```
2. Run the AWS CDK Bootstrap command for the production environment:
   ```bash
   STAGE=production npx aws-cdk@latest bootstrap aws://$AWS_ACCOUNT_ID/$AWS_REGION
   ```

### 2. Pre-provision Fly.io Apps
Create the empty shells for your production compute instances:
```bash
flyctl apps create genai-proxy-server-production
flyctl apps create genai-retrieval-server-production

flyctl ips allocate-v4 -a genai-proxy-server-production
flyctl ips allocate-v6 -a genai-proxy-server-production

flyctl certs add api.genflowly.com -a genai-proxy-server-production
```

### 3. Update Cloudflare DNS & Auth0
1. **Cloudflare**: Add your Fly.io IPv4 and IPv6 addresses as **Proxied** A and AAAA records for `api` (`api.genflowly.com`). Ensure SSL is set to **Full (Strict)**.
2. **Auth0**: Ensure your Auth0 Application allows `https://genflowly.com` and `https://www.genflowly.com` as Allowed Callback, Logout, and Web Origins URLs. The Production API Audience must be `https://api.genflowly.com`.

### 4. Set GitHub Production Environment Secrets
Go to your GitHub Repository > **Settings** > **Environments** > **production** (or global repository secrets) and ensure all secrets are updated for production:
- `AUTH0_SPA_CLIENT_ID` (Production Client ID)
- `AUTH0_API_AUDIENCE` (`https://api.genflowly.com`)
- `AWS_ACCESS_KEY_ID` & `AWS_SECRET_ACCESS_KEY` (Production AWS User)
- `NETLIFY_SITE_ID` (Production Netlify site ID)

### 5. Trigger CI/CD
Open a Pull Request against the `main` branch. When it merges, the `.github/workflows/prod-pipeline.yml` will automatically deploy your frontend to Netlify, sync your AWS CDK infrastructure, and push your backend containers to Fly.io Production!


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
