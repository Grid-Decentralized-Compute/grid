import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Writes dist/_headers, the security headers Cloudflare Pages serves with every page. The content
 * policy allows exactly what the site uses: its own scripts plus the hash of each inline script
 * in the built index.html (computed here, so editing that script can never silently break the
 * page), Google Fonts, and https connections to RPCs and host nodes, which can be anywhere. The
 * page cannot be framed, so no other site can overlay it to trick clicks into transactions.
 */
function securityHeaders(): Plugin {
  let outDir = "dist";
  return {
    name: "grid-security-headers",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const html = readFileSync(join(outDir, "index.html"), "utf8");
      const hashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
        (m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`,
      );
      const csp = [
        "default-src 'self'",
        `script-src 'self' ${hashes.join(" ")}`.trim(),
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data:",
        "connect-src 'self' https:",
        "frame-src 'none'",
        "frame-ancestors 'none'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "upgrade-insecure-requests",
      ].join("; ");
      const headers = [
        "/*",
        `  Content-Security-Policy: ${csp}`,
        "  Strict-Transport-Security: max-age=31536000; includeSubDomains",
        "  X-Frame-Options: DENY",
        "  X-Content-Type-Options: nosniff",
        "  Referrer-Policy: strict-origin-when-cross-origin",
        "  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()",
        "  Cross-Origin-Opener-Policy: same-origin",
        "",
      ].join("\n");
      writeFileSync(join(outDir, "_headers"), headers);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), securityHeaders()],
  server: { port: 5173 },
});
