import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  // Relative asset paths keep the bundle portable for GitHub Pages hosting.
  base: "./",
});
