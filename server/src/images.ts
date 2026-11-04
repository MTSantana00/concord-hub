import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Fotos de perfil e ícones de servidor: pequenas, só PNG, JPEG ou WebP. */
export const MAX_IMAGE_BYTES = 256 * 1024;

const FORMATS: { mime: string; match: (b: Buffer) => boolean }[] = [
  { mime: "image/png", match: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/jpeg", match: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/webp", match: (b) => b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP" },
];

/** Imagem de qualquer tamanho para anexos (aceita GIF além dos formatos de perfil); o limite de tamanho é de quem chama. */
export function detectAttachmentImage(body: Buffer): string | null {
  if (body.length > 6 && (body.toString("latin1", 0, 6) === "GIF87a" || body.toString("latin1", 0, 6) === "GIF89a")) return "image/gif";
  return FORMATS.find((f) => f.match(body))?.mime ?? null;
}

/** O tipo da imagem pelos BYTES (não pelo que o cliente disse), ou null se não for um formato aceito. */
export function sniffImage(body: unknown): string | null {
  if (!Buffer.isBuffer(body) || body.length === 0 || body.length > MAX_IMAGE_BYTES) return null;
  return FORMATS.find((f) => f.match(body))?.mime ?? null;
}

/** Caminho do arquivo: o nome é montado aqui (tipo + id), nunca vem do usuário. */
export const imagePath = (dir: string, kind: "avatar" | "icon", id: number) => join(resolve(dir), `${kind}-${id}`);

export async function saveImage(dir: string, kind: "avatar" | "icon", id: number, bytes: Buffer) {
  await mkdir(resolve(dir), { recursive: true });
  await writeFile(imagePath(dir, kind, id), bytes);
}

export const removeImage = (dir: string, kind: "avatar" | "icon", id: number) =>
  rm(imagePath(dir, kind, id), { force: true }).catch(() => {});
