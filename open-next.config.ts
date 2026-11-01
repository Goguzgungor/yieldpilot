import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Every page/route is force-dynamic (live agent state), so no incremental
// cache / R2 bucket is configured — the defaults are all we need.
export default defineCloudflareConfig();
