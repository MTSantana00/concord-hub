import { describe, expect, it } from "vitest";
import { connectSources, loadMediaConfig } from "./mediaConfig.js";

const livekit = { LIVEKIT_URL: "wss://a.livekit.cloud", LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: "s" };

describe("loadMediaConfig", () => {
  it("só LIVEKIT_*: vira a reserva e não há principal", () => {
    expect(loadMediaConfig(livekit, true)).toEqual({ primary: null, fallback: { url: "wss://a.livekit.cloud", apiKey: "k", apiSecret: "s" } });
  });

  it("MEDIA_FALLBACK_* ganha de LIVEKIT_*", () => {
    const cfg = loadMediaConfig({ ...livekit, MEDIA_FALLBACK_URL: "wss://b.livekit.cloud", MEDIA_FALLBACK_KEY: "k2", MEDIA_FALLBACK_SECRET: "s2" }, true);
    expect(cfg.fallback).toEqual({ url: "wss://b.livekit.cloud", apiKey: "k2", apiSecret: "s2" });
  });

  it("MEDIA_PRIMARY_* completo vira a principal", () => {
    const cfg = loadMediaConfig({ ...livekit, MEDIA_PRIMARY_URL: "wss://voz.duckdns.org", MEDIA_PRIMARY_KEY: "kp", MEDIA_PRIMARY_SECRET: "sp" }, true);
    expect(cfg.primary).toEqual({ url: "wss://voz.duckdns.org", apiKey: "kp", apiSecret: "sp" });
    expect(cfg.fallback.url).toBe("wss://a.livekit.cloud");
  });

  it("MEDIA_PRIMARY_* incompleto lança erro", () => {
    for (const falta of ["MEDIA_PRIMARY_URL", "MEDIA_PRIMARY_KEY", "MEDIA_PRIMARY_SECRET"]) {
      const env: Record<string, string> = { ...livekit, MEDIA_PRIMARY_URL: "wss://v", MEDIA_PRIMARY_KEY: "k", MEDIA_PRIMARY_SECRET: "s" };
      delete env[falta];
      expect(() => loadMediaConfig(env, true)).toThrow("MEDIA_PRIMARY_* precisa de URL, KEY e SECRET");
    }
  });

  it("variáveis vazias contam como ausentes", () => {
    const cfg = loadMediaConfig({ ...livekit, MEDIA_PRIMARY_URL: "", MEDIA_PRIMARY_KEY: "", MEDIA_PRIMARY_SECRET: "" }, true);
    expect(cfg.primary).toBeNull();
  });

  it("produção sem nenhuma reserva lança erro", () => {
    expect(() => loadMediaConfig({}, true)).toThrow("LIVEKIT_API_KEY, LIVEKIT_API_SECRET e LIVEKIT_URL são obrigatórios em produção.");
  });

  it("desenvolvimento usa devkey/secret/ws://localhost:7880", () => {
    expect(loadMediaConfig({}, false)).toEqual({ primary: null, fallback: { url: "ws://localhost:7880", apiKey: "devkey", apiSecret: "secret" } });
  });
});

describe("connectSources", () => {
  it("wss devolve wss e https, sem repetir", () => {
    expect(connectSources(["wss://a.livekit.cloud", "wss://voz.duckdns.org", "wss://a.livekit.cloud"])).toEqual([
      "wss://a.livekit.cloud",
      "https://a.livekit.cloud",
      "wss://voz.duckdns.org",
      "https://voz.duckdns.org",
    ]);
  });

  it("ws também devolve o próprio ws", () => {
    expect(connectSources(["ws://localhost:7880"])).toEqual(["wss://localhost:7880", "https://localhost:7880", "ws://localhost:7880"]);
  });

  it("endereço inválido é ignorado", () => {
    expect(connectSources(["isso não é url"])).toEqual([]);
  });
});
