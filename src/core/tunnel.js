import { spawn } from "node:child_process";

/**
 * Túnel público gratuito con Cloudflare (quick tunnel, sin cuenta): expone el puerto local
 * en una URL https://*.trycloudflare.com. La URL cambia en cada arranque, por eso el servidor
 * la descubre al vuelo y la publica en el catálogo x402.
 */
export function startCloudflareTunnel({ port, binary = "cloudflared", onLog = () => {}, timeoutMs = 45_000 }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(binary, ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      return reject(error);
    }
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) { child.kill(); reject(new Error("cloudflared no entregó una URL pública a tiempo")); }
    }, timeoutMs);
    const onData = (chunk) => {
      const text = chunk.toString();
      onLog(text.trim());
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({ url: match[0], stop: () => child.kill() });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (error) => { clearTimeout(timer); reject(new Error(`No se pudo lanzar ${binary}: ${error.message}. Instálalo con: brew install cloudflared`)); });
    child.on("exit", (code) => { if (!resolved) { clearTimeout(timer); reject(new Error(`cloudflared terminó con código ${code}`)); } });
  });
}
