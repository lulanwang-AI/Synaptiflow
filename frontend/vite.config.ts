import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The app calls the backend via VITE_API_BASE (default http://localhost:8000).
// The backend sets permissive CORS, so direct calls work. As a convenience we
// also proxy "/api" to the backend for setups that prefer a same-origin path
// (set VITE_API_BASE=/api to use it). MSW intercepts when the backend is down.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
