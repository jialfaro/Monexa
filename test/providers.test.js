import test from "node:test";
import assert from "node:assert/strict";
import { toOpenAiMessages, fromOpenAiResponse, createOpenAiProvider } from "../src/core/providers/openai.js";
import { toGeminiContents, fromGeminiResponse, createGeminiProvider } from "../src/core/providers/gemini.js";
import { createLlm, buildProviders } from "../src/core/llm.js";
import { createStore } from "../src/core/store.js";
import { buildConfig } from "../src/core/config.js";

const internal = [
  { role: "user", content: "hola" },
  { role: "assistant", content: [{ type: "text", text: "leo" }, { type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.js" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "contenido" }] }
];

test("OpenAI: convierte bloques a tool_calls y de vuelta", () => {
  const msgs = toOpenAiMessages("sys", internal);
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs[2].tool_calls[0].function.name, "read_file");
  assert.equal(msgs[3].role, "tool");
  const back = fromOpenAiResponse({ model: "gpt-5", choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c2", function: { name: "finish", arguments: '{"summary":"ok","resolvable":true}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  assert.equal(back.stop_reason, "tool_use");
  assert.deepEqual(back.content[0].input, { summary: "ok", resolvable: true });
  assert.equal(back.usage.input_tokens, 10);
});

test("Gemini: convierte a contents/functionResponse y de vuelta", () => {
  const contents = toGeminiContents([...internal.slice(0, 2), { role: "user", content: [{ type: "tool_result", tool_use_id: "read_file#1", content: "x" }] }]);
  assert.equal(contents[1].role, "model");
  assert.equal(contents[1].parts[1].functionCall.name, "read_file");
  assert.equal(contents[2].parts[0].functionResponse.name, "read_file");
  const back = fromGeminiResponse({ modelVersion: "gemini-3.8-flash", candidates: [{ finishReason: "STOP", content: { parts: [{ functionCall: { name: "list_dir", args: { path: "" } } }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } });
  assert.equal(back.stop_reason, "tool_use");
  assert.equal(back.content[0].id, "list_dir#1");
});

test("los proveedores envían la petición correcta", async () => {
  const seen = [];
  const fetchImpl = async (url, options) => { seen.push({ url, body: JSON.parse(options.body), headers: options.headers }); return { ok: true, json: async () => ({ choices: [{ finish_reason: "stop", message: { content: "{\"a\":1}" } }], usage: {} , candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{\"a\":1}" }] } }] }) }; };
  const openai = createOpenAiProvider({ apiKey: "k", defaults: {}, fetchImpl });
  await openai.complete({ model: "gpt-5", system: "s", messages: [{ role: "user", content: "u" }], tools: [{ name: "t", description: "d", input_schema: { type: "object" } }], maxTokens: 100, effort: "xhigh" });
  assert.equal(seen[0].body.reasoning_effort, "high");
  assert.equal(seen[0].body.tools[0].function.name, "t");
  assert.equal(seen[0].headers.Authorization, "Bearer k");
  const gemini = createGeminiProvider({ apiKey: "g", defaults: {}, fetchImpl });
  await gemini.complete({ model: "gemini-3.8-flash", system: "s", messages: [{ role: "user", content: "u" }], tools: [{ name: "t", description: "d", input_schema: { type: "object" } }], maxTokens: 100 });
  assert.match(seen[1].url, /gemini-3.8-flash:generateContent/);
  assert.equal(seen[1].body.systemInstruction.parts[0].text, "s");
  assert.equal(seen[1].body.tools[0].functionDeclarations[0].name, "t");
});

test("buildProviders respeta LLM_PROVIDER y exige su clave", () => {
  const cfg = buildConfig({ OPENAI_API_KEY: "o", GEMINI_API_KEY: "g", LLM_PROVIDER: "gemini" });
  assert.deepEqual(buildProviders(cfg.anthropic).map((p) => p.name), ["gemini", "openai"]);
  assert.throws(() => buildProviders(buildConfig({ OPENAI_API_KEY: "o", LLM_PROVIDER: "anthropic" }).anthropic), /no hay clave/);
});

test("conmuta al proveedor de respaldo cuando el principal falla por cuota", async () => {
  const config = buildConfig({ OPENAI_API_KEY: "o", GEMINI_API_KEY: "g", GEMINI_FREE_TIER: "false" });
  const providers = [
    { name: "openai", defaults: { worker: "gpt-5", scout: "gpt-5-mini" }, complete: async () => { const e = new Error("You have no credits remaining"); e.status = 429; throw e; } },
    { name: "gemini", defaults: { worker: "gemini-3.8-flash", scout: "gemini-3.8-flash" }, complete: async ({ model }) => ({ content: [{ type: "text", text: model }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }) }
  ];
  const llm = createLlm({ config, store: createStore(null), providers, sleep: async () => {} });
  const fallbacks = [];
  const result = await llm.complete({ agentId: "a", role: "scout", messages: [{ role: "user", content: "x" }], onFallback: (f) => fallbacks.push(f.provider) });
  assert.deepEqual(fallbacks, ["openai"]);
  assert.equal(result.provider, "gemini");
  assert.equal(llm.textOf(result.response), "gemini-3.8-flash");
  assert.ok(llm.spentTodayUsd() > 0);
});

test("reintenta en el mismo proveedor ante un 429 de velocidad y sólo cambia ante falta de saldo", async () => {
  const { classifyError, retryDelayMs } = await import("../src/core/llm.js");
  assert.equal(classifyError(Object.assign(new Error("Rate limit reached for gpt-5 (RPM): Limit 3. Please try again in 20s."), { status: 429 })), "rate_limit");
  assert.equal(classifyError(new Error("OpenAI 429: You have no credits remaining.")), "switch");
  assert.equal(classifyError(new Error("Gemini 429: You exceeded your current quota ... free_tier_requests")), "quota");
  assert.equal(classifyError(Object.assign(new Error("bad request"), { status: 400 })), "fatal");
  assert.equal(retryDelayMs(new Error("try again in 20s"), 1), 21_000);
  assert.equal(retryDelayMs(new Error("x"), 2), 10_000);

  const config = buildConfig({ OPENAI_API_KEY: "o", GEMINI_API_KEY: "g" });
  let calls = 0;
  const providers = [
    { name: "openai", defaults: { worker: "gpt-5", scout: "gpt-5-mini" }, complete: async () => { calls += 1; if (calls < 3) { const e = new Error("Rate limit reached. Please try again in 1s."); e.status = 429; throw e; } return { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }; } },
    { name: "gemini", defaults: { worker: "g", scout: "g" }, complete: async () => { throw new Error("no debería llegar"); } }
  ];
  const slept = [];
  const llm = createLlm({ config, store: createStore(null), providers, sleep: async (ms) => { slept.push(ms); } });
  const result = await llm.complete({ agentId: "a", messages: [{ role: "user", content: "x" }] });
  assert.equal(result.provider, "openai");
  assert.equal(calls, 3);
  assert.ok(slept.length >= 2 && slept.every((ms) => ms >= 1000));
});

test("cupo diario agotado en gpt-5: cae a gpt-5-mini del mismo proveedor y marca el modelo como no disponible", async () => {
  const config = buildConfig({ OPENAI_API_KEY: "o" });
  const used = [];
  const providers = [{
    name: "openai", defaults: { worker: "gpt-5", scout: "gpt-5-mini" },
    complete: async ({ model }) => {
      used.push(model);
      if (model === "gpt-5") { const e = new Error("Rate limit reached for gpt-5 on requests per day (RPD): Limit 50, Used 50. Please try again in 28m48s."); e.status = 429; throw e; }
      return { content: [{ type: "text", text: model }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
    }
  }];
  const llm = createLlm({ config, store: createStore(null), providers, sleep: async () => {} });
  const first = await llm.complete({ agentId: "a", messages: [{ role: "user", content: "x" }] });
  assert.equal(first.model, "gpt-5-mini");
  const second = await llm.complete({ agentId: "a", messages: [{ role: "user", content: "x" }] });
  assert.deepEqual(used, ["gpt-5", "gpt-5-mini", "gpt-5-mini"], "gpt-5 no se vuelve a intentar mientras dure el cupo");
  assert.equal(second.model, "gpt-5-mini");
  assert.equal(llm.available("worker").model, "gpt-5-mini");
  assert.equal(llm.status()[0].key, "openai:gpt-5");
});

test("sin ningún cupo disponible lanza LLM_UNAVAILABLE con hora de reintento y available() lo refleja", async () => {
  const config = buildConfig({ OPENAI_API_KEY: "o", GEMINI_API_KEY: "g" });
  const providers = [
    { name: "openai", defaults: { worker: "gpt-5", scout: "gpt-5-mini" }, complete: async () => { const e = new Error("Rate limit reached on requests per day (RPD). Please try again in 10m0s."); e.status = 429; throw e; } },
    { name: "gemini", defaults: { worker: "gemini-3.8-flash", scout: "gemini-3.5-flash-lite" }, complete: async () => { throw new Error("Gemini 429: You exceeded your current quota ... free_tier_requests, limit: 20"); } }
  ];
  const llm = createLlm({ config, store: createStore(null), providers, sleep: async () => {} });
  await assert.rejects(llm.complete({ agentId: "a", messages: [{ role: "user", content: "x" }] }), (e) => e.code === "LLM_UNAVAILABLE" && typeof e.retryAt === "number");
  const avail = llm.available("worker");
  assert.equal(avail.ok, false);
  assert.ok(avail.retryAt > Date.now());
  const { unavailableDelayMs } = await import("../src/core/llm.js");
  assert.equal(unavailableDelayMs(new Error("Please try again in 28m48s.")), (28 * 60 + 48) * 1000 + 30_000);
});
