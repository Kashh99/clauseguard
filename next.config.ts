import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse v2 relies on pdfjs-dist and @napi-rs/canvas (native bindings).
  // Opting them out of the Next.js bundler lets Node require them directly.
  serverExternalPackages: ['pdfjs-dist'],
};

export default nextConfig;
