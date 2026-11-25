/// <reference types="vitest" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The site talks to the desk under /api (same origin, so the review cookie stays SameSite=Strict).
const desk = process.env.DESK_URL ?? "http://127.0.0.1:4200";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": { target: desk, rewrite: (p) => p.replace(/^\/api/, "") } } },
  preview: { port: 5173, proxy: { "/api": { target: desk, rewrite: (p) => p.replace(/^\/api/, "") } } },
  test: { environment: "jsdom", globals: false, restoreMocks: true },
});
