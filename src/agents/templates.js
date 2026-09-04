/**
 * Plantillas de agente. Las capacidades son exactas y no se heredan: un hijo sólo tiene lo que su plantilla declara.
 * Ninguna plantilla puede firmar, transferir, leer secretos ni ejecutar código descargado.
 */
export const TEMPLATES = {
  manager: {
    label: "Manager",
    description: "Orquesta el enjambre: programa scouts, evalúa hallazgos, asigna workers, vigila cuotas y presupuesto.",
    capabilities: ["spawn:scout", "spawn:evaluator", "spawn:worker", "spawn:seller", "spawn:reconciler", "read:store"],
    longLived: true,
    spawnable: ["scout", "evaluator", "worker", "seller", "reconciler"]
  },
  scout: {
    label: "Scout",
    description: "Explora fuentes permitidas (GitHub, Bazaar x402, feeds) y registra oportunidades con evidencia.",
    capabilities: ["net:read-allowlist", "write:opportunities"],
    longLived: false,
    spawnable: []
  },
  evaluator: {
    label: "Evaluador",
    description: "Puntúa oportunidades por recompensa, viabilidad y riesgo; descarta las que exigen KYC, wallet o código ajeno.",
    capabilities: ["llm:scout-model", "read:store", "write:opportunities"],
    longLived: false,
    spawnable: []
  },
  worker: {
    label: "Worker",
    description: "Ejecuta un bounty: lee el repositorio, produce el cambio con Claude, pide revisión a un hijo y envía el PR.",
    capabilities: ["llm:worker-model", "net:github-read", "write:jobs", "spawn:reviewer", "github:pr"],
    longLived: false,
    spawnable: ["reviewer"]
  },
  reviewer: {
    label: "Revisor",
    description: "Hijo del worker: revisa el entregable antes del envío y devuelve un veredicto.",
    capabilities: ["llm:worker-model", "read:jobs"],
    longLived: false,
    spawnable: []
  },
  seller: {
    label: "Vendedor x402",
    description: "Publica servicios de pago por llamada (USDC vía x402) y registra cada cobro liquidado.",
    capabilities: ["llm:worker-model", "x402:serve", "write:ledger"],
    longLived: true,
    spawnable: []
  },
  reconciler: {
    label: "Conciliador",
    description: "Lee la cadena (sólo consulta) y concilia transferencias USDC recibidas con trabajos y ventas.",
    capabilities: ["chain:read", "write:ledger"],
    longLived: false,
    spawnable: []
  }
};

export const FORBIDDEN_CAPABILITIES = ["wallet:sign", "wallet:transfer", "secret:read", "shell", "exec:foreign-code"];
