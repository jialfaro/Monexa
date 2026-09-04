# Monexa

Enjambre de agentes de IA que **busca trabajo pagado en cripto, lo ejecuta y cobra**, con un dashboard que muestra de dónde salió cada oportunidad, qué agente hizo qué, cuánto costó y cuánto se ha cobrado **de verdad** (verificado en cadena) frente a lo estimado.

Un `manager` crea y supervisa agentes hijos: `scout` (busca), `evaluator` (puntúa), `worker` (resuelve bounties y abre PRs, con un `reviewer` hijo), `seller` (vende servicios cobrados en USDC por llamada mediante el protocolo x402) y `reconciler` (lee la blockchain y concilia). Tú también puedes crear agentes desde el dashboard.

## Arranque

```bash
cp .env.example .env   # rellena ANTHROPIC_API_KEY, PAYTO_ADDRESS y GITHUB_TOKEN
npm install
npm start
```

Abre http://127.0.0.1:4173. Sin claves el enjambre igualmente explora y puntúa oportunidades; para ejecutar trabajos, vender servicios y abrir PRs necesita:

| Variable | Para qué |
| --- | --- |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` | Razonar, producir código, atender servicios. Basta una; con varias, `LLM_PROVIDER` elige la principal y el resto son respaldo automático (`LLM_FALLBACK`). Presupuesto diario en `DAILY_LLM_BUDGET_USD`. |
| `PAYTO_ADDRESS` | Dirección pública EVM donde recibir USDC. La wallet la controlas tú; aquí nunca hay claves privadas. |
| `GITHUB_TOKEN` | Fork, commit y pull request en los repos con bounty. |
| `TUNNEL=cloudflare` | Abre al arrancar un túnel gratuito de Cloudflare (sin cuenta, requiere `brew install cloudflared`) y descubre solo la URL pública. Fuera del túnel sólo se exponen `/x402/*` y `/.well-known/x402`; el dashboard y la API siguen siendo locales. La URL cambia en cada arranque. |
| `PUBLIC_URL` | Alternativa a `TUNNEL`: URL fija de un despliegue o de un túnel con dominio propio. |
| `X402_NETWORK` | `eip155:84532` (Base Sepolia, pruebas) o `eip155:8453` (Base, dinero real). En Base real necesitas un facilitador que la soporte (`X402_FACILITATOR_URL` y `X402_FACILITATOR_AUTH`). |
| `AUTO_SUBMIT` | `false` (por defecto): los PRs esperan tu botón "Aprobar" en el dashboard. `true`: el worker los abre solo. |

## Qué ves en el dashboard

- **Resumen:** USDC verificado en cadena, reclamado, pipeline estimado, coste LLM del día, saldo de la dirección, alertas de configuración.
- **Agentes:** árbol padre/hijo con estado, objetivo, coste, registro y botón para detener; formulario para crear agentes por plantilla.
- **Oportunidades:** fuente, enlace, recompensa, score, riesgo, estado y agente asignado; inteligencia de mercado del Bazaar x402 (qué servicios cobran otros agentes y cuánta demanda tienen).
- **Trabajos:** cada bounty con los pasos que dio el worker, los archivos propuestos, el veredicto del revisor y el PR; cada venta x402 con pagador, importe y hash de transacción.
- **Servicios x402:** catálogo, precio editable y activación por servicio.
- **Ledger:** estimado / reclamado / verificado / coste por activo, con enlaces al explorador.
- **Bitácora:** eventos encadenados por hash; el dashboard verifica la integridad.

## Fuentes de trabajo

- **GitHub:** issues abiertos con etiquetas `bounty`, `💎 Bounty` (Algora) o comandos `/bounty $`. Consultas configurables en `GITHUB_BOUNTY_QUERIES`.
- **Bazaar x402:** listado público de Coinbase de servicios pagados por agentes, usado para saber qué se vende.
- **Feeds JSON:** cualquier URL en `EXTRA_JSON_FEEDS`.

## Pruebas

```bash
npm test
```

## Límites honestos

- No hay garantía de ingresos: los bounties son competitivos y los servicios x402 sólo cobran si alguien los llama.
- El sistema nunca firma ni mueve fondos; recibe USDC en tu dirección y sólo lee la cadena.
- Los textos de issues, repos y compradores son datos no confiables para los agentes, nunca órdenes.

Detalles en [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). El copiloto de cobranza anterior quedó en `archive/monexa-cobranza/`.
