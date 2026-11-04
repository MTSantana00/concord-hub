import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light" | "auto";
export type FontSize = "small" | "medium" | "large";

export interface Appearance {
  theme: Theme;
  accent: string;
  fontSize: FontSize;
}

export const ACCENTS = [
  { id: "vermelho", name: "Vermelho (logo)", color: "#b3121b" },
  { id: "azul", name: "Azul-violeta", color: "#5865f2" },
  { id: "verde", name: "Verde", color: "#2d9d5c" },
  { id: "rosa", name: "Rosa", color: "#d6409f" },
  { id: "laranja", name: "Laranja", color: "#e8590c" },
  { id: "turquesa", name: "Turquesa", color: "#0e8f9c" },
  { id: "roxo", name: "Roxo", color: "#9b51e0" },
] as const;

export const FONT_PX: Record<FontSize, number> = { small: 14, medium: 16, large: 18 };

const KEY = "concord.appearance";
const DEFAULT: Appearance = { theme: "auto", accent: ACCENTS[0].id, fontSize: "medium" };

export function loadAppearance(): Appearance {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Appearance> | null;
    return {
      theme: saved?.theme === "dark" || saved?.theme === "light" || saved?.theme === "auto" ? saved.theme : DEFAULT.theme,
      accent: ACCENTS.some((a) => a.id === saved?.accent) ? (saved!.accent as string) : DEFAULT.accent,
      fontSize: saved?.fontSize === "small" || saved?.fontSize === "medium" || saved?.fontSize === "large" ? saved.fontSize : DEFAULT.fontSize,
    };
  } catch {
    return DEFAULT; // armazenamento bloqueado ou conteúdo estragado: usa o padrão
  }
}

/** Escurece uma cor #rrggbb (para o "hover" do botão de destaque). */
export function darken(hex: string, amount = 0.18): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift: number) => Math.max(0, Math.round(((n >> shift) & 255) * (1 - amount)));
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, "0")).join("")}`;
}

const prefersLight = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: light)").matches;

/** Aplica o visual na página: tema (claro/escuro), cor de destaque e tamanho da fonte. */
export function applyAppearance(a: Appearance) {
  const root = document.documentElement;
  const light = a.theme === "light" || (a.theme === "auto" && prefersLight());
  root.dataset.theme = light ? "light" : "dark";
  const accent = ACCENTS.find((x) => x.id === a.accent)?.color ?? ACCENTS[0].color;
  root.style.setProperty("--accent", accent);
  root.style.setProperty("--accent-hover", darken(accent));
  root.style.fontSize = `${FONT_PX[a.fontSize]}px`;
}

/** O visual escolhido, guardado neste aparelho (localStorage) e aplicado na hora. */
export function useAppearance() {
  const [appearance, setAppearance] = useState<Appearance>(loadAppearance);

  const update = useCallback((patch: Partial<Appearance>) => {
    setAppearance((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // sem armazenamento: vale só até recarregar
      }
      applyAppearance(next);
      return next;
    });
  }, []);

  // No modo automático, acompanha o sistema quando ele troca de claro para escuro
  useEffect(() => {
    if (appearance.theme !== "auto" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => applyAppearance(appearance);
    media.addEventListener?.("change", onChange);
    return () => media.removeEventListener?.("change", onChange);
  }, [appearance]);

  return { appearance, update };
}
