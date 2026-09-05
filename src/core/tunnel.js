import { spawn } from "node:child_process";

/**
 * Túnel público con Cloudflare:
 * 1. Quick tunnel (gratuito, sin cuenta): expone el puerto en una URL aleatoria https://*.trycloudflare.com.
 * 2. Named tunnel (Cloudflare Zero Trust con dominio fijo): usa CLOUDFLARE_TUNNEL_TOKEN y CLOUDFLARE_TUNNEL_URL fija.
 */
export function startCloudflareTunnel({ port, token, fixedUrl, binary = "cloudflared", onLog = () => {}, timeoutMs = 45_000 }) {
  return new Promise((resolve, reject) => {
    let child;
    const args = token
      ? ["tunnel", "run", "--token", token]
      : ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"];
    try {
      child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
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
      if (token && fixedUrl && !resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({ url: fixedUrl.replace(/\/$/, ""), stop: () => child.kill() });
        return;
      }
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

/**
 * Túnel ngrok con dominio estático gratuito (requiere cuenta ngrok: NGROK_AUTHTOKEN y NGROK_DOMAIN).
 * A diferencia del quick tunnel de Cloudflare, la URL no cambia entre arranques, que es lo que exigen los directorios x402.
 */
export function startNgrokTunnel({ port, domain, authtoken, binary = "ngrok", onLog = () => {}, timeoutMs = 45_000 }) {
  return new Promise((resolve, reject) => {
    const args = ["http", String(port), "--log=stdout", "--log-format=json"];
    if (domain) args.push(`--url=${domain}`);
    let child;
    try {
      child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...(authtoken ? { NGROK_AUTHTOKEN: authtoken } : {}) } });
    } catch (error) {
      return reject(error);
    }
    let resolved = false;
    const timer = setTimeout(() => { if (!resolved) { child.kill(); reject(new Error("ngrok no entregó una URL pública a tiempo")); } }, timeoutMs);
    const onData = (chunk) => {
      const text = chunk.toString();
      onLog(text.trim());
      const match = text.match(/"url":"(https:\/\/[^"]+)"/) ?? text.match(/url=(https:\/\/\S+)/);
      if (match && !resolved) { resolved = true; clearTimeout(timer); resolve({ url: match[1], stop: () => child.kill() }); }
      if (/ERR_NGROK|authentication failed|error/i.test(text) && !resolved && /ERR_NGROK/.test(text)) {
        resolved = true; clearTimeout(timer); child.kill(); reject(new Error(text.slice(0, 300)));
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (error) => { clearTimeout(timer); reject(new Error(`No se pudo lanzar ${binary}: ${error.message}. Instálalo con: brew install ngrok`)); });
    child.on("exit", (code) => { if (!resolved) { clearTimeout(timer); reject(new Error(`ngrok terminó con código ${code}`)); } });
  });
}
