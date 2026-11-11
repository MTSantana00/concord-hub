import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { resetNotifyPrefs } from "./notifyPrefs";
import { getHotkeys, reloadHotkeys } from "./hotkeys";
import { resetVoicePrefs } from "./voicePrefs";
import { playCallSound, playSound } from "./sounds";

vi.mock("./sounds", () => ({ playSound: vi.fn(), playCallSound: vi.fn() }));
const playSoundMock = vi.mocked(playSound);

/** LiveKit falso: o teste vê o que o app pediu (conectar, ligar microfone) e dispara eventos. */
const livekit = vi.hoisted(() => {
  class FakeRoom {
    static instances: FakeRoom[] = [];
    handlers: Record<string, (...args: any[]) => void> = {};
    canPlaybackAudio = true;
    connect = vi.fn(async (_url: string, _token: string) => {});
    disconnect = vi.fn(async () => {});
    startAudio = vi.fn(async () => {});
    localParticipant: any = {
      identity: "1",
      isMicrophoneEnabled: true,
      isCameraEnabled: false,
      isScreenShareEnabled: false,
      pubs: {} as Record<string, unknown>,
      getTrackPublication(source: string) {
        return this.pubs[source];
      },
      setMicrophoneEnabled: vi.fn(async (_on: boolean) => {}),
      setCameraEnabled: vi.fn(async (_on: boolean) => {}),
      setScreenShareEnabled: vi.fn(async (_on: boolean, _capture?: unknown, _publish?: unknown) => {}),
    };
    remoteParticipants = new Map<string, any>();
    switchActiveDevice = vi.fn(async (_kind: string, _id: string) => true);
    /** O próximo Room criado já nasce com o microfone negado (a criação é assíncrona: não dá para configurar depois). */
    static nextMicError: unknown = null;
    constructor(public options?: any) {
      FakeRoom.instances.push(this);
      if (FakeRoom.nextMicError) {
        this.localParticipant.setMicrophoneEnabled.mockRejectedValueOnce(FakeRoom.nextMicError);
        FakeRoom.nextMicError = null;
      }
    }
    on(event: string, handler: (...args: any[]) => void) {
      this.handlers[event] = handler;
      return this;
    }
  }
  return { FakeRoom };
});
// o filtro forte de ruído usa AudioWorklet (que o jsdom não tem): aqui só importa que ele é ligado na faixa
vi.mock("./micTest", () => ({ startMicTest: vi.fn(async (_filtrado: boolean) => ({ stop: vi.fn() })) }));
vi.mock("./noiseProcessor", () => ({ createNoiseProcessor: () => ({ name: "concord-noise-suppression" }) }));
vi.mock("livekit-client", () => ({
  Room: livekit.FakeRoom,
  RoomEvent: {
    TrackSubscribed: "trackSubscribed",
    TrackUnsubscribed: "trackUnsubscribed",
    AudioPlaybackStatusChanged: "audioPlaybackStatusChanged",
    Disconnected: "disconnected",
    ActiveSpeakersChanged: "activeSpeakersChanged",
    TrackMuted: "trackMuted",
    TrackUnmuted: "trackUnmuted",
    TrackPublished: "trackPublished",
    TrackUnpublished: "trackUnpublished",
    LocalTrackPublished: "localTrackPublished",
    LocalTrackUnpublished: "localTrackUnpublished",
    ParticipantConnected: "participantConnected",
    ParticipantDisconnected: "participantDisconnected",
  },
  Track: { Kind: { Audio: "audio", Video: "video" }, Source: { Camera: "camera", ScreenShare: "screen_share", Microphone: "microphone", ScreenShareAudio: "screen_share_audio" } },
}));

/** WebSocket falso: o teste controla quando abre, fecha e recebe eventos. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  readyState = 1;
  sent: unknown[] = [];
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.onclose?.();
  }
  /** Simula o servidor mandando um evento. */
  emit(event: unknown) {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  livekit.FakeRoom.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.removeItem("concord.onboard");
  localStorage.removeItem("concord.hotkeys");
  reloadHotkeys();
});

type Handler = (body: unknown) => { status: number; body?: unknown };

/** fetch falso que responde por "METODO /rota". Rota não prevista falha o teste. */
function stubApi(routes: Record<string, Handler>) {
  const calls: { key: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (path: string, init?: { method?: string; body?: unknown }) => {
    const key = `${init?.method ?? "GET"} ${path}`;
    // Corpo JSON vira objeto; arquivo (áudio) segue como está
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    calls.push({ key, body });
    // Histórico vazio por padrão, para os testes que não tratam de mensagens
    const semMensagens = /^GET \/api\/channels\/\d+\/messages$/.test(key);
    const semMembros = /^GET \/api\/servers\/\d+\/members$/.test(key);
    const semVoz = /^GET \/api\/servers\/\d+\/voice$/.test(key);
    const semCargos = /^GET \/api\/servers\/\d+\/roles$/.test(key);
    const padrao = semCargos
      ? () => ({ status: 200, body: { roles: [], permissions: [], me: { isOwner: false, roleId: null, permissions: [] } } })
      : key === "POST /api/voice/token"
      ? () => ({ status: 200, body: { token: "chave-de-teste", url: "ws://midia.teste" } })
      : semMensagens
      ? () => ({ status: 200, body: { messages: [] } })
      : semVoz
        ? () => ({ status: 200, body: { participants: [] } })
        : semMembros
        ? () => ({ status: 200, body: { members: [] } })
        : key === "GET /api/auth/mail"
          ? () => ({ status: 200, body: { enabled: false } })
        : key === "GET /api/auth/oauth/providers"
          ? () => ({ status: 200, body: { google: false, github: false } })
        : key === "GET /api/unread"
          ? () => ({ status: 200, body: { channels: {}, dms: {}, mutes: { channels: [], servers: [], dms: [] } } })
          : /^PUT \/api\/(channels|dms)\/\d+\/read$/.test(key)
            ? () => ({ status: 204 })
        : key === "GET /api/dms"
          ? () => ({ status: 200, body: { dms: [] } })
          : undefined;
    const handler = routes[key] ?? padrao;
    if (!handler) throw new Error(`rota não prevista no teste: ${key}`);
    const r = handler(body);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: () => Promise.resolve(r.body ?? {}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

const ana = { id: 1, username: "ana" };
const naoLogado = { status: 401, body: { error: "Não autenticado" } };

describe("autenticação", () => {
  it("sem sessão mostra o formulário de entrar", async () => {
    stubApi({ "GET /api/auth/me": () => naoLogado });
    render(<App />);
    expect(await screen.findByRole("button", { name: "Entrar" })).toBeTruthy();
  });

  it("faz login pelo formulário e abre o espaço de trabalho", async () => {
    const calls = stubApi({
      "GET /api/auth/me": () => naoLogado,
      "POST /api/auth/login": () => ({ status: 200, body: { user: ana } }),
      "GET /api/servers": () => ({ status: 200, body: { servers: [] } }),
    });
    render(<App />);

    await userEvent.type(await screen.findByLabelText("Usuário"), "ana");
    await userEvent.type(screen.getByLabelText("Senha"), "senha-bem-longa");
    await userEvent.click(screen.getByRole("button", { name: "Entrar" }));

    expect(await screen.findByText("Criar um servidor")).toBeTruthy();
    expect(calls.find((c) => c.key === "POST /api/auth/login")?.body).toEqual({
      username: "ana",
      password: "senha-bem-longa",
    });
  });

  it("mostra a mensagem de erro quando o login falha", async () => {
    stubApi({
      "GET /api/auth/me": () => naoLogado,
      "POST /api/auth/login": () => ({ status: 401, body: { error: "Usuário ou senha inválidos" } }),
    });
    render(<App />);

    await userEvent.type(await screen.findByLabelText("Usuário"), "ana");
    await userEvent.type(screen.getByLabelText("Senha"), "errada-errada");
    await userEvent.click(screen.getByRole("button", { name: "Entrar" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Usuário ou senha inválidos");
  });

  it("alterna para o formulário de registro", async () => {
    stubApi({ "GET /api/auth/me": () => naoLogado });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /Registre-se/ }));
    expect(screen.getByRole("button", { name: "Criar conta" })).toBeTruthy();
  });

  it("sair volta para a tela de entrar", async () => {
    stubApi({
      "GET /api/auth/me": () => ({ status: 200, body: { user: ana } }),
      "GET /api/servers": () => ({ status: 200, body: { servers: [] } }),
      "POST /api/auth/logout": () => ({ status: 204 }),
    });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Sair" }));
    expect(await screen.findByRole("button", { name: "Entrar" })).toBeTruthy();
  });
});

describe("servidores", () => {
  const servidor = { id: 7, name: "Os Parças", ownerId: 1, channels: [{ id: 3, name: "geral" }] };

  it("mostra meus servidores e o canal #geral", async () => {
    stubApi({
      "GET /api/auth/me": () => ({ status: 200, body: { user: ana } }),
      "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
    });
    render(<App />);

    expect(await screen.findByRole("button", { name: "Os Parças" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "# geral" })).toBeTruthy();
  });

  it("quem não tem servidor é convidado a criar o primeiro, e ele aparece com #geral", async () => {
    const calls = stubApi({
      "GET /api/auth/me": () => ({ status: 200, body: { user: ana } }),
      "GET /api/servers": () => ({ status: 200, body: { servers: [] } }),
      "POST /api/servers": () => ({ status: 201, body: { server: servidor } }),
    });
    render(<App />);

    await userEvent.type(await screen.findByLabelText("Nome do servidor"), "Os Parças");
    await userEvent.click(screen.getByRole("button", { name: "Criar" }));

    expect(await screen.findByRole("button", { name: "Os Parças" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "# geral" })).toBeTruthy();
    expect(calls.find((c) => c.key === "POST /api/servers")?.body).toEqual({ name: "Os Parças" });
  });

  it("mostra o erro do servidor ao criar", async () => {
    stubApi({
      "GET /api/auth/me": () => ({ status: 200, body: { user: ana } }),
      "GET /api/servers": () => ({ status: 200, body: { servers: [] } }),
      "POST /api/servers": () => ({ status: 400, body: { error: "O nome do servidor deve ter de 1 a 50 caracteres" } }),
    });
    render(<App />);

    await userEvent.type(await screen.findByLabelText("Nome do servidor"), "x");
    await userEvent.click(screen.getByRole("button", { name: "Criar" }));
    expect((await screen.findByRole("alert")).textContent).toContain("1 a 50");
  });
});

describe("convites", () => {
  const servidor = { id: 7, name: "Os Parças", ownerId: 1, channels: [{ id: 3, name: "geral" }] };

  afterEach(() => window.history.replaceState(null, "", "/"));

  it("o dono gera e vê o link de convite", async () => {
    stubApi({
      "GET /api/auth/me": () => ({ status: 200, body: { user: ana } }),
      "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
      "POST /api/servers/7/invites": () => ({ status: 201, body: { code: "abc123" } }),
    });
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "Convidar amigos" }));
    const campo = (await screen.findByLabelText("Link de convite")) as HTMLInputElement;
    expect(campo.value).toBe(`${window.location.origin}/convite/abc123`);
  });

  it("quem não é dono não vê o botão de convidar", async () => {
    stubApi({
      "GET /api/auth/me": () => ({ status: 200, body: { user: { id: 2, username: "beto" } } }),
      "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
    });
    render(<App />);
    await screen.findByRole("button", { name: "Os Parças" });
    expect(screen.queryByRole("button", { name: "Convidar amigos" })).toBeNull();
  });

  it("abrir /convite/<código> já logado entra no servidor e limpa o endereço", async () => {
    window.history.pushState(null, "", "/convite/abc123");
    const calls = stubApi({
      "GET /api/auth/me": () => ({ status: 200, body: { user: { id: 2, username: "beto" } } }),
      "POST /api/invites/abc123/join": () => ({ status: 200, body: { server: servidor } }),
      "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
    });
    render(<App />);

    expect(await screen.findByRole("button", { name: "Os Parças" })).toBeTruthy();
    expect(calls.map((c) => c.key)).toContain("POST /api/invites/abc123/join");
    expect(window.location.pathname).toBe("/");
  });

  it("sem login, mostra o aviso de convite e entra no servidor depois do login", async () => {
    window.history.pushState(null, "", "/convite/abc123");
    stubApi({
      "GET /api/auth/me": () => naoLogado,
      "POST /api/auth/login": () => ({ status: 200, body: { user: { id: 2, username: "beto" } } }),
      "POST /api/invites/abc123/join": () => ({ status: 200, body: { server: servidor } }),
      "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
    });
    render(<App />);

    expect(await screen.findByText(/Você foi convidado/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Usuário"), "beto");
    await userEvent.type(screen.getByLabelText("Senha"), "senha-bem-longa");
    await userEvent.click(screen.getByRole("button", { name: "Entrar" }));

    expect(await screen.findByRole("button", { name: "Os Parças" })).toBeTruthy();
  });

  it("convite inválido mostra o erro mas abre o app normalmente", async () => {
    window.history.pushState(null, "", "/convite/ruim");
    stubApi({
      "GET /api/auth/me": () => ({ status: 200, body: { user: ana } }),
      "POST /api/invites/ruim/join": () => ({ status: 404, body: { error: "Convite inválido ou expirado" } }),
      "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
    });
    render(<App />);

    expect((await screen.findByRole("alert")).textContent).toBe("Convite inválido ou expirado");
    expect(screen.getByRole("button", { name: "Os Parças" })).toBeTruthy();
  });
});

describe("canais", () => {
  const servidor = {
    id: 7,
    name: "Os Parças",
    ownerId: 1,
    channels: [
      { id: 3, name: "geral" },
      { id: 4, name: "jogos" },
    ],
  };
  const sessao = (user = ana) => ({ status: 200, body: { user } });

  it("trocar de canal muda o canal ativo", async () => {
    stubApi({
      "GET /api/auth/me": () => sessao(),
      "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
    });
    render(<App />);

    const geral = await screen.findByRole("button", { name: "# geral" });
    const jogos = screen.getByRole("button", { name: "# jogos" });
    expect(geral.getAttribute("aria-current")).toBe("true");

    await userEvent.click(jogos);
    expect(jogos.getAttribute("aria-current")).toBe("true");
    expect(geral.getAttribute("aria-current")).toBeNull();
    expect(await screen.findByLabelText("Mensagem em # jogos")).toBeTruthy();
  });

  it("o dono cria um canal e ele já fica selecionado", async () => {
    const calls = stubApi({
      "GET /api/auth/me": () => sessao(),
      "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
      "POST /api/servers/7/channels": () => ({ status: 201, body: { channel: { id: 9, name: "papo-furado" } } }),
    });
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "+ Novo canal" }));
    await userEvent.type(screen.getByLabelText("Nome do canal"), "Papo Furado");
    await userEvent.click(screen.getByRole("button", { name: "Criar canal" }));

    const novo = await screen.findByRole("button", { name: "# papo-furado" });
    expect(novo.getAttribute("aria-current")).toBe("true");
    expect(calls.find((c) => c.key === "POST /api/servers/7/channels")?.body).toEqual({ name: "Papo Furado" });
  });

  it("mostra o erro do servidor (nome repetido) e mantém o formulário aberto", async () => {
    stubApi({
      "GET /api/auth/me": () => sessao(),
      "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
      "POST /api/servers/7/channels": () => ({ status: 409, body: { error: "Já existe um canal com esse nome" } }),
    });
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "+ Novo canal" }));
    await userEvent.type(screen.getByLabelText("Nome do canal"), "jogos");
    await userEvent.click(screen.getByRole("button", { name: "Criar canal" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Já existe um canal com esse nome");
    expect(screen.getByLabelText("Nome do canal")).toBeTruthy();
  });

  it("quem não é dono não vê o botão de novo canal", async () => {
    stubApi({
      "GET /api/auth/me": () => sessao({ id: 2, username: "beto" }),
      "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
    });
    render(<App />);
    await screen.findByRole("button", { name: "# geral" });
    expect(screen.queryByRole("button", { name: "+ Novo canal" })).toBeNull();
  });
});

describe("mensagens", () => {
  const servidor = { id: 7, name: "Os Parças", ownerId: 1, channels: [{ id: 3, name: "geral" }, { id: 4, name: "jogos" }] };
  const msg = (id: number, content: string, channelId = 3, username = "beto") => ({
    id,
    channelId,
    serverId: 7,
    content,
    createdAt: "2026-10-29T14:05:00.000Z",
    author: { id: 2, username },
  });
  const base = {
    "GET /api/auth/me": () => ({ status: 200, body: { user: ana } }),
    "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
  };

  it("mostra o histórico do canal", async () => {
    stubApi({
      ...base,
      "GET /api/channels/3/messages": () => ({ status: 200, body: { messages: [msg(1, "bom dia"), msg(2, "e aí")] } }),
    });
    render(<App />);
    expect(await screen.findByText("bom dia")).toBeTruthy();
    expect(screen.getByText("e aí")).toBeTruthy();
  });

  it("canal vazio mostra o convite para a primeira mensagem", async () => {
    stubApi(base);
    render(<App />);
    expect(await screen.findByText(/Mande a primeira mensagem/)).toBeTruthy();
  });

  it("envia uma mensagem: aparece na lista e limpa a caixa", async () => {
    const calls = stubApi({
      ...base,
      "POST /api/channels/3/messages": () => ({ status: 201, body: { message: msg(5, "oi pessoal", 3, "ana") } }),
    });
    render(<App />);

    const caixa = (await screen.findByLabelText("Mensagem em # geral")) as HTMLInputElement;
    await userEvent.type(caixa, "  oi pessoal  ");
    await userEvent.click(screen.getByRole("button", { name: "Enviar" }));

    expect(await screen.findByText("oi pessoal")).toBeTruthy();
    expect(caixa.value).toBe("");
    expect(calls.find((c) => c.key === "POST /api/channels/3/messages")?.body).toEqual({ content: "oi pessoal" });
  });

  it("não envia mensagem vazia", async () => {
    const calls = stubApi(base);
    render(<App />);
    const enviar = (await screen.findByRole("button", { name: "Enviar" })) as HTMLButtonElement;
    expect(enviar.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("Mensagem em # geral"), "   ");
    expect(enviar.disabled).toBe(true);
    expect(calls.some((c) => c.key.startsWith("POST /api/channels"))).toBe(false);
  });

  it("mostra o erro quando o envio falha e mantém o texto", async () => {
    stubApi({
      ...base,
      "POST /api/channels/3/messages": () => ({ status: 400, body: { error: "A mensagem deve ter de 1 a 2000 caracteres" } }),
    });
    render(<App />);
    const caixa = (await screen.findByLabelText("Mensagem em # geral")) as HTMLInputElement;
    await userEvent.type(caixa, "oi");
    await userEvent.click(screen.getByRole("button", { name: "Enviar" }));

    expect((await screen.findByRole("alert")).textContent).toContain("1 a 2000");
    expect(caixa.value).toBe("oi");
  });

  it("recebe em tempo real as mensagens do canal aberto e ignora as de outros canais", async () => {
    stubApi(base);
    render(<App />);
    await screen.findByLabelText("Mensagem em # geral");

    const ws = FakeWebSocket.instances[0];
    ws.emit({ type: "message.created", message: msg(10, "chegou pelo socket") });
    ws.emit({ type: "message.created", message: msg(11, "é de outro canal", 4) });

    expect(await screen.findByText("chegou pelo socket")).toBeTruthy();
    expect(screen.queryByText("é de outro canal")).toBeNull();
  });

  it("não duplica a mensagem quando ela chega pela resposta e pelo socket", async () => {
    stubApi({
      ...base,
      "POST /api/channels/3/messages": () => ({ status: 201, body: { message: msg(5, "uma só vez", 3, "ana") } }),
    });
    render(<App />);
    await userEvent.type(await screen.findByLabelText("Mensagem em # geral"), "uma só vez");
    await userEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await screen.findByText("uma só vez");

    FakeWebSocket.instances[0].emit({ type: "message.created", message: msg(5, "uma só vez", 3, "ana") });
    expect(screen.getAllByText("uma só vez")).toHaveLength(1);
  });

  it("trocar de canal carrega o histórico do outro canal", async () => {
    stubApi({
      ...base,
      "GET /api/channels/3/messages": () => ({ status: 200, body: { messages: [msg(1, "só no geral")] } }),
      "GET /api/channels/4/messages": () => ({ status: 200, body: { messages: [msg(2, "só nos jogos", 4)] } }),
    });
    render(<App />);
    await screen.findByText("só no geral");

    await userEvent.click(screen.getByRole("button", { name: "# jogos" }));
    expect(await screen.findByText("só nos jogos")).toBeTruthy();
    expect(screen.queryByText("só no geral")).toBeNull();
  });

  it("texto com HTML aparece como texto, sem virar elemento", async () => {
    stubApi({
      ...base,
      "GET /api/channels/3/messages": () => ({ status: 200, body: { messages: [msg(1, "<b>negrito?</b>")] } }),
    });
    render(<App />);
    const p = await screen.findByText("<b>negrito?</b>");
    expect(p.querySelector("b")).toBeNull();
  });

  it("ao reconectar o socket, recarrega o histórico para pegar o que perdeu", async () => {
    let chamadas = 0;
    stubApi({
      ...base,
      "GET /api/channels/3/messages": () => {
        chamadas++;
        return { status: 200, body: { messages: chamadas === 1 ? [] : [msg(1, "perdida enquanto offline")] } };
      },
    });
    render(<App />);
    await screen.findByLabelText("Mensagem em # geral");

    FakeWebSocket.instances[0].close(); // a conexão cai...
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2), { timeout: 3000 }); // ...e o app tenta de novo
    FakeWebSocket.instances[1].onopen?.(); // reconectou

    expect(await screen.findByText("perdida enquanto offline")).toBeTruthy();
  });
});

describe("membros e presença", () => {
  const servidor = { id: 7, name: "Os Parças", ownerId: 1, channels: [{ id: 3, name: "geral" }] };
  const membros = [
    { id: 1, username: "ana", online: false, isOwner: true },
    { id: 2, username: "beto", online: false, isOwner: false },
    { id: 3, username: "carla", online: true, isOwner: false },
  ];
  const base = {
    "GET /api/auth/me": () => ({ status: 200, body: { user: ana } }),
    "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
    "GET /api/servers/7/members": () => ({ status: 200, body: { members: membros } }),
  };

  /** [nome, "online"|"offline"] na ordem em que a lista mostra. */
  function lista() {
    const itens = within(screen.getByRole("region", { name: "Membros" })).getAllByRole("listitem");
    return itens.map((li) => [
      li.querySelector(".member-name")!.textContent,
      within(li).getByRole("img").getAttribute("aria-label"),
    ]);
  }

  it("lista os membros com online primeiro; quem está com o app aberto conta como online", async () => {
    stubApi(base);
    render(<App />);
    await screen.findByText("carla");

    // ana (eu) é online mesmo com o retrato dizendo offline; depois carla; beto offline por último
    expect(lista()).toEqual([
      ["ana", "online"],
      ["carla", "online"],
      ["beto", "offline"],
    ]);
    expect(screen.getByText("Membros — 2 online")).toBeTruthy();
    expect(screen.getByText("dono")).toBeTruthy();
  });

  it("atualiza a bolinha quando chega um aviso de presença", async () => {
    stubApi(base);
    render(<App />);
    await screen.findByText("carla");
    const ws = FakeWebSocket.instances[0];

    act(() => ws.emit({ type: "presence.updated", userId: 2, online: true }));
    await vi.waitFor(() => expect(lista()).toContainEqual(["beto", "online"]));
    expect(screen.getByText("Membros — 3 online")).toBeTruthy();

    act(() => ws.emit({ type: "presence.updated", userId: 3, online: false }));
    await vi.waitFor(() => expect(lista()).toContainEqual(["carla", "offline"]));
    expect(screen.getByText("Membros — 2 online")).toBeTruthy();
  });

  it("mostra na hora quem acabou de entrar no servidor", async () => {
    stubApi(base);
    render(<App />);
    await screen.findByText("carla");

    const novo = { id: 9, username: "dani", online: false, isOwner: false };
    act(() => FakeWebSocket.instances[0].emit({ type: "member.joined", serverId: 7, member: novo }));
    expect(await screen.findByText("dani")).toBeTruthy();

    // o mesmo aviso de novo, ou de outro servidor, não duplica nem mistura
    act(() => FakeWebSocket.instances[0].emit({ type: "member.joined", serverId: 7, member: novo }));
    act(() => FakeWebSocket.instances[0].emit({ type: "member.joined", serverId: 99, member: { ...novo, id: 10, username: "intruso" } }));
    expect(screen.getAllByText("dani")).toHaveLength(1);
    expect(screen.queryByText("intruso")).toBeNull();
  });

  it("mostra o erro se não conseguir carregar os membros", async () => {
    stubApi({ ...base, "GET /api/servers/7/members": () => ({ status: 500, body: { error: "Falhou" } }) });
    render(<App />);
    expect((await screen.findByRole("alert")).textContent).toBe("Falhou");
  });
});

