import { describe, expect, it } from "vitest";
import { applyMention, filterMembers, mentionQuery } from "./mentions";
import type { Member } from "./socket";

const m = (id: number, username: string, extra: Partial<Member> = {}): Member => ({ id, username, online: true, isOwner: false, ...extra });
const gente = [m(1, "ana"), m(2, "beto", { nickname: "Betão" }), m(3, "bianca", { displayName: "Bia" }), m(4, "joao", { displayName: "João Pedro" })];

describe("mentionQuery", () => {
  it("acha o @ logo antes do cursor, no começo ou depois de espaço", () => {
    expect(mentionQuery("@be", 3)).toEqual({ start: 0, query: "be" });
    expect(mentionQuery("oi @be", 6)).toEqual({ start: 3, query: "be" });
    expect(mentionQuery("oi @", 4)).toEqual({ start: 3, query: "" });
    expect(mentionQuery("oi @beto e @an", 14)).toEqual({ start: 11, query: "an" });
  });
  it("não é menção: e-mail, @ no meio da palavra, cursor depois de um espaço ou antes do @", () => {
    expect(mentionQuery("ana@exemplo.com", 15)).toBeNull();
    expect(mentionQuery("oi @beto ", 9)).toBeNull();
    expect(mentionQuery("oi @be", 2)).toBeNull();
    expect(mentionQuery("sem arroba", 10)).toBeNull();
  });
});

describe("filterMembers", () => {
  it("acha por usuário, apelido ou nome de exibição, sem acento nem maiúscula; quem começa com o texto vem antes", () => {
    expect(filterMembers(gente, "b").map((x) => x.username)).toEqual(["beto", "bianca"]);
    expect(filterMembers(gente, "BETAO").map((x) => x.username)).toEqual(["beto"]); // apelido sem acento
    expect(filterMembers(gente, "bia").map((x) => x.username)).toEqual(["bianca"]); // nome de exibição
    expect(filterMembers(gente, "pedro").map((x) => x.username)).toEqual(["joao"]); // contém
    expect(filterMembers(gente, "zzz")).toEqual([]);
  });
  it("sem texto lista todo mundo (respeita o limite)", () => {
    expect(filterMembers(gente, "")).toHaveLength(4);
    expect(filterMembers(gente, "", 2)).toHaveLength(2);
  });
});

describe("applyMention", () => {
  it("troca o pedaço digitado pelo usuário e deixa o cursor depois do espaço", () => {
    expect(applyMention("oi @be e mais", 3, 6, "beto")).toEqual({ text: "oi @beto  e mais", caret: 9 });
    expect(applyMention("@", 0, 1, "ana")).toEqual({ text: "@ana ", caret: 5 });
  });
});
