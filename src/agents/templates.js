import { getSkillsForTemplate } from "../skills/definitions.js";

/**
 * Plantillas de agente. Las capacidades son exactas y no se heredan: un hijo sólo tiene lo que su plantilla declara.
 * Ninguna plantilla puede firmar, transferir, leer secretos ni ejecutar código descargado.
 */
export const TEMPLATES = {
  manager: {
    label: "Manager",
    description: "Orquesta el enjambre: programa scouts, evalúa hallazgos, asigna workers, vigila cuotas y presupuesto.",
    capabilities: ["spawn:scout", "spawn:evaluator", "spawn:worker", "spawn:seller", "spawn:reconciler", "read:store"],
    skills: ["karpathy-precision", "gstack-cso-security"],
    longLived: true,
    spawnable: ["scout", "evaluator", "worker", "seller", "reconciler"]
  },
  scout: {
    label: "Scout",
    description: "Explora fuentes permitidas (GitHub, Bazaar x402, feeds) y registra oportunidades con evidencia.",
    capabilities: ["net:read-allowlist", "write:opportunities"],
    skills: ["escrow-radar-scanner"],
    longLived: false,
    spawnable: []
  },
  evaluator: {
    label: "Evaluador",
    description: "Puntúa oportunidades por recompensa, viabilidad y riesgo; descarta las que exigen KYC, wallet o código ajeno.",
    capabilities: ["llm:scout-model", "read:store", "write:opportunities"],
    skills: ["honeypot-slop-detector"],
    longLived: false,
    spawnable: []
  },
  worker: {
    label: "Worker",
    description: "Ejecuta un bounty: lee el repositorio, produce el cambio con Claude, pide revisión a un hijo y envía el PR.",
    capabilities: ["llm:worker-model", "net:github-read", "write:jobs", "spawn:reviewer", "github:pr"],
    skills: ["karpathy-precision", "gstack-cso-security", "bounty-pr-architect", "smart-contract-auditor", "pixel-art-generative", "jsdoc-typescript-cleaner"],
    longLived: false,
    spawnable: ["reviewer"]
  },
  reviewer: {
    label: "Revisor",
    description: "Hijo del worker: revisa el entregable antes del envío y devuelve un veredicto.",
    capabilities: ["llm:worker-model", "read:jobs"],
    skills: ["gstack-qa-verifier", "gstack-cso-security"],
    longLived: false,
    spawnable: []
  },
  seller: {
    label: "Vendedor x402",
    description: "Publica servicios de pago por llamada (USDC vía x402) y registra cada cobro liquidado.",
    capabilities: ["llm:worker-model", "x402:serve", "write:ledger"],
    skills: ["x402-eip3009-settlement", "smart-contract-auditor"],
    longLived: true,
    spawnable: []
  },
  trader: {
    label: "Trader",
    description: "Manager de trading: analiza mercados en Base, consulta estrategias algorítmicas, valida gestión de riesgo y emite órdenes reales para DEX.",
    capabilities: ["spawn:market-scout", "spawn:strategy-analyst", "spawn:risk-manager", "spawn:paper-executor", "read:store"],
    skills: ["momentum-breakout-strategy", "circuit-breaker-risk"],
    longLived: true,
    spawnable: ["market-scout", "strategy-analyst", "risk-manager", "paper-executor"]
  },
  "market-scout": {
    label: "Scout de mercado",
    description: "Lee precios y velas reales de la API pública de Coinbase para la lista de vigilancia.",
    capabilities: ["net:read-allowlist", "write:trading"],
    skills: ["momentum-breakout-strategy"],
    longLived: false,
    spawnable: []
  },
  "strategy-analyst": {
    label: "Analista de estrategia",
    description: "Aplica una estrategia determinista (tendencia, reversión o ruptura) y emite señales con fuerza y motivo.",
    capabilities: ["read:trading", "write:signals"],
    skills: ["momentum-breakout-strategy"],
    longLived: false,
    spawnable: []
  },
  "risk-manager": {
    label: "Gestor de riesgo",
    description: "Aprueba o rechaza señales según pérdida diaria, tamaño, exposición y fuerza; fija el tamaño de cada orden.",
    capabilities: ["read:trading", "write:signals"],
    skills: ["circuit-breaker-risk"],
    longLived: false,
    spawnable: []
  },
  "paper-executor": {
    label: "Ejecutor DEX On-Chain",
    description: "Ejecuta y verifica órdenes con dinero real en DEX (Uniswap v3 / Aerodrome en Base), gestiona stops y liquida en ledger.",
    capabilities: ["read:trading", "write:trades"],
    skills: ["circuit-breaker-risk"],
    longLived: false,
    spawnable: []
  },
  reconciler: {
    label: "Conciliador",
    description: "Lee la cadena (sólo consulta) y concilia transferencias USDC recibidas con trabajos y ventas.",
    capabilities: ["chain:read", "write:ledger"],
    skills: ["x402-eip3009-settlement"],
    longLived: false,
    spawnable: []
  }
};

export const FORBIDDEN_CAPABILITIES = ["wallet:sign", "wallet:transfer", "secret:read", "shell", "exec:foreign-code"];
