import { config } from "../config.js";

async function callAi(
  path: string,
  init: RequestInit = {},
  timeoutMs = 120_000
): Promise<Record<string, unknown>> {
  if (!config.aiInternalApiToken) {
    return { ok: false, message: "AI_INTERNAL_API_TOKEN is not configured" };
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.aiInternalApiToken}`,
    "X-Nextcloud-User-Id": config.aiUserId,
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };

  const response = await fetch(`${config.aiBaseUrl}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  return {
    ok: response.ok && body.ok !== false,
    upstreamStatus: response.status,
    ...body,
  };
}

/** 统一问数入口：把自然语言问题交给 meidong 的意图路由 + LLM + 引用片段。 */
export async function askQuestion(question: string): Promise<Record<string, unknown>> {
  const q = String(question || "").trim();
  if (!q) return { ok: false, message: "question is required" };
  return callAi("/api/ask", {
    method: "POST",
    body: JSON.stringify({ question: q }),
  }, 180_000);
}

export async function searchContent(
  query: string,
  limit: number,
  mode: "keyword" | "semantic" | "hybrid"
): Promise<Record<string, unknown>> {
  const q = String(query || "").trim();
  if (!q) return { ok: false, message: "query is required" };
  const safeLimit = Math.min(Math.max(limit, 1), 50);
  const path = mode === "semantic"
    ? `/api/semantic/search?q=${encodeURIComponent(q)}&limit=${safeLimit}`
    : `/api/content/search?q=${encodeURIComponent(q)}&limit=${safeLimit}`;
  const result = await callAi(path, {}, 120_000);

  if (mode !== "hybrid" || result.ok !== true) return { ...result, mode };

  // hybrid：再补一次语义结果，按 file_path + chunk_id 去重。
  const semantic = await callAi(
    `/api/semantic/search?q=${encodeURIComponent(q)}&limit=${safeLimit}`,
    {},
    120_000
  );
  const items = Array.isArray(result.items) ? [...result.items] : [];
  const seen = new Set(
    items.map((item) => {
      const row = item as Record<string, unknown>;
      return `${String(row.file_path || "")}:${String(row.chunk_id ?? row.chunk_index ?? "")}`;
    })
  );
  for (const item of (Array.isArray(semantic.items) ? semantic.items : [])) {
    const row = item as Record<string, unknown>;
    const key = `${String(row.file_path || "")}:${String(row.chunk_id ?? row.chunk_index ?? "")}`;
    if (!seen.has(key)) {
      seen.add(key);
      items.push(item);
    }
  }
  return { ...result, mode, hybridCount: items.length, items: items.slice(0, safeLimit * 2) };
}

export async function getStats(
  scope: "summary" | "by-folder" | "by-extension" | "recent",
  limit: number
): Promise<Record<string, unknown>> {
  const routes: Record<string, string> = {
    summary: "/api/stats/summary",
    "by-folder": `/api/stats/by-folder?limit=${Math.min(Math.max(limit, 1), 500)}`,
    "by-extension": `/api/stats/by-extension?limit=${Math.min(Math.max(limit, 1), 500)}`,
    recent: `/api/stats/recent?limit=${Math.min(Math.max(limit, 1), 200)}`,
  };
  return callAi(routes[scope] || routes.summary, {}, 60_000);
}

/** 让 meidong 为本次同步新写入的 chunk 生成 pgvector 向量。 */
export async function rebuildEmbeddings(maxRounds = 10): Promise<Record<string, unknown>> {
  let totalProcessed = 0;
  let last: Record<string, unknown> = {};
  for (let round = 0; round < maxRounds; round += 1) {
    const result = await callAi("/api/embeddings/rebuild", {
      method: "POST",
      body: JSON.stringify({ limit: 2000 }),
    }, 300_000);
    last = result;
    if (result.ok !== true) break;
    const processed = Number(result.processed || 0);
    totalProcessed += processed;
    if (processed === 0 || Number(result.pending_chunks || 0) === 0) break;
  }
  return { ok: last.ok, processed: totalProcessed, last };
}
