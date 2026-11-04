export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** Envia um arquivo de áudio como corpo cru (não JSON). */
export async function uploadAudio<T>(path: string, blob: Blob, durationMs: number): Promise<T> {
  const res = await fetch(`${path}?ms=${Math.round(durationMs)}`, {
    method: "POST",
    headers: { "Content-Type": blob.type || "audio/webm" },
    body: blob,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const tooBig = res.status === 413 ? "O áudio é grande demais (limite de 5 MB)" : undefined;
    throw new ApiError((data as { error?: string }).error ?? tooBig ?? "Algo deu errado", res.status);
  }
  return data as T;
}

/** Envia um arquivo qualquer como corpo cru; nome, legenda e resposta vão na própria URL. */
export async function uploadFile<T>(path: string, file: Blob, params: { name: string; caption?: string; replyTo?: number | null }): Promise<T> {
  const q = new URLSearchParams({ name: params.name });
  if (params.caption) q.set("caption", params.caption);
  if (params.replyTo) q.set("replyTo", String(params.replyTo));
  const res = await fetch(`${path}?${q}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const tooBig = res.status === 413 ? "O arquivo é grande demais (limite de 8 MB)" : undefined;
    throw new ApiError((data as { error?: string }).error ?? tooBig ?? "Algo deu errado", res.status);
  }
  return data as T;
}

export async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as { error?: string }).error ?? "Algo deu errado", res.status);
  return data as T;
}
