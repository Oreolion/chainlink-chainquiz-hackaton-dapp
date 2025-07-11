import type { NextConfig } from "next";

/** @type {import('next').NextConfig} */
const nextConfig: NextConfig  = {
    output: 'standalone',
    reactStrictMode: true,
  webpack: (config) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
    };
    return config;
  },
};

export default nextConfig;