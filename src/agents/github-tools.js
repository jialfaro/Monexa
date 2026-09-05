/**
 * Herramientas GitHub para el worker: lectura de repos vía API REST y envío de PR con la Git Data API.
 * No clona nada en disco ni ejecuta código del repositorio.
 */
export function createGithubTools({ fetchJson, token }) {
  const headers = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const api = (path, options = {}) => fetchJson(`https://api.github.com${path}`, { ...options, headers: { ...headers, ...(options.headers ?? {}) } });

  async function repoInfo(repo) {
    const info = await api(`/repos/${repo}`);
    return { defaultBranch: info.default_branch, language: info.language, description: info.description, stars: info.stargazers_count, openIssues: info.open_issues_count, createdAt: info.created_at, archived: info.archived, fork: info.fork };
  }

  async function issueThread(repo, number) {
    const [issue, comments] = await Promise.all([
      api(`/repos/${repo}/issues/${number}`),
      api(`/repos/${repo}/issues/${number}/comments?per_page=30`)
    ]);
    return {
      title: issue.title,
      body: issue.body ?? "",
      state: issue.state,
      assignees: (issue.assignees ?? []).map((a) => a.login),
      comments: comments.map((c) => ({ author: c.user?.login, body: (c.body ?? "").slice(0, 1500), at: c.created_at }))
    };
  }

  async function listDir(repo, path = "", ref) {
    const clean = path.replace(/^\/+|\/+$/g, "");
    const body = await api(`/repos/${repo}/contents/${clean}${ref ? `?ref=${ref}` : ""}`);
    if (!Array.isArray(body)) return [{ path: body.path, type: "file", size: body.size }];
    return body.map((e) => ({ path: e.path, type: e.type, size: e.size }));
  }

  async function readFile(repo, path, ref, maxChars = 40_000) {
    const clean = path.replace(/^\/+/, "");
    const body = await api(`/repos/${repo}/contents/${clean}${ref ? `?ref=${ref}` : ""}`);
    if (Array.isArray(body)) throw new Error(`${path} es un directorio`);
    if (body.encoding !== "base64") throw new Error(`No se pudo leer ${path}`);
    const text = Buffer.from(body.content, "base64").toString("utf8");
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncado ${text.length - maxChars} caracteres]` : text;
  }

  async function searchCode(repo, query) {
    const body = await api(`/search/code?q=${encodeURIComponent(`${query} repo:${repo}`)}&per_page=15`);
    return (body.items ?? []).map((i) => ({ path: i.path }));
  }

  async function currentUser() {
    const user = await api("/user");
    return user.login;
  }

  /** Crea (o reutiliza) un fork, sube los cambios como un commit y abre el PR. */
  async function openPullRequest({ repo, baseBranch, branchName, changes, title, body }) {
    if (!token) throw new Error("GITHUB_TOKEN necesario para abrir un PR");
    const login = await currentUser();
    const [owner, name] = repo.split("/");
    let forkRepo = `${login}/${name}`;
    if (owner.toLowerCase() !== login.toLowerCase()) {
      const fork = await api(`/repos/${repo}/forks`, { method: "POST", body: JSON.stringify({ default_branch_only: true }) });
      forkRepo = fork.full_name;
      await waitFor(async () => api(`/repos/${forkRepo}`).then(() => true).catch(() => false), 60_000);
    } else {
      forkRepo = repo;
    }
    const baseRef = await api(`/repos/${repo}/git/ref/heads/${baseBranch}`);
    const baseSha = baseRef.object.sha;
    const baseCommit = await api(`/repos/${repo}/git/commits/${baseSha}`);

    const tree = [];
    for (const change of changes) {
      if (change.delete) {
        tree.push({ path: change.path, mode: "100644", type: "blob", sha: null });
      } else {
        const blob = await api(`/repos/${forkRepo}/git/blobs`, { method: "POST", body: JSON.stringify({ content: change.content, encoding: "utf-8" }) });
        tree.push({ path: change.path, mode: "100644", type: "blob", sha: blob.sha });
      }
    }
    const newTree = await api(`/repos/${forkRepo}/git/trees`, { method: "POST", body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree }) });
    const commit = await api(`/repos/${forkRepo}/git/commits`, { method: "POST", body: JSON.stringify({ message: title, tree: newTree.sha, parents: [baseSha] }) });
    await api(`/repos/${forkRepo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: commit.sha }) })
      .catch(async (error) => {
        if (error.status !== 422) throw error;
        await api(`/repos/${forkRepo}/git/refs/heads/${branchName}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha, force: true }) });
      });
    const head = forkRepo === repo ? branchName : `${forkRepo.split("/")[0]}:${branchName}`;
    let pr;
    try {
      pr = await api(`/repos/${repo}/pulls`, { method: "POST", body: JSON.stringify({ title, head, base: baseBranch, body, maintainer_can_modify: true }) });
    } catch (error) {
      if (error.message?.includes("403") && token?.startsWith("github_pat_")) {
        throw new Error("GitHub 403 Forbidden: Tu token actual es Fine-Grained (github_pat_...). GitHub no permite a los tokens fine-grained abrir Pull Requests en repositorios externos u organizaciones. Debes usar un Personal Access Token (Classic) con permiso 'repo' (inicia con ghp_...) en .env.");
      }
      throw error;
    }
    return { url: pr.html_url, number: pr.number, commitSha: commit.sha, branch: `${forkRepo}:${branchName}` };
  }

  async function postIssueComment(repo, number, body) {
    return api(`/repos/${repo}/issues/${number}/comments`, { method: "POST", body: JSON.stringify({ body }) });
  }

  return { repoInfo, issueThread, listDir, readFile, searchCode, currentUser, openPullRequest, postIssueComment };
}

async function waitFor(check, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("Tiempo de espera agotado creando el fork");
}
