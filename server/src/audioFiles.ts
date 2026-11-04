import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Caminho do arquivo de áudio de uma mensagem (o nome é o id, nunca vem do usuário). */
export const audioPath = (audioDir: string, messageId: number) => join(resolve(audioDir), String(messageId));

export function removeAudioFile(audioDir: string, messageId: number) {
  return rm(audioPath(audioDir, messageId), { force: true }).catch(() => {});
}
