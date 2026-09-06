import { ethers } from "ethers";
import { BASE_TOKENS } from "./market.js";

// Direcciones canónicas en la red Base (EIP-155:8453)
export const BASE_CHAIN_ID = 8453;
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // 6 decimales
export const BASE_WETH = "0x4200000000000000000000000000000000000006"; // 18 decimales
export const UNISWAP_V3_ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481"; // SwapRouter02

// Configuración de pool fees de Uniswap v3 por par
export const TOKEN_FEES = {
  "AERO-USD": 3000,    // 0.3%
  "VIRTUAL-USD": 10000, // 1.0% (pool principal de liquidez en Base)
  "ETH-USD": 500,      // 0.05%
  "BTC-USD": 500       // 0.05%
};

// ABIs mínimas para interactuar con tokens y el SwapRouter de Uniswap
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)"
];

const SWAP_ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)"
];

/**
 * Crea el ejecutor on-chain de swaps sobre Uniswap v3 en Base.
 */
export function createOnChainSwapper({
  privateKey = "",
  rpcUrl = "https://mainnet.base.org",
  maxOrderUsd = 15,
  minEthGas = 0.0003,
  slippagePct = 0.015 // 1.5% slippage máximo
} = {}) {
  let provider = null;
  let wallet = null;

  try {
    provider = new ethers.JsonRpcProvider(rpcUrl, {
      chainId: BASE_CHAIN_ID,
      name: "base"
    });
  } catch (err) {
    console.error("[Swapper] Error inicializando JsonRpcProvider:", err.message);
  }

  const cleanKey = (privateKey || "").trim();
  if (cleanKey && cleanKey.startsWith("0x") && cleanKey.length === 66 && provider) {
    try {
      wallet = new ethers.Wallet(cleanKey, provider);
      console.log(`[Swapper] Hot Wallet lista en Base: ${wallet.address}`);
    } catch (err) {
      console.error("[Swapper] Error instanciando Wallet:", err.message);
    }
  }

  function isConfigured() {
    return Boolean(wallet && provider);
  }

  function getAddress() {
    return wallet?.address || null;
  }

  let cachedBalances = {
    configured: Boolean(wallet),
    address: wallet ? wallet.address : null,
    ethBalance: 0,
    usdcBalance: 0,
    canTrade: false,
    statusText: wallet ? "Consultando saldos on-chain..." : "Sin clave privada (TRADER_PRIVATE_KEY) configurada en .env",
    checkedAt: null
  };

  /**
   * Consulta los saldos de ETH y USDC de la wallet en Base y actualiza el caché.
   */
  async function getWalletBalances() {
    if (!wallet) {
      cachedBalances = {
        configured: false,
        address: null,
        ethBalance: 0,
        usdcBalance: 0,
        canTrade: false,
        statusText: "Sin clave privada (TRADER_PRIVATE_KEY) configurada en .env",
        checkedAt: new Date().toISOString()
      };
      return cachedBalances;
    }

    try {
      const [ethBalRaw, usdcContract] = await Promise.all([
        provider.getBalance(wallet.address),
        new ethers.Contract(BASE_USDC, ERC20_ABI, provider)
      ]);

      const ethBalance = Number(ethers.formatEther(ethBalRaw));
      const usdcBalRaw = await usdcContract.balanceOf(wallet.address);
      const usdcBalance = Number(ethers.formatUnits(usdcBalRaw, 6));

      const hasGas = ethBalance >= minEthGas;
      const hasCapital = usdcBalance >= 1; // al menos 1 USDC
      const canTrade = hasGas && hasCapital;

      let statusText = "🟢 Hot Wallet lista para operar on-chain";
      if (!hasGas && !hasCapital) statusText = "🟡 Falta fondear ETH (gas) y USDC en Base";
      else if (!hasGas) statusText = `🟡 ETH insuficiente para gas (mínimo ${minEthGas} ETH)`;
      else if (!hasCapital) statusText = "🟡 USDC insuficiente en Base (mínimo 1 USDC)";

      cachedBalances = {
        configured: true,
        address: wallet.address,
        ethBalance: Number(ethBalance.toFixed(5)),
        usdcBalance: Number(usdcBalance.toFixed(2)),
        canTrade,
        statusText,
        checkedAt: new Date().toISOString()
      };
      return cachedBalances;
    } catch (error) {
      cachedBalances = {
        configured: true,
        address: wallet.address,
        ethBalance: 0,
        usdcBalance: 0,
        canTrade: false,
        statusText: `Error consultando RPC Base: ${error.message}`,
        checkedAt: new Date().toISOString()
      };
      return cachedBalances;
    }
  }

  function getLastBalances() {
    return cachedBalances;
  }

  if (wallet) {
    // Consulta inicial en segundo plano
    getWalletBalances().catch(() => {});
  }

  /**
   * Verifica allowance y aprueba el token para el SwapRouter si es necesario.
   */
  async function ensureApproval(tokenAddress, amountWei) {
    if (!wallet) throw new Error("Wallet no configurada");
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
    const allowance = await token.allowance(wallet.address, UNISWAP_V3_ROUTER);
    if (allowance < amountWei) {
      console.log(`[Swapper] Aprobando ${tokenAddress} para Uniswap v3 Router...`);
      const tx = await token.approve(UNISWAP_V3_ROUTER, ethers.MaxUint256);
      await tx.wait(1);
      console.log(`[Swapper] Aprobación confirmada tx: ${tx.hash}`);
    }
  }

  /**
   * Compra tokens en Uniswap v3 entregando USDC (exactInputSingle).
   */
  async function executeBuy({ product, usdAmount, currentPrice }) {
    if (!wallet) throw new Error("TRADER_PRIVATE_KEY no configurada");
    const tokenInfo = BASE_TOKENS[product];
    if (!tokenInfo || !tokenInfo.address) {
      throw new Error(`Token no soportado para swap en Base: ${product}`);
    }

    const tradeUsd = Math.min(usdAmount, maxOrderUsd);
    if (tradeUsd < 1) throw new Error("El monto mínimo de operación es $1.00 USD");

    const balances = await getWalletBalances();
    if (!balances.canTrade) throw new Error(balances.statusText);
    if (balances.usdcBalance < tradeUsd) {
      throw new Error(`Saldo USDC insuficiente: tienes $${balances.usdcBalance} USDC, requerido $${tradeUsd}`);
    }

    const amountInWei = ethers.parseUnits(tradeUsd.toFixed(6), 6);
    const tokenDecimals = product === "BTC-USD" ? 8 : 18;
    const tokenOutAddress = product === "ETH-USD" ? BASE_WETH : tokenInfo.address;
    const fee = TOKEN_FEES[product] || 3000;

    // Calcular mínimo a recibir aplicando slippage protection
    const expectedTokens = tradeUsd / currentPrice;
    const minTokens = expectedTokens * (1 - slippagePct);
    const minAmountOutWei = ethers.parseUnits(minTokens.toFixed(tokenDecimals > 8 ? 6 : tokenDecimals), tokenDecimals);

    // 1. Aprobar USDC si hace falta
    await ensureApproval(BASE_USDC, amountInWei);

    // 2. Ejecutar swap
    const router = new ethers.Contract(UNISWAP_V3_ROUTER, SWAP_ROUTER_ABI, wallet);
    const params = {
      tokenIn: BASE_USDC,
      tokenOut: tokenOutAddress,
      fee,
      recipient: wallet.address,
      amountIn: amountInWei,
      amountOutMinimum: minAmountOutWei,
      sqrtPriceLimitX96: 0
    };

    console.log(`[Swapper] Ejecutando compra on-chain: $${tradeUsd} USDC -> ${product} en Uniswap v3 Base...`);
    const tx = await router.exactInputSingle(params);
    const receipt = await tx.wait(1);

    const basescanUrl = `https://basescan.org/tx/${receipt.hash}`;
    console.log(`[Swapper] Compra exitosa en bloque ${receipt.blockNumber}: ${basescanUrl}`);

    return {
      ok: true,
      action: "buy",
      product,
      txHash: receipt.hash,
      basescanUrl,
      blockNumber: receipt.blockNumber,
      amountInUsd: tradeUsd,
      estimatedTokens: expectedTokens,
      tokenAddress: tokenOutAddress,
      tokenDecimals,
      fillPrice: currentPrice,
      executedAt: new Date().toISOString()
    };
  }

  /**
   * Vende tokens en Uniswap v3 recibiendo USDC (exactInputSingle).
   */
  async function executeSell({ product, tokenAmount, currentPrice }) {
    if (!wallet) throw new Error("TRADER_PRIVATE_KEY no configurada");
    const tokenInfo = BASE_TOKENS[product];
    if (!tokenInfo || !tokenInfo.address) {
      throw new Error(`Token no soportado para swap en Base: ${product}`);
    }

    const tokenDecimals = product === "BTC-USD" ? 8 : 18;
    const tokenInAddress = product === "ETH-USD" ? BASE_WETH : tokenInfo.address;
    const fee = TOKEN_FEES[product] || 3000;

    const tokenContract = new ethers.Contract(tokenInAddress, ERC20_ABI, wallet);
    const actualBalWei = await tokenContract.balanceOf(wallet.address);
    const amountInWei = tokenAmount
      ? ethers.parseUnits(tokenAmount.toFixed(tokenDecimals > 8 ? 6 : tokenDecimals), tokenDecimals)
      : actualBalWei;

    if (amountInWei <= 0n) throw new Error(`Sin balance de ${product} para vender`);

    const expectedUsd = (Number(ethers.formatUnits(amountInWei, tokenDecimals))) * currentPrice;
    const minUsd = expectedUsd * (1 - slippagePct);
    const minAmountOutWei = ethers.parseUnits(Math.max(0.1, minUsd).toFixed(6), 6);

    // 1. Aprobar token si hace falta
    await ensureApproval(tokenInAddress, amountInWei);

    // 2. Ejecutar swap a USDC
    const router = new ethers.Contract(UNISWAP_V3_ROUTER, SWAP_ROUTER_ABI, wallet);
    const params = {
      tokenIn: tokenInAddress,
      tokenOut: BASE_USDC,
      fee,
      recipient: wallet.address,
      amountIn: amountInWei,
      amountOutMinimum: minAmountOutWei,
      sqrtPriceLimitX96: 0
    };

    console.log(`[Swapper] Ejecutando venta on-chain: ${product} -> USDC en Uniswap v3 Base...`);
    const tx = await router.exactInputSingle(params);
    const receipt = await tx.wait(1);

    const basescanUrl = `https://basescan.org/tx/${receipt.hash}`;
    console.log(`[Swapper] Venta exitosa en bloque ${receipt.blockNumber}: ${basescanUrl}`);

    return {
      ok: true,
      action: "sell",
      product,
      txHash: receipt.hash,
      basescanUrl,
      blockNumber: receipt.blockNumber,
      tokenAmountSold: Number(ethers.formatUnits(amountInWei, tokenDecimals)),
      estimatedUsdReceived: expectedUsd,
      fillPrice: currentPrice,
      executedAt: new Date().toISOString()
    };
  }

  return {
    isConfigured,
    getAddress,
    getWalletBalances,
    getLastBalances,
    executeBuy,
    executeSell,
    BASE_CHAIN_ID,
    BASE_USDC,
    UNISWAP_V3_ROUTER
  };
}
