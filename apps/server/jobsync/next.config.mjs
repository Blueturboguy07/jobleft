import path from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // Pin the tracing root. Without it Next walks up looking for a lockfile, and a
  // stray ~/pnpm-lock.yaml made it nest the whole server under
  // .next/standalone/jobleft/vendor/jobsync/.
  outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)),
  devIndicators: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
