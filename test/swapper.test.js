import test from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { createOnChainSwapper } from "../src/trading/swapper.js";

test("swapper: sin clave privada se inicia en modo seguro no-operable", async () => {
  const swapper = createOnChainSwapper({ privateKey: null });
  assert.equal(swapper.isConfigured(), false);
  assert.equal(swapper.getAddress(), null);

  const balances = await swapper.getWalletBalances();
  assert.equal(balances.configured, false);
  assert.equal(balances.canTrade, false);
  assert.match(balances.statusText, /Sin clave privada/);

  await assert.rejects(
    () => swapper.executeBuy({ product: "AERO-USD", usdAmount: 5, currentPrice: 0.8 }),
    /TRADER_PRIVATE_KEY no configurada/
  );

  await assert.rejects(
    () => swapper.executeSell({ product: "AERO-USD", tokenAmount: 10, currentPrice: 0.8 }),
    /TRADER_PRIVATE_KEY no configurada/
  );
});

test("swapper: con clave privada válida inicializa wallet y valida parámetros", async () => {
  const dummyWallet = ethers.Wallet.createRandom();
  const swapper = createOnChainSwapper({
    privateKey: dummyWallet.privateKey,
    maxOrderUsd: 10,
    slippageTolerancePct: 0.02
  });

  assert.equal(swapper.isConfigured(), true);
  assert.equal(swapper.getAddress(), dummyWallet.address);

  // Intentar comprar un producto no soportado debe rechazar
  await assert.rejects(
    () => swapper.executeBuy({ product: "UNKNOWN-USD", usdAmount: 5, currentPrice: 1 }),
    /Token no soportado para swap en Base/
  );

  // Monto menor a $1 USD debe rechazar
  await assert.rejects(
    () => swapper.executeBuy({ product: "AERO-USD", usdAmount: 0.5, currentPrice: 0.8 }),
    /El monto mínimo de operación es \$1.00 USD/
  );
});

test("swapper: constantes de red corresponden a Base y Uniswap v3 Router", () => {
  const swapper = createOnChainSwapper({});
  assert.equal(swapper.BASE_CHAIN_ID, 8453);
  assert.equal(swapper.BASE_USDC.toLowerCase(), "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913".toLowerCase());
  assert.equal(swapper.UNISWAP_V3_ROUTER.toLowerCase(), "0x2626664c2603336e57b271c5c0b26f421741e481".toLowerCase());
});
