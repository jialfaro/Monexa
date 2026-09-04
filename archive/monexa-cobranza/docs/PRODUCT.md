# Producto: Monexa

## Propuesta

**Monexa detecta qué dinero requiere atención, prepara la siguiente acción y mantiene a la persona siempre al mando.**

El primer cliente son freelancers y microempresas de habla hispana que emiten facturas, llevan la cobranza por hojas de cálculo y necesitan una rutina fiable de seguimiento.

## Flujo P0

```text
CSV de facturas → reglas deterministas → bandeja explicable → borrador → aprobación humana → exportación o envío autorizado
```

En el prototipo actual, los datos viven sólo en `localStorage` del navegador y "aprobar y copiar" no hace ninguna comunicación externa.

## Límites explícitos

- Monexa no paga, cobra, invierte ni recomienda movimientos financieros.
- Monexa no tiene acceso a terminal, navegador autónomo, secretos ni cuentas de terceros.
- Monexa no modifica su código ni crea agentes hijos.
- La aprobación se debe invalidar si cambian destinatario, importe, texto o condiciones del mensaje.

## Camino de producción

1. Migrar el núcleo a TypeScript y separar UI, dominio, adaptadores y worker.
2. Añadir autenticación, workspaces y Postgres con aislamiento por organización.
3. Guardar importaciones cifradas y eventos de auditoría inmutables.
4. Ejecutar un trabajo diario durable que recalcula alertas y propone —no ejecuta— acciones.
5. Añadir Gmail/Outlook con OAuth de privilegio mínimo y una aprobación vinculada al hash del borrador.
6. Integrar un proveedor de modelos sólo detrás de salidas JSON validadas y límites de coste.
