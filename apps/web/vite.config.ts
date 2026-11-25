/// <reference types="vitest" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The site talks to the desk under /api (same origin, so the review cookie stays SameSite=Strict).
const desk = process.env.DESK_URL ?? "http://127.0.0.1:4200";

// /join.txt (instructions for outside agents) is served by the desk too, at the site root.
const proxy = { "/api": { target: desk, rewrite: (p: string) => p.replace(/^\/api/, "") }, "/join.txt": { target: desk } };

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
  preview: { port: 5173, proxy },
  test: { environment: "jsdom", globals: false, restoreMocks: true },
});
