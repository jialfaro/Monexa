// Monexa Portal & Web3 Playground Client
import { cyberNotify } from "./cyber-dialog.js";

let connectedAccount = null;
let currentChainId = null;
let currentService = "smart-contract-audit";

const BASE_CHAIN_ID_HEX = "0x2105"; // 8453
const BASE_CHAIN_ID_DEC = 8453;

const EXAMPLES = {
  "smart-contract-audit": {
    1: JSON.stringify({
      contract: `pragma solidity ^0.8.0;

contract VulnerableBank {
    mapping(address => uint256) public balances;

    function deposit() external payable {
        balances[msg.sender] += msg.value;
    }

    function withdraw() external {
        uint256 bal = balances[msg.sender];
        require(bal > 0, "No funds");
        
        // VULNERABILIDAD: Reentrancy clásica (llamada externa antes de actualizar saldo)
        (bool sent, ) = msg.sender.call{value: bal}("");
        require(sent, "Failed to send");
        
        balances[msg.sender] = 0;
    }
}`,
      language: "solidity"
    }, null, 2),
    2: JSON.stringify({
      contract: `pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract SafeVault is ReentrancyGuard {
    mapping(address => uint256) private _balances;

    function deposit() external payable {
        _balances[msg.sender] += msg.value;
    }

    function withdraw() external nonReentrant {
        uint256 amount = _balances[msg.sender];
        require(amount > 0, "No balance");
        _balances[msg.sender] = 0;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "Transfer failed");
    }
}`,
      language: "solidity"
    }, null, 2)
  },
  "unit-test-gen": {
    1: JSON.stringify({
      code: `function calculateSlippage(amountIn, reserveIn, reserveOut) {
  if (amountIn <= 0n) throw new Error("Amount must be positive");
  const amountInWithFee = amountIn * 997n;
  const numerator = amountInWithFee * reserveOut;
  const denominator = (reserveIn * 1000n) + amountInWithFee;
  return numerator / denominator;
}`,
      framework: "jest"
    }, null, 2),
    2: JSON.stringify({
      code: `export async function verifySignature(message, signature, expectedSigner) {
  const recovered = ethers.verifyMessage(message, signature);
  return recovered.toLowerCase() === expectedSigner.toLowerCase();
}`,
      framework: "vitest"
    }, null, 2)
  },
  "code-review": {
    1: JSON.stringify({
      code: `app.get("/users", async (req, res) => {
  const query = "SELECT * FROM users WHERE role = '" + req.query.role + "'";
  const results = await db.raw(query);
  res.json(results);
});`,
      language: "javascript"
    }, null, 2),
    2: JSON.stringify({
      code: `export function sanitizeInput(str) {
  return str.replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&#39;', '"': '&quot;'
  }[c]));
}`,
      language: "javascript"
    }, null, 2)
  },
  "extract-json": {
    1: JSON.stringify({
      text: "Factura N° 8492 de Acme Corp emitida a DAO Labs por $1,450.00 USDC con fecha 2026-09-04 para auditoría de smart contracts.",
      schema: {
        type: "object",
        properties: {
          invoiceNumber: { type: "string" },
          vendor: { type: "string" },
          client: { type: "string" },
          totalAmount: { type: "number" },
          currency: { type: "string" },
          date: { type: "string" }
        }
      }
    }, null, 2),
    2: JSON.stringify({
      text: "Alexis reportó un bug de severidad crítica en el módulo de pagos x402 a las 14:30 hs. Estado: resuelto.",
      schema: {
        type: "object",
        properties: {
          reporter: { type: "string" },
          severity: { type: "string" },
          module: { type: "string" },
          status: { type: "string" }
        }
      }
    }, null, 2)
  },
  "ask": {
    1: JSON.stringify({
      prompt: "¿Cuáles son las 3 mejores prácticas para mitigar riesgos de reentrancy en contratos EVM en 2026?",
      system: "Responde como un auditor de seguridad senior Web3 en formato conciso."
    }, null, 2),
    2: JSON.stringify({
      prompt: "Explica en 2 párrafos cómo funciona el protocolo x402 sobre Base.",
      system: "Enfoque técnico para ingenieros de software."
    }, null, 2)
  },
  "summarize": {
    1: JSON.stringify({
      text: "Base es una red Layer 2 de Ethereum incubada por Coinbase, diseñada para ofrecer transacciones de ultra-bajo costo y alta seguridad respaldada por la red principal de Ethereum. Al utilizar OP Stack, Base permite a desarrolladores implementar contratos EVM estándar con tiempos de confirmación inferiores a 2 segundos y tarifas de gas de fracciones de centavo, haciéndola la red ideal para micropagos autónomos de agentes de IA.",
      language: "es"
    }, null, 2),
    2: JSON.stringify({
      text: "The x402 protocol revives the HTTP 402 status code to enable native, frictionless micropayments on the web. Instead of subscribing or generating credit card API keys, clients sign an EIP-3009 transfer authorization and receive immediate API access upon verified on-chain settlement.",
      language: "en"
    }, null, 2)
  },
  "translate": {
    1: JSON.stringify({
      text: "We have submitted 2 autonomous pull requests with verified test suites to open source repositories.",
      to: "es"
    }, null, 2),
    2: JSON.stringify({
      text: "El agente de Monexa ha verificado la liquidación del pago en Base y devuelto los hallazgos de seguridad.",
      to: "en"
    }, null, 2)
  }
};

