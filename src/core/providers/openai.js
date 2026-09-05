/**
 * Proveedor OpenAI (ChatGPT) vía Chat Completions. Convierte el formato interno (bloques estilo Anthropic)
 * a mensajes/tool_calls de OpenAI y de vuelta, para que los agentes no cambien.
 */
const EFFORT = { low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" };

export function toOpenAiMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: "system", content: system });
  for (const message of messages) {
    if (typeof message.content === "string") { out.push({ role: message.role, content: message.content }); continue; }
    if (message.role === "assistant") {
      const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const toolCalls = message.content.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      const entry = { role: "assistant", content: text || null };
      if (toolCalls.length) entry.tool_calls = toolCalls;
      out.push(entry);
    } else {
      for (const block of message.content) {
        if (block.type === "tool_result") out.push({ role: "tool", tool_call_id: block.tool_use_id, content: typeof block.content === "string" ? block.content : JSON.stringify(block.content) });
        else if (block.type === "text") out.push({ role: "user", content: block.text });
      }
    }
  }
  return out;
}

export function fromOpenAiResponse(body) {
  const choice = body.choices?.[0];
  if (!choice) throw new Error("OpenAI no devolvió respuesta");
  const content = [];
  if (choice.message.content) content.push({ type: "text", text: choice.message.content });
  for (const call of choice.message.tool_calls ?? []) {
    let input = {};
    try { input = JSON.parse(call.function.arguments || "{}"); } catch { input = {}; }
    content.push({ type: "tool_use", id: call.id, name: call.function.name, input });
  }
  const stopMap = { tool_calls: "tool_use", stop: "end_turn", length: "max_tokens", content_filter: "refusal" };
  return {
    content,
    stop_reason: stopMap[choice.finish_reason] ?? "end_turn",
    usage: { input_tokens: body.usage?.prompt_tokens ?? 0, cached_tokens: body.usage?.prompt_tokens_details?.cached_tokens ?? 0, output_tokens: body.usage?.completion_tokens ?? 0 },
    model: body.model
  };
}

export function createOpenAiProvider({ apiKey, defaults, baseUrl = "https://api.openai.com/v1", fetchImpl = fetch, serviceTier = "" }) {
  return {
    name: "openai",
    defaults,
    async complete({ model, system, messages, tools, maxTokens, effort }) {
      const request = { model, messages: toOpenAiMessages(system, messages), max_completion_tokens: maxTokens };
      if (tools?.length) request.tools = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
      if (/^(gpt-5|o[1-9])/.test(model)) request.reasoning_effort = EFFORT[effort] ?? "medium";
      if (serviceTier) request.service_tier = serviceTier;
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(request)
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(`OpenAI ${response.status}: ${body.error?.message ?? JSON.stringify(body).slice(0, 200)}`);
        error.status = response.status;
        const retryAfter = Number(response.headers?.get?.("retry-after"));
        if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfterMs = retryAfter * 1000;
        throw error;
      }
      return fromOpenAiResponse(body);
    }
  };
}
