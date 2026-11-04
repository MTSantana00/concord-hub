import { describe, expect, it } from "vitest";
import { moveCategory, moveChannel, shiftCategory, shiftChannel } from "./order";

const server = {
  categories: [{ id: 10, name: "A" }, { id: 11, name: "B" }],
  channels: [
    { id: 1, name: "geral", categoryId: null },
    { id: 2, name: "x", categoryId: 10 },
    { id: 3, name: "y", categoryId: 10 },
    { id: 4, name: "z", categoryId: 11 },
    { id: 5, name: "sem-categoria-2", categoryId: 999 }, // categoria que não existe mais: cai em "sem categoria"
  ],
};
const ids = (o: { channels: { id: number }[] }) => o.channels.map((c) => c.id);

describe("ordem dos canais", () => {
  it("a ordem de partida é a da tela: sem categoria primeiro, depois cada categoria", () => {
    const o = moveChannel(server, 1, null, 5); // pôr antes de quem já vem depois: não muda nada
    expect(o.channels).toEqual([
      { id: 1, categoryId: null },
      { id: 5, categoryId: null },
      { id: 2, categoryId: 10 },
      { id: 3, categoryId: 10 },
      { id: 4, categoryId: 11 },
    ]);
    expect(o.categories).toEqual([10, 11]);
  });

  it("mover antes de outro canal da mesma categoria", () => {
    expect(ids(moveChannel(server, 3, 10, 2))).toEqual([1, 5, 3, 2, 4]);
  });

  it("mover para outra categoria: antes de um canal dela, ou no fim quando não há referência", () => {
    expect(moveChannel(server, 2, 11, 4).channels).toContainEqual({ id: 2, categoryId: 11 });
    expect(ids(moveChannel(server, 2, 11, 4))).toEqual([1, 5, 3, 2, 4]);
    expect(ids(moveChannel(server, 2, 11, null))).toEqual([1, 5, 3, 4, 2]);
  });

  it("tirar da categoria: vai para o grupo sem categoria", () => {
    const o = moveChannel(server, 4, null, null);
    expect(o.channels[2]).toEqual({ id: 4, categoryId: null });
    expect(o.channels.at(-1)).toEqual({ id: 3, categoryId: 10 });
  });

  it("categoria vazia aceita um canal; referência desconhecida vai para o fim do grupo", () => {
    const vazia = { ...server, categories: [...server.categories, { id: 12, name: "vazia" }] };
    expect(moveChannel(vazia, 1, 12, null).channels.at(-1)).toEqual({ id: 1, categoryId: 12 });
    expect(ids(moveChannel(server, 1, 10, 12345))).toEqual([5, 2, 3, 1, 4]);
  });

  it("subir e descer dentro da categoria; nas pontas não há o que fazer", () => {
    expect(ids(shiftChannel(server, 3, -1)!)).toEqual([1, 5, 3, 2, 4]);
    expect(ids(shiftChannel(server, 2, 1)!)).toEqual([1, 5, 3, 2, 4]);
    expect(shiftChannel(server, 2, -1)).toBeNull();
    expect(shiftChannel(server, 3, 1)).toBeNull();
    expect(shiftChannel(server, 4, 1)).toBeNull();
    expect(shiftChannel(server, 99, 1)).toBeNull();
  });

  it("categorias: mover antes de outra, descer, subir e pontas", () => {
    expect(moveCategory(server, 11, 10).categories).toEqual([11, 10]);
    expect(ids(moveCategory(server, 11, 10))).toEqual([1, 5, 4, 2, 3]); // os canais seguem a categoria
    expect(moveCategory(server, 10, null).categories).toEqual([11, 10]);
    expect(shiftCategory(server, 10, 1)!.categories).toEqual([11, 10]);
    expect(shiftCategory(server, 11, -1)!.categories).toEqual([11, 10]);
    expect(shiftCategory(server, 10, -1)).toBeNull();
    expect(shiftCategory(server, 11, 1)).toBeNull();
    expect(moveCategory(server, 999, null).categories).toEqual([10, 11]);
  });
});
