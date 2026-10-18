import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";
import { SHARE_ENTRY, shareAwareUrl } from "./src/build/shareUrls.ts";

const API_TARGET = process.env.CELLAR_DEV_API ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@cellar/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
      "/healthz": { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Every browser cellar supports has native modulepreload. Without the
    // polyfill the two entries cannot end up sharing a helper chunk.
    modulePreload: { polyfill: false },
    // Two entries share one dist/. See src/build/shareUrls.ts for why the share
    // entry's files are all named share-* and referenced as /s/assets/...
    rolldownOptions: {
      input: {
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        [SHARE_ENTRY]: fileURLToPath(new URL("./share.html", import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === SHARE_ENTRY ? "assets/share-[hash].js" : "assets/[name]-[hash].js",
        // Admin chunks must never look like share files to isShareHost.
        chunkFileNames: (chunk) =>
          chunk.name.startsWith(`${SHARE_ENTRY}-`)
            ? "assets/chunk-[name]-[hash].js"
            : "assets/[name]-[hash].js",
        // share.css is the share entry's stylesheet. A public/ file only becomes
        // a bundled asset when share.html references it relatively (the admin
        // page links public files by absolute path, which Vite copies as-is),
        // so those are share files too: today, just the favicon.
        assetFileNames: (asset) => {
          if (asset.names.includes(`${SHARE_ENTRY}.css`)) return "assets/share-[hash][extname]";
          if (asset.originalFileNames.some((file) => file.startsWith("public/"))) {
            return "assets/share-[name]-[hash][extname]";
          }
          return "assets/[name]-[hash][extname]";
        },
      },
    },
    // The admin entry carries Vue, the router, pinia, zod and the PrimeVue
    // runtime with the Aura theme. Every page is lazy except Videos.
    chunkSizeWarningLimit: 700,
  },
  experimental: {
    renderBuiltUrl: (filename, context) => shareAwareUrl(filename, context),
  },
});
