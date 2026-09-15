import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  agentRules: false,
  distDir: process.env.HEPTAPOD_NEXT_DIST_DIR ?? ".next",
  serverExternalPackages: ["@thestraylight/heptapod-core"],
};
export default nextConfig;
