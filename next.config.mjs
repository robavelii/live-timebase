/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The generated live stream is served by app/stream/[...file]/route.ts rather than
  // from public/, which Next indexes at build time and would 404 for every segment
  // written afterwards. Caching headers are set there.
}

export default nextConfig
