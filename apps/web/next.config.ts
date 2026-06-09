import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@patchpilot/domain"],
  output: "standalone"
};

export default nextConfig;
