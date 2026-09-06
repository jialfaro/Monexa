import { ethers } from "ethers";

console.log("\n=======================================================");
console.log("   GENERADOR DE HOT WALLET PARA MONEXA TRADER BOT");
console.log("=======================================================\n");

const wallet = ethers.Wallet.createRandom();

console.log("📍 DIRECCIÓN PÚBLICA (Donde debes enviar los fondos en Base):");
console.log(`   ${wallet.address}\n`);

console.log("🔑 CLAVE PRIVADA (Pon esto en tu archivo .env):");
console.log(`   TRADER_PRIVATE_KEY=${wallet.privateKey}\n`);

console.log("-------------------------------------------------------");
console.log("PASOS A SEGUIR:");
console.log("1. Abre tu archivo .env y pega la línea:");
console.log(`   TRADER_PRIVATE_KEY=${wallet.privateKey}`);
console.log("2. Desde tu exchange (Binance, Coinbase, OKX) o MetaMask,");
console.log("   transfiere a la dirección pública (en RED BASE):");
console.log("   - $10 a $20 USDC (para operar swaps)");
console.log("   - $1 a $2 en ETH (para las comisiones de gas)");
console.log("3. Reinicia tu servidor o entra al dashboard de Monexa.");
console.log("=======================================================\n");
