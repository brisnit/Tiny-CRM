import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prisma's driver adapters load native bindings, so they must resolve at
  // runtime rather than be traced into the bundle.
  serverExternalPackages: [
    "@prisma/adapter-better-sqlite3",
    "@prisma/adapter-pg",
    "better-sqlite3",
  ],
  typedRoutes: true,
  images: {
    remotePatterns: [{ protocol: "https", hostname: "**" }],
  },
};

export default nextConfig;
