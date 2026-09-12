import type { NextConfig } from "next";
const nextConfig: NextConfig = {
  agentRules: false,
  distDir: process.env.HEPTAPOD_NEXT_DIST_DIR ?? ".next",
};
export default nextConfig;
