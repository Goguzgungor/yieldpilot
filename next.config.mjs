/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep heavy server-only deps out of the bundle so routes load them via Node's
  // require at runtime. `mongodb` pulls in optional native/peer deps that don't
  // bundle cleanly; the Stellar/Blend SDKs are large and pull in node built-ins
  // that don't need bundling on the server.
  serverExternalPackages: [
    "mongodb",
    "@stellar/stellar-sdk",
    "@blend-capital/blend-sdk",
  ],
};

export default nextConfig;
