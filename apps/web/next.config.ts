import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  transpilePackages: ["@patchpilot/domain"],
  output: "standalone"
};

export default nextConfig;