describe("mensagens diretas", () => {
  const servidor = { id: 7, name: "Os Parças", ownerId: 1, channels: [{ id: 3, name: "geral" }] };
  const membros = [
    { id: 1, username: "ana", online: true, isOwner: true },
    { id: 2, username: "beto", online: true, isOwner: false },
  ];
  const dmBeto = { id: 20, user: { id: 2, username: "beto", online: true } };
  const msgDm = (id: number, content: string, dmId = 20, username = "beto") => ({
    id,
    channelId: null,
    dmId,
    serverId: null,
    content,
    createdAt: "2026-10-29T14:05:00.000Z",
    author: { id: 2, username },
  });
  const base = {
    "GET /api/auth/me": () => ({ status: 200, body: { user: ana } }),
    "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
    "GET /api/servers/7/members": () => ({ status: 200, body: { members: membros } }),
  };

  it("clicar no nome de um membro abre a conversa direta com ele", async () => {
    const calls = stubApi({ ...base, "POST /api/dms": () => ({ status: 201, body: { dm: dmBeto } }) });
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "Mensagem direta para beto" }));

    expect(await screen.findByLabelText("Mensagem para @beto")).toBeTruthy();
    expect(screen.getByText("Mensagens diretas", { selector: "header" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /beto/, current: true })).toBeTruthy(); // na lista de conversas
    expect(calls.find((c) => c.key === "POST /api/dms")?.body).toEqual({ userId: 2 });
    // nada de servidor na tela de DMs
    expect(screen.queryByRole("region", { name: "Membros" })).toBeNull();
    expect(screen.queryByRole("button", { name: "# geral" })).toBeNull();
  });

  it("não há link de conversa no seu próprio nome", async () => {
    stubApi(base);
    render(<App />);
    await screen.findByRole("button", { name: "Mensagem direta para beto" });
    expect(screen.queryByRole("button", { name: "Mensagem direta para ana" })).toBeNull();
  });

  it("envia e recebe mensagens na conversa, sem misturar com as de canal", async () => {
    stubApi({
      ...base,
      "GET /api/dms": () => ({ status: 200, body: { dms: [dmBeto] } }),
      "GET /api/dms/20/messages": () => ({ status: 200, body: { messages: [msgDm(1, "oi, Ana")] } }),
      "POST /api/dms/20/messages": () => ({ status: 201, body: { message: msgDm(2, "oi, Beto", 20, "ana") } }),
    });
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "Mensagens diretas" }));
    await userEvent.click(await screen.findByRole("button", { name: /beto/ }));
    expect(await screen.findByText("oi, Ana")).toBeTruthy();

    await userEvent.type(screen.getByLabelText("Mensagem para @beto"), "oi, Beto");
    await userEvent.click(screen.getByRole("button", { name: "Enviar" }));
    expect(await screen.findByText("oi, Beto")).toBeTruthy();

    const ws = FakeWebSocket.instances[0];
    act(() => ws.emit({ type: "message.created", message: msgDm(3, "chegou ao vivo") }));
    expect(await screen.findByText("chegou ao vivo")).toBeTruthy();
    // mensagem de OUTRA conversa não aparece aqui
    act(() => ws.emit({ type: "message.created", message: msgDm(4, "de outra conversa", 99) }));
    expect(screen.queryByText("de outra conversa")).toBeNull();
  });

  it("quando alguém fala comigo pela primeira vez, a conversa aparece na lista", async () => {
    let chamadas = 0;
    stubApi({
      ...base,
      "GET /api/dms": () => {
        chamadas++;
        return { status: 200, body: { dms: chamadas === 1 ? [] : [dmBeto] } };
      },
    });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Mensagens diretas" }));
    expect(await screen.findByText(/Nenhuma conversa ainda/)).toBeTruthy();

    act(() => FakeWebSocket.instances[0].emit({ type: "message.created", message: msgDm(1, "oi!") }));
    expect(await screen.findByRole("button", { name: /beto/ })).toBeTruthy();
  });

  it("a bolinha da conversa acompanha a presença", async () => {
    stubApi({ ...base, "GET /api/dms": () => ({ status: 200, body: { dms: [dmBeto] } }) });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Mensagens diretas" }));
    const botao = await screen.findByRole("button", { name: /beto/ });
    expect(within(botao).getByRole("img").getAttribute("aria-label")).toBe("online");

    act(() => FakeWebSocket.instances[0].emit({ type: "presence.updated", userId: 2, online: false }));
    await vi.waitFor(() => expect(within(botao).getByRole("img").getAttribute("aria-label")).toBe("offline"));
  });

  it("voltar para o servidor mostra os canais de novo", async () => {
    stubApi({ ...base, "GET /api/dms": () => ({ status: 200, body: { dms: [dmBeto] } }) });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Mensagens diretas" }));
    expect(screen.queryByRole("button", { name: "# geral" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Os Parças" }));
    expect(await screen.findByRole("button", { name: "# geral" })).toBeTruthy();
  });

  it("mostra o erro se não conseguir abrir a conversa", async () => {
    stubApi({ ...base, "POST /api/dms": () => ({ status: 404, body: { error: "Usuário não encontrado" } }) });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Mensagem direta para beto" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Usuário não encontrado");
  });
});

describe("editar, apagar e carregar anteriores", () => {
  const servidor = { id: 7, name: "Os Parças", ownerId: 1, channels: [{ id: 3, name: "geral" }] };
  const msg = (id: number, content: string, authorId: number, extra: object = {}) => ({
    id,
    channelId: 3,
    dmId: null,
    serverId: 7,
    content,
    createdAt: "2026-10-29T14:05:00.000Z",
    editedAt: null,
    author: { id: authorId, username: authorId === 1 ? "ana" : "beto" },
    ...extra,
  });
  const sessao = (user = ana) => ({ "GET /api/auth/me": () => ({ status: 200, body: { user } }) });
  const comServidor = (ownerId: number) => ({
    "GET /api/servers": () => ({ status: 200, body: { servers: [{ ...servidor, ownerId }] } }),
  });
  const historico = (messages: object[], hasMore = false) => ({
    "GET /api/channels/3/messages": () => ({ status: 200, body: { messages, hasMore } }),
  });
  const beto = { id: 2, username: "beto" };

  /** A linha (li) da mensagem com esse texto. */
  const linha = (texto: string) => screen.getByText(texto).closest("li") as HTMLElement;

  it("o autor edita a própria mensagem e ela passa a mostrar (editada)", async () => {
    const calls = stubApi({
      ...sessao(beto),
      ...comServidor(1),
      ...historico([msg(1, "texto com erro", 2)]),
      "PATCH /api/channels/3/messages/1": () => ({
        status: 200,
        body: { message: msg(1, "texto corrigido", 2, { editedAt: "2026-10-29T14:06:00.000Z" }) },
      }),
    });
    render(<App />);
    await screen.findByText("texto com erro");

    await userEvent.click(within(linha("texto com erro")).getByRole("button", { name: "Editar mensagem" }));
    const campo = screen.getByLabelText("Novo texto da mensagem") as HTMLInputElement;
    expect(campo.value).toBe("texto com erro");
    await userEvent.clear(campo);
    await userEvent.type(campo, "texto corrigido");
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));

    expect(await screen.findByText("texto corrigido")).toBeTruthy();
    expect(screen.getByText("(editada)")).toBeTruthy();
    expect(screen.queryByLabelText("Novo texto da mensagem")).toBeNull();
    expect(calls.find((c) => c.key.startsWith("PATCH"))?.body).toEqual({ content: "texto corrigido" });
  });

  it("Escape cancela a edição sem chamar a API; sem mudar o texto, Salvar também não chama", async () => {
    const calls = stubApi({ ...sessao(beto), ...comServidor(1), ...historico([msg(1, "original", 2)]) });
    render(<App />);
    await screen.findByText("original");

    await userEvent.click(within(linha("original")).getByRole("button", { name: "Editar mensagem" }));
    await userEvent.type(screen.getByLabelText("Novo texto da mensagem"), " mudado{Escape}");
    expect(screen.queryByLabelText("Novo texto da mensagem")).toBeNull();
    expect(screen.getByText("original")).toBeTruthy();

    await userEvent.click(within(linha("original")).getByRole("button", { name: "Editar mensagem" }));
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(calls.some((c) => c.key.startsWith("PATCH"))).toBe(false);
  });

  it("mostra o erro quando a edição é recusada e mantém o campo aberto", async () => {
    stubApi({
      ...sessao(beto),
      ...comServidor(1),
      ...historico([msg(1, "original", 2)]),
      "PATCH /api/channels/3/messages/1": () => ({ status: 400, body: { error: "A mensagem deve ter de 1 a 2000 caracteres" } }),
    });
    render(<App />);
    await screen.findByText("original");
    await userEvent.click(within(linha("original")).getByRole("button", { name: "Editar mensagem" }));
    await userEvent.type(screen.getByLabelText("Novo texto da mensagem"), "!");
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));

    expect((await screen.findByRole("alert")).textContent).toContain("1 a 2000");
    expect(screen.getByLabelText("Novo texto da mensagem")).toBeTruthy();
  });

  it("apagar pede confirmação; cancelar não apaga, confirmar apaga", async () => {
    const calls = stubApi({
      ...sessao(beto),
      ...comServidor(1),
      ...historico([msg(1, "para apagar", 2)]),
      "DELETE /api/channels/3/messages/1": () => ({ status: 204 }),
    });
    render(<App />);
    await screen.findByText("para apagar");

    await userEvent.click(within(linha("para apagar")).getByRole("button", { name: "Apagar mensagem" }));
    const grupo = screen.getByRole("group", { name: "Confirmar exclusão" });
    await userEvent.click(within(grupo).getByRole("button", { name: "Cancelar" }));
    expect(screen.getByText("para apagar")).toBeTruthy();
    expect(calls.some((c) => c.key.startsWith("DELETE"))).toBe(false);

    await userEvent.click(within(linha("para apagar")).getByRole("button", { name: "Apagar mensagem" }));
    await userEvent.click(within(screen.getByRole("group", { name: "Confirmar exclusão" })).getByRole("button", { name: "Apagar" }));
    await vi.waitFor(() => expect(screen.queryByText("para apagar")).toBeNull());
    expect(calls.some((c) => c.key === "DELETE /api/channels/3/messages/1")).toBe(true);
  });

  it("o dono do servidor pode apagar mensagem de outro, mas não editar", async () => {
    stubApi({ ...sessao(), ...comServidor(1), ...historico([msg(1, "do Beto", 2)]) });
    render(<App />);
    await screen.findByText("do Beto");
    const li = linha("do Beto");
    expect(within(li).getByRole("button", { name: "Apagar mensagem" })).toBeTruthy();
    expect(within(li).queryByRole("button", { name: "Editar mensagem" })).toBeNull();
  });

  it("um membro comum não vê botões na mensagem de outro", async () => {
    stubApi({ ...sessao(beto), ...comServidor(1), ...historico([msg(1, "da Ana", 1)]) });
    render(<App />);
    await screen.findByText("da Ana");
    const li = linha("da Ana");
    expect(within(li).queryByRole("button", { name: "Editar mensagem" })).toBeNull();
    expect(within(li).queryByRole("button", { name: "Apagar mensagem" })).toBeNull();
  });

  it("mostra o erro quando apagar é recusado", async () => {
    stubApi({
      ...sessao(beto),
      ...comServidor(1),
      ...historico([msg(1, "teimosa", 2)]),
      "DELETE /api/channels/3/messages/1": () => ({ status: 404, body: { error: "Mensagem não encontrada" } }),
    });
    render(<App />);
    await screen.findByText("teimosa");
    await userEvent.click(within(linha("teimosa")).getByRole("button", { name: "Apagar mensagem" }));
    await userEvent.click(within(screen.getByRole("group", { name: "Confirmar exclusão" })).getByRole("button", { name: "Apagar" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Mensagem não encontrada");
    expect(screen.getByText("teimosa")).toBeTruthy();
  });

  it("edições e exclusões de outras pessoas aparecem em tempo real", async () => {
    stubApi({ ...sessao(beto), ...comServidor(1), ...historico([msg(1, "da Ana", 1), msg(2, "outra", 1)]) });
    render(<App />);
    await screen.findByText("da Ana");
    const ws = FakeWebSocket.instances[0];

    act(() => ws.emit({ type: "message.updated", message: msg(1, "da Ana (editada ao vivo)", 1, { editedAt: "2026-10-29T14:06:00.000Z" }) }));
    expect(await screen.findByText("da Ana (editada ao vivo)")).toBeTruthy();
    expect(screen.getByText("(editada)")).toBeTruthy();

    act(() => ws.emit({ type: "message.deleted", id: 2, channelId: 3, dmId: null, serverId: 7 }));
    await vi.waitFor(() => expect(screen.queryByText("outra")).toBeNull());

    // eventos de outro canal não mexem nesta conversa
    act(() => ws.emit({ type: "message.deleted", id: 1, channelId: 99, dmId: null, serverId: 7 }));
    act(() => ws.emit({ type: "message.updated", message: msg(1, "de outro canal", 1, { channelId: 99 }) }));
    expect(screen.getByText("da Ana (editada ao vivo)")).toBeTruthy();
  });

  it("carrega as mensagens anteriores sem repetir e esconde o botão quando acabam", async () => {
    const calls = stubApi({
      ...sessao(),
      ...comServidor(1),
      ...historico([msg(51, "nova 51", 2), msg(52, "nova 52", 2)], true),
      "GET /api/channels/3/messages?before=51": () => ({
        status: 200,
        body: { messages: [msg(49, "antiga 49", 2), msg(50, "antiga 50", 2)], hasMore: true },
      }),
      "GET /api/channels/3/messages?before=49": () => ({
        status: 200,
        body: { messages: [msg(48, "antiga 48", 2)], hasMore: false },
      }),
    });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Carregar mensagens anteriores" }));
    expect(await screen.findByText("antiga 50")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Carregar mensagens anteriores" }));
    expect(await screen.findByText("antiga 48")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Carregar mensagens anteriores" })).toBeNull();

    const textos = within(screen.getByRole("list", { name: "Mensagens" })).getAllByText(/^(antiga|nova) \d+$/).map((e) => e.textContent);
    expect(textos).toEqual(["antiga 48", "antiga 49", "antiga 50", "nova 51", "nova 52"]);
    expect(calls.filter((c) => c.key.includes("before=")).map((c) => c.key)).toEqual([
      "GET /api/channels/3/messages?before=51",
      "GET /api/channels/3/messages?before=49",
    ]);
  });

  it("não mostra o botão de carregar anteriores quando não há mais", async () => {
    stubApi({ ...sessao(), ...comServidor(1), ...historico([msg(1, "única", 2)], false) });
    render(<App />);
    await screen.findByText("única");
    expect(screen.queryByRole("button", { name: "Carregar mensagens anteriores" })).toBeNull();
  });

  it("nas conversas diretas, editar e apagar usam o caminho das DMs", async () => {
    const dmBeto = { id: 20, user: { id: 2, username: "beto", online: true } };
    const msgDm = (id: number, content: string, extra: object = {}) => ({
      id, channelId: null, dmId: 20, serverId: null, content,
      createdAt: "2026-10-29T14:05:00.000Z", editedAt: null, author: { id: 1, username: "ana" }, ...extra,
    });
    const calls = stubApi({
      ...sessao(),
      ...comServidor(1),
      "GET /api/dms": () => ({ status: 200, body: { dms: [dmBeto] } }),
      "GET /api/dms/20/messages": () => ({ status: 200, body: { messages: [msgDm(1, "minha DM")], hasMore: false } }),
      "PATCH /api/dms/20/messages/1": () => ({ status: 200, body: { message: msgDm(1, "minha DM editada", { editedAt: "2026-10-29T14:06:00.000Z" }) } }),
      "DELETE /api/dms/20/messages/1": () => ({ status: 204 }),
    });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Mensagens diretas" }));
    await userEvent.click(await screen.findByRole("button", { name: /beto/ }));
    await screen.findByText("minha DM");

    await userEvent.click(within(linha("minha DM")).getByRole("button", { name: "Editar mensagem" }));
    await userEvent.type(screen.getByLabelText("Novo texto da mensagem"), " editada");
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(await screen.findByText("minha DM editada")).toBeTruthy();

    await userEvent.click(within(linha("minha DM editada")).getByRole("button", { name: "Apagar mensagem" }));
    await userEvent.click(within(screen.getByRole("group", { name: "Confirmar exclusão" })).getByRole("button", { name: "Apagar" }));
    await vi.waitFor(() => expect(screen.queryByText("minha DM editada")).toBeNull());
    expect(calls.map((c) => c.key)).toEqual(expect.arrayContaining(["PATCH /api/dms/20/messages/1", "DELETE /api/dms/20/messages/1"]));
  });
});

describe("mensagens de áudio", () => {
  const servidor = { id: 7, name: "Os Parças", ownerId: 1, channels: [{ id: 3, name: "geral" }] };
  const audioMsg = (id: number, authorId: number, durationMs = 4000) => ({
    id,
    channelId: 3,
    dmId: null,
    serverId: 7,
    content: "",
    createdAt: "2026-10-29T14:05:00.000Z",
    editedAt: null,
    audio: { durationMs, mime: "audio/webm" },
    author: { id: authorId, username: authorId === 1 ? "ana" : "beto" },
  });
  const base = {
    "GET /api/auth/me": () => ({ status: 200, body: { user: ana } }),
    "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
  };

  /** MediaRecorder falso: ao parar, entrega um pedaço de áudio. */
  class FakeMediaRecorder {
    static supported = (t: string) => t.startsWith("audio/webm");
    static isTypeSupported(t: string) {
      return FakeMediaRecorder.supported(t);
    }
    state = "inactive";
    mimeType: string;
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    constructor(
      public stream: unknown,
      opts?: { mimeType?: string },
    ) {
      this.mimeType = opts?.mimeType ?? "";
    }
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["som"], { type: this.mimeType }) });
      this.onstop?.();
    }
  }

  const stopTrack = vi.fn();
  const getUserMedia = vi.fn();

  function microfone(getter: () => Promise<unknown>) {
    getUserMedia.mockImplementation(getter);
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia }, configurable: true });
  }
  const microfoneOk = () => microfone(async () => ({ getTracks: () => [{ stop: stopTrack }] }));

  beforeEach(() => {
    stopTrack.mockClear();
    getUserMedia.mockReset();
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    URL.createObjectURL = vi.fn(() => "blob:gravacao");
    URL.revokeObjectURL = vi.fn();
    HTMLMediaElement.prototype.play = vi.fn(async function (this: HTMLMediaElement) {
      this.dispatchEvent(new Event("play")); // o navegador de verdade avisa que começou
    });
    HTMLMediaElement.prototype.pause = vi.fn();
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, "mediaDevices");
  });

  it("mostra o áudio do histórico com player; o autor não edita, mas pode apagar", async () => {
    stubApi({
      ...base,
      "GET /api/channels/3/messages": () => ({ status: 200, body: { messages: [audioMsg(1, 1, 65000), audioMsg(2, 2)] } }),
    });
    render(<App />);
    const meu = await screen.findByRole("group", { name: "Áudio de ana" });
    expect(within(meu).getByText("0:00 / 1:05")).toBeTruthy();
    expect(meu.querySelector("audio")?.getAttribute("src")).toBe("/api/audio/1");

    const li = meu.closest("li") as HTMLElement;
    expect(within(li).queryByRole("button", { name: "Editar mensagem" })).toBeNull();
    expect(within(li).getByRole("button", { name: "Apagar mensagem" })).toBeTruthy();

    await userEvent.click(within(meu).getByRole("button", { name: "Tocar" }));
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    expect(within(meu).getByRole("button", { name: "Pausar" })).toBeTruthy();
  });

  it("grava, ouve antes de enviar e envia; o áudio aparece na lista", async () => {
    microfoneOk();
    const calls = stubApi({
      ...base,
      "POST /api/channels/3/audio?ms=": () => ({ status: 201, body: {} }),
    });
    // a rota inclui a duração medida; responde a qualquer uma
    const original = globalThis.fetch as unknown as (p: string, i?: unknown) => Promise<unknown>;
    vi.stubGlobal("fetch", (p: string, i?: unknown) =>
      p.startsWith("/api/channels/3/audio?ms=")
        ? (calls.push({ key: `POST ${p}`, body: (i as { body: unknown }).body }),
          Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ message: audioMsg(9, 1, 1500) }) }))
        : original(p, i),
    );
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "Gravar mensagem de áudio" }));
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(await screen.findByRole("group", { name: "Gravando áudio" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Parar" }));
    expect(stopTrack).toHaveBeenCalled(); // soltou o microfone
    expect(screen.getByRole("group", { name: "Ouvir antes de enviar" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Enviar áudio" }));
    expect(await screen.findByRole("group", { name: "Áudio de ana" })).toBeTruthy();
    const envio = calls.find((c) => c.key.startsWith("POST /api/channels/3/audio?ms="))!;
    expect(envio.key).toMatch(/\?ms=\d+$/);
    expect((envio.body as Blob).type).toBe("audio/webm;codecs=opus");
    // voltou ao botão de gravar
    expect(screen.getByRole("button", { name: "Gravar mensagem de áudio" })).toBeTruthy();
  });

  it("permissão do microfone negada: mostra mensagem clara e o chat continua funcionando", async () => {
    microfone(() => Promise.reject(new DOMException("negado", "NotAllowedError")));
    stubApi({
      ...base,
      "POST /api/channels/3/messages": () => ({ status: 201, body: { message: { ...audioMsg(5, 1), content: "oi", audio: null } } }),
    });
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "Gravar mensagem de áudio" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Permissão do microfone negada/);
    expect(screen.getByRole("button", { name: "Gravar mensagem de áudio" })).toBeTruthy();

    await userEvent.type(screen.getByLabelText("Mensagem em # geral"), "oi");
    await userEvent.click(screen.getByRole("button", { name: "Enviar" }));
    expect(await screen.findByText("oi")).toBeTruthy();
  });

  it("sem microfone ou com o microfone ocupado: avisa o motivo", async () => {
    microfone(() => Promise.reject(new DOMException("x", "NotFoundError")));
    stubApi(base);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Gravar mensagem de áudio" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Nenhum microfone/);

    microfone(() => Promise.reject(new DOMException("x", "NotReadableError")));
    await userEvent.click(screen.getByRole("button", { name: "Gravar mensagem de áudio" }));
    await vi.waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/em uso por outro programa/));
  });

  it("navegador sem MediaRecorder: explica e não quebra", async () => {
    vi.stubGlobal("MediaRecorder", undefined);
    microfoneOk();
    stubApi(base);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Gravar mensagem de áudio" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/não consegue gravar áudio/);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("cancelar e descartar não enviam nada e soltam o microfone", async () => {
    microfoneOk();
    const calls = stubApi(base);
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "Gravar mensagem de áudio" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancelar" }));
    expect(stopTrack).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Gravar mensagem de áudio" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Gravar mensagem de áudio" }));
    await userEvent.click(await screen.findByRole("button", { name: "Parar" }));
    await userEvent.click(screen.getByRole("button", { name: "Descartar" }));
    expect(screen.getByRole("button", { name: "Gravar mensagem de áudio" })).toBeTruthy();
    expect(calls.some((c) => c.key.includes("/audio"))).toBe(false);
  });

  it("se o envio falha, mostra o erro e mantém a gravação para tentar de novo", async () => {
    microfoneOk();
    const original = globalThis.fetch as unknown as (p: string, i?: unknown) => Promise<unknown>;
    stubApi(base);
    const comRotas = globalThis.fetch as unknown as (p: string, i?: unknown) => Promise<unknown>;
    vi.stubGlobal("fetch", (p: string, i?: unknown) =>
      p.startsWith("/api/channels/3/audio")
        ? Promise.resolve({ ok: false, status: 413, json: () => Promise.resolve({}) })
        : (comRotas ?? original)(p, i),
    );
    render(<App />);

    await userEvent.click(await screen.findByRole("button", { name: "Gravar mensagem de áudio" }));
    await userEvent.click(await screen.findByRole("button", { name: "Parar" }));
    await userEvent.click(screen.getByRole("button", { name: "Enviar áudio" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/grande demais/);
    expect(screen.getByRole("button", { name: "Enviar áudio" })).toBeTruthy(); // gravação mantida
  });

  it("áudio de outra pessoa chega em tempo real", async () => {
    stubApi(base);
    render(<App />);
    await screen.findByText(/Mande a primeira mensagem/);
    act(() => FakeWebSocket.instances[0].emit({ type: "message.created", message: audioMsg(4, 2, 12000) }));
    const grupo = await screen.findByRole("group", { name: "Áudio de beto" });
    expect(within(grupo).getByText("0:00 / 0:12")).toBeTruthy();
  });
});

describe("canais de voz", () => {
  const servidor = {
    id: 7,
    name: "Os Parças",
    ownerId: 1,
    channels: [
      { id: 3, name: "geral", type: "text" },
      { id: 4, name: "sala-1", type: "voice" },
    ],
  };
  const base = (extra: Record<string, Handler> = {}) => ({
    "GET /api/auth/me": () => ({ status: 200, body: { user: ana } }),
    "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
    ...extra,
  });

  it("mostra o canal de voz com 🔊 e quem está nele; abrir o canal não abre chat de texto", async () => {
    stubApi(
      base({
        "GET /api/servers/7/voice": () => ({
          status: 200,
          body: { participants: [{ channelId: 4, userId: 2, username: "beto" }] },
        }),
      }),
    );
    render(<App />);
    const botao = await screen.findByRole("button", { name: "🔊 sala-1" });
    expect(await screen.findByLabelText("Na sala de voz")).toBeTruthy();
    expect(within(screen.getByLabelText("Na sala de voz")).getByText("beto")).toBeTruthy();

    await userEvent.click(botao);
    expect(screen.getByRole("heading", { name: "🔊 sala-1" })).toBeTruthy();
    expect(screen.queryByLabelText("Mensagem em # geral")).toBeNull();
    expect(screen.queryByLabelText(/Mensagem em/)).toBeNull();
  });

  it("entrar e sair mandam as mensagens pelo WebSocket e a lista muda quando o servidor avisa", async () => {
    stubApi(base());
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "🔊 sala-1" }));
    const ws = FakeWebSocket.instances[0];

    await userEvent.click(screen.getByRole("button", { name: "Entrar na sala" }));
    expect(ws.sent).toEqual([{ type: "voice.join", channelId: 4 }]);
    // só entra de fato quando o servidor confirma
    expect(screen.queryByRole("button", { name: "Sair da sala" })).toBeNull();

    act(() => ws.emit({ type: "voice.joined", serverId: 7, channelId: 4, user: { id: 1, username: "ana" } }));
    act(() => ws.emit({ type: "voice.joined", serverId: 7, channelId: 4, user: { id: 2, username: "beto" } }));
    expect(await screen.findByRole("button", { name: "Sair da sala" })).toBeTruthy();
    expect(screen.getByText("2 pessoas na sala:")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Sair da sala" }));
    expect(ws.sent[1]).toEqual({ type: "voice.leave" });
    act(() => ws.emit({ type: "voice.left", serverId: 7, channelId: 4, userId: 1 }));
    expect(await screen.findByRole("button", { name: "Entrar na sala" })).toBeTruthy();
    expect(screen.getByText("1 pessoa na sala:")).toBeTruthy();

    // eventos de outro servidor não mexem nesta lista
    act(() => ws.emit({ type: "voice.joined", serverId: 99, channelId: 4, user: { id: 5, username: "intruso" } }));
    expect(screen.queryByText("intruso")).toBeNull();
  });

  it("mostra o erro que o servidor devolve ao tentar entrar", async () => {
    stubApi(base());
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "🔊 sala-1" }));
    act(() => FakeWebSocket.instances[0].emit({ type: "error", error: "Canal de voz não encontrado" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Canal de voz não encontrado");
  });

  it("ao reconectar, recarrega quem está nas salas", async () => {
    let chamadas = 0;
    stubApi(
      base({
        "GET /api/servers/7/voice": () => ({
          status: 200,
          body: { participants: ++chamadas > 1 ? [{ channelId: 4, userId: 2, username: "beto" }] : [] },
        }),
      }),
    );
    render(<App />);
    await screen.findByRole("button", { name: "🔊 sala-1" });
    act(() => FakeWebSocket.instances[0].close());
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(2), { timeout: 3000 });
    act(() => FakeWebSocket.instances[1].onopen?.());
    expect(await screen.findByText("beto")).toBeTruthy();
  });

  it("o dono cria canal de voz marcando a opção; canal de texto continua sem tipo no pedido", async () => {
    const calls = stubApi(
      base({
        "POST /api/servers/7/channels": (body) => ({
          status: 201,
          body: { channel: { id: 8, name: (body as { name: string }).name, type: (body as { type?: string }).type ?? "text" } },
        }),
      }),
    );
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "+ Novo canal" }));
    await userEvent.type(screen.getByLabelText("Nome do canal"), "resenha");
    await userEvent.click(screen.getByLabelText("Canal de voz"));
    await userEvent.click(screen.getByRole("button", { name: "Criar canal" }));

    expect(await screen.findByRole("heading", { name: "🔊 resenha" })).toBeTruthy();
    expect(calls.find((c) => c.key === "POST /api/servers/7/channels")?.body).toEqual({ name: "resenha", type: "voice" });
  });
});

