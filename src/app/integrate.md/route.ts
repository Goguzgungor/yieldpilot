import { fullGuide } from "../../lib/integrate/brief";

// The whole guide is built from constants, so it is rendered once at build time.
export const dynamic = "force-static";

/**
 * GET /integrate.md — the integration guide as plain Markdown, for an AI coding
 * assistant to read (the brief on /integrate points it here). Same content as
 * the page, every path and every snippet at the default rule.
 */
export function GET() {
  return new Response(fullGuide(), {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}
