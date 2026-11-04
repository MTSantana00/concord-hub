import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError } from "./api";

export interface User {
  id: number;
  username: string;
  /** Administradora da plataforma (a primeira conta): pode redefinir senhas. */
  isAdmin?: boolean;
  /** Entrou com uma senha temporária e precisa trocá-la. */
  mustChangePassword?: boolean;
  displayName?: string | null;
  about?: string;
  statusKind?: string;
  statusText?: string;
  avatarVersion?: number;
  /** E-mail confirmado da conta (só existe depois de confirmado com o código). */
  email?: string | null;
  emailVerified?: boolean;
  /** Conta nova que ainda não confirmou o e-mail: o app pede o código antes de abrir. */
  emailPending?: boolean;
  /** Para onde foi o último código de confirmação. */
  pendingEmail?: string | null;
}

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, inviteCode?: string | null, email?: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Lê de novo quem sou eu (depois de trocar a senha, por exemplo). */
  reload: () => Promise<void>;
  /** Conta recém-criada: o app pergunta das notificações antes de abrir. */
  onboarding: boolean;
  startOnboarding: () => void;
  finishOnboarding: () => void;
}

/** Conta recém-criada: logo depois o app pergunta se pode mandar notificações (ver NotifyOnboarding). */
const ONBOARD_KEY = "concord.onboard";
export function markOnboarding() {
  try {
    localStorage.setItem(ONBOARD_KEY, "1");
  } catch {
    // sem armazenamento: a pergunta aparece como aviso na tela depois
  }
}
export const onboardingPending = () => {
  try {
    return localStorage.getItem(ONBOARD_KEY) === "1";
  } catch {
    return false;
  }
};
export function clearOnboarding() {
  try {
    localStorage.removeItem(ONBOARD_KEY);
  } catch {
    // tudo bem
  }
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [onboarding, setOnboarding] = useState(onboardingPending);
  const startOnboarding = useCallback(() => {
    markOnboarding();
    setOnboarding(true);
  }, []);
  const finishOnboarding = useCallback(() => {
    clearOnboarding();
    setOnboarding(false);
  }, []);

  useEffect(() => {
    api<{ user: User }>("/api/auth/me")
      .then((d) => setUser(d.user))
      .catch((err) => {
        if (!(err instanceof ApiError && err.status === 401)) console.error(err);
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const d = await api<{ user: User }>("/api/auth/login", "POST", { username, password });
    setUser(d.user);
  }, []);

  const register = useCallback(async (username: string, password: string, inviteCode?: string | null, email?: string) => {
    const body: Record<string, string> = { username, password };
    if (inviteCode) body.inviteCode = inviteCode;
    if (email) body.email = email;
    const d = await api<{ user: User }>("/api/auth/register", "POST", body);
    startOnboarding();
    setUser(d.user);
  }, [startOnboarding]);

  const logout = useCallback(async () => {
    await api<void>("/api/auth/logout", "POST");
    setUser(null);
  }, []);

  const reload = useCallback(async () => {
    const d = await api<{ user: User }>("/api/auth/me");
    setUser(d.user);
  }, []);

  const value = useMemo(
    () => ({ user, loading, login, register, logout, reload, onboarding, startOnboarding, finishOnboarding }),
    [user, loading, login, register, logout, reload, onboarding, startOnboarding, finishOnboarding],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth precisa estar dentro de <AuthProvider>");
  return ctx;
}
