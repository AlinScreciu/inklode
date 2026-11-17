import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import { cpSync, createReadStream, existsSync } from "node:fs";
const host = process.env.TAURI_DEV_HOST;

// Excalidraw's fonts, as they are in its package. The app serves them itself at `/fonts`
// (src/modules/excalidraw/index.ts points the library there), so drawings need no CDN and work offline.
const FONTS = "node_modules/@excalidraw/excalidraw/dist/prod/fonts";
const excalidrawFonts = (): Plugin => ({
  name: "inklode-excalidraw-fonts",
  // `pnpm dev` and `pnpm tauri dev`: straight from the package.
  configureServer(server) {
    server.middlewares.use("/fonts", (request, response, next) => {
      const file = FONTS + decodeURIComponent((request.url ?? "").split("?")[0]);
      if (file.includes("..") || !file.endsWith(".woff2") || !existsSync(file)) return next();
      response.setHeader("Content-Type", "font/woff2");
      createReadStream(file).pipe(response);
    });
  },
  // `pnpm build`: copied next to the built page.
  closeBundle() {
    cpSync(FONTS, "dist/fonts", { recursive: true });
  },
});

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), excalidrawFonts()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