describe("voz ao vivo", () => {
  const servidor = {
    id: 7,
    name: "Os Parças",
    ownerId: 1,
    channels: [
      { id: 3, name: "geral", type: "text" },
      { id: 4, name: "sala-1", type: "voice" },
    ],
  };
  const base = (extra: Record<string, Handler> = {}) => ({
    "GET /api/auth/me": () => ({ status: 200, body: { user: ana } }),
    "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
    ...extra,
  });
  // este aparelho pede para entrar (só assim a ligação começa aqui) e o servidor confirma
  const euEntrei = () => {
    fireEvent.click(screen.getByRole("button", { name: "🔊 sala-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Entrar na sala" }));
    act(() => FakeWebSocket.instances[0].emit({ type: "voice.joined", serverId: 7, channelId: 4, user: { id: 1, username: "ana" } }));
  };
  const sala = () => livekit.FakeRoom.instances[0];

  it("ao entrar na sala: pede a chave, conecta no servidor de mídia e liga o microfone", async () => {
    const calls = stubApi(base());
    render(<App />);
    await screen.findByRole("button", { name: "🔊 sala-1" });
    euEntrei();

    const barra = await screen.findByRole("group", { name: "Chamada de voz" });
    await vi.waitFor(() => expect(within(barra).getByText("Voz conectada")).toBeTruthy());
    expect(calls.find((c) => c.key === "POST /api/voice/token")?.body).toEqual({ channelId: 4 });
    expect(sala().connect).toHaveBeenCalledWith("ws://midia.teste", "chave-de-teste");
    expect(sala().localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
  });

  it("já estou na sala por outro aparelho: não liga sozinho, pergunta se quer trocar de aparelho", async () => {
    const calls = stubApi(base({ "GET /api/servers/7/voice": () => ({ status: 200, body: { participants: [{ channelId: 4, userId: 1, username: "ana" }] } }) }));
    render(<App />);
    const aviso = await screen.findByRole("alertdialog", { name: "Trocar de aparelho" });
    expect(within(aviso).getByText(/Deseja trocar de aparelho\?/)).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Chamada de voz" })).toBeNull();
    expect(calls.find((c) => c.key === "POST /api/voice/token")).toBeUndefined();

    // quando o outro aparelho entra/muda, este também não liga sozinho
    await userEvent.click(within(aviso).getByRole("button", { name: "Agora não" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("group", { name: "Chamada de voz" })).toBeNull();
  });

  it("trocar de aparelho: pede a vaga ao servidor e liga a chamada neste aparelho", async () => {
    const calls = stubApi(base({ "GET /api/servers/7/voice": () => ({ status: 200, body: { participants: [{ channelId: 4, userId: 1, username: "ana" }] } }) }));
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Trocar para este" }));
    expect(FakeWebSocket.instances[0].sent).toContainEqual({ type: "voice.join", channelId: 4 });
    const barra = await screen.findByRole("group", { name: "Chamada de voz" });
    await vi.waitFor(() => expect(within(barra).getByText("Voz conectada")).toBeTruthy());
    expect(calls.find((c) => c.key === "POST /api/voice/token")?.body).toEqual({ channelId: 4 });

    // outro aparelho assume a vaga: aqui a ligação acaba e dá para voltar
    act(() => FakeWebSocket.instances[0].emit({ type: "voice.moved", channelId: 4 }));
    expect(screen.queryByRole("group", { name: "Chamada de voz" })).toBeNull();
    expect(await screen.findByRole("alertdialog", { name: "Trocar de aparelho" })).toBeTruthy();
  });

  it("celular: o menu de canais abre e fecha pelo botão e fecha sozinho ao escolher um canal", async () => {
    stubApi(base());
    render(<App />);
    await screen.findByRole("button", { name: "🔊 sala-1" });
    const menu = screen.getByRole("button", { name: "Abrir menu" });
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(menu);
    expect(screen.getByRole("button", { name: "Fechar menu", expanded: true })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Fechar menu" })).toHaveLength(2); // o botão e o fundo escuro
    await userEvent.click(screen.getAllByRole("button", { name: "Fechar menu" })[1]);
    expect(screen.getByRole("button", { name: "Abrir menu" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Abrir menu" }));
    await userEvent.click(screen.getByRole("button", { name: "🔊 sala-1" }));
    expect(screen.getByRole("button", { name: "Abrir menu" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("heading", { name: /sala-1/ })).toBeTruthy();
  });

  it("avisos sonoros da chamada: entrar, mutar, ensurdecer, câmera, tela e sair", async () => {
    const tocou = vi.mocked(playCallSound);
    tocou.mockClear();
    stubApi(base());
    render(<App />);
    await screen.findByRole("button", { name: "🔊 sala-1" });
    euEntrei();
    expect(tocou).toHaveBeenLastCalledWith("join");
    const barra = await screen.findByRole("group", { name: "Chamada de voz" });
    await vi.waitFor(() => expect(within(barra).getByText("Voz conectada")).toBeTruthy());

    const clicar = async (nome: string, som: string) => {
      await userEvent.click(within(barra).getByRole("button", { name: nome }));
      await vi.waitFor(() => expect(tocou).toHaveBeenLastCalledWith(som));
    };
    await clicar("Mutar", "mute");
    await clicar("Ativar microfone", "unmute");
    await clicar("Ensurdecer", "deafen");
    await clicar("Voltar a ouvir", "undeafen");
    await clicar("Ligar câmera", "camera-on");
    await clicar("Desligar câmera", "camera-off");
    await clicar("Compartilhar tela", "screen-on");
    await clicar("Parar de compartilhar", "screen-off");
    await userEvent.click(within(barra).getByRole("button", { name: "Desconectar" }));
    expect(tocou).toHaveBeenLastCalledWith("leave");
  });

  it("avisos sonoros: quem entra e sai da sala em que estou toca um aviso; de outra sala, não", async () => {
    const tocou = vi.mocked(playCallSound);
    stubApi(base());
    render(<App />);
    await screen.findByRole("button", { name: "🔊 sala-1" });
    euEntrei();
    tocou.mockClear();
    act(() => FakeWebSocket.instances[0].emit({ type: "voice.joined", serverId: 7, channelId: 4, user: { id: 2, username: "beto" } }));
    expect(tocou).toHaveBeenLastCalledWith("peer-join");
    act(() => FakeWebSocket.instances[0].emit({ type: "voice.left", serverId: 7, channelId: 4, userId: 2 }));
    expect(tocou).toHaveBeenLastCalledWith("peer-leave");

    tocou.mockClear();
    act(() => FakeWebSocket.instances[0].emit({ type: "voice.joined", serverId: 7, channelId: 99, user: { id: 3, username: "carla" } }));
    expect(tocou).not.toHaveBeenCalled();
  });

  it("atalhos: o configurado aciona a ação na chamada; fora da chamada não faz nada; Ctrl+K abre a busca", async () => {
    reloadHotkeys();
    stubApi(base());
    render(<App />);
    await screen.findByRole("button", { name: "🔊 sala-1" });

    // fora da chamada, "mutar" não faz nada
    fireEvent.keyDown(window, { code: "KeyM", altKey: true, shiftKey: true });
    expect(livekit.FakeRoom.instances).toHaveLength(0);

    euEntrei();
    const barra = await screen.findByRole("group", { name: "Chamada de voz" });
    await vi.waitFor(() => expect(within(barra).getByText("Voz conectada")).toBeTruthy());
    sala().localParticipant.setMicrophoneEnabled.mockClear();

    fireEvent.keyDown(window, { code: "KeyM", altKey: true, shiftKey: true });
    await vi.waitFor(() => expect(sala().localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(false));
    expect(await within(barra).findByRole("button", { name: "Ativar microfone" })).toBeTruthy();
    fireEvent.keyDown(window, { code: "KeyM", altKey: true, shiftKey: true });
    await vi.waitFor(() => expect(within(barra).getByRole("button", { name: "Mutar" })).toBeTruthy());

    fireEvent.keyDown(window, { code: "KeyL", altKey: true, shiftKey: true }); // sair da chamada
    expect(FakeWebSocket.instances[0].sent).toContainEqual({ type: "voice.leave" });

    fireEvent.keyDown(window, { code: "KeyK", ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: "Ir para um canal" })).toBeTruthy();
  });

  it("atalhos: em Minha conta dá para gravar outro, repetido é recusado, Esc cancela sem fechar a janela, e dá para limpar e restaurar", async () => {
    reloadHotkeys();
    stubApi(base());
    render(<App />);
    await screen.findByRole("button", { name: "🔊 sala-1" });
    await userEvent.click(screen.getByRole("button", { name: "Minha conta" }));
    const mutar = await screen.findByRole("button", { name: "Mudar o atalho de Mutar / ativar o microfone" });
    expect(mutar.textContent).toBe("Alt + Shift + M");

    // letra solta é recusada; repetido também
    await userEvent.click(mutar);
    expect(mutar.textContent).toBe("Aperte as teclas…");
    fireEvent.keyDown(window, { code: "KeyJ" });
    expect((await screen.findByRole("alert")).textContent).toMatch(/Ctrl, Alt ou Cmd/);
    fireEvent.keyDown(window, { code: "KeyD", altKey: true, shiftKey: true }); // é o de ensurdecer
    expect((await screen.findByRole("alert")).textContent).toMatch(/Ensurdecer/);

    // combinação nova vale e é guardada
    fireEvent.keyDown(window, { code: "KeyJ", ctrlKey: true, altKey: true });
    await vi.waitFor(() => expect(mutar.textContent).toBe("Ctrl + Alt + J"));
    expect(getHotkeys().toggleMute).toBe("Ctrl+Alt+KeyJ");
    expect(JSON.parse(localStorage.getItem("concord.hotkeys") ?? "{}").toggleMute).toBe("Ctrl+Alt+KeyJ");

    // Esc enquanto grava cancela a gravação e NÃO fecha a janela
    await userEvent.click(mutar);
    fireEvent.keyDown(window, { code: "Escape", key: "Escape" });
    expect(mutar.textContent).toBe("Ctrl + Alt + J");
    expect(screen.getByRole("dialog", { name: "Minha conta" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Tirar o atalho de Ligar / desligar a câmera" }));
    expect(screen.getByRole("button", { name: "Mudar o atalho de Ligar / desligar a câmera" }).textContent).toBe("Sem atalho");
    await userEvent.click(screen.getByRole("button", { name: "Restaurar os atalhos padrão" }));
    expect(screen.getByRole("button", { name: "Mudar o atalho de Mutar / ativar o microfone" }).textContent).toBe("Alt + Shift + M");
    expect(screen.getByRole("button", { name: "Mudar o atalho de Ligar / desligar a câmera" }).textContent).toBe("Alt + Shift + V");
  });

  it("mutar e ativar o microfone de novo", async () => {
    stubApi(base());
    render(<App />);
    await screen.findByRole("button", { name: "🔊 sala-1" });
    euEntrei();
    const barra = await screen.findByRole("group", { name: "Chamada de voz" });
    await vi.waitFor(() => expect(within(barra).getByText("Voz conectada")).toBeTruthy());

    await userEvent.click(within(barra).getByRole("button", { name: "Mutar" }));
    expect(sala().localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
    await userEvent.click(await within(barra).findByRole("button", { name: "Ativar microfone" }));
    expect(sala().localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(true);
    expect(within(barra).getByRole("button", { name: "Mutar" })).toBeTruthy();
  });

  it("microfone negado: explica, segue ouvindo e deixa tentar de novo", async () => {
    stubApi(base());
    render(<App />);
    await screen.findByRole("button", { name: "🔊 sala-1" });
    euEntrei();
    await vi.waitFor(() => expect(sala()).toBeTruthy());
    // a primeira entrada usa o mock padrão; o cenário é forçado numa nova entrada
    act(() => FakeWebSocket.instances[0].emit({ type: "voice.left", serverId: 7, channelId: 4, userId: 1 }));
    await vi.waitFor(() => expect(screen.queryByRole("group", { name: "Chamada de voz" })).toBeNull());
    livekit.FakeRoom.nextMicError = new DOMException("negado", "NotAllowedError");
    euEntrei();
    await vi.waitFor(() => expect(livekit.FakeRoom.instances.length).toBe(2));

    const barra = await screen.findByRole("group", { name: "Chamada de voz" });
    expect((await within(barra).findByRole("alert")).textContent).toMatch(/Permissão do microfone negada.*continua ouvindo/);
    expect(within(barra).getByText("Voz conectada")).toBeTruthy();
    expect(within(barra).getByRole("button", { name: "Ativar microfone" })).toBeTruthy();
  });

  it("desconectar sai da sala e encerra a chamada", async () => {
    stubApi(base());
    render(<App />);
    await screen.findByRole("button", { name: "🔊 sala-1" });
    euEntrei();
    const barra = await screen.findByRole("group", { name: "Chamada de voz" });
    await userEvent.click(within(barra).getByRole("button", { name: "Desconectar" }));
    expect(FakeWebSocket.instances[0].sent).toContainEqual({ type: "voice.leave" });

    act(() => FakeWebSocket.instances[0].emit({ type: "voice.left", serverId: 7, channelId: 4, userId: 1 }));
    await vi.waitFor(() => expect(screen.queryByRole("group", { name: "Chamada de voz" })).toBeNull());
    expect(sala().disconnect).toHaveBeenCalled();
  });

  it("toca o áudio dos outros quando chega uma faixa", async () => {
    stubApi(base());
    render(<App />);
    await screen.findByRole("button", { name: "🔊 sala-1" });
    euEntrei();
    await vi.waitFor(() => expect(sala().connect).toHaveBeenCalled());

    const elemento = document.createElement("audio");
    elemento.id = "audio-do-beto";
    const faixa = { kind: "audio", attach: () => elemento, detach: () => [elemento] };
    act(() => sala().handlers.trackSubscribed(faixa));
    expect(document.getElementById("audio-do-beto")).toBeTruthy();
    act(() => sala().handlers.trackUnsubscribed(faixa));
    expect(document.getElementById("audio-do-beto")).toBeNull();

    // o LiveKit já chamou detach() ao parar a faixa: o elemento não vem mais de lá, mas precisa sair da página
    act(() => sala().handlers.trackSubscribed(faixa));
    faixa.detach = () => [];
    act(() => sala().handlers.trackUnsubscribed(faixa));
    expect(document.getElementById("audio-do-beto")).toBeNull();
  });

  it("se o navegador bloquear o som, oferece o botão para ativar", async () => {
    stubApi(base());
    render(<App />);
    await screen.findByRole("button", { name: "🔊 sala-1" });
    euEntrei();
    await vi.waitFor(() => expect(sala().connect).toHaveBeenCalled());
    sala().canPlaybackAudio = false;
    act(() => sala().handlers.audioPlaybackStatusChanged());
    await userEvent.click(await screen.findByRole("button", { name: "Ativar o som da sala" }));
    expect(sala().startAudio).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Ativar o som da sala" })).toBeNull();
  });

  it("falha ao pegar a chave: mostra o erro e não conecta", async () => {
    stubApi(base({ "POST /api/voice/token": () => ({ status: 403, body: { error: "Entre na sala de voz primeiro" } }) }));
    render(<App />);
    await screen.findByRole("button", { name: "🔊 sala-1" });
    euEntrei();
    const barra = await screen.findByRole("group", { name: "Chamada de voz" });
    expect((await within(barra).findByRole("alert")).textContent).toBe("Entre na sala de voz primeiro");
    expect(sala().connect).not.toHaveBeenCalled();
  });

  it("mostra quem está falando e quem está com o microfone desligado", async () => {
    stubApi(base());
    render(<App />);
    await screen.findByRole("button", { name: "🔊 sala-1" });
    euEntrei();
    fireEvent.click(screen.getByRole("button", { name: "# geral" })); // volta ao texto: só a lista da lateral fica à mostra
    act(() => FakeWebSocket.instances[0].emit({ type: "voice.joined", serverId: 7, channelId: 4, user: { id: 2, username: "beto" } }));
    await vi.waitFor(() => expect(sala().connect).toHaveBeenCalled());
    const lista = await screen.findByLabelText("Na sala de voz");
    expect(within(lista).queryByRole("img", { name: "microfone desligado" })).toBeNull();

    // Beto desliga o microfone
    sala().remoteParticipants.set("2", { identity: "2", isMicrophoneEnabled: false, getTrackPublication: () => undefined });
    act(() => sala().handlers.trackMuted());
    const beto = within(lista).getByText("beto").closest("li") as HTMLElement;
    expect(within(beto).getByRole("img", { name: "microfone desligado" })).toBeTruthy();

    // Ana fala
    act(() => sala().handlers.activeSpeakersChanged([{ identity: "1" }]));
    const eu = within(lista).getByText("ana").closest("li") as HTMLElement;
    expect(eu.className).toBe("speaking");
    expect(beto.className).toBe("");
    act(() => sala().handlers.activeSpeakersChanged([]));
    expect(eu.className).toBe("");
  });

  /** Faixa de vídeo falsa: guarda em qual <video> foi ligada. */
  const faixaDeVideo = () => {
    const f = { attached: [] as HTMLElement[], attach: vi.fn((el: HTMLElement) => void f.attached.push(el)), detach: vi.fn() };
    return f;
  };

  it("ligar a câmera só por clique; mostra o próprio vídeo e desliga de novo", async () => {
    stubApi(base());
    render(<App />);
    await screen.findByRole("button", { name: "🔊 sala-1" });
    await userEvent.click(screen.getByRole("button", { name: "🔊 sala-1" }));
    euEntrei();
    await vi.waitFor(() => expect(sala().connect).toHaveBeenCalled());
    // nunca liga sozinha
    expect(sala().localParticipant.setCameraEnabled).not.toHaveBeenCalled();

    const barra = await screen.findByRole("group", { name: "Chamada de voz" });
    await vi.waitFor(() => expect(within(barra).getByText("Voz conectada")).toBeTruthy());
    const eu = faixaDeVideo();
    sala().localParticipant.setCameraEnabled.mockImplementationOnce(async () => {
      sala().localParticipant.isCameraEnabled = true;
      sala().localParticipant.pubs.camera = { track: eu, isMuted: false };
    });
    await userEvent.click(within(barra).getByRole("button", { name: "Ligar câmera" }));
    expect(sala().localParticipant.setCameraEnabled).toHaveBeenCalledWith(true);
    act(() => sala().handlers.localTrackPublished());
    const quadro = await screen.findByLabelText("Câmera de ana");
    expect(within(quadro).getByText("ana (você)")).toBeTruthy();
    expect(eu.attach).toHaveBeenCalled();

    sala().localParticipant.setCameraEnabled.mockImplementationOnce(async () => {
      sala().localParticipant.isCameraEnabled = false;
      delete sala().localParticipant.pubs.camera;
    });
    await userEvent.click(within(barra).getByRole("button", { name: "Desligar câmera" }));
    expect(sala().localParticipant.setCameraEnabled).toHaveBeenLastCalledWith(false);
    act(() => sala().handlers.localTrackUnpublished());
    await vi.waitFor(() => expect(screen.queryByLabelText("Câmera de ana")).toBeNull());
    expect(eu.detach).toHaveBeenCalled();
  });

  it("câmera negada ou inexistente: avisa e a sala continua funcionando", async () => {
    stubApi(base());
    render(<App />);
    await screen.findByRole("button", { name: "🔊 sala-1" });
    euEntrei();
    const barra = await screen.findByRole("group", { name: "Chamada de voz" });
    await vi.waitFor(() => expect(within(barra).getByText("Voz conectada")).toBeTruthy());

    const erro = (nome: string) => Object.assign(new Error("x"), { name: nome });
    sala().localParticipant.setCameraEnabled.mockRejectedValueOnce(erro("NotAllowedError"));
    await userEvent.click(within(barra).getByRole("button", { name: "Ligar câmera" }));
    expect((await within(barra).findByText(/Permissão da câmera negada/)).textContent).toBeTruthy();

    sala().localParticipant.setCameraEnabled.mockRejectedValueOnce(erro("NotFoundError"));
    await userEvent.click(within(barra).getByRole("button", { name: "Ligar câmera" }));
    expect(await within(barra).findByText("Nenhuma câmera encontrada neste dispositivo.")).toBeTruthy();
    expect(within(barra).queryByText(/Permissão da câmera negada/)).toBeNull();

    // continua conectado, e ainda dá para mutar
    expect(within(barra).getByText("Voz conectada")).toBeTruthy();
    expect(within(barra).getByRole("button", { name: "Mutar" })).toBeTruthy();
  });

  it("o vídeo dos outros aparece e some quando eles desligam", async () => {
    stubApi(base());
    render(<App />);
    await screen.findByRole("button", { name: "🔊 sala-1" });
    await userEvent.click(screen.getByRole("button", { name: "🔊 sala-1" }));
    euEntrei();
    act(() => FakeWebSocket.instances[0].emit({ type: "voice.joined", serverId: 7, channelId: 4, user: { id: 2, username: "beto" } }));
    await vi.waitFor(() => expect(sala().connect).toHaveBeenCalled());
    expect(screen.queryByLabelText("Câmeras")).toBeNull();

    const dele = faixaDeVideo();
    const beto = { identity: "2", isMicrophoneEnabled: true, getTrackPublication: (_: string) => ({ track: dele, isMuted: false }) as unknown };
    sala().remoteParticipants.set("2", beto);
    act(() => sala().handlers.trackSubscribed({ kind: "video", attach: () => document.createElement("video"), detach: () => [] }));
    const quadro = await screen.findByLabelText("Câmera de beto");
    expect(within(quadro).getByText("beto")).toBeTruthy();
    expect(dele.attach).toHaveBeenCalled();

    beto.getTrackPublication = () => undefined;
    act(() => sala().handlers.trackUnsubscribed({ kind: "video", attach: () => document.createElement("video"), detach: () => [] }));
    await vi.waitFor(() => expect(screen.queryByLabelText("Câmera de beto")).toBeNull());
  });

  it("sem estar conectado na voz o botão da câmera fica desligado e sair apaga os vídeos", async () => {
    stubApi(base());
    render(<App />);
    await screen.findByRole("button", { name: "🔊 sala-1" });
    expect(screen.queryByRole("button", { name: "Ligar câmera" })).toBeNull();
  });

  /** Faixa de tela falsa com estatísticas controladas pelo teste. */
  const faixaDeTela = (sender?: object[], receiver?: () => object) => {
    const f = {
      attach: vi.fn(),
      detach: vi.fn(),
      getSenderStats: vi.fn(async () => sender ?? []),
      getReceiverStats: vi.fn(async () => receiver?.()),
    };
    return f;
  };

  async function entrarNaSala() {
    stubApi(base());
    render(<App />);
    await screen.findByRole("button", { name: "🔊 sala-1" });
    await userEvent.click(screen.getByRole("button", { name: "🔊 sala-1" }));
    euEntrei();
    const barra = await screen.findByRole("group", { name: "Chamada de voz" });
    await vi.waitFor(() => expect(within(barra).getByText("Voz conectada")).toBeTruthy());
    return barra;
  }

  it("compartilhar tela pede 1920×1080 a 120 fps, como movimento, e mostra a qualidade medida", async () => {
    const barra = await entrarNaSala();
    const tela = faixaDeTela([{ frameWidth: 1920, frameHeight: 1080, framesPerSecond: 118.4, qualityLimitationReason: "none" }]);
    sala().localParticipant.setScreenShareEnabled.mockImplementationOnce(async () => {
      sala().localParticipant.isScreenShareEnabled = true;
      sala().localParticipant.pubs.screen_share = { track: tela, isMuted: false };
    });
    expect(sala().localParticipant.setScreenShareEnabled).not.toHaveBeenCalled(); // nunca sozinho

    await userEvent.click(within(barra).getByRole("button", { name: "Compartilhar tela" }));
    const [ligar, captura, publicacao] = sala().localParticipant.setScreenShareEnabled.mock.calls[0];
    expect(ligar).toBe(true);
    expect(captura.resolution).toEqual({ width: 1920, height: 1080, frameRate: 120 });
    expect(captura.contentHint).toBe("motion");
    expect(publicacao.screenShareEncoding.maxFramerate).toBe(120);
    expect(publicacao.degradationPreference).toBe("maintain-resolution");

    act(() => sala().handlers.localTrackPublished());
    const quadro = await screen.findByLabelText("Tela de ana");
    const selo = await within(quadro).findByText("1920×1080 · 118 fps");
    expect(selo.closest(".quality")?.className).toContain("ok");
    expect(within(quadro).queryByText(/Abaixo da meta/)).toBeNull();
    expect(within(barra).getByRole("button", { name: "Parar de compartilhar" })).toBeTruthy();
  });

  it("abaixo de 1080p/120 mostra o aviso com a causa", async () => {
    await entrarNaSala();
    const tela = faixaDeTela([{ frameWidth: 1920, frameHeight: 1080, framesPerSecond: 60, qualityLimitationReason: "bandwidth" }]);
    sala().localParticipant.pubs.screen_share = { track: tela, isMuted: false };
    sala().localParticipant.isScreenShareEnabled = true;
    act(() => sala().handlers.localTrackPublished());
    const quadro = await screen.findByLabelText("Tela de ana");
    const selo = await within(quadro).findByText("1920×1080 · 60 fps");
    expect(selo.closest(".quality")?.className).toContain("low");
    expect(within(quadro).getByText(/Abaixo da meta: 60 fps \(meta 120\)/)).toBeTruthy();
    expect(within(quadro).getByText(/a internet não aguenta mais/)).toBeTruthy();
  });

  it("cancelar o seletor do navegador não quebra nada", async () => {
    const barra = await entrarNaSala();
    sala().localParticipant.setScreenShareEnabled.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "NotAllowedError" }));
    await userEvent.click(within(barra).getByRole("button", { name: "Compartilhar tela" }));
    expect(await within(barra).findByText(/cancelado ou a permissão foi negada/)).toBeTruthy();
    expect(within(barra).getByRole("button", { name: "Compartilhar tela" })).toBeTruthy();
    expect(within(barra).getByText("Voz conectada")).toBeTruthy();
    expect(screen.queryByLabelText("Tela de ana")).toBeNull();
  });

  it("parar pelo botão do navegador encerra: o botão volta e o quadro some", async () => {
    const barra = await entrarNaSala();
    const tela = faixaDeTela([{ frameWidth: 1920, frameHeight: 1080, framesPerSecond: 120 }]);
    sala().localParticipant.pubs.screen_share = { track: tela, isMuted: false };
    sala().localParticipant.isScreenShareEnabled = true;
    act(() => sala().handlers.localTrackPublished());
    await screen.findByLabelText("Tela de ana");
    expect(within(barra).getByRole("button", { name: "Parar de compartilhar" })).toBeTruthy();

    delete sala().localParticipant.pubs.screen_share;
    sala().localParticipant.isScreenShareEnabled = false;
    act(() => sala().handlers.localTrackUnpublished());
    await vi.waitFor(() => expect(screen.queryByLabelText("Tela de ana")).toBeNull());
    expect(within(barra).getByRole("button", { name: "Compartilhar tela" })).toBeTruthy();
  });

  it("o espectador vê a tela do outro e os fps medidos no recebimento", async () => {
    stubApi(base());
    render(<App />);
    await screen.findByRole("button", { name: "🔊 sala-1" });
    await userEvent.click(screen.getByRole("button", { name: "🔊 sala-1" }));
    euEntrei();
    act(() => FakeWebSocket.instances[0].emit({ type: "voice.joined", serverId: 7, channelId: 4, user: { id: 2, username: "beto" } }));
    await vi.waitFor(() => expect(sala().connect).toHaveBeenCalled());

    let quadros = 0;
    const tela = faixaDeTela(undefined, () => ({ frameWidth: 1920, frameHeight: 1080, framesDecoded: (quadros += 120) }));
    sala().remoteParticipants.set("2", {
      identity: "2",
      isMicrophoneEnabled: true,
      getTrackPublication: (fonte: string) => (fonte === "screen_share" ? { track: tela, isMuted: false } : undefined),
    });
    act(() => sala().handlers.trackSubscribed({ kind: "video", attach: () => document.createElement("video"), detach: () => [] }));

    const quadro = await screen.findByLabelText("Tela de beto");
    expect(within(quadro).getByText("beto")).toBeTruthy(); // não é a minha: sem "(você)"
    // a primeira leitura não tem com o que comparar; a segunda (1 s depois) mede ~120 fps
    await vi.waitFor(() => expect(within(quadro).getByText(/^1920×1080 · \d+ fps$/).textContent).toMatch(/· (1[01]\d|120|12\d) fps/), {
      timeout: 4000,
    });
  });
});

describe("chamadas na conversa direta", () => {
  const servidor = { id: 7, name: "Os Parças", ownerId: 1, channels: [{ id: 3, name: "geral" }] };
  const dmBeto = { id: 20, user: { id: 2, username: "beto", online: true } };
  const base = (extra: Record<string, Handler> = {}) => ({
    "GET /api/auth/me": () => ({ status: 200, body: { user: ana } }),
    "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
    "GET /api/dms": () => ({ status: 200, body: { dms: [dmBeto] } }),
    ...extra,
  });
  const ws = () => FakeWebSocket.instances[0];
  const eu = { id: 1, username: "ana" };
  const beto = { id: 2, username: "beto" };
  const tocando = (from: object, to: object) => act(() => ws().emit({ type: "call.ringing", dmId: 20, from, to }));

  async function abrirConversa() {
    const calls = stubApi(base());
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Mensagens diretas" }));
    await userEvent.click(await screen.findByRole("button", { name: /beto/ }));
    return calls;
  }

  it("ligar chama pelo WebSocket, mostra 'Chamando...' e dá para cancelar", async () => {
    await abrirConversa();
    await userEvent.click(await screen.findByRole("button", { name: "Ligar para beto" }));
    expect(ws().sent).toContainEqual({ type: "call.start", dmId: 20 });

    tocando(eu, beto);
    expect(await screen.findByText("📞 Chamando beto...")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Ligar para beto" }) as HTMLButtonElement).disabled).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(ws().sent).toContainEqual({ type: "call.hangup", dmId: 20 });
    act(() => ws().emit({ type: "call.ended", dmId: 20, reason: "cancelled" }));
    expect(await screen.findByText("Chamada cancelada.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Ligar para beto" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("avisos sonoros: chamando toca o sinal, recebida toca o toque, atender e encerrar tocam o seu aviso", async () => {
    const tocou = vi.mocked(playCallSound);
    tocou.mockClear();
    await abrirConversa();
    await userEvent.click(await screen.findByRole("button", { name: "Ligar para beto" }));
    tocando(eu, beto);
    expect(tocou).toHaveBeenLastCalledWith("ring-out");
    act(() => ws().emit({ type: "call.ended", dmId: 20, reason: "declined" }));
    expect(tocou).toHaveBeenLastCalledWith("call-end");

    tocou.mockClear();
    tocando(beto, eu);
    expect(tocou).toHaveBeenLastCalledWith("ring-in");
    act(() => ws().emit({ type: "call.accepted", dmId: 20 }));
    expect(tocou).toHaveBeenLastCalledWith("call-connected");
  });

  it("ligação com a janela em segundo plano também vira notificação do navegador (se a pessoa ligou os avisos)", async () => {
    const criadas: { titulo: string; opcoes: { tag?: string; requireInteraction?: boolean } }[] = [];
    vi.stubGlobal(
      "Notification",
      Object.assign(
        function (this: { onclick: unknown; close: () => void }, titulo: string, opcoes: { tag?: string; requireInteraction?: boolean }) {
          criadas.push({ titulo, opcoes });
          this.close = () => {};
        },
        { permission: "granted", requestPermission: async () => "granted" },
      ),
    );
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    localStorage.setItem("concord.notify", JSON.stringify({ sounds: true, callSounds: true, volume: 60, desktop: true }));
    resetNotifyPrefs();
    stubApi(base());
    render(<App />);
    await screen.findByRole("navigation", { name: "Servidores" });
    tocando(beto, eu);
    expect(await screen.findByText("📞 beto está ligando...")).toBeTruthy();
    expect(criadas).toEqual([{ titulo: "📞 beto está ligando", opcoes: expect.objectContaining({ tag: "call-20", requireInteraction: true }) }]);
    vi.restoreAllMocks();
  });

  it("o toque da chamada recebida não toca em 'Não perturbe'", async () => {
    const tocou = vi.mocked(playCallSound);
    tocou.mockClear();
    stubApi(base({ "GET /api/auth/me": () => ({ status: 200, body: { user: { ...ana, statusKind: "dnd" } } }) }));
    render(<App />);
    await screen.findByRole("navigation", { name: "Servidores" });
    tocando(beto, eu);
    expect(await screen.findByText("📞 beto está ligando...")).toBeTruthy();
    expect(tocou).not.toHaveBeenCalledWith("ring-in");
  });

  it("chamada recebida aparece em qualquer tela; recusar avisa o servidor e some", async () => {
    stubApi(base());
    render(<App />);
    await screen.findByRole("button", { name: "🔊 sala-1" }).catch(() => null);
    await screen.findByRole("navigation", { name: "Servidores" });

    tocando(beto, eu); // estamos na tela de servidores, não na conversa
    expect(await screen.findByText("📞 beto está ligando...")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Recusar" }));
    expect(ws().sent).toContainEqual({ type: "call.decline", dmId: 20 });
    act(() => ws().emit({ type: "call.ended", dmId: 20, reason: "declined" }));
    await vi.waitFor(() => expect(screen.queryByText("📞 beto está ligando...")).toBeNull());
    expect(await screen.findByText("Você recusou a chamada.")).toBeTruthy(); // quem recusa vê o próprio resultado
  });

  it("atender liga a chamada: pede a chave da conversa, conecta e mostra a barra; desligar avisa o servidor", async () => {
    const calls = stubApi(base());
    render(<App />);
    await screen.findByRole("navigation", { name: "Servidores" });

    tocando(beto, eu);
    await userEvent.click(await screen.findByRole("button", { name: "Atender" }));
    expect(ws().sent).toContainEqual({ type: "call.accept", dmId: 20 });

    act(() => ws().emit({ type: "call.accepted", dmId: 20 }));
    const barra = await screen.findByRole("group", { name: "Chamada de voz" });
    expect(within(barra).getByText("📞 beto")).toBeTruthy();
    await vi.waitFor(() => expect(within(barra).getByText("Voz conectada")).toBeTruthy());
    expect(calls.find((c) => c.key === "POST /api/voice/token")?.body).toEqual({ dmId: 20 });
    expect(livekit.FakeRoom.instances[0].connect).toHaveBeenCalledWith("ws://midia.teste", "chave-de-teste");
    expect(livekit.FakeRoom.instances[0].localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);

    await userEvent.click(within(barra).getByRole("button", { name: "Desconectar" }));
    expect(ws().sent).toContainEqual({ type: "call.hangup", dmId: 20 });
    act(() => ws().emit({ type: "call.ended", dmId: 20, reason: "hangup" }));
    await vi.waitFor(() => expect(screen.queryByRole("group", { name: "Chamada de voz" })).toBeNull());
    expect(livekit.FakeRoom.instances[0].disconnect).toHaveBeenCalled();
    expect(await screen.findByText("Chamada encerrada.")).toBeTruthy();
  });

  it("mostra por que a chamada acabou: recusada, perdida, caiu", async () => {
    stubApi(base());
    render(<App />);
    await screen.findByRole("navigation", { name: "Servidores" });

    tocando(eu, beto);
    act(() => ws().emit({ type: "call.ended", dmId: 20, reason: "declined" }));
    expect(await screen.findByText("beto recusou a chamada.")).toBeTruthy();

    tocando(eu, beto);
    act(() => ws().emit({ type: "call.ended", dmId: 20, reason: "missed" }));
    expect(await screen.findByText("beto não atendeu.")).toBeTruthy();

    tocando(beto, eu);
    act(() => ws().emit({ type: "call.ended", dmId: 20, reason: "missed" }));
    expect(await screen.findByText("Chamada perdida de beto.")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Fechar" }));
    expect(screen.queryByText("Chamada perdida de beto.")).toBeNull();
  });

  it("ocupado ou offline: mostra a resposta do servidor ao pedido de ligar", async () => {
    await abrirConversa();
    await userEvent.click(await screen.findByRole("button", { name: "Ligar para beto" }));
    act(() => ws().emit({ type: "error", error: "A pessoa está ocupada em outra chamada" }));
    expect(await screen.findByText("A pessoa está ocupada em outra chamada")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Ligar para beto" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("chamada ativa na conversa mostra o vídeo do outro dentro dela", async () => {
    await abrirConversa();
    tocando(eu, beto);
    act(() => ws().emit({ type: "call.accepted", dmId: 20 }));
    await vi.waitFor(() => expect(livekit.FakeRoom.instances[0]?.connect).toHaveBeenCalled());
    const sala = livekit.FakeRoom.instances[0];

    const faixa = { attach: vi.fn(), detach: vi.fn() };
    sala.remoteParticipants.set("2", {
      identity: "2",
      isMicrophoneEnabled: true,
      getTrackPublication: (fonte: string) => (fonte === "camera" ? { track: faixa, isMuted: false } : undefined),
    });
    act(() => sala.handlers.trackSubscribed({ kind: "video", attach: () => document.createElement("video"), detach: () => [] }));
    const quadro = await screen.findByLabelText("Câmera de beto");
    expect(within(quadro).getByText("beto")).toBeTruthy();
    expect(faixa.attach).toHaveBeenCalled();
  });

  it("ao reconectar o socket a chamada some (o servidor já a encerrou)", async () => {
    stubApi(base());
    render(<App />);
    await screen.findByRole("navigation", { name: "Servidores" });
    tocando(beto, eu);
    expect(await screen.findByText("📞 beto está ligando...")).toBeTruthy();
    act(() => ws().close());
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(2), { timeout: 3000 });
    act(() => FakeWebSocket.instances[1].onopen?.());
    await vi.waitFor(() => expect(screen.queryByText("📞 beto está ligando...")).toBeNull());
  });
});

describe("cadastro pelo link de convite", () => {
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("manda o código do convite junto com o cadastro (servidor fechado exige)", async () => {
    window.history.pushState(null, "", "/convite/abc123");
    const servidor = { id: 7, name: "Os Parças", ownerId: 2, channels: [{ id: 3, name: "geral" }] };
    const calls = stubApi({
      "GET /api/auth/me": () => naoLogado,
      "POST /api/auth/register": () => ({ status: 201, body: { user: ana } }),
      "POST /api/invites/abc123/join": () => ({ status: 200, body: { server: servidor } }),
      "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
    });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /Registre-se/ }));
    await userEvent.type(screen.getByLabelText("Usuário"), "ana");
    await userEvent.type(screen.getByLabelText("Senha"), "senha-bem-longa");
    await userEvent.click(screen.getByRole("button", { name: "Criar conta" }));
    // conta recém-criada: antes do app, a pergunta das notificações
    await userEvent.click(await screen.findByRole("button", { name: "Agora não" }));
    await screen.findByRole("button", { name: "# geral" });
    expect(calls.find((c) => c.key === "POST /api/auth/register")?.body).toEqual({
      username: "ana",
      password: "senha-bem-longa",
      inviteCode: "abc123",
    });
  });

  it("sem convite no endereço o cadastro não leva código", async () => {
    const calls = stubApi({
      "GET /api/auth/me": () => naoLogado,
      "POST /api/auth/register": () => ({ status: 403, body: { error: "O cadastro é só por convite. Peça um link de convite a um amigo." } }),
    });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: /Registre-se/ }));
    await userEvent.type(screen.getByLabelText("Usuário"), "ana");
    await userEvent.type(screen.getByLabelText("Senha"), "senha-bem-longa");
    await userEvent.click(screen.getByRole("button", { name: "Criar conta" }));
    expect((await screen.findByRole("alert")).textContent).toContain("só por convite");
    expect(calls.find((c) => c.key === "POST /api/auth/register")?.body).toEqual({ username: "ana", password: "senha-bem-longa" });
  });
});

describe("cargos, convites e moderação", () => {
  const servidor = { id: 7, name: "Os Parças", ownerId: 1, channels: [{ id: 3, name: "geral", type: "text" }] };
  const TODAS = ["invite", "manage_invites", "manage_messages", "kick_ban", "manage_channels", "view_log"];
  const cargos = [
    { id: 10, name: "Membro", permissions: [] as string[], isDefault: true, members: 2 },
    { id: 11, name: "Convidador", permissions: ["invite"], isDefault: false, members: 1 },
    { id: 12, name: "Moderador", permissions: TODAS, isDefault: false, members: 0 },
  ];
  const dono = { isOwner: true, roleId: null, permissions: TODAS };
  const comum = { isOwner: false, roleId: 10, permissions: [] as string[] };
  const beto = { id: 2, username: "beto" };
  const membros = [
    { id: 1, username: "ana", online: true, isOwner: true, roleId: null, roleName: null },
    { id: 2, username: "beto", online: true, isOwner: false, roleId: 10, roleName: "Membro" },
  ];

  const base = (user: object = ana, me: object = dono, extra: Record<string, Handler> = {}) => ({
    "GET /api/auth/me": () => ({ status: 200, body: { user } }),
    "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
    "GET /api/servers/7/roles": () => ({ status: 200, body: { roles: cargos, permissions: TODAS, me } }),
    "GET /api/servers/7/members": () => ({ status: 200, body: { members: membros } }),
    ...extra,
  });
  const abrirPainel = async () => {
    await userEvent.click(await screen.findByRole("button", { name: "⚙ Servidor" }));
    return screen.findByRole("dialog", { name: "Configurações de Os Parças" });
  };
  const ws = () => FakeWebSocket.instances[0];

  it("membro comum: sem convidar nem criar canal; o painel só oferece sair do servidor", async () => {
    const calls = stubApi(base(beto, comum, { "POST /api/servers/7/leave": () => ({ status: 204 }) }));
    render(<App />);
    const painel = await abrirPainel();
    expect(screen.queryByRole("button", { name: "Convidar amigos" })).toBeNull();
    expect(screen.queryByRole("button", { name: "+ Novo canal" })).toBeNull();
    expect(within(painel).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Meu apelido"]); // nada de administração, só o apelido

    await userEvent.click(within(painel).getByRole("button", { name: "Sair do servidor" }));
    await userEvent.click(within(painel).getByRole("button", { name: "Sair mesmo" }));
    await vi.waitFor(() => expect(calls.some((c) => c.key === "POST /api/servers/7/leave")).toBe(true));
    expect(await screen.findByText("Criar um servidor")).toBeTruthy(); // não sobrou servidor
  });

  it("o dono não vê 'Sair do servidor'", async () => {
    stubApi(base());
    render(<App />);
    const painel = await abrirPainel();
    expect(within(painel).queryByRole("button", { name: "Sair do servidor" })).toBeNull();
  });

  it("quem tem o cargo Convidador vê 'Convidar amigos'; passou do limite, o erro aparece", async () => {
    stubApi(
      base(beto, { isOwner: false, roleId: 11, permissions: ["invite"] }, {
        "POST /api/servers/7/invites": () => ({ status: 429, body: { error: "Você já usou seus 10 convites." } }),
      }),
    );
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Convidar amigos" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Você já usou seus 10 convites.");
  });

  it("painel de convites: mostra o limite, cria um link de uso único e revoga um pendente", async () => {
    let revogado = false;
    const calls = stubApi(
      base(ana, dono, {
        "GET /api/servers/7/invites": () => {
          const revogadoAgora = revogado;
          return {
          status: 200,
          body: {
            invites: [
              { code: "usado111111", createdBy: { id: 1, username: "ana" }, createdAt: "2026-10-30T10:00:00.000Z", usedBy: { id: 2, username: "beto" }, usedAt: "2026-10-30T11:00:00.000Z", status: "used" },
              { code: "pendente222", createdBy: { id: 1, username: "ana" }, createdAt: "2026-10-30T09:00:00.000Z", usedBy: null, usedAt: null, status: revogadoAgora ? "revoked" : "pending" },
            ],
            limit: 10,
            used: 3,
            remaining: 7,
            canSeeAll: true,
          },
          };
        },
        "POST /api/servers/7/invites": () => ({ status: 201, body: { code: "novo12345678", limit: 10, used: 4, remaining: 6 } }),
        "DELETE /api/servers/7/invites/pendente222": () => {
          revogado = true;
          return { status: 204 };
        },
      }),
    );
    render(<App />);
    const painel = await abrirPainel();
    expect(await within(painel).findByText(/restam/)).toBeTruthy();
    expect(painel.textContent).toContain("Você usou 3 de 10 convites; restam 7");
    expect(within(painel).getByText(/Usado por beto/)).toBeTruthy();
    expect(within(painel).getByText(/Pendente/)).toBeTruthy();

    await userEvent.click(within(painel).getByRole("button", { name: "Criar convite" }));
    const campo = (await within(painel).findByLabelText("Link do novo convite")) as HTMLInputElement;
    expect(campo.value).toMatch(/\/convite\/novo12345678$/);

    await userEvent.click(within(painel).getByRole("button", { name: "Revogar" }));
    await userEvent.click(within(painel).getByRole("button", { name: "Confirmar" }));
    await vi.waitFor(() => expect(calls.some((c) => c.key === "DELETE /api/servers/7/invites/pendente222")).toBe(true));
    expect(await within(painel).findByText(/Revogado/)).toBeTruthy();
  });

  it("sem vagas, o botão de criar convite fica desligado", async () => {
    stubApi(
      base(ana, dono, {
        "GET /api/servers/7/invites": () => ({ status: 200, body: { invites: [], limit: 10, used: 10, remaining: 0, canSeeAll: true } }),
      }),
    );
    render(<App />);
    const painel = await abrirPainel();
    await within(painel).findByText(/restam/);
    expect((within(painel).getByRole("button", { name: "Criar convite" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("cargos: o dono edita as permissões e cria um cargo novo", async () => {
    const calls = stubApi(
      base(ana, dono, {
        "GET /api/servers/7/invites": () => ({ status: 200, body: { invites: [], limit: 10, used: 0, remaining: 10, canSeeAll: true } }),
        "PATCH /api/servers/7/roles/10": () => ({ status: 200, body: { role: cargos[0] } }),
        "POST /api/servers/7/roles": () => ({ status: 201, body: { role: { id: 13, name: "DJ", permissions: [], isDefault: false, members: 0 } } }),
      }),
    );
    render(<App />);
    const painel = await abrirPainel();
    await userEvent.click(within(painel).getByRole("tab", { name: "Cargos" }));
    const membro = await within(painel).findByRole("form", { name: "Cargo Membro" });
    await userEvent.click(within(membro).getByLabelText("Apagar mensagens de outros"));
    await userEvent.click(within(membro).getByRole("button", { name: "Salvar" }));
    await vi.waitFor(() => expect(calls.find((c) => c.key === "PATCH /api/servers/7/roles/10")?.body).toEqual({ name: "Membro", permissions: ["manage_messages"] }));

    await userEvent.type(within(painel).getByLabelText("Nome do novo cargo"), "DJ");
    await userEvent.click(within(painel).getByRole("button", { name: "Criar cargo" }));
    await vi.waitFor(() => expect(calls.find((c) => c.key === "POST /api/servers/7/roles")?.body).toEqual({ name: "DJ", permissions: [] }));
  });

  it("cargos: só o dono vê a aba; um moderador não", async () => {
    stubApi(base(beto, { isOwner: false, roleId: 12, permissions: TODAS }));
    render(<App />);
    const painel = await abrirPainel();
    expect(within(painel).queryByRole("tab", { name: "Cargos" })).toBeNull();
    expect(within(painel).getByRole("tab", { name: "Membros" })).toBeTruthy();
    expect(within(painel).getByRole("tab", { name: "Banidos" })).toBeTruthy();
    expect(within(painel).getByRole("tab", { name: "Log" })).toBeTruthy();
  });

  it("membros: o dono troca o cargo, expulsa e bane (com confirmação)", async () => {
    const calls = stubApi(
      base(ana, dono, {
        "GET /api/servers/7/invites": () => ({ status: 200, body: { invites: [], limit: 10, used: 0, remaining: 10, canSeeAll: true } }),
        "PUT /api/servers/7/members/2/role": () => ({ status: 200, body: { roleId: 12 } }),
        "DELETE /api/servers/7/members/2": () => ({ status: 204 }),
        "POST /api/servers/7/bans": () => ({ status: 201, body: { ok: true } }),
      }),
    );
    render(<App />);
    const painel = await abrirPainel();
    await userEvent.click(within(painel).getByRole("tab", { name: "Membros" }));
    const seletor = await within(painel).findByLabelText("Cargo de beto");
    await userEvent.selectOptions(seletor, "Moderador");
    await vi.waitFor(() => expect(calls.find((c) => c.key === "PUT /api/servers/7/members/2/role")?.body).toEqual({ roleId: 12 }));

    // sem confirmar, nada acontece
    await userEvent.click(within(painel).getByRole("button", { name: "Expulsar" }));
    expect(calls.some((c) => c.key.startsWith("DELETE /api/servers/7/members"))).toBe(false);
    await userEvent.click(within(painel).getByRole("button", { name: "Confirmar" }));
    await vi.waitFor(() => expect(calls.some((c) => c.key === "DELETE /api/servers/7/members/2")).toBe(true));

    await userEvent.click(within(painel).getByRole("button", { name: "Banir" }));
    await userEvent.click(within(painel).getByRole("button", { name: "Confirmar" }));
    await vi.waitFor(() => expect(calls.find((c) => c.key === "POST /api/servers/7/bans")?.body).toEqual({ userId: 2 }));
    // não há botões de agir sobre o dono nem sobre si mesmo
    expect(within(painel).getAllByRole("button", { name: "Expulsar" })).toHaveLength(1);
  });

  it("a administradora gera uma senha temporária para um amigo e a vê uma vez", async () => {
    const calls = stubApi(
      base({ ...ana, isAdmin: true }, dono, {
        "GET /api/servers/7/invites": () => ({ status: 200, body: { invites: [], limit: 10, used: 0, remaining: 10, canSeeAll: true } }),
        "POST /api/auth/admin/reset-password": () => ({ status: 200, body: { username: "beto", tempPassword: "Xy7-temporaria" } }),
      }),
    );
    render(<App />);
    const painel = await abrirPainel();
    await userEvent.click(within(painel).getByRole("tab", { name: "Membros" }));
    await userEvent.click(await within(painel).findByRole("button", { name: "Redefinir senha" }));
    await userEvent.click(within(painel).getByRole("button", { name: "Gerar senha temporária" }));
    expect(await within(painel).findByText("Xy7-temporaria")).toBeTruthy();
    expect(calls.find((c) => c.key === "POST /api/auth/admin/reset-password")?.body).toEqual({ userId: 2 });
    await userEvent.click(within(painel).getByRole("button", { name: "Ok" }));
    expect(within(painel).queryByText("Xy7-temporaria")).toBeNull();
  });

  it("banidos e log aparecem para quem tem a permissão", async () => {
    stubApi(
      base(beto, { isOwner: false, roleId: 12, permissions: TODAS }, {
        "GET /api/servers/7/invites": () => ({ status: 200, body: { invites: [], limit: 10, used: 0, remaining: 10, canSeeAll: true } }),
        "GET /api/servers/7/bans": () => ({ status: 200, body: { bans: [{ userId: 5, username: "carla", createdAt: "2026-10-30T10:00:00.000Z", bannedBy: "ana" }] } }),
        "GET /api/servers/7/log": () => ({ status: 200, body: { entries: [{ id: 1, text: "ana baniu carla", createdAt: "2026-10-30T10:00:00.000Z" }] } }),
        "DELETE /api/servers/7/bans/5": () => ({ status: 204 }),
      }),
    );
    render(<App />);
    const painel = await abrirPainel();
    await userEvent.click(within(painel).getByRole("tab", { name: "Banidos" }));
    expect(await within(painel).findByText(/carla/)).toBeTruthy();
    await userEvent.click(within(painel).getByRole("tab", { name: "Log" }));
    expect(await within(painel).findByText("ana baniu carla")).toBeTruthy();
  });

  it("ser banido: o servidor some da lista e aparece um aviso", async () => {
    stubApi(base(beto, comum));
    render(<App />);
    await screen.findByRole("button", { name: "⚙ Servidor" });
    act(() => ws().emit({ type: "member.removed", serverId: 7, userId: 2, reason: "banned" }));
    expect(await screen.findByText(/Você foi banido de "Os Parças"/)).toBeTruthy();
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: "⚙ Servidor" })).toBeNull());
  });
});

describe("minha conta", () => {
  const servidor = { id: 7, name: "Os Parças", ownerId: 1, channels: [{ id: 3, name: "geral", type: "text" }] };
  const base = (user: object = ana, extra: Record<string, Handler> = {}) => ({
    "GET /api/auth/me": () => ({ status: 200, body: { user } }),
    "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
    ...extra,
  });

  it("troca a senha: confere as duas novas, manda a atual e avisa que os outros aparelhos caíram", async () => {
    const calls = stubApi(base(ana, { "POST /api/auth/password": () => ({ status: 204 }) }));
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Minha conta" }));
    const janela = await screen.findByRole("dialog", { name: "Minha conta" });

    await userEvent.type(within(janela).getByLabelText("Senha atual"), "senha-bem-longa");
    await userEvent.type(within(janela).getByLabelText("Nova senha"), "outra-senha-forte");
    await userEvent.type(within(janela).getByLabelText("Repita a nova senha"), "diferente-de-novo");
    await userEvent.click(within(janela).getByRole("button", { name: "Trocar senha" }));
    expect((await within(janela).findByRole("alert")).textContent).toBe("As duas senhas novas não são iguais");
    expect(calls.some((c) => c.key === "POST /api/auth/password")).toBe(false);

    await userEvent.clear(within(janela).getByLabelText("Repita a nova senha"));
    await userEvent.type(within(janela).getByLabelText("Repita a nova senha"), "outra-senha-forte");
    await userEvent.click(within(janela).getByRole("button", { name: "Trocar senha" }));
    expect(await within(janela).findByText(/outros aparelhos foram desconectados/)).toBeTruthy();
    expect(calls.find((c) => c.key === "POST /api/auth/password")?.body).toEqual({ current: "senha-bem-longa", next: "outra-senha-forte" });
  });

  it("mostra o erro do servidor quando a senha atual está errada", async () => {
    stubApi(base(ana, { "POST /api/auth/password": () => ({ status: 403, body: { error: "A senha atual está errada" } }) }));
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Minha conta" }));
    const janela = await screen.findByRole("dialog", { name: "Minha conta" });
    await userEvent.type(within(janela).getByLabelText("Senha atual"), "errada-errada");
    await userEvent.type(within(janela).getByLabelText("Nova senha"), "outra-senha-forte");
    await userEvent.type(within(janela).getByLabelText("Repita a nova senha"), "outra-senha-forte");
    await userEvent.click(within(janela).getByRole("button", { name: "Trocar senha" }));
    expect((await within(janela).findByRole("alert")).textContent).toBe("A senha atual está errada");
  });

  it("sair de todos os outros aparelhos", async () => {
    const calls = stubApi(base(ana, { "POST /api/auth/logout-all": () => ({ status: 204 }) }));
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Minha conta" }));
    const janela = await screen.findByRole("dialog", { name: "Minha conta" });
    await userEvent.click(within(janela).getByRole("button", { name: "Sair de todos os outros aparelhos" }));
    expect(await within(janela).findByText(/todos os outros aparelhos foram desconectados/)).toBeTruthy();
    expect(calls.some((c) => c.key === "POST /api/auth/logout-all")).toBe(true);
  });

  it("entrou com senha temporária: só vê a tela de trocar a senha, e depois entra no app", async () => {
    let trocou = false;
    stubApi({
      "GET /api/auth/me": () => ({ status: 200, body: { user: { ...ana, mustChangePassword: !trocou } } }),
      "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
      "POST /api/auth/password": () => {
        trocou = true;
        return { status: 204 };
      },
    });
    render(<App />);
    expect(await screen.findByText("Escolha uma senha nova")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Minha conta" })).toBeNull(); // o app nem abre

    await userEvent.type(screen.getByLabelText("Senha temporária"), "Xy7-temporaria");
    await userEvent.type(screen.getByLabelText("Nova senha"), "minha-senha-nova");
    await userEvent.type(screen.getByLabelText("Repita a nova senha"), "minha-senha-nova");
    await userEvent.click(screen.getByRole("button", { name: "Trocar senha" }));
    expect(await screen.findByRole("button", { name: "Minha conta" })).toBeTruthy();
  });
});

describe("perfil, fotos e visual", () => {
  const servidor = { id: 7, name: "Os Parças", ownerId: 1, iconVersion: 0, channels: [{ id: 3, name: "geral", type: "text" }] };
  const membros = [
    { id: 1, username: "ana", online: true, isOwner: true, roleId: null, roleName: null, displayName: "Ana Paula", avatarVersion: 4, statusKind: "dnd", statusText: "estudando" },
    { id: 2, username: "beto", online: true, isOwner: false, roleId: 10, roleName: "Membro", displayName: null, avatarVersion: 0, statusKind: "online", statusText: "" },
  ];
  const dono = { isOwner: true, roleId: null, permissions: ["invite", "manage_invites", "manage_messages", "kick_ban", "manage_channels", "view_log"] };
  const euAna = { ...ana, displayName: "Ana Paula", about: "oi", statusKind: "dnd", statusText: "estudando", avatarVersion: 4 };
  const base = (user: object = euAna, extra: Record<string, Handler> = {}) => ({
    "GET /api/auth/me": () => ({ status: 200, body: { user } }),
    "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
    "GET /api/servers/7/members": () => ({ status: 200, body: { members: membros } }),
    "GET /api/servers/7/roles": () => ({ status: 200, body: { roles: [], permissions: [], me: dono } }),
    ...extra,
  });
  const ws = () => FakeWebSocket.instances[0];
  const mensagem = (id: number, autor: object, conteudo = "oi") => ({
    id, channelId: 3, dmId: null, serverId: 7, content: conteudo, createdAt: "2026-10-30T14:05:00.000Z", editedAt: null, author: autor,
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("style");
  });

  it("mostra o nome de exibição e a foto; sem foto, a inicial; o status aparece na lista", async () => {
    stubApi(base());
    render(<App />);
    const lista = await screen.findByRole("region", { name: "Membros" });
    expect(await within(lista).findByText("Ana Paula")).toBeTruthy(); // nome de exibição no lugar do usuário
    expect(within(lista).getByText("estudando")).toBeTruthy();
    const fotoAna = lista.querySelector('img.avatar[src="/api/profile/avatar/1?v=4"]');
    expect(fotoAna).toBeTruthy();
    // o Beto não tem foto: círculo com a inicial
    const beto = within(lista).getByText("beto").closest("li") as HTMLElement;
    expect(beto.querySelector("img.avatar")).toBeNull();
    expect(beto.querySelector(".avatar.initial")?.textContent).toBe("B");
    expect(beto.querySelector(".dot")?.className).toContain("on");
    expect((within(lista).getByText("Ana Paula").closest("li") as HTMLElement).querySelector(".dot")?.className).toContain("dnd");
  });

  it("as mensagens mostram o nome de exibição e a foto do autor", async () => {
    stubApi(
      base(euAna, {
        "GET /api/channels/3/messages": () => ({
          status: 200,
          body: { messages: [mensagem(1, { id: 1, username: "ana", displayName: "Ana Paula", avatarVersion: 4 }, "bom dia")], hasMore: false },
        }),
      }),
    );
    render(<App />);
    const linha = (await screen.findByText("bom dia")).closest("li") as HTMLElement;
    expect(within(linha).getByText("Ana Paula")).toBeTruthy();
    expect(linha.querySelector('img.avatar[src="/api/profile/avatar/1?v=4"]')).toBeTruthy();
  });

  it("perfil novo de alguém chega ao vivo e troca o nome na lista", async () => {
    stubApi(base());
    render(<App />);
    const lista = await screen.findByRole("region", { name: "Membros" });
    await within(lista).findByText("beto");
    act(() => ws().emit({ type: "profile.updated", userId: 2, profile: { displayName: "Bê", about: "", statusKind: "away", statusText: "já volto", avatarVersion: 1 } }));
    expect(await within(lista).findByText("Bê")).toBeTruthy();
    expect(within(lista).queryByText("beto")).toBeNull();
    expect(within(lista).getByText("já volto")).toBeTruthy();
    expect(lista.querySelector('img.avatar[src="/api/profile/avatar/2?v=1"]')).toBeTruthy();
  });

  it("minha conta: salva nome, sobre mim e status", async () => {
    let usuario = euAna;
    const calls = stubApi(
      base(euAna, {
        "GET /api/auth/me": () => ({ status: 200, body: { user: usuario } }),
        "PATCH /api/profile": (body) => {
          usuario = { ...usuario, ...(body as object) };
          return { status: 200, body: { profile: body } };
        },
      }),
    );
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Minha conta" }));
    const janela = await screen.findByRole("dialog", { name: "Minha conta" });
    const nome = within(janela).getByLabelText("Nome de exibição") as HTMLInputElement;
    expect(nome.value).toBe("Ana Paula");
    await userEvent.clear(nome);
    await userEvent.type(nome, "Aninha");
    await userEvent.selectOptions(within(janela).getByLabelText("Status"), "away");
    await userEvent.clear(within(janela).getByLabelText("Texto do status"));
    await userEvent.type(within(janela).getByLabelText("Texto do status"), "almoçando");
    await userEvent.click(within(janela).getByRole("button", { name: "Salvar perfil" }));
    expect(await within(janela).findByText("Perfil salvo.")).toBeTruthy();
    expect(calls.find((c) => c.key === "PATCH /api/profile")?.body).toEqual({ displayName: "Aninha", about: "oi", statusKind: "away", statusText: "almoçando" });
  });

  it("minha conta: erro do servidor aparece", async () => {
    stubApi(base(euAna, { "PATCH /api/profile": () => ({ status: 400, body: { error: "O nome deve ter até 32 caracteres" } }) }));
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Minha conta" }));
    const janela = await screen.findByRole("dialog", { name: "Minha conta" });
    await userEvent.click(within(janela).getByRole("button", { name: "Salvar perfil" }));
    expect((await within(janela).findByRole("alert")).textContent).toBe("O nome deve ter até 32 caracteres");
  });

  it("foto: recorta o centro, reduz para 256 px e envia como JPEG; remover foto chama a API", async () => {
    const desenhos: unknown[][] = [];
    vi.stubGlobal("createImageBitmap", async () => ({ width: 400, height: 300, close() {} }));
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: (...a: unknown[]) => desenhos.push(a) } as never);
    const toBlob = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb) => cb(new Blob(["jpeg"], { type: "image/jpeg" })));
    let enviado: unknown;
    const calls = stubApi(
      base(euAna, {
        "PUT /api/profile/avatar": () => ({ status: 200, body: {} }),
        "DELETE /api/profile/avatar": () => ({ status: 200, body: {} }),
      }),
    );
    const original = globalThis.fetch as unknown as (p: string, i?: { body?: unknown }) => Promise<unknown>;
    vi.stubGlobal("fetch", (p: string, i?: { body?: unknown }) => {
      if (p === "/api/profile/avatar" && (i as { method?: string })?.method === "PUT") enviado = i?.body;
      return original(p, i);
    });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Minha conta" }));
    const janela = await screen.findByRole("dialog", { name: "Minha conta" });
    await userEvent.upload(within(janela).getByLabelText("Escolher foto de perfil"), new File(["x"], "eu.png", { type: "image/png" }));
    await vi.waitFor(() => expect(enviado).toBeInstanceOf(Blob));
    expect((enviado as Blob).type).toBe("image/jpeg");
    expect(desenhos[0]).toEqual([expect.anything(), 50, 0, 300, 300, 0, 0, 256, 256]); // recorte central quadrado, reduzido

    await userEvent.click(within(janela).getByRole("button", { name: "Remover foto" }));
    await vi.waitFor(() => expect(calls.some((c) => c.key === "DELETE /api/profile/avatar")).toBe(true));
    getContext.mockRestore();
    toBlob.mockRestore();
  });

  it("aparência: tema, cor de destaque e tamanho da letra mudam a página e ficam guardados", async () => {
    stubApi(base());
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Minha conta" }));
    const janela = await screen.findByRole("dialog", { name: "Minha conta" });

    await userEvent.click(within(janela).getByRole("radio", { name: "Claro" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    await userEvent.click(within(janela).getByRole("radio", { name: "Escuro" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(within(janela).getByRole("radio", { name: "Escuro" }).getAttribute("aria-checked")).toBe("true");

    await userEvent.click(within(janela).getByRole("radio", { name: "Rosa" }));
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#d6409f");
    await userEvent.click(within(janela).getByRole("radio", { name: "Grande" }));
    expect(document.documentElement.style.fontSize).toBe("18px");

    expect(JSON.parse(localStorage.getItem("concord.appearance") ?? "{}")).toEqual({ theme: "dark", accent: "rosa", fontSize: "large" });
  });

  it("servidor: o dono renomeia e troca o ícone; o ícone e o nome novos aparecem na barra ao vivo", async () => {
    const calls = stubApi(
      base(euAna, {
        "GET /api/servers/7/invites": () => ({ status: 200, body: { invites: [], limit: 10, used: 0, remaining: 10, canSeeAll: true } }),
        "PATCH /api/servers/7": () => ({ status: 200, body: {} }),
        "PUT /api/servers/7/icon": () => ({ status: 200, body: {} }),
      }),
    );
    vi.stubGlobal("createImageBitmap", async () => ({ width: 100, height: 100, close() {} }));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage() {} } as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb) => cb(new Blob(["jpeg"], { type: "image/jpeg" })));
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "⚙ Servidor" }));
    const painel = await screen.findByRole("dialog", { name: "Configurações de Os Parças" });
    await userEvent.click(within(painel).getByRole("tab", { name: "Geral" }));
    const campo = within(painel).getByLabelText("Nome do servidor") as HTMLInputElement;
    await userEvent.clear(campo);
    await userEvent.type(campo, "Os Craques");
    await userEvent.click(within(painel).getByRole("button", { name: "Salvar nome" }));
    await vi.waitFor(() => expect(calls.find((c) => c.key === "PATCH /api/servers/7")?.body).toEqual({ name: "Os Craques" }));
    await userEvent.upload(within(painel).getByLabelText("Escolher ícone do servidor"), new File(["x"], "i.png", { type: "image/png" }));
    await vi.waitFor(() => expect(calls.some((c) => c.key === "PUT /api/servers/7/icon")).toBe(true));

    act(() => ws().emit({ type: "server.updated", serverId: 7, name: "Os Craques", iconVersion: 3 }));
    const botao = await screen.findByRole("button", { name: "Os Craques" });
    expect(botao.querySelector('img.rail-icon[src="/api/servers/7/icon?v=3"]')).toBeTruthy();
    vi.restoreAllMocks();
  });

  it("só o dono vê a aba Geral", async () => {
    stubApi(
      base({ id: 2, username: "beto" }, {
        "GET /api/servers/7/roles": () => ({ status: 200, body: { roles: [], permissions: [], me: { isOwner: false, roleId: 12, permissions: ["kick_ban"] } } }),
      }),
    );
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "⚙ Servidor" }));
    const painel = await screen.findByRole("dialog", { name: "Configurações de Os Parças" });
    expect(within(painel).queryByRole("tab", { name: "Geral" })).toBeNull();
  });
});

describe("mensagens ricas", () => {
  const servidor = { id: 7, name: "Os Parças", ownerId: 1, channels: [{ id: 3, name: "geral" }] };
  const msg = (id: number, content: string, extra: Record<string, unknown> = {}, author = { id: 2, username: "beto" }) => ({
    id,
    channelId: 3,
    dmId: null,
    serverId: 7,
    content,
    createdAt: "2026-10-29T14:05:00.000Z",
    editedAt: null,
    author,
    ...extra,
  });
  const base = {
    "GET /api/auth/me": () => ({ status: 200, body: { user: ana } }),
    "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
  };
  const historico = (...messages: unknown[]) => ({ "GET /api/channels/3/messages": () => ({ status: 200, body: { messages } }) });
  const citacao = { id: 1, deleted: false, author: { id: 2, username: "beto" }, snippet: "vamos jogar hoje?" };

  it("formata texto com segurança: negrito, itálico, riscado, código, bloco e link; HTML continua sendo só texto", async () => {
    stubApi({
      ...base,
      ...historico(
        msg(1, "**forte** *leve* ~~fora~~ `x = 1` veja https://exemplo.com/a. <script>alert(1)</script>"),
        msg(2, "```\nlinha1\nlinha2\n```"),
        msg(3, "javascript:alert(1) e **aberto"),
      ),
      "GET /api/link-preview?url=https%3A%2F%2Fexemplo.com%2Fa": () => ({ status: 200, body: { preview: null } }),
    });
    const { container } = render(<App />);
    await screen.findByText("forte");
    expect(screen.getByText("forte").tagName).toBe("STRONG");
    expect(screen.getByText("leve").tagName).toBe("EM");
    expect(screen.getByText("fora").tagName).toBe("S");
    expect(screen.getByText("x = 1").tagName).toBe("CODE");
    const link = screen.getByRole("link", { name: "https://exemplo.com/a" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://exemplo.com/a"); // o ponto final ficou de fora
    expect(link.rel).toContain("noopener");
    expect(link.target).toBe("_blank");
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
    expect(container.querySelector("pre code")?.textContent).toBe("linha1\nlinha2");
    expect(container.textContent).toContain("javascript:alert(1) e **aberto");
    expect(screen.queryByRole("link", { name: /javascript/ })).toBeNull();
  });

  it("anexa um arquivo: mostra o cartão antes de enviar, manda nome e legenda e exibe o resultado", async () => {
    const calls = stubApi({
      ...base,
      "POST /api/channels/3/attachments?name=plano.pdf&caption=veja": () => ({
        status: 201,
        body: { message: msg(5, "veja", { attachment: { name: "plano.pdf", mime: "application/octet-stream", size: 2048, kind: "file" } }, ana) },
      }),
    });
    render(<App />);
    const input = await screen.findByLabelText("Escolher arquivo");
    await userEvent.upload(input, new File(["conteudo"], "plano.pdf", { type: "application/pdf" }));
    expect(screen.getByText("plano.pdf")).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Mensagem em # geral"), "veja");
    await userEvent.click(screen.getByRole("button", { name: "Enviar" }));

    const cartao = (await screen.findByRole("link", { name: /plano\.pdf/ })) as HTMLAnchorElement;
    expect(cartao.getAttribute("href")).toBe("/api/files/5");
    expect(cartao.getAttribute("download")).toBe("plano.pdf");
    expect(cartao.textContent).toContain("2 KB");
    expect(calls.some((c) => c.key === "POST /api/channels/3/attachments?name=plano.pdf&caption=veja")).toBe(true);
    expect(screen.queryByLabelText("Remover anexo")).toBeNull();
  });

  it("anexo sozinho pode ser enviado; dá para remover antes; arquivo grande é recusado na hora", async () => {
    const calls = stubApi({
      ...base,
      "POST /api/channels/3/attachments?name=foto.png": () => ({
        status: 201,
        body: { message: msg(6, "", { attachment: { name: "foto.png", mime: "image/png", size: 100, kind: "image" } }, ana) },
      }),
    });
    render(<App />);
    const input = await screen.findByLabelText("Escolher arquivo");
    const enviar = screen.getByRole("button", { name: "Enviar" }) as HTMLButtonElement;
    expect(enviar.disabled).toBe(true);

    await userEvent.upload(input, new File([new Uint8Array(9 * 1024 * 1024)], "enorme.bin"));
    expect((await screen.findByRole("alert")).textContent).toContain("8 MB");
    expect(screen.queryByLabelText("Remover anexo")).toBeNull();

    await userEvent.upload(input, new File(["x"], "temp.txt", { type: "text/plain" }));
    await userEvent.click(screen.getByLabelText("Remover anexo"));
    expect(enviar.disabled).toBe(true);

    await userEvent.upload(input, new File(["x"], "foto.png", { type: "image/png" }));
    expect(enviar.disabled).toBe(false);
    await userEvent.click(enviar);
    const img = (await screen.findByAltText("foto.png")) as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/api/files/6");
    expect(calls.some((c) => c.key === "POST /api/channels/3/attachments?name=foto.png")).toBe(true);
  });

  it("clicar na imagem amplia; Esc fecha", async () => {
    stubApi({
      ...base,
      ...historico(msg(1, "", { attachment: { name: "praia.jpg", mime: "image/jpeg", size: 5000, kind: "image" } })),
    });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Ampliar imagem praia.jpg" }));
    const dialogo = screen.getByRole("dialog", { name: "Imagem ampliada" });
    expect(within(dialogo).getByRole("link", { name: "Abrir original" }).getAttribute("href")).toBe("/api/files/1");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Imagem ampliada" })).toBeNull();
  });

  it("responder: a barra mostra a quem, a mensagem leva replyTo e a citação aparece; dá para cancelar", async () => {
    const calls = stubApi({
      ...base,
      ...historico(
        msg(1, "vamos jogar hoje?"),
        msg(2, "bora", { replyTo: citacao }),
        msg(3, "ok", { replyTo: { id: 9, deleted: true, author: null, snippet: "" } }),
      ),
      "POST /api/channels/3/messages": () => ({ status: 201, body: { message: msg(10, "fechado", { replyTo: citacao }, ana) } }),
    });
    render(<App />);
    expect((await screen.findAllByLabelText("Ir para a mensagem respondida")).length).toBe(2);
    expect(screen.getByText("Mensagem apagada")).toBeTruthy();

    await userEvent.click(screen.getAllByLabelText("Responder mensagem")[0]);
    expect(screen.getByText(/Respondendo a/).textContent).toContain("vamos jogar hoje?");
    await userEvent.click(screen.getByLabelText("Cancelar resposta"));
    expect(screen.queryByText(/Respondendo a/)).toBeNull();

    await userEvent.click(screen.getAllByLabelText("Responder mensagem")[0]);
    await userEvent.type(screen.getByLabelText("Mensagem em # geral"), "fechado");
    await userEvent.click(screen.getByRole("button", { name: "Enviar" }));
    await screen.findByText("fechado");
    expect(calls.find((c) => c.key === "POST /api/channels/3/messages")?.body).toEqual({ content: "fechado", replyTo: 1 });
    expect(screen.queryByText(/Respondendo a/)).toBeNull();
  });

  it("reações: escolher emoji, contar, destacar a minha, e atualizar ao vivo", async () => {
    const calls = stubApi({
      ...base,
      ...historico(msg(1, "festa sábado", { reactions: [{ emoji: "🎉", count: 1, users: [2] }] })),
      "POST /api/channels/3/messages/1/reactions": (b) => ({
        status: 200,
        body: {
          reactions:
            (b as { emoji: string }).emoji === "🎉"
              ? [{ emoji: "🎉", count: 2, users: [2, 1] }]
              : [{ emoji: "👍", count: 1, users: [1] }, { emoji: "🎉", count: 1, users: [2] }],
        },
      }),
    });
    render(<App />);
    const festa = await screen.findByRole("button", { name: "🎉 1 reação" });
    expect(festa.getAttribute("aria-pressed")).toBe("false");

    await userEvent.click(festa);
    const dois = await screen.findByRole("button", { name: "🎉 2 reações" });
    expect(dois.getAttribute("aria-pressed")).toBe("true");
    expect(calls.find((c) => c.key === "POST /api/channels/3/messages/1/reactions")?.body).toEqual({ emoji: "🎉" });

    await userEvent.click(screen.getByLabelText("Adicionar reação"));
    await userEvent.click(screen.getByRole("button", { name: "Reagir com 👍" }));
    expect(await screen.findByRole("button", { name: "👍 1 reação" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Escolher emoji" })).toBeNull();

    act(() => FakeWebSocket.instances[0].emit({ type: "message.reactions", messageId: 1, channelId: 3, serverId: 7, reactions: [{ emoji: "😂", count: 3, users: [2, 3, 4] }] }));
    expect(await screen.findByRole("button", { name: "😂 3 reações" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "👍 1 reação" })).toBeNull();
    act(() => FakeWebSocket.instances[0].emit({ type: "message.reactions", messageId: 1, channelId: 99, serverId: 7, reactions: [] }));
    expect(screen.getByRole("button", { name: "😂 3 reações" })).toBeTruthy();
  });

  it("o seletor do campo de texto insere o emoji na mensagem", async () => {
    stubApi(base);
    render(<App />);
    await userEvent.click(await screen.findByLabelText("Inserir emoji"));
    await userEvent.click(screen.getByRole("button", { name: "Inserir 😀" }));
    expect((screen.getByLabelText("Mensagem em # geral") as HTMLInputElement).value).toBe("😀");
  });

  it("fixar e desafixar (quem modera), com a marca na mensagem e o painel de fixadas", async () => {
    const fixada = msg(1, "regras: sem spoiler", { pinned: true });
    const calls = stubApi({
      ...base,
      ...historico(msg(1, "regras: sem spoiler"), msg(2, "outra")),
      "PUT /api/channels/3/messages/1/pin": () => ({ status: 200, body: { message: fixada } }),
      "DELETE /api/channels/3/messages/1/pin": () => ({ status: 200, body: { message: msg(1, "regras: sem spoiler", { pinned: false }) } }),
      "GET /api/channels/3/pins": () => ({ status: 200, body: { messages: [fixada] } }),
    });
    render(<App />);
    await userEvent.click((await screen.findAllByLabelText("Fixar mensagem"))[0]);
    expect(await screen.findByText("📌 Fixada")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: /Fixadas/ }));
    const painel = await screen.findByRole("region", { name: "Mensagens fixadas" });
    expect(await within(painel).findByText("regras: sem spoiler")).toBeTruthy();
    await userEvent.click(within(painel).getByLabelText("Fechar painel"));
    expect(screen.queryByRole("region", { name: "Mensagens fixadas" })).toBeNull();

    await userEvent.click(screen.getByLabelText("Desafixar mensagem"));
    await vi.waitFor(() => expect(screen.queryByText("📌 Fixada")).toBeNull());
    expect(calls.some((c) => c.key === "DELETE /api/channels/3/messages/1/pin")).toBe(true);
  });

  it("quem não modera o canal não vê o botão de fixar", async () => {
    stubApi({
      "GET /api/auth/me": () => ({ status: 200, body: { user: { id: 2, username: "beto" } } }),
      "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
      ...historico(msg(1, "oi", {}, ana)),
    });
    render(<App />);
    await screen.findByText("oi");
    expect(screen.queryByLabelText("Fixar mensagem")).toBeNull();
  });

  it("buscar: mostra os resultados, explica quando não acha, e recusa busca curta sem ir ao servidor", async () => {
    const calls = stubApi({
      ...base,
      ...historico(msg(1, "vamos jogar")),
      "GET /api/channels/3/search?q=jogar": () => ({
        status: 200,
        body: { messages: [msg(1, "vamos jogar"), msg(7, "", { attachment: { name: "jogar.png", mime: "image/png", size: 1, kind: "image" } })] },
      }),
      "GET /api/channels/3/search?q=zzzz": () => ({ status: 200, body: { messages: [] } }),
    });
    render(<App />);
    const busca = await screen.findByLabelText("Buscar mensagens");
    await userEvent.type(busca, "j{Enter}");
    expect((await screen.findByRole("alert")).textContent).toContain("2 letras");

    await userEvent.clear(busca);
    await userEvent.type(busca, "jogar{Enter}");
    const painel = await screen.findByRole("region", { name: "Resultados da busca" });
    expect(await within(painel).findByText("📎 jogar.png")).toBeTruthy();
    expect(within(painel).getAllByLabelText("Ir para a mensagem de beto").length).toBe(2);

    await userEvent.clear(busca);
    await userEvent.type(busca, "zzzz{Enter}");
    expect(await within(await screen.findByRole("region", { name: "Resultados da busca" })).findByText("Nada encontrado.")).toBeTruthy();
    expect(calls.filter((c) => c.key.includes("/search")).length).toBe(2);
  });

  it("'digitando': mostra quem está digitando (um, dois, vários), some sozinho e ao chegar a mensagem; só deste canal", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      stubApi({ ...base, ...historico() });
      render(<App />);
      await screen.findByLabelText("Mensagem em # geral");
      const ws = FakeWebSocket.instances[0];
      act(() => ws.emit({ type: "typing", userId: 2, username: "beto", channelId: 3 }));
      expect(screen.getByText("beto está digitando...")).toBeTruthy();
      act(() => ws.emit({ type: "typing", userId: 3, username: "carla", channelId: 3 }));
      expect(screen.getByText("beto e carla estão digitando...")).toBeTruthy();
      act(() => ws.emit({ type: "typing", userId: 4, username: "davi", channelId: 3 }));
      expect(screen.getByText("Várias pessoas estão digitando...")).toBeTruthy();
      act(() => ws.emit({ type: "typing", userId: 5, username: "eva", channelId: 99 }));
      expect(screen.getByText("Várias pessoas estão digitando...")).toBeTruthy();

      act(() => ws.emit({ type: "message.created", message: msg(1, "pronto") }));
      expect(screen.getByText("carla e davi estão digitando...")).toBeTruthy();
      act(() => void vi.advanceTimersByTime(6100));
      expect(screen.queryByText(/digitando/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ao digitar avisa o servidor só uma vez a cada 2 s", async () => {
    stubApi({ ...base, ...historico() });
    render(<App />);
    const caixa = await screen.findByLabelText("Mensagem em # geral");
    const ws = FakeWebSocket.instances[0];
    await userEvent.type(caixa, "oi tudo bem");
    expect(ws.sent.filter((m) => (m as { type: string }).type === "typing")).toEqual([{ type: "typing", channelId: 3 }]);
  });

  it("o primeiro link da mensagem ganha um cartão com título e descrição", async () => {
    stubApi({
      ...base,
      ...historico(msg(1, "olha https://noticia.com/x")),
      "GET /api/link-preview?url=https%3A%2F%2Fnoticia.com%2Fx": () => ({
        status: 200,
        body: { preview: { url: "https://noticia.com/x", title: "Grande notícia", description: "Resumo da notícia", site: "noticia.com" } },
      }),
    });
    render(<App />);
    const cartao = (await screen.findByRole("link", { name: /Grande notícia/ })) as HTMLAnchorElement;
    expect(cartao.textContent).toContain("Resumo da notícia");
    expect(cartao.getAttribute("href")).toBe("https://noticia.com/x");
    expect(cartao.rel).toContain("noopener");
  });
});

describe("avisos: não lidas, menções, silenciar e sons", () => {
  const servidor = {
    id: 7,
    name: "Os Parças",
    ownerId: 1,
    channels: [{ id: 3, name: "geral" }, { id: 4, name: "jogos" }],
  };
  const msg = (id: number, content: string, channelId = 4, author = { id: 2, username: "beto" }, extra: Record<string, unknown> = {}) => ({
    id,
    channelId,
    dmId: null,
    serverId: 7,
    content,
    createdAt: "2026-10-29T14:05:00.000Z",
    editedAt: null,
    author,
    ...extra,
  });
  const nenhuma = { unread: 0, mentions: 0 };
  const baseRotas = (extra: Record<string, Handler> = {}) => ({
    "GET /api/auth/me": () => ({ status: 200, body: { user: ana } }),
    "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
    "GET /api/unread": () => ({ status: 200, body: { channels: { 3: nenhuma, 4: nenhuma }, dms: {}, mutes: { channels: [], servers: [], dms: [] } } }),
    ...extra,
  });
  const emitir = (event: unknown) => act(() => FakeWebSocket.instances[0].emit(event));
  const tocou = playSoundMock;

  beforeEach(() => {
    localStorage.clear();
    resetNotifyPrefs();
    tocou.mockClear();
    document.title = "Concord Hub";
  });

  it("canal com mensagem nova ganha marcador com o número, e abrir o canal zera e avisa o servidor", async () => {
    const calls = stubApi({ ...baseRotas(), "PUT /api/channels/4/read": () => ({ status: 204 }) });
    render(<App />);
    await screen.findByRole("button", { name: "# jogos" });
    emitir({ type: "message.created", message: msg(10, "bora?") });
    emitir({ type: "message.created", message: msg(11, "alguém?") });
    expect((await screen.findAllByRole("img", { name: "2 não lidas" }))[0]).toBeTruthy();
    expect(document.title).toBe("(2) Concord Hub");
    expect(screen.getByRole("button", { name: /# jogos/ }).className).toContain("has-unread");

    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event("focus"))); // a janela está em foco
    await userEvent.click(screen.getByRole("button", { name: /# jogos/ }));
    await vi.waitFor(() => expect(screen.queryAllByRole("img", { name: "2 não lidas" })).toHaveLength(0));
    vi.restoreAllMocks();
    expect(calls.some((c) => c.key === "PUT /api/channels/4/read")).toBe(true);
    expect(document.title).toBe("Concord Hub");
  });

  it("a foto inicial mostra o que ficou sem ler, com menções em vermelho; o servidor soma os canais", async () => {
    stubApi({
      ...baseRotas({
        "GET /api/unread": () => ({ status: 200, body: { channels: { 3: { unread: 150, mentions: 0 }, 4: { unread: 5, mentions: 2 } }, dms: {}, mutes: { channels: [], servers: [], dms: [] } } }),
      }),
    });
    render(<App />);
    expect(await screen.findByRole("img", { name: "99+ não lidas" })).toBeTruthy();
    expect(screen.getAllByRole("img", { name: "2 menções" }).length).toBeGreaterThan(0); // no canal e no ícone do servidor
  });

  it("menção a mim: marcador vermelho e destaque na mensagem; a de outra pessoa, não", async () => {
    stubApi({ ...baseRotas(), "GET /api/channels/4/messages": () => ({ status: 200, body: { messages: [msg(1, "oi @ana, vem"), msg(2, "oi @anabel")] } }) });
    render(<App />);
    await screen.findByRole("button", { name: "# jogos" });
    await userEvent.click(screen.getByRole("button", { name: "# jogos" }));
    const mencionada = (await screen.findByText(/oi @ana, vem/)).closest("li")!;
    expect(mencionada.className).toContain("mention-me");
    expect(screen.getByText("oi @anabel").closest("li")!.className).not.toContain("mention-me");
  });

  it("mensagem no canal que estou vendo, com a janela em foco, é lida na hora: sem marcador e sem som", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const calls = stubApi({ ...baseRotas(), "PUT /api/channels/3/read": () => ({ status: 204 }) });
    render(<App />);
    await screen.findByLabelText("Mensagem em # geral");
    emitir({ type: "message.created", message: msg(10, "oi", 3) });
    await vi.waitFor(() => expect(calls.some((c) => c.key === "PUT /api/channels/3/read")).toBe(true));
    expect(screen.queryAllByRole("img", { name: /não lidas/ })).toHaveLength(0);
    expect(tocou).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("sons: mensagem comum, menção (outro som), minhas mensagens não tocam; volume vem das preferências", async () => {
    stubApi(baseRotas());
    render(<App />);
    await screen.findByRole("button", { name: "# jogos" });
    emitir({ type: "message.created", message: msg(10, "oi") });
    expect(tocou).toHaveBeenLastCalledWith("message", 60);
    emitir({ type: "message.created", message: msg(11, "ei @ana") });
    expect(tocou).toHaveBeenLastCalledWith("mention", 60);
    tocou.mockClear();
    emitir({ type: "message.created", message: msg(12, "eu mesma", 4, { id: 1, username: "ana" }) });
    expect(tocou).not.toHaveBeenCalled();
  });

  it("silenciar o canal: PUT, ícone muda, marcador vira ponto discreto e não toca; só a menção continua contando", async () => {
    const calls = stubApi({ ...baseRotas(), "PUT /api/mutes/channel/4": () => ({ status: 204 }), "DELETE /api/mutes/channel/4": () => ({ status: 204 }) });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Silenciar jogos" }));
    expect(calls.some((c) => c.key === "PUT /api/mutes/channel/4")).toBe(true);
    expect(screen.getByRole("button", { name: "Reativar avisos de jogos" }).getAttribute("aria-pressed")).toBe("true");

    emitir({ type: "message.created", message: msg(10, "oi") });
    expect(tocou).not.toHaveBeenCalled();
    expect((await screen.findAllByRole("img", { name: "1 não lidas" }))[0]).toBeTruthy();
    expect(document.title).toBe("Concord Hub"); // silenciado não entra no título
    emitir({ type: "message.created", message: msg(11, "@ana olha") });
    expect(tocou).not.toHaveBeenCalled();
    expect((await screen.findAllByRole("img", { name: "1 menção" }))[0]).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Reativar avisos de jogos" }));
    expect(calls.some((c) => c.key === "DELETE /api/mutes/channel/4")).toBe(true);
  });

  it("silenciar o servidor inteiro cala o som de qualquer canal dele", async () => {
    const calls = stubApi({ ...baseRotas(), "PUT /api/mutes/server/7": () => ({ status: 204 }) });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "🔔 Silenciar servidor" }));
    expect(calls.some((c) => c.key === "PUT /api/mutes/server/7")).toBe(true);
    emitir({ type: "message.created", message: msg(10, "oi") });
    expect(tocou).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "🔕 Servidor silenciado" })).toBeTruthy();
  });

  it("o que foi silenciado ou lido em outro aparelho chega por evento", async () => {
    stubApi({
      ...baseRotas({
        "GET /api/unread": () => ({ status: 200, body: { channels: { 3: nenhuma, 4: { unread: 3, mentions: 0 } }, dms: {}, mutes: { channels: [], servers: [], dms: [] } } }),
      }),
    });
    render(<App />);
    expect((await screen.findAllByRole("img", { name: "3 não lidas" }))[0]).toBeTruthy();
    emitir({ type: "read.updated", kind: "channel", id: 4 });
    await vi.waitFor(() => expect(screen.queryAllByRole("img", { name: "3 não lidas" })).toHaveLength(0));
    emitir({ type: "mute.updated", kind: "channel", id: 3, muted: true });
    expect(await screen.findByRole("button", { name: "Reativar avisos de geral" })).toBeTruthy();
  });

  it("status Não perturbe e som desligado: nada toca, mas os marcadores continuam", async () => {
    stubApi({ ...baseRotas(), "GET /api/auth/me": () => ({ status: 200, body: { user: { ...ana, statusKind: "dnd" } } }) });
    render(<App />);
    await screen.findByRole("button", { name: "# jogos" });
    emitir({ type: "message.created", message: msg(10, "oi") });
    expect(tocou).not.toHaveBeenCalled();
    expect((await screen.findAllByRole("img", { name: "1 não lidas" }))[0]).toBeTruthy();
  });

  it("DM: mensagem nova vira marcador vermelho no @ e na conversa, e toca o som de menção", async () => {
    stubApi({
      ...baseRotas(),
      "GET /api/dms": () => ({ status: 200, body: { dms: [{ id: 9, user: { id: 2, username: "beto", online: true } }] } }),
    });
    render(<App />);
    await screen.findByRole("button", { name: "# jogos" });
    emitir({ type: "message.created", message: { ...msg(10, "psiu", 4), channelId: null, dmId: 9, serverId: null } });
    expect(await screen.findByRole("img", { name: "1 menção" })).toBeTruthy();
    expect(tocou).toHaveBeenLastCalledWith("mention", 60);
    await userEvent.click(screen.getByRole("button", { name: "Mensagens diretas" }));
    expect((await screen.findAllByRole("img", { name: "1 menção" })).length).toBe(2); // ícone @ e a conversa
  });

  it("Minha conta → Avisos: liga/desliga o som, ajusta o volume e testa; fica guardado no aparelho", async () => {
    stubApi(baseRotas());
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Minha conta" }));
    const avisos = within(await screen.findByRole("region", { name: "Avisos" }));
    await userEvent.click(avisos.getByRole("button", { name: "Testar som de menção" }));
    expect(tocou).toHaveBeenLastCalledWith("mention", 60);

    fireEvent.change(avisos.getByLabelText("Volume do som"), { target: { value: "30" } });
    await userEvent.click(avisos.getByRole("button", { name: "Testar som de mensagem" }));
    expect(tocou).toHaveBeenLastCalledWith("message", 30);

    await userEvent.click(avisos.getByLabelText("Tocar som quando chegar mensagem"));
    expect((avisos.getByRole("button", { name: "Testar som de mensagem" }) as HTMLButtonElement).disabled).toBe(true);
    expect(JSON.parse(localStorage.getItem("concord.notify")!)).toMatchObject({ sounds: false, volume: 30 });
  });

  it("notificação do navegador: pede permissão ao ligar, e só aparece com a janela em segundo plano", async () => {
    const criadas: { title: string; body: string }[] = [];
    class FakeNotification {
      static permission = "default";
      static requestPermission = vi.fn(async () => {
        FakeNotification.permission = "granted";
        return "granted";
      });
      onclick: (() => void) | null = null;
      constructor(public title: string, opts: { body: string }) {
        criadas.push({ title, body: opts.body });
      }
      close() {}
    }
    vi.stubGlobal("Notification", FakeNotification);
    stubApi(baseRotas());
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Minha conta" }));
    await userEvent.click(screen.getByLabelText("Notificações do navegador (com a janela em segundo plano)"));
    expect(FakeNotification.requestPermission).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Fechar" }));

    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    emitir({ type: "message.created", message: msg(10, "com foco") });
    expect(criadas).toEqual([]);
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    emitir({ type: "message.created", message: msg(11, "em segundo plano") });
    expect(criadas).toEqual([{ title: "beto", body: "em segundo plano" }]);
    emitir({ type: "message.created", message: msg(12, "", 4, { id: 2, username: "beto" }, { attachment: { name: "a.png", mime: "image/png", size: 1, kind: "image" } }) });
    expect(criadas[1].body).toBe("enviou um arquivo");
    vi.restoreAllMocks();
  });
});

describe("voz melhor: dispositivos, volume, ensurdecer, apertar para falar e tirar da sala", () => {
  const servidor = {
    id: 7,
    name: "Os Parças",
    ownerId: 1,
    channels: [
      { id: 3, name: "geral", type: "text" },
      { id: 4, name: "sala-1", type: "voice" },
    ],
  };
  const base = (extra: Record<string, Handler> = {}) => ({
    "GET /api/auth/me": () => ({ status: 200, body: { user: ana } }),
    "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
    ...extra,
  });
  // este aparelho pede para entrar (só assim a ligação começa aqui) e o servidor confirma
  const euEntrei = () => {
    fireEvent.click(screen.getByRole("button", { name: "🔊 sala-1" }));
    fireEvent.click(screen.getByRole("button", { name: "Entrar na sala" }));
    act(() => FakeWebSocket.instances[0].emit({ type: "voice.joined", serverId: 7, channelId: 4, user: { id: 1, username: "ana" } }));
  };
  const sala = () => livekit.FakeRoom.instances[0];
  const beto = { identity: "2", name: "beto", isMicrophoneEnabled: true, getTrackPublication: () => undefined };
  const faixaDeAudio = () => {
    const el = document.createElement("audio");
    return { kind: "audio", attach: () => el, detach: () => [] as HTMLElement[], setVolume: vi.fn(), el };
  };
  /** Entra na sala e espera conectar; devolve a barra de voz. */
  async function entrar() {
    render(<App />);
    await screen.findByRole("button", { name: "🔊 sala-1" });
    euEntrei();
    const barra = await screen.findByRole("group", { name: "Chamada de voz" });
    await vi.waitFor(() => expect(within(barra).getByText("Voz conectada")).toBeTruthy());
    return barra;
  }

  beforeEach(() => {
    localStorage.clear();
    resetVoicePrefs();
  });

  it("escolher microfone, câmera e caixa de som: guarda a escolha e troca na hora; a próxima sala já usa", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      mediaDevices: {
        enumerateDevices: async () => [
          { kind: "audioinput", deviceId: "mic1", label: "Microfone da mesa" },
          { kind: "audioinput", deviceId: "mic2", label: "Headset" },
          { kind: "videoinput", deviceId: "cam1", label: "Webcam HD" },
          { kind: "audiooutput", deviceId: "out1", label: "Caixas" },
        ],
        addEventListener() {},
        removeEventListener() {},
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, "setSinkId", { configurable: true, value: async () => {} });
    stubApi(base());
    const barra = await entrar();
    await userEvent.click(within(barra).getByText("⚙ Ajustes de voz"));
    await userEvent.selectOptions(await within(barra).findByLabelText("Microfone"), "mic2");
    expect(sala().switchActiveDevice).toHaveBeenCalledWith("audioinput", "mic2");
    await userEvent.selectOptions(within(barra).getByLabelText("Câmera"), "cam1");
    expect(sala().switchActiveDevice).toHaveBeenCalledWith("videoinput", "cam1");
    await userEvent.selectOptions(within(barra).getByLabelText("Caixa de som"), "out1");
    expect(sala().switchActiveDevice).toHaveBeenCalledWith("audiooutput", "out1");
    expect(JSON.parse(localStorage.getItem("concord.voice")!)).toMatchObject({ micId: "mic2", camId: "cam1", speakerId: "out1" });

    await userEvent.click(within(barra).getByRole("button", { name: "Desconectar" }));
    act(() => FakeWebSocket.instances[0].emit({ type: "voice.left", serverId: 7, channelId: 4, userId: 1 }));
    await vi.waitFor(() => expect(screen.queryByRole("group", { name: "Chamada de voz" })).toBeNull());
    euEntrei();
    await vi.waitFor(() => expect(livekit.FakeRoom.instances.length).toBe(2));
    expect(livekit.FakeRoom.instances[1].options).toMatchObject({
      audioCaptureDefaults: { deviceId: "mic2" },
      videoCaptureDefaults: { deviceId: "cam1" },
      audioOutput: { deviceId: "out1" },
    });
    delete (HTMLMediaElement.prototype as unknown as Record<string, unknown>).setSinkId;
  });

  it("supressão de ruído: já vem ligada, entra com o filtro forte e liga/desliga na hora sem calar o microfone", async () => {
    stubApi(base());
    const barra = await entrar();
    expect(sala().options.audioCaptureDefaults).toMatchObject({ noiseSuppression: true, echoCancellation: true });
    const setProcessor = vi.fn(async (_p: unknown) => {});
    const stopProcessor = vi.fn(async () => {});
    const restartTrack = vi.fn(async (_o: object) => {});
    sala().localParticipant.pubs.microphone = { audioTrack: { setProcessor, stopProcessor, getProcessor: () => undefined, restartTrack } };
    sala().localParticipant.setMicrophoneEnabled.mockClear();
    await userEvent.click(within(barra).getByText("⚙ Ajustes de voz"));
    const ruido = within(barra).getByLabelText("Supressão de ruído do microfone") as HTMLInputElement;
    expect(ruido.checked).toBe(true);
    await userEvent.click(ruido); // desliga
    await vi.waitFor(() => expect(stopProcessor).toHaveBeenCalled());
    expect(restartTrack).not.toHaveBeenCalled();
    expect(sala().localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled(); // não mexe no mudo
    expect(JSON.parse(localStorage.getItem("concord.voice")!)).toMatchObject({ noiseSuppression: false });
    await userEvent.click(ruido); // liga de novo
    await vi.waitFor(() => expect(setProcessor).toHaveBeenCalledWith(expect.objectContaining({ name: "concord-noise-suppression" })));
  });

  it("filtro de ruído mostra se está ativo e o teste do microfone toca com e sem o filtro", async () => {
    stubApi(base());
    const barra = await entrar();
    sala().localParticipant.pubs.microphone = { audioTrack: { setProcessor: vi.fn(async (_p: unknown) => {}), stopProcessor: vi.fn(async () => {}), getProcessor: () => undefined } };
    await userEvent.click(within(barra).getByText("⚙ Ajustes de voz"));
    const ruido = within(barra).getByLabelText("Supressão de ruído do microfone");
    await userEvent.click(ruido); // desliga: o aviso some
    expect(within(barra).queryByText(/Filtro forte de ruído/)).toBeNull();
    await userEvent.click(ruido); // liga: agora o filtro entra e o aviso diz que está ativo
    expect(await within(barra).findByText(/Filtro forte de ruído: ativo/)).toBeTruthy();

    const { startMicTest } = await import("./micTest");
    await userEvent.click(within(barra).getByRole("button", { name: "Ouvir com o filtro" }));
    expect(startMicTest).toHaveBeenLastCalledWith(true);
    await userEvent.click(within(barra).getByRole("button", { name: "Ouvir sem o filtro" }));
    expect(startMicTest).toHaveBeenLastCalledWith(false);
    expect(within(barra).getAllByRole("button", { name: "Parar" })).toHaveLength(1);
  });

  it("sensibilidade do portão: automática por padrão; no manual aparece o limite e fica guardado; o medidor mostra o nível", async () => {
    stubApi(base());
    const barra = await entrar();
    await userEvent.click(within(barra).getByText("⚙ Ajustes de voz"));
    const auto = within(barra).getByLabelText(/Sensibilidade automática/) as HTMLInputElement;
    expect(auto.checked).toBe(true);
    expect(within(barra).queryByLabelText("Limite do portão de voz")).toBeNull();
    await userEvent.click(auto);
    const limite = within(barra).getByLabelText("Limite do portão de voz") as HTMLInputElement;
    expect(limite.value).toBe("-45");
    fireEvent.change(limite, { target: { value: "-32" } });
    expect(JSON.parse(localStorage.getItem("concord.voice")!)).toMatchObject({ gateAuto: false, gateDb: -32 });
    expect(within(barra).getByText(/Só passa som acima de -32 dB/)).toBeTruthy();
    const { emitGateLevel } = await import("./gateLevel");
    act(() => emitGateLevel({ db: -20, threshold: -32, open: true }));
    expect(within(barra).getByRole("img", { name: /Volume do microfone -20 dB, portão aberto/ })).toBeTruthy();
  });

  it("filtro de ruído que não consegue ligar avisa o motivo", async () => {
    stubApi(base());
    const barra = await entrar();
    sala().localParticipant.pubs.microphone = { audioTrack: { setProcessor: vi.fn(async () => { throw new Error("sem AudioWorklet"); }), stopProcessor: vi.fn(async () => {}), getProcessor: () => undefined } };
    await userEvent.click(within(barra).getByText("⚙ Ajustes de voz"));
    const ruido = within(barra).getByLabelText("Supressão de ruído do microfone");
    await userEvent.click(ruido);
    await userEvent.click(ruido);
    expect(await within(barra).findByText(/não conseguiu ligar neste aparelho \(sem AudioWorklet\)/)).toBeTruthy();
  });

  it("supressão de ruído: se o navegador não muda a faixa em uso, reinicia e mantém o microfone aberto", async () => {
    stubApi(base());
    const barra = await entrar();
    const restartTrack = vi.fn(async (_o: object) => {});
    sala().localParticipant.pubs.microphone = { audioTrack: { mediaStreamTrack: { applyConstraints: vi.fn(async () => { throw new Error("não suportado"); }) }, restartTrack } };
    sala().localParticipant.isMicrophoneEnabled = true;
    sala().localParticipant.setMicrophoneEnabled.mockClear();
    await userEvent.click(within(barra).getByText("⚙ Ajustes de voz"));
    await userEvent.click(within(barra).getByLabelText("Cancelamento de eco"));
    await vi.waitFor(() => expect(restartTrack).toHaveBeenCalledWith(expect.objectContaining({ echoCancellation: false })));
    await vi.waitFor(() => expect(sala().localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true));
  });

  it("transmissão de tela: volume próprio (separado da voz) e tela cheia no quadro", async () => {
    Object.defineProperty(document, "fullscreenEnabled", { value: true, configurable: true });
    stubApi(base());
    await entrar();
    act(() => FakeWebSocket.instances[0].emit({ type: "voice.joined", serverId: 7, channelId: 4, user: { id: 2, username: "beto" } }));
    const tela = { attach: vi.fn(), detach: vi.fn(), getSenderStats: vi.fn(async () => []), getReceiverStats: vi.fn(async () => undefined) };
    sala().remoteParticipants.set("2", { identity: "2", name: "beto", isMicrophoneEnabled: true, getTrackPublication: (fonte: string) => (fonte === "screen_share" ? { track: tela, isMuted: false } : undefined) });
    act(() => sala().handlers.trackSubscribed({ kind: "video", attach: () => document.createElement("video"), detach: () => [] }));
    const voz = { ...faixaDeAudio(), source: "microphone" };
    const somTela = { ...faixaDeAudio(), source: "screen_share_audio" };
    act(() => sala().handlers.trackSubscribed(voz, {}, beto));
    act(() => sala().handlers.trackSubscribed(somTela, {}, beto));

    const quadro = await screen.findByLabelText("Tela de beto");
    const controle = within(quadro).getByLabelText("Volume da transmissão de beto") as HTMLInputElement;
    expect(controle.value).toBe("100");
    fireEvent.change(controle, { target: { value: "25" } });
    await vi.waitFor(() => expect(somTela.setVolume).toHaveBeenLastCalledWith(0.25)); // só o som da transmissão muda
    expect(voz.setVolume).not.toHaveBeenLastCalledWith(0.25);
    expect(JSON.parse(localStorage.getItem("concord.voice")!).streamVolumes).toEqual({ "2": 25 });

    // tela cheia pelo botão
    const requestFullscreen = vi.fn(async () => {});
    (quadro as unknown as { requestFullscreen: unknown }).requestFullscreen = requestFullscreen;
    await userEvent.click(within(quadro).getByRole("button", { name: /^Tela cheia: Tela de beto/ }));
    expect(requestFullscreen).toHaveBeenCalled();
    delete (document as unknown as Record<string, unknown>).fullscreenEnabled;
  });

  it("volume de cada pessoa: o controle aparece para quem está na sala, vale na hora e fica guardado para as próximas vezes", async () => {
    stubApi(base());
    const barra = await entrar();
    sala().remoteParticipants.set("2", beto);
    act(() => sala().handlers.participantConnected?.());
    await userEvent.click(within(barra).getByText("⚙ Ajustes de voz"));
    const controle = await within(barra).findByLabelText("Volume de beto");
    expect((controle as HTMLInputElement).value).toBe("100");

    const faixa = faixaDeAudio();
    act(() => sala().handlers.trackSubscribed?.(faixa, {}, beto));
    expect(faixa.setVolume).toHaveBeenLastCalledWith(1);
    fireEvent.change(controle, { target: { value: "30" } });
    expect(faixa.setVolume).toHaveBeenLastCalledWith(0.3);
    expect(JSON.parse(localStorage.getItem("concord.voice")!).volumes).toEqual({ "2": 30 });

    const outra = faixaDeAudio(); // faixa nova do mesmo beto (reconectou): já entra no volume escolhido
    act(() => sala().handlers.trackSubscribed?.(outra, {}, beto));
    expect(outra.setVolume).toHaveBeenLastCalledWith(0.3);
  });

  it("ensurdecer: corta o som de todos e o microfone; voltar a ouvir devolve o microfone como estava", async () => {
    stubApi(base());
    const barra = await entrar();
    const faixa = faixaDeAudio();
    act(() => sala().handlers.trackSubscribed?.(faixa, {}, beto));

    await userEvent.click(within(barra).getByRole("button", { name: "Ensurdecer" }));
    expect((faixa.el as HTMLAudioElement).muted).toBe(true);
    expect(sala().localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
    const nova = faixaDeAudio(); // quem chega enquanto estou ensurdecida também fica sem som
    act(() => sala().handlers.trackSubscribed?.(nova, {}, { ...beto, identity: "3" }));
    expect((nova.el as HTMLAudioElement).muted).toBe(true);

    await userEvent.click(within(barra).getByRole("button", { name: "Voltar a ouvir" }));
    expect((faixa.el as HTMLAudioElement).muted).toBe(false);
    expect(sala().localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(true);
    expect(within(barra).getByRole("button", { name: "Mutar" })).toBeTruthy();
  });

  it("ensurdecer com o microfone já mutado: ao voltar a ouvir ele continua mutado", async () => {
    stubApi(base());
    const barra = await entrar();
    await userEvent.click(within(barra).getByRole("button", { name: "Mutar" }));
    await userEvent.click(within(barra).getByRole("button", { name: "Ensurdecer" }));
    sala().localParticipant.setMicrophoneEnabled.mockClear();
    await userEvent.click(within(barra).getByRole("button", { name: "Voltar a ouvir" }));
    expect(sala().localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(within(barra).getByRole("button", { name: "Ativar microfone" })).toBeTruthy();
  });

  it("apertar para falar: microfone fechado até segurar a tecla; ignora a tecla ao digitar; trocar a tecla; desligar volta ao normal", async () => {
    stubApi(base());
    const barra = await entrar();
    fireEvent.click(screen.getByRole("button", { name: "# geral" })); // o teste digita no chat de texto
    await userEvent.click(within(barra).getByText("⚙ Ajustes de voz"));
    await userEvent.click(within(barra).getByLabelText("Falar só segurando uma tecla"));
    await vi.waitFor(() => expect(sala().localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false));
    expect(within(barra).getByRole("button", { name: "Ativar microfone" })).toBeTruthy();

    fireEvent.keyDown(window, { code: "KeyV" });
    expect(sala().localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(true);
    fireEvent.keyUp(window, { code: "KeyV" });
    expect(sala().localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);

    sala().localParticipant.setMicrophoneEnabled.mockClear();
    fireEvent.keyDown(screen.getByLabelText("Mensagem em # geral"), { code: "KeyV" }); // digitando a letra V
    expect(sala().localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();

    await userEvent.click(within(barra).getByRole("button", { name: /Tecla de falar: V/ }));
    fireEvent.keyDown(window, { code: "KeyT" });
    expect(await within(barra).findByRole("button", { name: /Tecla de falar: T/ })).toBeTruthy();
    sala().localParticipant.setMicrophoneEnabled.mockClear();
    fireEvent.keyDown(window, { code: "KeyV" }); // a antiga não vale mais
    expect(sala().localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { code: "KeyT" });
    expect(sala().localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(true);

    await userEvent.click(within(barra).getByLabelText("Falar só segurando uma tecla"));
    expect(sala().localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(true);
    expect(JSON.parse(localStorage.getItem("concord.voice")!)).toMatchObject({ pushToTalk: false, pttKey: "KeyT" });
  });

  it("quem modera vê 'Tirar da sala' nos outros (nunca em si nem no dono) e o servidor é avisado", async () => {
    const calls = stubApi(
      base({
        "GET /api/servers/7/voice": () => ({
          status: 200,
          body: { participants: [{ channelId: 4, userId: 1, username: "ana" }, { channelId: 4, userId: 2, username: "beto" }] },
        }),
        "POST /api/voice/kick": () => ({ status: 204 }),
      }),
    );
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "🔊 sala-1" }));
    const botao = await screen.findByRole("button", { name: "Tirar beto da sala" });
    expect(screen.queryByRole("button", { name: "Tirar ana da sala" })).toBeNull();
    await userEvent.click(botao);
    expect(calls.find((c) => c.key === "POST /api/voice/kick")?.body).toEqual({ userId: 2 });
  });

  it("sem permissão não aparece o botão; quem foi tirado vê o aviso", async () => {
    stubApi({
      "GET /api/auth/me": () => ({ status: 200, body: { user: { id: 2, username: "beto" } } }),
      "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
      "GET /api/servers/7/voice": () => ({ status: 200, body: { participants: [{ channelId: 4, userId: 1, username: "ana" }] } }),
    });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "🔊 sala-1" }));
    await screen.findByText("1 pessoa na sala:");
    expect(screen.queryByRole("button", { name: /Tirar .* da sala/ })).toBeNull();
    act(() => FakeWebSocket.instances[0].emit({ type: "voice.kicked", serverId: 7, channelId: 4, byUserId: 1 }));
    expect((await screen.findByRole("status")).textContent).toContain("tirado da sala de voz");
  });
});

describe("administração: backups e limites", () => {
  const servidor = { id: 7, name: "Os Parças", ownerId: 1, channels: [{ id: 3, name: "geral" }] };
  const rotas = (admin: boolean, extra: Record<string, Handler> = {}) => ({
    "GET /api/auth/me": () => ({ status: 200, body: { user: { ...ana, isAdmin: admin } } }),
    "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
    ...extra,
  });

  it("a administradora vê o último backup automático e o link para baixar um novo", async () => {
    const calls = stubApi(
      rotas(true, {
        "GET /api/admin/backups": () => ({
          status: 200,
          body: { backups: [{ name: "concord-20261030-120000.db", size: 90000, createdAt: "2026-10-30T12:00:00.000Z" }, { name: "concord-20261029-120000.db", size: 80000, createdAt: "2026-10-29T12:00:00.000Z" }] },
        }),
      }),
    );
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Minha conta" }));
    const secao = within(await screen.findByRole("region", { name: "Administração" }));
    expect((await secao.findByText(/Último backup automático/)).textContent).toContain("2 guardados");
    const link = secao.getByRole("link", { name: "Baixar um backup agora" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/api/admin/backup");
    expect(link.hasAttribute("download")).toBe(true);
    expect(calls.some((c) => c.key === "GET /api/admin/backups")).toBe(true);
  });

  it("sem backup ainda, explica; quem não é administradora nem vê a seção", async () => {
    stubApi(rotas(true, { "GET /api/admin/backups": () => ({ status: 200, body: { backups: [] } }) }));
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Minha conta" }));
    expect(await screen.findByText(/Ainda não há backup automático/)).toBeTruthy();
    cleanup();

    const calls = stubApi(rotas(false));
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Minha conta" }));
    await screen.findByRole("region", { name: "Avisos" });
    expect(screen.queryByRole("region", { name: "Administração" })).toBeNull();
    expect(calls.some((c) => c.key.includes("/api/admin"))).toBe(false);
  });

  it("passou do limite de mensagens: mostra o aviso do servidor e mantém o texto para tentar de novo", async () => {
    stubApi(
      rotas(false, {
        "POST /api/channels/3/messages": () => ({ status: 429, body: { error: "Calma! Você está enviando mensagens rápido demais. Tente de novo em 4 segundos." } }),
      }),
    );
    render(<App />);
    const caixa = (await screen.findByLabelText("Mensagem em # geral")) as HTMLInputElement;
    await userEvent.type(caixa, "oi");
    await userEvent.click(screen.getByRole("button", { name: "Enviar" }));
    expect((await screen.findByRole("alert")).textContent).toContain("rápido demais");
    expect(caixa.value).toBe("oi");
  });
});

describe("servidor flexível: categorias, canais privados, somente leitura e apelido", () => {
  const beto = { id: 2, username: "beto" };
  const servidor = {
    id: 7,
    name: "Os Parças",
    ownerId: 1,
    categories: [{ id: 50, name: "Jogos" }, { id: 51, name: "Vazia" }],
    channels: [
      { id: 3, name: "geral", type: "text", categoryId: null, readOnly: false, private: false },
      { id: 4, name: "minecraft", type: "text", categoryId: 50, readOnly: false, private: false },
      { id: 5, name: "avisos", type: "text", categoryId: null, readOnly: true, private: false },
      { id: 6, name: "diretoria", type: "text", categoryId: null, readOnly: false, private: true, roleIds: [9] },
    ],
  };
  const comoDona = (extra: Record<string, Handler> = {}) => ({
    "GET /api/auth/me": () => ({ status: 200, body: { user: ana } }),
    "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
    ...extra,
  });
  const comoMembro = (extra: Record<string, Handler> = {}) => ({
    "GET /api/auth/me": () => ({ status: 200, body: { user: beto } }),
    "GET /api/servers": () => ({ status: 200, body: { servers: [{ ...servidor, channels: servidor.channels.filter((c) => !c.private).map(({ roleIds, ...c }: any) => c) }] } }),
    ...extra,
  });
  const lista = () => within(screen.getByRole("list", { name: "Canais" }));

  it("canais aparecem agrupados por categoria, com marcas de privado e somente leitura; categoria vazia só para quem gerencia", async () => {
    stubApi(comoDona());
    render(<App />);
    await screen.findByRole("button", { name: "# geral" });
    expect(lista().getByText("Jogos")).toBeTruthy();
    expect(lista().getByText("Vazia")).toBeTruthy();
    const textos = [...document.querySelectorAll(".channels > li")].map((li) => li.textContent);
    expect(textos.findIndex((t) => t?.includes("# geral"))).toBeLessThan(textos.findIndex((t) => t?.includes("Jogos"))); // sem categoria vem primeiro
    expect(textos.findIndex((t) => t?.includes("Jogos"))).toBeLessThan(textos.findIndex((t) => t?.includes("# minecraft")));
    expect(screen.getByRole("button", { name: "# diretoria 🔒" }).title).toBe("Privado");
    expect(screen.getByRole("button", { name: "# avisos 📢" }).title).toBe("Somente leitura");
    cleanup();

    stubApi(comoMembro());
    render(<App />);
    await screen.findByRole("button", { name: "# geral" });
    expect(lista().getByText("Jogos")).toBeTruthy();
    expect(lista().queryByText("Vazia")).toBeNull();
    expect(screen.queryByRole("button", { name: /diretoria/ })).toBeNull(); // o canal privado nem aparece
    expect(screen.queryByLabelText(/Configurar canal/)).toBeNull();
  });

  it("canal somente leitura: quem não gerencia vê o aviso e nenhum campo para escrever; quem gerencia escreve", async () => {
    stubApi(comoMembro({ "GET /api/channels/5/messages": () => ({ status: 200, body: { messages: [] } }) }));
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "# avisos 📢" }));
    expect(await screen.findByRole("note")).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain("somente leitura");
    expect(screen.queryByLabelText("Mensagem em # avisos")).toBeNull();
    expect(screen.queryByRole("button", { name: "Gravar mensagem de áudio" })).toBeNull();
    cleanup();

    stubApi(comoDona());
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "# avisos 📢" }));
    expect(await screen.findByLabelText("Mensagem em # avisos")).toBeTruthy();
  });

  it("configurar um canal: salva nome, categoria, leitura e cargos que enxergam", async () => {
    const calls = stubApi(
      comoDona({
        "GET /api/servers/7/roles": () => ({
          status: 200,
          body: {
            roles: [{ id: 9, name: "Membro", permissions: [], isDefault: true, members: 3 }, { id: 10, name: "Moderador", permissions: [], isDefault: false, members: 1 }],
            permissions: [],
            me: { isOwner: true, roleId: null, permissions: [] },
          },
        }),
        "PATCH /api/servers/7/channels/4": () => ({ status: 200, body: { channel: {} } }),
      }),
    );
    render(<App />);
    await userEvent.click(await screen.findByLabelText("Configurar canal minecraft"));
    const janela = within(await screen.findByRole("dialog", { name: "Configurar canal minecraft" }));
    expect((janela.getByLabelText("Categoria") as HTMLSelectElement).value).toBe("50");
    await userEvent.clear(janela.getByLabelText("Nome do canal"));
    await userEvent.type(janela.getByLabelText("Nome do canal"), "jogos-de-mesa");
    await userEvent.selectOptions(janela.getByLabelText("Categoria"), "");
    await userEvent.click(janela.getByLabelText(/Somente leitura/));
    expect(janela.queryByText("Cargos que enxergam")).toBeNull();
    await userEvent.click(janela.getByLabelText(/Privado/));
    await userEvent.click(await janela.findByLabelText("Moderador"));
    await userEvent.click(janela.getByRole("button", { name: "Salvar" }));
    await vi.waitFor(() => expect(calls.some((c) => c.key === "PATCH /api/servers/7/channels/4")).toBe(true));
    expect(calls.find((c) => c.key === "PATCH /api/servers/7/channels/4")?.body).toEqual({
      name: "jogos-de-mesa",
      categoryId: null,
      readOnly: true,
      slowmodeSeconds: 0,
      topic: "",
      private: true,
      roleIds: [10],
    });
    await vi.waitFor(() => expect(screen.queryByRole("dialog", { name: /Configurar canal/ })).toBeNull());
  });

  it("apagar canal pede confirmação; categoria: renomear e apagar; criar categoria e criar canal dentro dela", async () => {
    const calls = stubApi(
      comoDona({
        "DELETE /api/servers/7/channels/4": () => ({ status: 204 }),
        "PATCH /api/servers/7/categories/50": () => ({ status: 200, body: { category: { id: 50, name: "Games" } } }),
        "DELETE /api/servers/7/categories/51": () => ({ status: 204 }),
        "POST /api/servers/7/categories": () => ({ status: 201, body: { category: { id: 60, name: "Novidades" } } }),
        "POST /api/servers/7/channels": () => ({ status: 201, body: { channel: { id: 70, name: "dentro", type: "text", categoryId: 50, readOnly: false, private: false } } }),
      }),
    );
    render(<App />);
    await userEvent.click(await screen.findByLabelText("Configurar canal minecraft"));
    let janela = within(await screen.findByRole("dialog", { name: "Configurar canal minecraft" }));
    await userEvent.click(janela.getByRole("button", { name: "Apagar canal" }));
    expect(calls.some((c) => c.key === "DELETE /api/servers/7/channels/4")).toBe(false);
    await userEvent.click(janela.getByRole("button", { name: "Apagar mesmo" }));
    await vi.waitFor(() => expect(calls.some((c) => c.key === "DELETE /api/servers/7/channels/4")).toBe(true));

    await userEvent.click(screen.getByLabelText("Editar categoria Jogos"));
    janela = within(await screen.findByRole("dialog", { name: "Editar categoria Jogos" }));
    await userEvent.clear(janela.getByLabelText("Nome da categoria"));
    await userEvent.type(janela.getByLabelText("Nome da categoria"), "Games");
    await userEvent.click(janela.getByRole("button", { name: "Salvar" }));
    await vi.waitFor(() => expect(calls.find((c) => c.key === "PATCH /api/servers/7/categories/50")?.body).toEqual({ name: "Games" }));

    await userEvent.click(screen.getByLabelText("Editar categoria Vazia"));
    janela = within(await screen.findByRole("dialog", { name: "Editar categoria Vazia" }));
    await userEvent.click(janela.getByRole("button", { name: "Apagar categoria" }));
    await userEvent.click(janela.getByRole("button", { name: "Apagar mesmo" }));
    await vi.waitFor(() => expect(calls.some((c) => c.key === "DELETE /api/servers/7/categories/51")).toBe(true));

    await userEvent.click(screen.getByRole("button", { name: "+ Nova categoria" }));
    await userEvent.type(screen.getByLabelText("Nome da categoria"), "Novidades");
    await userEvent.click(screen.getByRole("button", { name: "Criar categoria" }));
    await vi.waitFor(() => expect(calls.find((c) => c.key === "POST /api/servers/7/categories")?.body).toEqual({ name: "Novidades" }));

    await userEvent.click(screen.getByRole("button", { name: "+ Novo canal" }));
    await userEvent.type(screen.getByLabelText("Nome do canal"), "dentro");
    await userEvent.selectOptions(screen.getByLabelText("Categoria do canal"), "50");
    await userEvent.click(screen.getByRole("button", { name: "Criar canal" }));
    await vi.waitFor(() => expect(calls.find((c) => c.key === "POST /api/servers/7/channels")?.body).toEqual({ name: "dentro", categoryId: 50 }));
  });

  it("alguém mudou os canais (ou o meu cargo): a lista é refeita no servidor, e o canal em que eu estava some se virou privado", async () => {
    let versao = 0;
    stubApi(
      comoMembro({
        "GET /api/servers": () => ({
          status: 200,
          body: {
            servers: [
              {
                ...servidor,
                channels: versao === 0 ? [{ id: 3, name: "geral", type: "text" }] : [{ id: 3, name: "geral", type: "text" }, { id: 8, name: "novo", type: "text", categoryId: null, readOnly: false, private: false }],
              },
            ],
          },
        }),
      }),
    );
    render(<App />);
    await screen.findByRole("button", { name: "# geral" });
    expect(screen.queryByRole("button", { name: "# novo" })).toBeNull();
    versao = 1;
    act(() => FakeWebSocket.instances[0].emit({ type: "channels.changed", serverId: 7 }));
    expect(await screen.findByRole("button", { name: "# novo" })).toBeTruthy();
  });

  it("meu apelido: salvar, aparecer no lugar do nome neste servidor (membros e mensagens) e não nas conversas diretas", async () => {
    const calls = stubApi({
      "GET /api/auth/me": () => ({ status: 200, body: { user: beto } }),
      "GET /api/servers": () => ({ status: 200, body: { servers: [{ id: 7, name: "Os Parças", ownerId: 1, channels: [{ id: 3, name: "geral", type: "text" }] }] } }),
      "GET /api/servers/7/members": () => ({
        status: 200,
        body: { members: [{ id: 1, username: "ana", online: true, isOwner: true, nickname: "Chefa" }, { id: 2, username: "beto", online: true, isOwner: false }] },
      }),
      "GET /api/channels/3/messages": () => ({
        status: 200,
        body: { messages: [{ id: 1, channelId: 3, dmId: null, serverId: 7, content: "bom dia", createdAt: "2026-10-30T10:00:00Z", editedAt: null, author: { id: 1, username: "ana" } }] },
      }),
      "PUT /api/servers/7/nickname": (b) => ({ status: 200, body: { nickname: (b as { nickname: string }).nickname.trim() || null } }),
    });
    render(<App />);
    expect(await screen.findByText("bom dia")).toBeTruthy();
    expect((await within(screen.getByRole("region", { name: "Membros" })).findAllByText("Chefa")).length).toBe(1);
    expect(within(screen.getByRole("list", { name: "Mensagens" })).getByText("Chefa")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "⚙ Servidor" }));
    const painel = within(await screen.findByRole("dialog", { name: "Configurações de Os Parças" }));
    await userEvent.click(painel.getByRole("tab", { name: "Meu apelido" }));
    await userEvent.type(painel.getByLabelText("Apelido neste servidor"), "Betão");
    await userEvent.click(painel.getByRole("button", { name: "Salvar apelido" }));
    expect(await painel.findByText("Apelido salvo.")).toBeTruthy();
    expect(calls.find((c) => c.key === "PUT /api/servers/7/nickname")?.body).toEqual({ nickname: "Betão" });
    await userEvent.click(painel.getByRole("button", { name: "Fechar" }));
    expect(within(screen.getByRole("region", { name: "Membros" })).getByText("Betão")).toBeTruthy();

    // outra pessoa troca o apelido: chega ao vivo
    act(() => FakeWebSocket.instances[0].emit({ type: "member.updated", serverId: 7, userId: 1, nickname: "Patroa" }));
    expect(await within(screen.getByRole("list", { name: "Mensagens" })).findByText("Patroa")).toBeTruthy();
    act(() => FakeWebSocket.instances[0].emit({ type: "member.updated", serverId: 7, userId: 1, nickname: null }));
    expect(await within(screen.getByRole("list", { name: "Mensagens" })).findByText("ana")).toBeTruthy();
  });
});

describe("moderar apelido de outros (cliente)", () => {
  it("o dono muda o apelido de um membro pela aba Membros; vê o apelido atual ao lado do nome", async () => {
    const calls = stubApi({
      "GET /api/auth/me": () => ({ status: 200, body: { user: ana } }),
      "GET /api/servers": () => ({ status: 200, body: { servers: [{ id: 7, name: "Os Parças", ownerId: 1, channels: [{ id: 3, name: "geral", type: "text" }] }] } }),
      "GET /api/servers/7/members": () => ({
        status: 200,
        body: { members: [{ id: 1, username: "ana", online: true, isOwner: true }, { id: 2, username: "beto", online: true, isOwner: false, roleId: 1, roleName: "Membro", nickname: "Betinho" }] },
      }),
      "PUT /api/servers/7/members/2/nickname": () => ({ status: 200, body: { nickname: "Beto Sério" } }),
    });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "⚙ Servidor" }));
    const painel = within(await screen.findByRole("dialog", { name: "Configurações de Os Parças" }));
    await userEvent.click(painel.getByRole("tab", { name: "Membros" }));
    expect(await painel.findByText("(apelido: Betinho)")).toBeTruthy();
    expect(painel.queryByRole("button", { name: "Mudar o apelido de ana" })).toBeNull(); // o dono não

    await userEvent.click(painel.getByRole("button", { name: "Mudar o apelido de beto" }));
    const campo = painel.getByLabelText("Apelido de beto") as HTMLInputElement;
    expect(campo.value).toBe("Betinho");
    await userEvent.clear(campo);
    await userEvent.type(campo, "Beto Sério");
    await userEvent.click(painel.getByRole("button", { name: "Salvar" }));
    await vi.waitFor(() => expect(calls.find((c) => c.key === "PUT /api/servers/7/members/2/nickname")?.body).toEqual({ nickname: "Beto Sério" }));
    expect(painel.queryByLabelText("Apelido de beto")).toBeNull();
  });
});

describe("reordenar canais e categorias (cliente)", () => {
  const servidor = {
    id: 7,
    name: "Os Parças",
    ownerId: 1,
    categories: [{ id: 50, name: "Jogos" }, { id: 51, name: "Música" }],
    channels: [
      { id: 3, name: "geral", type: "text", categoryId: null },
      { id: 4, name: "minecraft", type: "text", categoryId: 50 },
      { id: 5, name: "xadrez", type: "text", categoryId: 50 },
      { id: 6, name: "playlist", type: "text", categoryId: 51 },
    ],
  };
  const dona = (extra: Record<string, Handler> = {}) => ({
    "GET /api/auth/me": () => ({ status: 200, body: { user: ana } }),
    "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
    "PUT /api/servers/7/order": () => ({ status: 200, body: { server: servidor } }),
    ...extra,
  });
  const linha = (nome: RegExp) => screen.getByRole("button", { name: nome }).closest("li") as HTMLElement;
  const arrastar = (de: HTMLElement, para: HTMLElement) => {
    const dataTransfer = { setData() {}, getData: () => "", types: [] as string[] };
    fireEvent.dragStart(de, { dataTransfer });
    fireEvent.dragOver(para, { dataTransfer });
    fireEvent.drop(para, { dataTransfer });
  };

  it("arrastar um canal para cima de outro põe ele antes, na categoria do destino", async () => {
    const calls = stubApi(dona());
    render(<App />);
    await screen.findByRole("button", { name: "# minecraft" });
    arrastar(linha(/# playlist/), linha(/# xadrez/));
    await vi.waitFor(() => expect(calls.some((c) => c.key === "PUT /api/servers/7/order")).toBe(true));
    expect(calls.find((c) => c.key === "PUT /api/servers/7/order")?.body).toEqual({
      categories: [50, 51],
      channels: [
        { id: 3, categoryId: null },
        { id: 4, categoryId: 50 },
        { id: 6, categoryId: 50 },
        { id: 5, categoryId: 50 },
      ],
    });
  });

  it("soltar um canal no título de uma categoria põe no fim dela; arrastar uma categoria sobre outra a coloca antes", async () => {
    const calls = stubApi(dona());
    render(<App />);
    await screen.findByRole("button", { name: "# minecraft" });
    arrastar(linha(/# geral/), screen.getByText("Música").closest("li") as HTMLElement);
    await vi.waitFor(() => expect(calls.filter((c) => c.key === "PUT /api/servers/7/order").length).toBe(1));
    expect((calls[calls.length - 1].body as any).channels.at(-1)).toEqual({ id: 3, categoryId: 51 });

    arrastar(screen.getByText("Música").closest("li") as HTMLElement, screen.getByText("Jogos").closest("li") as HTMLElement);
    await vi.waitFor(() => expect(calls.filter((c) => c.key === "PUT /api/servers/7/order").length).toBe(2));
    expect((calls[calls.length - 1].body as any).categories).toEqual([51, 50]);
  });

  it("quem não gerencia não consegue arrastar; soltar em si mesmo não faz nada", async () => {
    const calls = stubApi(dona({ "GET /api/auth/me": () => ({ status: 200, body: { user: { id: 2, username: "beto" } } }) }));
    render(<App />);
    await screen.findByRole("button", { name: "# minecraft" });
    expect(linha(/# xadrez/).getAttribute("draggable")).toBeNull();
    arrastar(linha(/# playlist/), linha(/# xadrez/));
    expect(calls.some((c) => c.key.includes("/order"))).toBe(false);
  });

  it("botões Subir e Descer na janela do canal e da categoria (para o celular), desligados nas pontas", async () => {
    const calls = stubApi(dona());
    render(<App />);
    await userEvent.click(await screen.findByLabelText("Configurar canal xadrez"));
    let janela = within(await screen.findByRole("dialog", { name: "Configurar canal xadrez" }));
    expect((janela.getByRole("button", { name: "Descer" }) as HTMLButtonElement).disabled).toBe(true); // último da categoria
    await userEvent.click(janela.getByRole("button", { name: "Subir" }));
    await vi.waitFor(() => expect(calls.find((c) => c.key === "PUT /api/servers/7/order")).toBeTruthy());
    expect((calls.find((c) => c.key === "PUT /api/servers/7/order")!.body as any).channels.map((c: any) => c.id)).toEqual([3, 5, 4, 6]);
    await userEvent.click(janela.getByRole("button", { name: "Fechar" }));

    await userEvent.click(screen.getByLabelText("Editar categoria Jogos"));
    janela = within(await screen.findByRole("dialog", { name: "Editar categoria Jogos" }));
    expect((janela.getByRole("button", { name: "Subir" }) as HTMLButtonElement).disabled).toBe(true); // primeira
    await userEvent.click(janela.getByRole("button", { name: "Descer" }));
    await vi.waitFor(() => expect(calls.filter((c) => c.key === "PUT /api/servers/7/order").length).toBe(2));
    expect((calls[calls.length - 1].body as any).categories).toEqual([51, 50]);
  });
});

describe("notificações com o app fechado (cliente)", () => {
  const servidor = { id: 7, name: "Os Parças", ownerId: 1, channels: [{ id: 3, name: "geral" }] };
  const rotas = (extra: Record<string, Handler> = {}) => ({
    "GET /api/auth/me": () => ({ status: 200, body: { user: ana } }),
    "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
    ...extra,
  });
  const assinatura = (endpoint = "https://push.exemplo.com/abc") => ({
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: "p".repeat(20), auth: "a".repeat(20) } }),
    unsubscribe: vi.fn(async () => true),
  });
  /** Simula um navegador com service worker e push (jsdom não tem). */
  function navegadorComPush(existente: ReturnType<typeof assinatura> | null, permissao = "granted") {
    const registro = {
      pushManager: {
        getSubscription: vi.fn(async () => existente),
        subscribe: vi.fn(async () => assinatura()),
      },
    };
    vi.stubGlobal("navigator", { ...navigator, serviceWorker: { ready: Promise.resolve(registro) } });
    vi.stubGlobal("PushManager", class {});
    vi.stubGlobal("Notification", { permission: permissao, requestPermission: vi.fn(async () => permissao) });
    return registro;
  }
  const abrirAvisos = async () => {
    await userEvent.click(await screen.findByRole("button", { name: "Minha conta" }));
    return within(await screen.findByRole("region", { name: "Avisos" }));
  };

  it("ligar: pede permissão, assina com a chave do servidor e registra o aparelho", async () => {
    const registro = navegadorComPush(null);
    const calls = stubApi(rotas({ "GET /api/push/key": () => ({ status: 200, body: { publicKey: "BPublicaDeTeste_" } }), "POST /api/push/subscribe": () => ({ status: 204 }) }));
    render(<App />);
    const avisos = await abrirAvisos();
    const caixa = (await avisos.findByLabelText(/Notificações com o app fechado/)) as HTMLInputElement;
    expect(caixa.checked).toBe(false);
    await userEvent.click(caixa);
    await vi.waitFor(() => expect(caixa.checked).toBe(true));
    expect(registro.pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true, applicationServerKey: expect.any(Uint8Array) }));
    expect(calls.find((c) => c.key === "POST /api/push/subscribe")?.body).toMatchObject({ endpoint: "https://push.exemplo.com/abc", keys: { p256dh: expect.any(String), auth: expect.any(String) } });
  });

  it("já ligado aparece marcado; desligar cancela no servidor e no navegador", async () => {
    const existente = assinatura();
    navegadorComPush(existente);
    const calls = stubApi(rotas({ "GET /api/push/key": () => ({ status: 200, body: { publicKey: "BPublicaDeTeste_" } }), "DELETE /api/push/subscribe": () => ({ status: 204 }) }));
    render(<App />);
    const avisos = await abrirAvisos();
    const caixa = (await avisos.findByLabelText(/Notificações com o app fechado/)) as HTMLInputElement;
    await vi.waitFor(() => expect(caixa.checked).toBe(true));
    await userEvent.click(caixa);
    await vi.waitFor(() => expect(caixa.checked).toBe(false));
    expect(calls.find((c) => c.key === "DELETE /api/push/subscribe")?.body).toEqual({ endpoint: existente.endpoint });
    expect(existente.unsubscribe).toHaveBeenCalled();
  });

  it("permissão negada no navegador: explica e continua desligado", async () => {
    navegadorComPush(null, "denied");
    stubApi(rotas({ "GET /api/push/key": () => ({ status: 200, body: { publicKey: "BPublicaDeTeste_" } }) }));
    render(<App />);
    const avisos = await abrirAvisos();
    const caixa = (await avisos.findByLabelText(/Notificações com o app fechado/)) as HTMLInputElement;
    await userEvent.click(caixa);
    expect((await avisos.findByRole("alert")).textContent).toContain("bloqueou");
    expect(caixa.checked).toBe(false);
  });

  it("servidor sem as chaves ou navegador sem suporte: some o interruptor e explica", async () => {
    navegadorComPush(null);
    stubApi(rotas({ "GET /api/push/key": () => ({ status: 200, body: { publicKey: null } }) }));
    render(<App />);
    const avisos = await abrirAvisos();
    expect(await avisos.findByText(/não estão disponíveis aqui/)).toBeTruthy();
    expect(avisos.queryByLabelText(/Notificações com o app fechado/)).toBeNull();
  });
});

describe("avisos de limite para a administradora (cliente)", () => {
  const servidor = { id: 7, name: "Os Parças", ownerId: 1, channels: [{ id: 3, name: "geral" }] };
  const aviso = (id: number, titulo: string, nivel: "aviso" | "critico" = "aviso", acked = false) => ({
    id,
    level: nivel,
    title: titulo,
    message: `Detalhe de ${titulo}`,
    createdAt: "2026-11-10T12:00:00.000Z",
    acked,
  });
  const uso = (alerts: unknown[]) => ({
    status: 200,
    body: {
      month: "2026-11",
      voice: { minutes: 3600, minutesLimit: 5000, gb: 12.3, gbLimit: 50 },
      vm: { memAvailableMb: 330, memTotalMb: 954, swapUsedMb: 600, swapTotalMb: 4096, diskUsedPct: 18, containerMemMb: 53, containerLimitMb: 200 },
      alerts,
    },
  });
  const rotas = (admin: boolean, extra: Record<string, Handler> = {}) => ({
    "GET /api/auth/me": () => ({ status: 200, body: { user: { ...ana, isAdmin: admin } } }),
    "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
    ...extra,
  });

  it("ao abrir o app mostra os avisos ainda não lidos; marcar como lido some e avisa o servidor", async () => {
    const calls = stubApi(rotas(true, { "GET /api/admin/usage": () => uso([aviso(2, "Voz: 70% do limite gratuito"), aviso(1, "Disco da VM enchendo", "aviso", true)]), "POST /api/admin/alerts/ack": () => ({ status: 204 }) }));
    render(<App />);
    const faixa = within(await screen.findByRole("alert"));
    expect(faixa.getByText(/^⚠ Voz: 70% do limite gratuito/)).toBeTruthy();
    expect(faixa.queryAllByText(/Disco da VM enchendo/)).toHaveLength(0); // esse já estava lido
    await userEvent.click(faixa.getByRole("button", { name: "Marcar como lido" }));
    await vi.waitFor(() => expect(screen.queryAllByText(/Voz: 70% do limite gratuito/)).toHaveLength(0));
    expect(calls.some((c) => c.key === "POST /api/admin/alerts/ack")).toBe(true);
  });

  it("um aviso novo chega em tempo real, com som, e fica no topo até ser lido; quem não é administradora não vê nada", async () => {
    stubApi(rotas(true, { "GET /api/admin/usage": () => uso([]) }));
    render(<App />);
    await screen.findByRole("button", { name: "# geral" });
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => FakeWebSocket.instances[0].emit({ type: "admin.alert", alert: aviso(5, "Limite de voz atingido", "critico") }));
    expect((await screen.findByRole("alert")).textContent).toContain("Limite de voz atingido");
    expect(playSoundMock).toHaveBeenCalledWith("mention", 60);
    cleanup();

    const calls = stubApi(rotas(false));
    render(<App />);
    await screen.findByRole("button", { name: "# geral" });
    expect(calls.some((c) => c.key.includes("/api/admin"))).toBe(false);
  });

  it("Minha conta → Administração mostra o uso do mês e os avisos", async () => {
    stubApi(
      rotas(true, {
        "GET /api/admin/usage": () => uso([aviso(2, "Voz: 70% do limite gratuito")]),
        "GET /api/admin/backups": () => ({ status: 200, body: { backups: [] } }),
        "POST /api/admin/alerts/ack": () => ({ status: 204 }),
      }),
    );
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Minha conta" }));
    const painel = within(await screen.findByLabelText("Uso e limites"));
    expect(painel.getByText(/3\.600 de 5\.000 \(72%\)/)).toBeTruthy();
    expect(painel.getByText(/12,3 de 50 GB|12.3 de 50 GB/)).toBeTruthy();
    expect(painel.getByText(/330 MB livres/)).toBeTruthy();
    expect(painel.getByText(/53 de 200 MB/)).toBeTruthy();
    expect(painel.getByText("Voz: 70% do limite gratuito")).toBeTruthy();
    await userEvent.click(painel.getByRole("button", { name: "Marcar avisos como lidos" }));
    await vi.waitFor(() => expect(painel.queryByRole("button", { name: "Marcar avisos como lidos" })).toBeNull());
  });
});

describe("sair sozinho da sala de voz parada (na tela)", () => {
  const servidor = { id: 7, name: "Os Parças", ownerId: 1, channels: [{ id: 3, name: "geral", type: "text" }, { id: 4, name: "sala-1", type: "voice" }] };
  const rotas = {
    "GET /api/auth/me": () => ({ status: 200, body: { user: ana } }),
    "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
  };

  it("sozinha na sala: aparece o aviso com contagem, 'continuar' adia, e aos 10 minutos sai com uma mensagem", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      stubApi(rotas);
      render(<App />);
      await screen.findByRole("button", { name: "🔊 sala-1" });
      fireEvent.click(screen.getByRole("button", { name: "🔊 sala-1" }));
      fireEvent.click(screen.getByRole("button", { name: "Entrar na sala" }));
      act(() => FakeWebSocket.instances[0].emit({ type: "voice.joined", serverId: 7, channelId: 4, user: { id: 1, username: "ana" } }));
      const barra = await screen.findByRole("group", { name: "Chamada de voz" });
      await vi.waitFor(() => expect(within(barra).getByText("Voz conectada")).toBeTruthy());

      act(() => void vi.advanceTimersByTime(9 * 60 * 1000 + 5000));
      const aviso = within(barra).getByText(/Sala parada: você sai em \d+s/);
      expect(aviso).toBeTruthy();
      await userEvent.click(within(barra).getByRole("button", { name: "Continuar na sala" }));
      expect(within(barra).queryByText(/Sala parada/)).toBeNull();

      act(() => void vi.advanceTimersByTime(9 * 60 * 1000 + 5000)); // de novo perto dos 10 minutos
      expect(within(barra).getByText(/Sala parada/)).toBeTruthy();
      expect(FakeWebSocket.instances[0].sent.filter((m) => (m as { type: string }).type === "voice.leave")).toHaveLength(0);
      act(() => void vi.advanceTimersByTime(60 * 1000));
      expect(FakeWebSocket.instances[0].sent.filter((m) => (m as { type: string }).type === "voice.leave")).toHaveLength(1);
      expect((await screen.findByRole("status")).textContent).toContain("saiu da sala de voz por inatividade");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("entrar com Google ou GitHub (cliente)", () => {
  const ambos = { "GET /api/auth/oauth/providers": () => ({ status: 200, body: { google: true, github: true } }) };
  const semConta = { "GET /api/auth/me": () => naoLogado };
  const irPara = (url: string) => window.history.pushState({}, "", url);
  afterEach(() => irPara("/"));

  it("mostra os botões só dos provedores ligados; sem nenhum, a tela fica como sempre", async () => {
    stubApi({ ...semConta, ...ambos });
    render(<App />);
    expect(((await screen.findByRole("link", { name: "Entrar com Google" })) as HTMLAnchorElement).getAttribute("href")).toBe("/api/auth/oauth/google/start");
    expect((screen.getByRole("link", { name: "Entrar com GitHub" }) as HTMLAnchorElement).getAttribute("href")).toBe("/api/auth/oauth/github/start");
    cleanup();

    stubApi({ ...semConta, "GET /api/auth/oauth/providers": () => ({ status: 200, body: { google: true, github: false } }) });
    render(<App />);
    await screen.findByRole("link", { name: "Entrar com Google" });
    expect(screen.queryByRole("link", { name: "Entrar com GitHub" })).toBeNull();
    cleanup();

    stubApi(semConta);
    render(<App />);
    await screen.findByRole("button", { name: "Entrar" });
    expect(screen.queryByRole("link", { name: /Entrar com/ })).toBeNull();
  });

  it("pelo link de convite, o convite vai junto no botão", async () => {
    irPara("/convite/aBc-123_x");
    stubApi({ ...semConta, ...ambos });
    render(<App />);
    expect(((await screen.findByRole("link", { name: "Entrar com Google" })) as HTMLAnchorElement).getAttribute("href")).toBe("/api/auth/oauth/google/start?invite=aBc-123_x");
    expect((screen.getByRole("link", { name: "Entrar com GitHub" }) as HTMLAnchorElement).getAttribute("href")).toBe("/api/auth/oauth/github/start?invite=aBc-123_x");
  });

  it("o motivo de uma recusa aparece na tela de entrada e some da barra de endereço", async () => {
    irPara("/?oauth_erro=sem-convite");
    stubApi({ ...semConta, ...ambos });
    render(<App />);
    expect((await screen.findByRole("alert")).textContent).toContain("ainda não tem convite");
    expect(window.location.search).toBe("");
  });

  it("pessoa nova: escolhe o apelido sugerido ou outro, entra e vê o Concord; erros do servidor aparecem", async () => {
    irPara("/?oauth=apelido");
    let entrou = false;
    const calls = stubApi({
      "GET /api/auth/me": () => (entrou ? { status: 200, body: { user: { id: 9, username: "Maria_S" } } } : naoLogado),
      "GET /api/auth/oauth/pending": () => ({ status: 200, body: { provider: "google", suggestedNick: "Maria" } }),
      "GET /api/servers": () => ({ status: 200, body: { servers: [{ id: 7, name: "Os Parças", ownerId: 1, channels: [{ id: 3, name: "geral" }] }] } }),
      "POST /api/auth/oauth/complete": (b) => {
        if ((b as { username: string }).username === "ana") return { status: 409, body: { error: "Esse apelido já existe. Escolha outro." } };
        entrou = true;
        return { status: 201, body: { user: { id: 9, username: "Maria_S" } } };
      },
    });
    render(<App />);
    const campo = (await screen.findByLabelText("Apelido")) as HTMLInputElement;
    await vi.waitFor(() => expect(campo.value).toBe("Maria"));
    expect(screen.getByText(/Conta do Google confirmada/)).toBeTruthy();

    await userEvent.clear(campo);
    await userEvent.type(campo, "ana");
    await userEvent.click(screen.getByRole("button", { name: "Entrar no Concord" }));
    expect((await screen.findByRole("alert")).textContent).toContain("já existe");

    await userEvent.clear(campo);
    await userEvent.type(campo, "Maria_S");
    await userEvent.click(screen.getByRole("button", { name: "Entrar no Concord" }));
    // conta nova (também pelo Google/GitHub): antes do app, a pergunta das notificações
    await userEvent.click(await screen.findByRole("button", { name: "Agora não" }));
    expect(await screen.findByRole("button", { name: "# geral" })).toBeTruthy();
    expect(calls.find((c) => c.key === "POST /api/auth/oauth/complete" && (c.body as { username: string }).username === "Maria_S")).toBeTruthy();
  });

  it("cadastro expirado: explica e oferece voltar ao início", async () => {
    irPara("/?oauth=apelido");
    stubApi({ ...semConta, "GET /api/auth/oauth/pending": () => ({ status: 404, body: { error: "O cadastro expirou." } }) });
    render(<App />);
    expect((await screen.findByRole("alert")).textContent).toContain("expirou");
    expect((screen.getByRole("link", { name: "Voltar ao início" }) as HTMLAnchorElement).getAttribute("href")).toBe("/");
  });

  it("já logada: vincular termina com um aviso de sucesso", async () => {
    irPara("/?oauth_ok=vinculado");
    stubApi({ "GET /api/auth/me": () => ({ status: 200, body: { user: ana } }), "GET /api/servers": () => ({ status: 200, body: { servers: [{ id: 7, name: "Os Parças", ownerId: 1, channels: [{ id: 3, name: "geral" }] }] } }) });
    render(<App />);
    expect((await screen.findByRole("status")).textContent).toContain("Conta vinculada");
  });

  it("o aviso de sucesso some sozinho depois de alguns segundos", async () => {
    const original = window.setTimeout;
    const agendados: Array<() => void> = [];
    const spy = vi.spyOn(window, "setTimeout").mockImplementation(((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
      if (ms === 6000) {
        agendados.push(fn as () => void);
        return 0 as unknown as number;
      }
      return original(fn, ms, ...args);
    }) as typeof window.setTimeout);
    try {
      irPara("/?oauth_ok=vinculado");
      stubApi({ "GET /api/auth/me": () => ({ status: 200, body: { user: ana } }), "GET /api/servers": () => ({ status: 200, body: { servers: [{ id: 7, name: "Os Parças", ownerId: 1, channels: [{ id: 3, name: "geral" }] }] } }) });
      render(<App />);
      await screen.findByRole("status");
      expect(agendados.length).toBe(1);
      act(() => agendados[0]());
      expect(screen.queryByText(/Conta vinculada/)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("Minha conta → Contas vinculadas: vincular, ver o que já está ligado e desvincular", async () => {
    let google = true;
    const calls = stubApi({
      "GET /api/auth/me": () => ({ status: 200, body: { user: ana } }),
      "GET /api/servers": () => ({ status: 200, body: { servers: [{ id: 7, name: "Os Parças", ownerId: 1, channels: [{ id: 3, name: "geral" }] }] } }),
      ...ambos,
      "GET /api/auth/oauth/identities": () => ({ status: 200, body: { identities: google ? [{ provider: "google" }] : [], hasPassword: true } }),
      "POST /api/auth/oauth/unlink": () => {
        google = false;
        return { status: 204 };
      },
    });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Minha conta" }));
    const secao = within(await screen.findByRole("region", { name: "Contas vinculadas" }));
    expect(await secao.findByText("Google: vinculado ✓")).toBeTruthy();
    expect((secao.getByRole("link", { name: "Vincular GitHub" }) as HTMLAnchorElement).getAttribute("href")).toBe("/api/auth/oauth/github/start?mode=link");

    await userEvent.click(secao.getByRole("button", { name: "Desvincular Google" }));
    expect(await secao.findByRole("link", { name: "Vincular Google" })).toBeTruthy();
    expect(calls.find((c) => c.key === "POST /api/auth/oauth/unlink")?.body).toEqual({ provider: "google" });
  });

  it("sem provedores ligados a seção nem aparece em Minha conta", async () => {
    stubApi({ "GET /api/auth/me": () => ({ status: 200, body: { user: ana } }), "GET /api/servers": () => ({ status: 200, body: { servers: [{ id: 7, name: "Os Parças", ownerId: 1, channels: [{ id: 3, name: "geral" }] }] } }) });
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Minha conta" }));
    await screen.findByRole("region", { name: "Aparência" });
    expect(screen.queryByRole("region", { name: "Contas vinculadas" })).toBeNull();
  });
});

describe("mencionar com @ (cliente)", () => {
  const servidor = { id: 7, name: "Os Parças", ownerId: 1, channels: [{ id: 3, name: "geral" }] };
  const membros = [
    { id: 1, username: "ana", online: true, isOwner: true },
    { id: 2, username: "beto", online: true, isOwner: false, nickname: "Betão" },
    { id: 3, username: "bianca", online: false, isOwner: false, displayName: "Bia" },
  ];
  const rotas = (extra: Record<string, Handler> = {}) => ({
    "GET /api/auth/me": () => ({ status: 200, body: { user: ana } }),
    "GET /api/servers": () => ({ status: 200, body: { servers: [servidor] } }),
    "GET /api/servers/7/members": () => ({ status: 200, body: { members: membros } }),
    ...extra,
  });

  it("digitar @ abre a lista de membros; setas e Enter escolhem; Esc fecha; o resto da frase continua", async () => {
    const calls = stubApi(rotas({ "POST /api/channels/3/messages": () => ({ status: 201, body: { message: { id: 9, channelId: 3, dmId: null, serverId: 7, content: "x", author: { id: 1, username: "ana" }, createdAt: "2026-01-01T00:00:00Z" } } }) }));
    render(<App />);
    const campo = (await screen.findByLabelText("Mensagem em # geral")) as HTMLInputElement;

    await userEvent.type(campo, "oi @b");
    const lista = await screen.findByRole("listbox", { name: "Mencionar alguém" });
    expect(within(lista).getAllByRole("option").map((o) => o.textContent)).toEqual([expect.stringContaining("Betão"), expect.stringContaining("Bia")]);
    expect(within(lista).getAllByRole("option")[0].getAttribute("aria-selected")).toBe("true");

    await userEvent.keyboard("{ArrowDown}{Enter}"); // desce para a Bia e escolhe
    expect(campo.value).toBe("oi @bianca ");
    expect(screen.queryByRole("listbox", { name: "Mencionar alguém" })).toBeNull();

    await userEvent.type(campo, "tudo bem? @be");
    expect(await screen.findByRole("listbox", { name: "Mencionar alguém" })).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox", { name: "Mencionar alguém" })).toBeNull();
    expect(campo.value).toBe("oi @bianca tudo bem? @be"); // Esc não apaga nada

    await userEvent.clear(campo);
    await userEvent.type(campo, "@");
    await userEvent.click(within(await screen.findByRole("listbox", { name: "Mencionar alguém" })).getByRole("button", { name: /Betão/ }));
    expect(campo.value).toBe("@beto ");
    await userEvent.type(campo, "vem{Enter}");
    await vi.waitFor(() => expect(calls.find((c) => c.key === "POST /api/channels/3/messages")?.body).toEqual({ content: "@beto vem" }));
  });

  it("e-mail e @ de quem não existe não abrem a lista", async () => {
    stubApi(rotas());
    render(<App />);
    const campo = await screen.findByLabelText("Mensagem em # geral");
    await userEvent.type(campo, "me escreve em ana@exemplo.com");
    expect(screen.queryByRole("listbox", { name: "Mencionar alguém" })).toBeNull();
    await userEvent.clear(campo);
    await userEvent.type(campo, "oi @zzz");
    expect(screen.queryByRole("listbox", { name: "Mencionar alguém" })).toBeNull();
  });
});
