import { ApiError } from "./api";

/** Recorta o centro da imagem em um quadrado e reduz para `size` px (JPEG): fotos de perfil e ícones ficam leves. */
export async function squareThumbnail(file: Blob, size = 256): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Este navegador não consegue preparar a imagem");
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  bitmap.close?.();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
  if (!blob) throw new Error("Não foi possível preparar a imagem");
  return blob;
}

/** Envia uma imagem como corpo cru (PUT). */
export async function putImage(path: string, blob: Blob): Promise<void> {
  const res = await fetch(path, { method: "PUT", headers: { "Content-Type": blob.type || "image/jpeg" }, body: blob, credentials: "same-origin" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError((data as { error?: string }).error ?? (res.status === 413 ? "A imagem é grande demais" : "Algo deu errado"), res.status);
  }
}
