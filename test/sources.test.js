import test from "node:test";
import assert from "node:assert/strict";
import { extractReward, issueToOpportunity, createGithubSource } from "../src/sources/github-bounties.js";
import { resourceToOpportunity } from "../src/sources/x402-bazaar.js";
import { heuristicScore } from "../src/agents/evaluator.js";
import { createFetcher } from "../src/core/http.js";

test("extrae recompensas en distintos formatos", () => {
  assert.deepEqual(extractReward("/bounty $250"), { amount: 250, asset: "USD" });
  assert.deepEqual(extractReward("Bounty: $1,000 for this fix"), { amount: 1000, asset: "USD" });
  assert.deepEqual(extractReward("Reward 150 USDC on Base"), { amount: 150, asset: "USDC" });
  assert.equal(extractReward("no money here"), null);
});

test("marca riesgos en issues que piden wallet o KYC", () => {
  const opp = issueToOpportunity({ title: "Fix", body: "Connect your wallet and complete identity verification", labels: [{ name: "bounty" }], repository_url: "https://api.github.com/repos/o/r", number: 1, html_url: "https://github.com/o/r/issues/1", created_at: new Date().toISOString() });
  assert.ok(opp.riskFlags.includes("kyc") && opp.riskFlags.includes("wallet_access"));
  assert.equal(heuristicScore(opp).score < 40, true);
});

test("el score heurístico favorece recompensa alta sin asignados", () => {
  const good = heuristicScore({ kind: "bounty", expectedReward: { amount: 600, asset: "USD" }, assignees: 0, comments: 2, postedAt: new Date().toISOString(), riskFlags: [] });
  const taken = heuristicScore({ kind: "bounty", expectedReward: { amount: 600, asset: "USD" }, assignees: 2, comments: 2, postedAt: new Date().toISOString(), riskFlags: [] });
  assert.ok(good.score > taken.score);
  assert.ok(good.score >= 60);
});

test("el scout de GitHub deduplica y omite pull requests", async () => {
  const issue = (n, extra = {}) => ({ title: `Issue ${n}`, body: "/bounty $100", labels: [], repository_url: "https://api.github.com/repos/o/r", number: n, html_url: `https://github.com/o/r/issues/${n}`, created_at: new Date().toISOString(), ...extra });
  const fetchJson = async () => ({ items: [issue(1), issue(1), issue(2, { pull_request: {} })] });
  const source = createGithubSource({ fetchJson, token: "", queries: ["label:bounty", "state:open commenter:algora-pbc[bot]"] });
  const result = await source.discover();
  assert.equal(result.opportunities.length, 1);
  assert.equal(result.opportunities[0].expectedReward.amount, 100);
  assert.equal(result.opportunities[0].verifiedPayer, "algora-pbc");
});

test("el Bazaar convierte recursos en inteligencia de mercado", () => {
  const opp = resourceToOpportunity({ resource: "https://api.example.com/weather", description: "Weather", serviceName: "Weather", accepts: [{ amount: "10000", network: "eip155:8453", payTo: "0x1" }], quality: { l30DaysTotalCalls: 1200, l30DaysUniquePayers: 30 } });
  assert.equal(opp.kind, "market");
  assert.equal(opp.pricePerCallUsd, 0.01);
  assert.equal(opp.expectedReward.amount, 12);
});

test("el fetcher bloquea hosts fuera de la lista", async () => {
  const fetcher = createFetcher({ allowedHosts: ["api.github.com"] });
  await assert.rejects(fetcher.fetchJson("https://evil.example.com/x"), /no permitido/);
  await assert.rejects(fetcher.fetchJson("http://api.github.com/x"), /HTTPS/);
});

test("muchos bounties del mismo repo penalizan el score", () => {
  const base = { kind: "bounty", expectedReward: { amount: 700, asset: "USD" }, assignees: 0, comments: 0, postedAt: new Date().toISOString(), riskFlags: [] };
  assert.ok(heuristicScore(base, { sameRepoCount: 12 }).score < heuristicScore(base).score);
});

test("repoTrust descarta granjas de bounties y premia custodia de Algora", async () => {
  const { repoTrust } = await import("../src/agents/evaluator.js");
  const farm = repoTrust({ repo: "x/farm", labels: ["bounty"] }, { sameRepoCount: 40, repo: { stars: 288, openIssues: 8925, createdAt: new Date(Date.now() - 120 * 86_400_000).toISOString() } });
  assert.equal(farm.spam, true);
  const blocked = repoTrust({ repo: "a/b" }, { blockedRepos: ["A/B"] });
  assert.equal(blocked.spam, true);
  const good = repoTrust({ repo: "org/lib", labels: ["💎 Bounty"], verifiedPayer: "algora-pbc" }, { sameRepoCount: 2, repo: { stars: 5000, openIssues: 120, createdAt: "2020-01-01T00:00:00Z" } });
  assert.equal(good.spam, false);
  assert.ok(good.bonus >= 30);
  const bait = repoTrust({ repo: "x/y", labels: ["AI agent friendly", "💎 Bounty"] }, { sameRepoCount: 1, repo: { stars: 3000, openIssues: 10, createdAt: "2020-01-01T00:00:00Z" } });
  assert.equal(bait.spam, true);
  const mimic = repoTrust({ repo: "someone/qdrant-qdrant" }, { repo: { fork: true, stars: 0, openIssues: 5, createdAt: "2026-01-01T00:00:00Z" } });
  assert.equal(mimic.spam, true);
});

test("Gemini reenvía thoughtSignature en llamadas de función", async () => {
  const { fromGeminiResponse, toGeminiContents } = await import("../src/core/providers/gemini.js");
  const r = fromGeminiResponse({ candidates: [{ finishReason: "STOP", content: { parts: [{ thought: true, text: "pensando" }, { functionCall: { name: "read_file", args: { path: "a" } }, thoughtSignature: "sig123" }] } }], usageMetadata: {} });
  assert.equal(r.content.length, 1);
  const parts = toGeminiContents([{ role: "assistant", content: r.content }])[0].parts;
  assert.equal(parts[0].thoughtSignature, "sig123");
});
