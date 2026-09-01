/** @type {import('next').NextConfig} */
const nextConfig = {
  // The repo root has its own package-lock.json; pin tracing to this app.
  outputFileTracingRoot: import.meta.dirname,
}

export default nextConfig
