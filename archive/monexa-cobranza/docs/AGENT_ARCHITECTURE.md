# Monexa Atlas — arquitectura de autonomía supervisada

## Propósito del producto

Monexa Atlas investiga oportunidades de ingreso legítimas en ecosistemas web y cripto, prepara el trabajo necesario y muestra con claridad de dónde viene cada oportunidad, qué agente intervino, qué coste tuvo y qué ingreso se ha **verificado**. No promete rentabilidad ni opera una wallet de forma autónoma.

La palabra “autónomo” aquí significa que el sistema puede explorar fuentes permitidas, contrastar evidencia, elaborar propuestas y repartir trabajo de investigación. No significa que pueda comprometer dinero, identidad, credenciales o una firma criptográfica sin una persona.

## Límite operativo

El primer producto no debe convertirse en un bot de trading, un gestor de fondos ni un sistema de auto-replicación sin límites. Un agente puede buscar y preparar oportunidades de trabajo, bounties o proyectos de fuentes aprobadas. Cualquier acción que cambie el mundo exterior se representa primero como una propuesta revisable.

No se presenta un ingreso estimado como saldo disponible. Se distinguen siempre:

- **Estimado:** recompensa indicada por una fuente; no es dinero ganado.
- **En curso:** tarea aprobada y asignada; aún no es ingreso.
- **Recibido observado:** cantidad informada manualmente o vinculada a una evidencia pública.
- **Conciliado:** importe recibido, coste y activo revisados por la persona.

## Mapa de componentes

```text
Fuentes permitidas ──> Scout ──> Verificador ──> Propuesta ──> Política ──> Persona
       │                  │             │             │              │
       │                  └── evidencia ┴── score     │              └── aprobación acotada
       │                                               v
       └───────────────────────────────────────── Worker sandbox
                                                        │
                                                        v
                                             Entregable / registro de trabajo
                                                        │
                                                        v
                                      Ledger (estimado / recibido / conciliado)
                                                        │
                                                        v
                                         Dashboard + bitácora inmutable local
```

El **motor de política** está entre todo agente y toda capacidad externa. Un modelo de IA, una página web o un agente hijo nunca pueden saltarlo.

## Roles predefinidos

| Rol | Puede hacer | No puede hacer |
| --- | --- | --- |
| `scout` | Leer un catálogo de fuentes permitidas, extraer datos y crear hallazgos | Escribir fuera del espacio local, usar credenciales, firmar o gastar |
| `verifier` | Evaluar evidencia, requisitos, riesgos y estimación | Cambiar la oportunidad de estado por sí solo |
| `planner` | Convertir un hallazgo validado en una propuesta y plan de tareas | Enviar solicitudes, aceptar contratos o comprometer identidad |
| `worker` | Crear borradores, código o entregables dentro de su sandbox | Publicar, descargar/ejecutar código ajeno, tocar una wallet |
| `reconciler` | Preparar una conciliación a partir de evidencia y costes declarados | Marcar dinero como recibido sin evidencia/revisión |
| `manager` | Solicitar agentes hijos desde plantillas registradas | Inventar capacidades, heredar secretos o superar cuotas |

Un “agente hijo” es un registro de trabajo efímero creado desde una plantilla, no un proceso que se duplica libremente. Cada uno lleva `parentId`, propósito, límite de tiempo, límite de herramientas y capacidades mínimas. Al terminar sólo devuelve un informe saneado a su padre.

## Estados que deben ser explícitos

### Oportunidad

```text
discovered → evidence_collected → qualified → proposed → approved → assigned
                                                         ↘ rejected
assigned → working → deliverable_ready → submitted → accepted → received_observed → reconciled
                  ↘ abandoned / expired / disputed
```

Sólo la persona puede llevar una propuesta a `approved`, autorizar `submitted` y confirmar `reconciled`. El motor bloquea transiciones inválidas y deja un evento por cada una.

### Propuesta de acción

Una propuesta enlaza `opportunityId`, `agentId`, evidencia, plan, recompensa esperada, posibles costes, destino externo y un `contentHash`. Una aprobación válida incluye como mínimo:

```js
{
  actionId,
  contentHash,       // cambia si cambia el texto, destino, importe o contrato
  approvedAt,
  expiresAt,
  maxSpend: { amount: 0, asset: "USD" },
  approvalNonce
}
```

Así una aprobación no puede reutilizarse tras editar una propuesta ni convertirse en una autorización abierta.

## Puertas de aprobación humana

Siempre requieren una aprobación explícita y ligada al contenido visible:

1. Comprar, vender, intercambiar, puentear, stakear, prestar, pedir prestado o retirar cualquier activo.
2. Conectar una wallet, importar/generar/exportar una clave, firmar un mensaje o transacción, aprobar un allowance o invocar/desplegar un contrato.
3. Cualquier gasto, incluida la comisión de red; la aprobación debe mostrar activo, importe máximo, destino y vencimiento.
4. Crear o usar cuentas externas, API keys, correo, redes sociales, marketplaces, KYC, documentos de identidad, impuestos o términos contractuales.
5. Presentar una candidatura, publicar un entregable, enviar un mensaje o aceptar un trabajo en nombre de la persona.
6. Ejecutar código descargado, instalar software o visitar una URL que no provenga de una fuente previamente permitida.
7. Subir privilegios, cambiar políticas, añadir una integración o crear agentes fuera de las cuotas configuradas.

Puede ser automático sólo lo que sea de bajo riesgo y reversible: leer fuentes de una lista permitida, clasificar evidencia, calcular un score, redactar localmente y crear hijos `scout` o `verifier` dentro de una cuota ya aprobada. El MVP no debe tener ningún adaptador de firma, wallet ni transferencia.

