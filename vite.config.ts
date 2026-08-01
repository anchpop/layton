import path from "node:path";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

const REQUIRED_ENV = [
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
] as const;

/**
 * Refuses to build without the Supabase credentials.
 *
 * Vite inlines a missing `import.meta.env` var as `undefined` and carries on,
 * so a typo'd or unset variable produces a bundle that builds green and then
 * throws on the first line of the app. In CI that is the worst shape a failure
 * can take: the run reports success and layton.space serves a blank page.
 *
 * Checking here rather than in the workflow means every build is covered by
 * one rule — CI, a colleague's laptop, and `pnpm dev` alike.
 */
function requireEnv(): Plugin {
  return {
    name: "layton:require-env",
    config(_config, { mode }) {
      const env = loadEnv(mode, process.cwd(), "VITE_");
      const missing = REQUIRED_ENV.filter((name) => !env[name]);
      if (missing.length > 0) {
        throw new Error(
          `Missing ${missing.join(", ")}. Copy .env.example to .env.local and fill it in.`,
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [
    requireEnv(),
    react(),
    tailwindcss(),
    VitePWA({
      // The worker fetches new builds on its own; UpdatePrompt decides when to
      // activate one, so a reload never interrupts a sentence.
      registerType: "prompt",
      injectRegister: null,
      workbox: {
        globPatterns: [
          "**/*.{js,css,html,svg,png,ico,webmanifest,wasm,woff,woff2}",
        ],
        // Loro's wasm is ~3 MB, well over Workbox's 2 MiB default. Without
        // this it is silently dropped from the precache and the editor cannot
        // open offline — which is the entire point of the app.
        maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
        // Client-side routes must resolve offline too.
        navigateFallback: "index.html",
        // Never answer a Supabase call from the precache. Sync has its own
        // offline handling (an IndexedDB outbox); a stale cached API response
        // would be worse than a clean failure.
        navigateFallbackDenylist: [/supabase\.co/],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.hostname.endsWith("supabase.co"),
            handler: "NetworkOnly",
          },
        ],
        cleanupOutdatedCaches: true,
      },
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Layton",
        short_name: "Layton",
        description:
          "A quiet, offline-first place to write fiction, synced to your account.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#fbfaf7",
        theme_color: "#fbfaf7",
        categories: ["productivity", "books"],
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  build: {
    target: "es2022",
  },
});
