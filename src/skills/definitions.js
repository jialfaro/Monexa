/**
 * Catálogo de Habilidades (Skills) para los Agentes de Monexa.
 * Descargadas, adaptadas y estructuradas a partir de los mejores repositorios de GitHub:
 * - multica-ai/andrej-karpathy-skills (Andrej Karpathy - Pautas de precisión para LLMs)
 * - garrytan/gstack (Garry Tan - CSO Security, QA, Release Engineering)
 * - anthropics/claude-code (Habilidades nativas de ingeniería autónoma)
 * - Monexa Web3 & Algora Bounty Hunters (Especializaciones cripto y bounties)
 */

export const SKILLS_CATALOG = [
  // ==================== WORKER SKILLS ====================
  {
    id: "karpathy-precision",
    name: "Karpathy Precision Engineering",
    category: "coding",
    source: "github:multica-ai/andrej-karpathy-skills",
    stars: "210k+",
    assignedTemplates: ["worker"],
    summary: "Pautas de Andrej Karpathy para evitar fallos típicos de LLMs: cambios mínimos necesarios, sin código especulativo ni abstracciones prematuras.",
    promptInjection: `[SKILL: Karpathy Precision Engineering]
- Piensa antes de codificar: no asumas silently, explicita supuestos clave y busca la solución más simple posible.
- Simplicidad primero: entrega el código mínimo que resuelve el problema. CERO características especulativas, CERO abstracciones de un solo uso.
- Cero código defensivo innecesario para casos imposibles; no agregues complejidad innecesaria.
- Valida la compatibilidad de firmas y tipos antes de proponer el cambio.`,
    tags: ["karpathy", "clean-code", "surgical-diffs"]
  },
  {
    id: "gstack-cso-security",
    name: "GStack CSO Security Guardian",
    category: "security",
    source: "github:garrytan/gstack",
    stars: "131k+",
    assignedTemplates: ["worker", "reviewer"],
    summary: "Auditor de seguridad basado en el rol de Chief Security Officer de gstack: detección de inyecciones, fugas de secretos y vulnerabilidades lógicas.",
    promptInjection: `[SKILL: GStack CSO Security Guardian]
- CERO tolerancia a comandos destructivos ('rm -rf', 'DROP TABLE', scripts foráneos o shell sin sanitizar).
- Inspecciona cada archivo modificado para asegurar que NUNCA se introduzcan claves privadas, tokens, credenciales ni rutas absolutas de entorno local.
- Asegura sanitización estricta de entradas y previene fallos de seguridad comunes (CWE-89 SQLi, CWE-79 XSS, SSRF).`,
    tags: ["security", "cso", "audit", "gstack"]
  },
  {
    id: "bounty-pr-architect",
    name: "Bounty PR & Claim Architect",
    category: "bounty",
    source: "github:monexa/bounty-architect",
    stars: "Verified",
    assignedTemplates: ["worker"],
    summary: "Especialista en formato de Pull Requests para cobro automático en plataformas de bounties (Algora, Opire, Polar). Mapeo exacto de criterios de aceptación.",
    promptInjection: `[SKILL: Bounty PR & Claim Architect]
- Estructura el título y cuerpo del Pull Request para maximizar la tasa de merge y disparo de bots de cobro:
  - Incluye siempre '/claim #<issue_number>' y 'Closes #<issue_number>'.
  - Documenta un resumen ejecutivo de cambios conciso (2 a 3 viñetas).
  - Incluye evidencia de verificación (comandos ejecutados, tests pasados, salida determinista).
  - Si el repo exige checklist de agente o metadatos de modelo, complétalos al 100%.`,
    tags: ["bounty", "algora", "opire", "pr-automation"]
  },
  {
    id: "smart-contract-auditor",
    name: "EVM Smart Contract Security",
    category: "security",
    source: "github:crytic/slither",
    stars: "4.8k+",
    assignedTemplates: ["worker", "reviewer", "seller"],
    summary: "Análisis estático y heurístico de smart contracts Solidity: detección de reentrancy, control de accesos, desbordamientos y riesgos ERC-20/EIP-712.",
    promptInjection: `[SKILL: EVM Smart Contract Security]
- Revisa patrones de Check-Effects-Interactions para prevenir reentrancy attacks.
- Valida controles de acceso (Ownable, AccessControl, modifiers críticos en funciones de transferencia o minting).
- Verifica cálculos de slippage, decimales de USDC (6 decimales) y autorizaciones ERC-2612 / EIP-3009.`,
    tags: ["solidity", "evm", "base", "smart-contracts"]
  },
  {
    id: "pixel-art-generative",
    name: "Generative Pixel Art Engine",
    category: "creative",
    source: "github:monexa/generative-pixel-art",
    stars: "Verified",
    assignedTemplates: ["worker"],
    summary: "Generador determinista de arte pixelado (64x64 a 256x256) en PNG puro usando zlib y struct sin dependencias externas.",
    promptInjection: `[SKILL: Generative Pixel Art Engine]
- Cuando se soliciten activos visuales o pixel art, genera un script de Python puro sin dependencias (usando zlib y struct para compresión PNG).
- El código debe ser 100% reproducible byte por byte y crear arte de alta calidad con paleta coherente.`,
    tags: ["python", "pixel-art", "deterministic"]
  },
  {
    id: "jsdoc-typescript-cleaner",
    name: "TypeScript & JSDoc Precision Engine",
    category: "coding",
    source: "github:typescript-eslint/typescript-eslint",
    stars: "15k+",
    assignedTemplates: ["worker"],
    summary: "Especialista en modularización, anotaciones JSDoc completas (@param, @returns, @example) y compatibilidad estricta con TypeScript monorepos.",
    promptInjection: `[SKILL: TypeScript & JSDoc Precision Engine]
- Asegura contratos de tipos claros con interfaces exportadas.
- Documenta funciones con JSDoc conciso pero completo explicando comportamiento, entradas y salidas.
- Mantiene compatibilidad regresiva intacta en rutas y controladores existentes.`,
    tags: ["typescript", "jsdoc", "refactor"]
  },

  // ==================== SCOUT & EVALUATOR SKILLS ====================
  {
    id: "escrow-radar-scanner",
    name: "Verified Escrow Bounty Radar",
    category: "discovery",
    source: "github:algora-io/bounties",
    stars: "12k+",
    assignedTemplates: ["scout"],
    summary: "Escaner heurístico y GraphQL para detectar issues con escrow real garantizado por bots oficiales (Algora, Opire, Polar) descartando ofertas falsas.",
    promptInjection: `[SKILL: Verified Escrow Bounty Radar]
- Prioriza issues con pagadores verificados no falsificables (commenter:algora-pbc[bot], opire, polar-sh).
- Extrae importes exactos reconociendo notaciones $1k, $500, USDC, etc.
- Filtra repositorios con historial de cierre sin pago o comportamiento de spam.`,
    tags: ["scout", "escrow", "radar", "bounties"]
  },
  {
    id: "honeypot-slop-detector",
    name: "Honeypot & Slop Detector",
    category: "security",
    source: "github:anthropics/prompt-eng-interactive-tutorial",
    stars: "30k+",
    assignedTemplates: ["evaluator"],
    summary: "Filtro implacable contra repositorios trampa, solicitudes de claves privadas, enlaces con malware o tareas que requieren hardware físico inalcanzable.",
    promptInjection: `[SKILL: Honeypot & Slop Detector]
- Descarta de inmediato oportunidades con indicadores de riesgo: KYC, descargas de binarios desconocidos, peticiones de wallet seed phrase o servidores apagados.
- Puntuación de viabilidad: evalúa si el código puede ser modificado y probado de forma estática en cliente sin depender de infraestructura privada del autor.`,
    tags: ["evaluator", "honeypot", "risk-control"]
  },

  // ==================== REVIEWER SKILLS ====================
  {
    id: "gstack-qa-verifier",
    name: "GStack QA Diff Verifier",
    category: "qa",
    source: "github:garrytan/gstack",
    stars: "131k+",
    assignedTemplates: ["reviewer"],
    summary: "Simulador de QA estricto: analiza diffs de código línea por línea, verifica cobertura de aceptación y detecta regresiones antes del pull request.",
    promptInjection: `[SKILL: GStack QA Diff Verifier]
- Examina el diff generado: verifica sintaxis de lenguajes modificados, coherencia de importaciones y cumplimiento estricto del issue original.
- Rechaza entregables con archivos a medio terminar, placeholders tipo 'TODO' o funciones vacías.`,
    tags: ["reviewer", "qa", "diff-inspection"]
  },

  // ==================== TRADER SKILLS ====================
  {
    id: "momentum-breakout-strategy",
    name: "Momentum & Breakout Engine",
    category: "trading",
    source: "github:freqtrade/freqtrade",
    stars: "34k+",
    assignedTemplates: ["trader", "strategy-analyst"],
    summary: "Detección de rupturas de volatilidad, cruces EMA (9/21/50) y aceleración de volumen en mercados spot de Coinbase.",
    promptInjection: `[SKILL: Momentum & Breakout Engine]
- Evalúa la fuerza de tendencia analizando velas recientes y rechazo de soportes/resistencias.
- Emite señales ponderadas (0.0 a 1.0) con justificación técnica rigurosa y cálculo de stop loss basado en volatilidad ATR.`,
    tags: ["trading", "momentum", "crypto", "technical-analysis"]
  },
  {
    id: "circuit-breaker-risk",
    name: "Drawdown Shield & Circuit Breaker",
    category: "risk",
    source: "github:ccxt/ccxt",
    stars: "33k+",
    assignedTemplates: ["trader", "risk-manager"],
    summary: "Gestión matemática de riesgo: límites duros por posición, control de exposición máxima y congelación automática ante drawdown diario.",
    promptInjection: `[SKILL: Drawdown Shield & Circuit Breaker]
- Bloquea cualquier operación que supere el porcentaje máximo de capital asignado.
- Exige ratio riesgo-beneficio mínimo de 1:2 en cada señal aprobada.
- Impone enfriamiento inmediato si las pérdidas del día alcanzan el límite configurado.`,
    tags: ["trading", "risk", "capital-protection"]
  },

  // ==================== SELLER SKILLS ====================
  {
    id: "x402-eip3009-settlement",
    name: "x402 EIP-3009 Micro-Settlement",
    category: "web3",
    source: "github:coinbase/x402",
    stars: "Official",
    assignedTemplates: ["seller"],
    summary: "Negociación de desafíos HTTP 402, verificación de firmas EIP-712/EIP-3009 en Base y liquidación instantánea no custodial de USDC.",
    promptInjection: `[SKILL: x402 EIP-3009 Micro-Settlement]
- Sirve especificaciones 402 transparentes con receptor exacto (PAYTO_ADDRESS), cadena (Base) y token (USDC).
- Valida la cabecera PAYMENT-SIGNATURE antes de despachar servicios de IA de alta latencia.
- Registra cada cobro exitoso en el ledger inmutable con hash de transacción.`,
    tags: ["x402", "base", "usdc", "eip3009"]
  }
];

/** Obtiene las habilidades asignadas a una plantilla de agente dada. */
export function getSkillsForTemplate(templateKey) {
  return SKILLS_CATALOG.filter((s) => s.assignedTemplates.includes(templateKey));
}

/** Construye la inyección de prompt combinando todas las habilidades de una plantilla. */
export function buildSkillsPrompt(templateKey) {
  const skills = getSkillsForTemplate(templateKey);
  if (!skills.length) return "";
  return "\n\n=== HABILIDADES ESPECIALIZADAS ACTIVAS ===\n" +
    skills.map((s) => s.promptInjection).join("\n\n") +
    "\n=========================================\n";
}