const PRICES = {
  "smart-contract-audit": "0.10 USDC",
  "unit-test-gen": "0.05 USDC",
  "code-review": "0.05 USDC",
  "extract-json": "0.02 USDC",
  "ask": "0.01 USDC",
  "summarize": "0.01 USDC",
  "translate": "0.01 USDC"
};

// Initialization
document.addEventListener("DOMContentLoaded", () => {
  setupEventListeners();
  loadService(currentService);
  checkWalletConnection();
  fetchCatalogMetadata();
});

function setupEventListeners() {
  document.getElementById("btn-connect-wallet").addEventListener("click", connectWallet);
}

// Fetch live catalog from server
async function fetchCatalogMetadata() {
  try {
    const res = await fetch("/.well-known/x402");
    if (res.ok) {
      const data = await res.json();
      console.log("Catálogo en vivo x402:", data);
    }
  } catch (err) {
    console.log("Modo standalone");
  }
}

// Service switching
function onServiceChange(slug) {
  loadService(slug);
}

function selectService(slug) {
  document.getElementById("service-selector").value = slug;
  loadService(slug);
  document.getElementById("playground").scrollIntoView({ behavior: "smooth" });
}

function loadService(slug) {
  currentService = slug;
  const costDisplay = document.getElementById("service-cost-display");
  if (costDisplay && PRICES[slug]) {
    costDisplay.textContent = PRICES[slug];
  }
  loadExample(1);
  updateDocsSnippets(slug);
}

function loadExample(index) {
  const textarea = document.getElementById("payload-input");
  if (EXAMPLES[currentService] && EXAMPLES[currentService][index]) {
    textarea.value = EXAMPLES[currentService][index];
  }
}

// Web3 Wallet
async function checkWalletConnection() {
  if (typeof window.ethereum !== "undefined") {
    try {
      const accounts = await window.ethereum.request({ method: "eth_accounts" });
      if (accounts && accounts.length > 0) {
        setConnected(accounts[0]);
      }
      window.ethereum.on("accountsChanged", (accs) => {
        if (accs.length > 0) setConnected(accs[0]);
        else setDisconnected();
      });
      window.ethereum.on("chainChanged", (chain) => {
        currentChainId = chain;
      });
    } catch (e) {
      console.error(e);
    }
  }
}

async function connectWallet() {
  if (typeof window.ethereum === "undefined") {
    cyberNotify("No se detectó billetera Web3 (MetaMask / Coinbase Wallet). Instala una extensión compatible.", {
      type: "warn",
      title: "Billetera Web3 Requerida"
    });
    return;
  }
  try {
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    if (accounts && accounts.length > 0) {
      await ensureBaseNetwork();
      setConnected(accounts[0]);
    }
  } catch (err) {
    showStatus("Error al conectar billetera: " + err.message, "error");
  }
}

async function ensureBaseNetwork() {
  const chainId = await window.ethereum.request({ method: "eth_chainId" });
  currentChainId = chainId;
  if (parseInt(chainId, 16) !== BASE_CHAIN_ID_DEC) {
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: BASE_CHAIN_ID_HEX }]
      });
    } catch (switchError) {
      if (switchError.code === 4902) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: BASE_CHAIN_ID_HEX,
            chainName: "Base",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://mainnet.base.org"],
            blockExplorerUrls: ["https://basescan.org"]
          }]
        });
      } else {
        throw switchError;
      }
    }
  }
}

