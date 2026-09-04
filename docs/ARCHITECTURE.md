# Arquitectura del enjambre

```text
                 ┌──────────── Manager (raíz, bucle cada 30 s) ────────────┐
                 │  cuotas · presupuesto LLM · backlog · intervalos        │
                 └──┬──────────┬──────────────┬──────────┬───────────┬─────┘
                    │          │              │          │           │
                 Scout     Evaluador       Worker     Vendedor   Conciliador
              (por fuente) (lotes de 15)  (1 bounty)   x402      (lectura de cadena)
                    │          │              │          │           │
   GitHub search ───┘          │          Revisor (hijo) │       eth_getLogs USDC → payTo
   Bazaar x402 ────┘           │              │          │
   Feeds JSON ─────┘           │         PR vía Git Data API      facilitador /verify /settle
                               ▼              ▼          ▼           ▼
                       opportunities        jobs      services     ledger
                                       (todo en data/state.json + bitácora hash-encadenada)
```

## Dos vías de ingreso

1. **Bounties** (`kind: bounty`). El scout encuentra issues pagados, el evaluador los puntúa, un worker lee el repo por API, propone archivos completos, un revisor hijo emite veredicto y el PR se abre con tu `GITHUB_TOKEN`. La recompensa la paga el mantenedor cuando fusiona; el ledger la muestra como *estimada* hasta que se vea en cadena.
2. **Servicios x402** (`kind: x402_sale`). El vendedor publica `/x402/<slug>`; un comprador recibe `402` con `PAYMENT-REQUIRED`, firma una autorización USDC y reenvía con `PAYMENT-SIGNATURE`; el facilitador verifica y liquida directamente a `PAYTO_ADDRESS`. El cobro nace como *reclamado* y el conciliador lo sube a *verificado* cuando ve el log `Transfer` en la cadena.

## Estados

- Oportunidad: `discovered → qualified | needs_review | rejected | insight → assigned → working → ready_for_review | submitted → abandoned`.
- Trabajo: `in_progress → review → ready_for_review → submitting → submitted`; ventas: `paid → verified`.
- Agente: `starting → running → done | failed | stopped`.

## Lo que el sistema no hace nunca

- No custodia claves ni firma: sólo conoce una dirección pública. Ninguna plantilla tiene `wallet:*`, `secret:read`, `shell` ni `exec:foreign-code`, y una prueba lo verifica.
- No navega libremente: sólo los hosts de la lista permitida, HTTPS, con timeout y tamaño máximo.
- No trata texto externo como instrucción: issues, comentarios, archivos y entradas de compradores se envuelven como datos no confiables.
- No supera cuotas: agentes activos, profundidad, hijos por padre, workers concurrentes y presupuesto diario de LLM se comprueban antes de cada creación.
