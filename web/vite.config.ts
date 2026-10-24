import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    allowedHosts: ["deniss-macbook-pro-voyfai.tail82062f.ts.net"],
  },
});