function setConnected(address) {
  connectedAccount = address;
  const btn = document.getElementById("btn-connect-wallet");
  const text = document.getElementById("wallet-btn-text");
  btn.classList.add("btn-outline");
  btn.classList.remove("btn-primary");
  text.textContent = `${address.slice(0, 6)}...${address.slice(-4)}`;
  showStatus(`Billetera conectada en Base: ${address}`, "info");
}

function setDisconnected() {
  connectedAccount = null;
  const btn = document.getElementById("btn-connect-wallet");
  const text = document.getElementById("wallet-btn-text");
  btn.classList.remove("btn-outline");
  btn.classList.add("btn-primary");
  text.textContent = "Conectar Wallet";
}

// Generate random bytes32 for EIP-3009 nonce
function randomBytes32() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return "0x" + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Base64 helper
function base64Encode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function base64Decode(str) {
  return decodeURIComponent(escape(atob(str)));
}

// 402 Challenge Fetcher
async function fetch402Challenge() {
  const output = document.getElementById("output-display");
  const statusMsg = document.getElementById("execution-status-msg");
  let inputData = {};
  try {
    inputData = JSON.parse(document.getElementById("payload-input").value);
  } catch (e) {
    showStatus("JSON de entrada inválido", "error");
    return;
  }

  showStatus("Consultando desafío HTTP 402 al servidor...", "info");
  try {
    const res = await fetch(`/x402/${currentService}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(inputData)
    });

    const statusHeader = res.headers.get("PAYMENT-REQUIRED");
    const jsonBody = await res.json();
    output.textContent = JSON.stringify({
      httpStatus: res.status,
      statusText: "402 Payment Required (Protocolo x402 v2)",
      paymentRequiredHeader: statusHeader ? JSON.parse(base64Decode(statusHeader)) : null,
      responseBody: jsonBody
    }, null, 2);
    showStatus("Desafío 402 recibido. El servidor solicita autorización EIP-3009 en Base.", "info");
  } catch (err) {
    showStatus("Error al contactar servicio: " + err.message, "error");
  }
}

// Execute Service Call
async function executeServiceCall() {
  const output = document.getElementById("output-display");
  const loading = document.getElementById("output-loading");
  const loadingText = document.getElementById("loading-step-text");
  let inputData;

  try {
    inputData = JSON.parse(document.getElementById("payload-input").value);
  } catch (e) {
    showStatus("Error en JSON de entrada: " + e.message, "error");
    return;
  }

  if (!connectedAccount) {
    showStatus("Conecta tu billetera (MetaMask / Coinbase) para firmar el pago de " + (PRICES[currentService] || "USDC") + " en Base.", "info");
    await connectWallet();
    if (!connectedAccount) return;
  }

  try {
    await ensureBaseNetwork();
  } catch (e) {
    showStatus("Por favor cambia la red a Base Mainnet.", "error");
    return;
  }

  loading.classList.remove("hidden");
  output.classList.add("hidden");
  loadingText.textContent = "1/3 Solicitando desafío HTTP 402 a Monexa...";

  try {
    // Paso 1: Petición sin pago para obtener requerimientos
    const challengeRes = await fetch(`/x402/${currentService}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(inputData)
    });

    if (challengeRes.status !== 402) {
      throw new Error("El servidor respondió con código inesperado: " + challengeRes.status);
    }

    const reqHeader = challengeRes.headers.get("PAYMENT-REQUIRED");
    if (!reqHeader) throw new Error("No se recibió la cabecera PAYMENT-REQUIRED");
    const requirements = JSON.parse(base64Decode(reqHeader));
    const requirement = requirements.accepts[0];

    loadingText.textContent = `2/3 Firmando autorización EIP-3009 de ${(parseInt(requirement.amount)/1e6).toFixed(2)} USDC...`;

    // Paso 2: Construir mensaje EIP-712 TransferWithAuthorization
    const now = Math.floor(Date.now() / 1000);
    const validAfter = 0;
    const validBefore = now + (requirement.maxTimeoutSeconds || 3600);
    const nonce = randomBytes32();

    const typedData = {
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" }
        ],
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" }
        ]
      },
      primaryType: "TransferWithAuthorization",
      domain: {
        name: "USD Coin",
        version: "2",
        chainId: BASE_CHAIN_ID_DEC,
        verifyingContract: requirement.asset // 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
      },
      message: {
        from: connectedAccount,
        to: requirement.payTo,
        value: requirement.amount,
        validAfter: validAfter,
        validBefore: validBefore,
        nonce: nonce
      }
    };

    // Solicitar firma a la billetera (gasless para el usuario, liquidado por facilitador)
    const signature = await window.ethereum.request({
      method: "eth_signTypedData_v4",
      params: [connectedAccount, JSON.stringify(typedData)]
    });

    loadingText.textContent = "3/3 Liquidando con facilitador PayAI y ejecutando IA...";

    // Paso 3: Construir payload x402 v2
    const paymentPayload = {
      x402Version: 2,
      accepted: requirement,
      payload: {
        authorization: {
          from: connectedAccount,
          to: requirement.payTo,
          value: requirement.amount,
          validAfter: validAfter,
          validBefore: validBefore,
          nonce: nonce
        },
        signature: signature
      }
    };

    const signatureHeader = base64Encode(JSON.stringify(paymentPayload));

    // Paso 4: Enviar petición pagada
    const paidRes = await fetch(`/x402/${currentService}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "PAYMENT-SIGNATURE": signatureHeader
      },
      body: JSON.stringify(inputData)
    });

    const resultJson = await paidRes.json();
    loading.classList.add("hidden");
    output.classList.remove("hidden");

    if (paidRes.status === 200) {
      showStatus("✅ ¡Pago verificado y servicio ejecutado con éxito!", "success");
      const settlementHeader = paidRes.headers.get("PAYMENT-RESPONSE");
      output.textContent = JSON.stringify({
        status: 200,
        service: currentService,
        payer: connectedAccount,
        settlement: settlementHeader ? JSON.parse(base64Decode(settlementHeader)) : "Verificado",
        result: resultJson
      }, null, 2);
    } else {
      showStatus(`Fallo en verificación (${paidRes.status}): ${resultJson.error || "Pago no procesado"}`, "error");
      output.textContent = JSON.stringify(resultJson, null, 2);
    }

  } catch (err) {
    loading.classList.add("hidden");
    output.classList.remove("hidden");
    showStatus("Error: " + err.message, "error");
    output.textContent = JSON.stringify({ error: err.message }, null, 2);
  }
}

function showStatus(text, type = "info") {
  const msg = document.getElementById("execution-status-msg");
  msg.className = `status-msg ${type}`;
  msg.textContent = text;
  msg.classList.remove("hidden");
}

function copyOutput() {
  const text = document.getElementById("output-display").textContent;
  navigator.clipboard.writeText(text);
  cyberNotify("Respuesta copiada al portapapeles.", { type: "success", icon: "📋" });
}

function copyDocSnippet(id) {
  const text = document.getElementById(id).textContent;
  navigator.clipboard.writeText(text);
  cyberNotify("Snippet de código copiado.", { type: "success", icon: "📋" });
}

// Documentation tabs
function showDocTab(tabName) {
  document.querySelectorAll(".tab-btn").forEach(btn => btn.classList.remove("active"));
  document.querySelectorAll(".doc-tab-pane").forEach(pane => pane.classList.remove("active"));
  
  const currentTabBtn = Array.from(document.querySelectorAll(".tab-btn")).find(b => b.getAttribute("onclick")?.includes(tabName));
  if (currentTabBtn) currentTabBtn.classList.add("active");
  
  const pane = document.getElementById(`tab-${tabName}`);
  if (pane) pane.classList.add("active");
}

function updateDocsSnippets(slug) {
  const curlCode = document.getElementById("snippet-curl");
  if (curlCode) {
    const host = window.location.origin;
    curlCode.textContent = `# 1. Petición inicial (HTTP 402 con requisitos de pago en Base)
curl -i -X POST ${host}/x402/${slug} \\
  -H "Content-Type: application/json" \\
  -d '${EXAMPLES[slug] ? EXAMPLES[slug][1].replace(/\n/g, ' ').replace(/\s+/g, ' ') : '{}'}'

# 2. Petición con firma de autorización (HTTP 200 con resultado verificado)
curl -X POST ${host}/x402/${slug} \\
  -H "Content-Type: application/json" \\
  -H "PAYMENT-SIGNATURE: <PAYMENT_PAYLOAD_BASE64>" \\
  -d '${EXAMPLES[slug] ? EXAMPLES[slug][1].replace(/\n/g, ' ').replace(/\s+/g, ' ') : '{}'}'`;
  }
}

// Exponer funciones globales para atributos onclick de HTML
window.selectService = selectService;
window.loadExample = loadExample;
window.executeServiceCall = executeServiceCall;
window.copyOutput = copyOutput;
window.fetch402Challenge = fetch402Challenge;
window.showDocTab = showDocTab;
window.copyDocSnippet = copyDocSnippet;
