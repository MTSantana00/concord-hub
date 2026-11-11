// Nível do microfone medido pelo portão de voz (para o medidor da tela). Fica num módulo pequeno e separado
// para a tela poder ouvir os níveis sem carregar o filtro de ruído inteiro.
export interface GateLevel {
  /** Volume atual do microfone depois do filtro, em dB (0 é o máximo; -60 é quase silêncio). */
  db: number;
  /** Limite que o portão está usando agora, em dB. */
  threshold: number;
  /** O portão está aberto (deixando a voz passar)? */
  open: boolean;
}

const listeners = new Set<(level: GateLevel) => void>();

export function onGateLevel(listener: (level: GateLevel) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitGateLevel(level: GateLevel) {
  for (const l of listeners) l(level);
}
