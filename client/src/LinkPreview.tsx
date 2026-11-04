import { useEffect, useState } from "react";
import { api } from "./api";

interface Preview {
  url: string;
  title: string;
  description: string;
  site: string;
}

/** Cartão com título e descrição do primeiro link da mensagem (o servidor busca a página, nunca o navegador). */
export function LinkPreview({ url }: { url: string }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<{ preview: Preview | null }>(`/api/link-preview?url=${encodeURIComponent(url)}`)
      .then((d) => {
        if (!cancelled) setPreview(d.preview);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [url]);
  if (!preview) return null;
  return (
    <a className="link-preview" href={preview.url} target="_blank" rel="noopener noreferrer nofollow">
      <span className="link-preview-site">{preview.site}</span>
      {preview.title && <strong>{preview.title}</strong>}
      {preview.description && <span className="link-preview-desc">{preview.description}</span>}
    </a>
  );
}
