import { defineCloudflareConfig } from '@opennextjs/cloudflare';

// Cloudflare Workers adapter for the existing Next.js ICOP frontend.
// Build output must be generated before Wrangler can deploy.
export default defineCloudflareConfig();
