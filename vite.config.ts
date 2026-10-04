import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

// `npm run dev`        → http://localhost:5173 (desktop / pré-visualização)
// `npm run dev:https`  → https://<ip-da-maquina>:5173 com certificado autoassinado,
//                         necessário para abrir o WebXR no Meta Quest pela rede local.
export default defineConfig(({ mode }) => {
  // Lê ESP32_HOST / ESP32_PORT de .env.local (veja .env.example).
  const env = loadEnv(mode, process.cwd(), "");
  const espHost = env.ESP32_HOST || "furadeira.local";
  const espPort = env.ESP32_PORT || "81";

  // Ponte para o ESP32: a página conecta em ws(s)://<este servidor>/esp32 e o
  // Vite repassa para ws://ESP32_HOST:81. Isso resolve o bloqueio de
  // "conteúdo misto" (página HTTPS não pode abrir ws:// direto no ESP32).
  const proxy: Record<string, ProxyOptions> = {
    "/esp32": {
      target: `ws://${espHost}:${espPort}`,
      ws: true,
      changeOrigin: true,
      rewrite: (path) => path.replace(/^\/esp32/, "") || "/",
    },
  };

  return {
    // Caminhos relativos: funciona em qualquer subpasta (GitHub Pages, Netlify, etc.)
    base: "./",
    plugins: mode === "https" ? [basicSsl()] : [],
    server: { host: true, port: 5173, proxy },
    preview: { host: true, port: 4173, proxy },
    build: {
      outDir: "dist",
      target: "es2020",
      // Babylon.js é grande por natureza; o aviso padrão de 500 kB não é útil aqui.
      chunkSizeWarningLimit: 7000,
    },
  };
});
