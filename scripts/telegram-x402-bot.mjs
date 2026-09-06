#!/usr/bin/env node
/**
 * Bot de Telegram para Monexa x402 Services.
 * Permite a usuarios de Telegram interactuar con el catálogo de micro-servicios,
 * consultar auditorías, tests y revisiones directamente.
 * 
 * Uso:
 *   TELEGRAM_BOT_TOKEN="tu_token" node scripts/telegram-x402-bot.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Cargar variables de .env si existe
if (existsSync(".env")) {
  const envContent = readFileSync(".env", "utf8");
  for (const line of envContent.split("\n")) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = (match[2] || "").trim().replace(/^['"]|['"]$/g, "");
    }
  }
}

const token = process.env.TELEGRAM_BOT_TOKEN;
const monexaUrl = (process.env.PUBLIC_URL || "http://127.0.0.1:4173").replace(/\/$/, "");
const payTo = process.env.PAYTO_ADDRESS || "0xf138f07cE4F8C69B0A500D41d1D9b620E48687C2";

if (!token) {
  console.log(`
[Telegram Bot Monexa]
Para activar el bot en Telegram:
1. Habla con @BotFather en Telegram y crea un bot para obtener tu token.
2. Agrega en tu archivo .env:
   TELEGRAM_BOT_TOKEN="tu_token_aqui"
3. Ejecuta:
   node scripts/telegram-x402-bot.mjs
`);
  process.exit(0);
}

const TG_API = `https://api.telegram.org/bot${token}`;

async function api(method, body = {}) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function sendMessage(chatId, text, extra = {}) {
  return api("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown", ...extra });
}

console.log(`[Telegram Bot] Iniciando polling para Monexa (${monexaUrl})...`);

let offset = 0;

async function poll() {
  while (true) {
    try {
      const res = await api("getUpdates", { offset, timeout: 30 });
      if (res.ok && res.result.length > 0) {
        for (const update of res.result) {
          offset = update.update_id + 1;
          if (update.message?.text) {
            await handleMessage(update.message);
          }
        }
      }
    } catch (err) {
      console.error("[Telegram Bot] Error en polling:", err.message);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

async function handleMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text === "/start" || text === "/help") {
    const welcome = `🤖 *Bienvenido a Monexa AI Services*

Micro-servicios de IA autónomos sobre la red *Base (Ethereum L2)* con micropagos en *USDC*.

*Comandos disponibles:*
• \`/servicios\` - Lista completa de servicios y precios
• \`/portal\` - Enlace al Playground Web3 interactivo
• \`/wallet\` - Dirección de cobro oficial en Base
• \`/info\` - Protocolo x402 y facilitador

🌐 *Portal Web3:* [Abrir Monexa Portal](${monexaUrl}/portal)
`;
    await sendMessage(chatId, welcome);
    return;
  }

  if (text === "/servicios") {
    const catalog = `📋 *Catálogo de Servicios Monexa (x402 en Base)*

1. 🛡️ *Auditoría de Smart Contracts*
   • Precio: $0.10 USDC
   • Solidity, seguridad, reentrancy, control de acceso.

2. 🧪 *Generador de Tests Unitarios*
   • Precio: $0.05 USDC
   • Jest, Mocha, Vitest, PyTest.

3. 🔍 *Revisión de Código*
   • Precio: $0.05 USDC
   • Hallazgos con severidad y veredicto.

4. 📊 *Extracción JSON Estructurada*
   • Precio: $0.02 USDC

5. ⚡ *Inferencia LLM Gateway*
   • Precio: $0.01 USDC

6. 📝 *Resumen Ejecutivo*
   • Precio: $0.01 USDC

7. 🌐 *Traducción Técnica*
   • Precio: $0.01 USDC

👉 *Prueba y ejecuta directamente en:*
${monexaUrl}/portal
`;
    await sendMessage(chatId, catalog);
    return;
  }

  if (text === "/portal") {
    await sendMessage(chatId, `🌐 *Playground Web3 y Documentación de APIs:*\n${monexaUrl}/portal\n\nConecta tu MetaMask o Coinbase Wallet en Base para pagar y ejecutar servicios.`);
    return;
  }

  if (text === "/wallet") {
    await sendMessage(chatId, `🏦 *Dirección de cobro de Monexa en Base (USDC):*\n\`${payTo}\`\n\nRed: *Base Mainnet (EIP-155:8453)*\nContrato USDC: \`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\``);
    return;
  }

  if (text === "/info") {
    await sendMessage(chatId, `ℹ️ *Monexa Protocolo x402*
• Protocolo: HTTP 402 v2
• Red: Base Mainnet
• Facilitador: PayAI Network (EIP-3009 gasless authorization)
• Sin claves privadas en servidor (100% no-custodial)`);
    return;
  }

  await sendMessage(chatId, `Comando no reconocido. Escribe \`/servicios\` o visita el portal en:\n${monexaUrl}/portal`);
}

poll();