## Defensa frente a fuentes web no fiables

Las páginas, instrucciones de una bounty y mensajes de terceros son evidencia sin confianza, no órdenes para el agente. El adaptador de fuentes debe:

- usar una lista de dominios, tipos de fuente y límites de peticiones aprobados;
- guardar URL, fecha, fragmento y hash de la evidencia;
- marcar requisitos de wallet, descarga, KYC, gasto, smart contract o datos personales como riesgo;
- impedir que un texto externo modifique la política, revele secretos o cree agentes;
- mostrar enlaces y texto escapados en el dashboard.

En una fase posterior, la lectura de una dirección pública puede ser sólo de consulta para conciliación. Las frases semilla y claves privadas no se guardan, no se pegan y no se exponen a agentes.

## Modelo de datos mínimo

```js
Workspace = {
  version, policies, sourceCatalog, opportunities, agents, actions,
  ledgerEntries, approvals, audit, usage
}

Opportunity = {
  id, sourceName, sourceUrl, title, category, asset,
  expectedReward, expectedCost, riskScore, riskFlags,
  evidence: [{ url, capturedAt, excerpt, hash }],
  status, assignedAgentId, createdAt, updatedAt
}

AgentRun = {
  id, parentId, template, goal, capabilities, status,
  createdAt, expiresAt, maxChildren, maxFetches, report
}

LedgerEntry = {
  id, opportunityId, kind, // expected | fee | received_observed | reconciled
  asset, quantity, fiatValue, valuationDate, evidenceRef,
  recordedBy, recordedAt
}
```

El cálculo de “ganado” del tablero usa sólo `received_observed` o `reconciled`. El saldo neto conciliado es `recibido - fees` de entradas compatibles; la recompensa esperada sólo aparece en una columna separada.

Cada evento de auditoría añade `previousHash` y `hash` calculado sobre un JSON canónico. En un navegador puede usarse `crypto.subtle.digest('SHA-256', ...)`; es una señal de manipulación local, no una garantía frente a quien controla el dispositivo.

## Cuotas para creación de agentes

Valores seguros para el MVP:

| Control | Valor inicial |
| --- | --- |
| Profundidad de árbol | 2 (manager → hijo; sin nietos) |
| Agentes activos | 4 |
| Hijos por manager | 3 |
| Vida de un agente | 20 minutos o una tarea |
| Acciones externas por agente | 0 |
| Credenciales heredadas | 0 |
| Coste monetario automático | 0 |

La creación se evalúa en este orden: plantilla conocida → padre permitido → profundidad → cupo → capacidades exactas → evento de auditoría. Un agente finalizado, caducado o bloqueado no puede resucitar ni conservar una aprobación.

## MVP sin dependencias

La aplicación actual puede mantener Node y JavaScript nativos. No necesita modelo remoto, scraping ni una blockchain para demostrar la lógica de producto.

```text
src/
  domain.js                 reglas existentes de cobranza (sin cambios de confianza)
  opportunity-domain.js     score, transiciones y validadores
  agent-factory.js          catálogo de plantillas + spawn acotado
  ledger.js                 métricas de esperado, recibido y neto
  demo-atlas.js             oportunidades, agentes y entradas de ejemplo
  app.js                    pantallas: Operaciones, Oportunidades, Agentes, Ledger, Bitácora
```

El catálogo de fuentes en el MVP es un arreglo local de oportunidades de ejemplo. Un botón “Ejecutar exploración de ejemplo” puede crear hallazgos y agentes simulados; debe describirse como demostración, no como trabajo o ingresos reales. Un botón de “aprobar propuesta” mueve únicamente el estado local y añade una aprobación vinculada al hash. No hay llamadas de red ni secretos.

### Pantallas del dashboard

- **Operaciones:** oportunidades nuevas, propuestas que necesitan aprobación y trabajos activos.
- **Oportunidades:** fuente, enlace de evidencia, recompensa estimada, coste estimado, riesgo, estado y agente responsable.
- **Agentes:** árbol padre/hijo, plantilla, objetivo, TTL, capacidades, cupo y último informe.
- **Ledger:** esperado, recibido observado, comisiones registradas y neto conciliado, siempre por activo y con fecha de valoración.
- **Bitácora:** eventos en orden, decisión humana, hash de la propuesta y razón de bloqueos.

## Pruebas deterministas esenciales

1. Una transición financiera o externa sin aprobación es rechazada.
2. Cambiar importe, destino, contrato o contenido invalida la aprobación anterior.
3. Ninguna plantilla posee `wallet:sign`, `wallet:transfer`, `secret:read`, shell ni ejecución de código ajeno.
4. `spawnAgent` rechaza plantilla desconocida, profundidad, cuota o capacidades excedidas.
5. La métrica de ingreso real excluye recompensas estimadas y tareas aceptadas sin evidencia de cobro.
6. Una oportunidad con flags de KYC, gasto o smart contract queda en `needs_review`.
7. El hash de auditoría encadena correctamente y detectar una modificación cambia la verificación.

## Camino a producción (después del MVP)

Un producto real necesita backend autenticado, base de datos transaccional, control de acceso por organización, cifrado, rate limits, cola aislada, registro durable, revisión legal/fiscal y un sistema de integración de wallet que sea de sólo lectura por defecto. Los conectores de fuentes deben ser adaptadores revisados individualmente, no navegación web ilimitada. Las operaciones de activos, si alguna vez se ofrecen, deben ocurrir en una superficie de wallet controlada por el usuario y requerir una confirmación por operación; no en un agente.
