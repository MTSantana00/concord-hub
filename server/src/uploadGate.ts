import type { RequestHandler } from "express";

/** Quantos envios de arquivo (anexo ou áudio) o servidor recebe ao mesmo tempo. Cada um ocupa memória até terminar. */
export const MAX_CONCURRENT_UPLOADS = 4;

/**
 * Porteiro dos envios: se já há envios demais em andamento, pede para tentar de novo em instantes
 * (o limite de tamanho de cada envio continua com quem lê o corpo).
 * Um porteiro só serve a todas as rotas de envio (a contagem é global, do servidor inteiro).
 */
export function uploadGate(max = MAX_CONCURRENT_UPLOADS): RequestHandler {
  let active = 0;
  return (req, res, next) => {
    if (active >= max) {
      res.set("Retry-After", "3");
      res.status(503).json({ error: "O servidor está recebendo outros arquivos agora. Tente de novo em instantes." });
      return;
    }
    active++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active--;
    };
    res.on("close", release); // vale também para quem desiste no meio do envio
    res.on("finish", release);
    next();
  };
}
