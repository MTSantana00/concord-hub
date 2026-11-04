import { describe, expect, it } from "vitest";
import { assess, describeMeasure, fpsBetween, screenCaptureOptions, screenPublishOptions, TARGET } from "./qualityMeter";

describe("o que pedimos ao navegador", () => {
  it("captura 1920×1080 a 120 fps, marcada como movimento e sem áudio do sistema", () => {
    expect(screenCaptureOptions.resolution).toEqual({ width: 1920, height: 1080, frameRate: 120 });
    expect(screenCaptureOptions.contentHint).toBe("motion");
    expect(TARGET).toEqual({ width: 1920, height: 1080, fps: 120 });
  });

  it("envia uma camada só, com teto alto de taxa de bits e prioridade para a resolução", () => {
    expect(screenPublishOptions.simulcast).toBe(false);
    expect(screenPublishOptions.screenShareEncoding).toEqual({ maxBitrate: 25_000_000, maxFramerate: 120 });
    expect(screenPublishOptions.degradationPreference).toBe("maintain-resolution");
  });
});

describe("medidor de qualidade", () => {
  it("meta cumprida: 1080p com 100 fps ou mais, sem aviso", () => {
    expect(assess({ width: 1920, height: 1080, fps: 120 })).toEqual({ ok: true, note: "" });
    expect(assess({ width: 2560, height: 1440, fps: 100 }).ok).toBe(true);
  });

  it("monitor de 60 Hz: 1080p mas só 60 fps avisa dos fps e cita o monitor", () => {
    const a = assess({ width: 1920, height: 1080, fps: 60 });
    expect(a.ok).toBe(false);
    expect(a.note).toContain("60 fps (meta 120)");
    expect(a.note).toContain("monitor de 60 Hz");
    expect(a.note).not.toContain("resolução");
  });

  it("resolução baixa avisa da resolução; limite de CPU e de internet entram como causa", () => {
    const a = assess({ width: 1280, height: 720, fps: 120, limit: "bandwidth" });
    expect(a.ok).toBe(false);
    expect(a.note).toContain("resolução 1280×720 (meta 1920×1080)");
    expect(a.note).toContain("a internet não aguenta mais");
    expect(assess({ width: 1280, height: 720, fps: 30, limit: "cpu" }).note).toContain("processador");
  });

  it("abaixo da meta sem causa conhecida ainda explica", () => {
    expect(assess({ width: 1920, height: 1080, fps: 99 }).note).toMatch(/Abaixo da meta: 99 fps/);
  });

  it("calcula fps pelo contador de quadros", () => {
    expect(fpsBetween({ frames: 100, at: 1000 }, { frames: 220, at: 2000 })).toBe(120);
    expect(fpsBetween({ frames: 0, at: 0 }, { frames: 45, at: 1500 })).toBe(30);
    expect(fpsBetween(undefined, { frames: 10, at: 1000 })).toBe(0);
    expect(fpsBetween({ frames: 50, at: 1000 }, { frames: 40, at: 2000 })).toBe(0);
    expect(fpsBetween({ frames: 5, at: 1000 }, { frames: 9, at: 1000 })).toBe(0);
  });

  it("descreve a medida em texto", () => {
    expect(describeMeasure({ width: 1920, height: 1080, fps: 118 })).toBe("1920×1080 · 118 fps");
  });
});
