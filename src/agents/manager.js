/**
 * Manager: bucle de orquestación. Decide qué agentes crear según backlog, cuotas y presupuesto.
 */
export function createManagerRunner({ store, config, llm, registry, sources }) {
  const sleep = (ms, signal) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

  return async function manager(ctx) {
    ctx.log("Manager iniciado");
    let warnedNoLlm = false;
    let ticks = 0;
    while (!ctx.signal.aborted) {
      ticks += 1;
      try {
        // Se lee el almacén en vivo en cada comprobación: dentro de un mismo ciclo se crean agentes y las cuotas deben verlos.
        const running = (template) => store.list("agents", (a) => a.template === template && ["running", "starting"].includes(a.status));
        const lastFinished = (template) => store.list("agents", (a) => a.template === template && a.finishedAt).map((a) => a.finishedAt).sort().at(-1);
        const budgetLeft = llm.enabled && llm.spentTodayUsd() < config.anthropic.dailyBudgetUsd;

        // 1. Exploración periódica: un scout por fuente.
        const lastScout = lastFinished("scout");
        if (!running("scout").length && (!lastScout || Date.now() - new Date(lastScout).getTime() > config.policy.scoutIntervalMs)) {
          for (const source of sources) {
            await ctx.spawnChild({ template: "scout", goal: `Explorar ${source.name}`, input: { sourceName: source.name } }).catch((e) => ctx.log(`No se creó scout: ${e.message}`, { level: "warn" }));
          }
        }

        // 2. Evaluación de hallazgos nuevos.
        const discovered = store.list("opportunities", (o) => o.status === "discovered");
        if (discovered.length && !running("evaluator").length) {
          const batch = discovered.slice(0, llm.enabled ? 15 : 120).map((o) => o.id);
          await ctx.spawnChild({ template: "evaluator", goal: `Evaluar ${batch.length} oportunidades`, input: { opportunityIds: batch } }).catch((e) => ctx.log(`No se creó evaluador: ${e.message}`, { level: "warn" }));
        }

        // 3. Workers para el backlog calificado, por score.
        const backlog = store.list("opportunities", (o) => o.status === "qualified" && o.kind === "bounty" && !o.assignedAgentId).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        if (backlog.length && !budgetLeft && !warnedNoLlm) {
          ctx.log(llm.enabled ? "Presupuesto diario de LLM agotado; los workers esperan" : "Sin ANTHROPIC_API_KEY: hay backlog pero ningún worker puede ejecutarlo", { level: "warn" });
          warnedNoLlm = true;
        }
        while (budgetLeft && config.policy.autoScale && backlog.length && running("worker").length < config.policy.maxConcurrentWorkers) {
          const opp = backlog.shift();
          try {
            await ctx.spawnChild({ template: "worker", goal: `Resolver ${opp.repo}#${opp.number}`, input: { opportunityId: opp.id } });
            store.upsert("opportunities", { id: opp.id, status: "assigned" });
          } catch (error) {
            ctx.log(`No se creó worker: ${error.message}`, { level: "warn" });
            break;
          }
        }

        // 4. Vendedor x402 siempre activo si está configurado.
        if (config.x402.enabled && config.x402.payTo && llm.enabled && !running("seller").length) {
          await ctx.spawnChild({ template: "seller", goal: "Vender servicios por USDC vía x402" }).catch((e) => ctx.log(`No se creó vendedor: ${e.message}`, { level: "warn" }));
        }

        // 5. Conciliación periódica en cadena.
        const lastRec = lastFinished("reconciler");
        if (config.x402.payTo && !running("reconciler").length && (!lastRec || Date.now() - new Date(lastRec).getTime() > config.policy.reconcileIntervalMs)) {
          await ctx.spawnChild({ template: "reconciler", goal: "Conciliar cobros en cadena" }).catch((e) => ctx.log(`No se creó conciliador: ${e.message}`, { level: "warn" }));
        }

        if (ticks % 10 === 0) ctx.log(`Tick ${ticks}: ${registry.active().length} agentes activos, backlog ${backlog.length}, gasto LLM hoy ${llm.spentTodayUsd().toFixed(3)} USD`);
      } catch (error) {
        ctx.log(`Error en el ciclo: ${error.message}`, { level: "error" });
      }
      await sleep(config.policy.managerTickMs ?? 30_000, ctx.signal);
    }
    return { summary: `Manager detenido tras ${ticks} ciclos` };
  };
}
