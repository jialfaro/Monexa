/**
 * Proveedor Google Gemini vía generateContent. Gemini no asigna ids a las llamadas de función,
 * así que se generan ids deterministas y se devuelven los resultados como functionResponse.
 */
export function toGeminiContents(messages) {
  const contents = [];
  for (const message of messages) {
    const role = message.role === "assistant" ? "model" : "user";
    if (typeof message.content === "string") { contents.push({ role, parts: [{ text: message.content }] }); continue; }
    const parts = [];
    for (const block of message.content) {
      if (block.type === "text") parts.push(withSignature({ text: block.text }, block));
      else if (block.type === "tool_use") parts.push(withSignature({ functionCall: { name: block.name, args: block.input ?? {} } }, block));
      else if (block.type === "tool_result") {
        const name = String(block.tool_use_id).split("#")[0];
        const result = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
        parts.push({ functionResponse: { name, response: block.is_error ? { error: result } : { result } } });
      }
    }
    if (parts.length) contents.push({ role, parts });
  }
  return contents;
}

export function fromGeminiResponse(body, callCounter = { n: 0 }) {
  const candidate = body.candidates?.[0];
  if (!candidate) {
    const reason = body.promptFeedback?.blockReason;
    if (reason) return { content: [], stop_reason: "refusal", usage: usageOf(body), model: body.modelVersion };
    throw new Error("Gemini no devolvió candidatos");
  }
  const content = [];
  for (const part of candidate.content?.parts ?? []) {
    if (part.thought) continue; // resumen de razonamiento: no se reenvía como contenido
    const signature = part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {};
    if (part.text) content.push({ type: "text", text: part.text, ...signature });
    else if (part.functionCall) {
      callCounter.n += 1;
      content.push({ type: "tool_use", id: `${part.functionCall.name}#${callCounter.n}`, name: part.functionCall.name, input: part.functionCall.args ?? {}, ...signature });
    }
  }
  const hasTool = content.some((b) => b.type === "tool_use");
  const finish = candidate.finishReason;
  const stop_reason = hasTool ? "tool_use" : finish === "MAX_TOKENS" ? "max_tokens" : ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST"].includes(finish) ? "refusal" : "end_turn";
  return { content, stop_reason, usage: usageOf(body), model: body.modelVersion };
}

/** Gemini 3 exige reenviar la firma de razonamiento (thoughtSignature) con cada parte que la traía. */
function withSignature(part, block) {
  return block.thoughtSignature ? { ...part, thoughtSignature: block.thoughtSignature } : part;
}

function usageOf(body) {
  return { input_tokens: body.usageMetadata?.promptTokenCount ?? 0, output_tokens: (body.usageMetadata?.candidatesTokenCount ?? 0) + (body.usageMetadata?.thoughtsTokenCount ?? 0) };
}

export function createGeminiProvider({ apiKey, defaults, baseUrl = "https://generativelanguage.googleapis.com/v1beta", fetchImpl = fetch }) {
  const counter = { n: 0 };
  return {
    name: "gemini",
    defaults,
    async complete({ model, system, messages, tools, maxTokens }) {
      const request = { contents: toGeminiContents(messages), generationConfig: { maxOutputTokens: maxTokens } };
      if (system) request.systemInstruction = { parts: [{ text: system }] };
      if (tools?.length) request.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema })) }];
      const response = await fetchImpl(`${baseUrl}/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(request)
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`Gemini ${response.status}: ${body.error?.message ?? JSON.stringify(body).slice(0, 200)}`);
      return fromGeminiResponse(body, counter);
    }
  };
}
