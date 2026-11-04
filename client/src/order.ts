import type { Channel, ServerInfo } from "./Workspace";

/** O que o servidor recebe para reordenar: categorias em ordem e canais em ordem (cada um com a sua categoria). */
export interface OrderPayload {
  categories: number[];
  channels: { id: number; categoryId: number | null }[];
}

type Group = { categoryId: number | null; channels: Channel[] };

/** Os canais como aparecem na lista: primeiro os sem categoria, depois cada categoria na ordem dela. */
function groupsOf(server: Pick<ServerInfo, "channels" | "categories">): Group[] {
  const cats = server.categories ?? [];
  const known = (id: number | null | undefined) => id != null && cats.some((k) => k.id === id);
  return [
    { categoryId: null, channels: server.channels.filter((c) => !known(c.categoryId)) },
    ...cats.map((k) => ({ categoryId: k.id as number | null, channels: server.channels.filter((c) => c.categoryId === k.id) })),
  ];
}

const toPayload = (server: Pick<ServerInfo, "categories">, groups: Group[]): OrderPayload => ({
  categories: (server.categories ?? []).map((k) => k.id),
  channels: groups.flatMap((g) => g.channels.map((c) => ({ id: c.id, categoryId: g.categoryId }))),
});

/** Tira o canal de onde está e põe antes de `beforeId` (ou no fim) da categoria de destino. */
export function moveChannel(server: Pick<ServerInfo, "channels" | "categories">, channelId: number, toCategory: number | null, beforeId: number | null): OrderPayload {
  const moving = server.channels.find((c) => c.id === channelId);
  const groups = groupsOf(server).map((g) => ({ ...g, channels: g.channels.filter((c) => c.id !== channelId) }));
  const target = groups.find((g) => g.categoryId === toCategory) ?? groups[0];
  if (moving) {
    const at = beforeId === null ? -1 : target.channels.findIndex((c) => c.id === beforeId);
    if (at < 0) target.channels.push(moving);
    else target.channels.splice(at, 0, moving);
  }
  return toPayload(server, groups);
}

/** Põe a categoria antes de `beforeId` (ou no fim). */
export function moveCategory(server: Pick<ServerInfo, "channels" | "categories">, categoryId: number, beforeId: number | null): OrderPayload {
  const cats = [...(server.categories ?? [])];
  const from = cats.findIndex((k) => k.id === categoryId);
  if (from < 0) return toPayload(server, groupsOf(server));
  const [moving] = cats.splice(from, 1);
  const at = beforeId === null ? -1 : cats.findIndex((k) => k.id === beforeId);
  if (at < 0) cats.push(moving);
  else cats.splice(at, 0, moving);
  const base = { channels: server.channels, categories: cats };
  return toPayload(base, groupsOf(base));
}

/** Sobe (-1) ou desce (+1) um canal dentro da sua categoria; null se já está na ponta. */
export function shiftChannel(server: Pick<ServerInfo, "channels" | "categories">, channelId: number, dir: -1 | 1): OrderPayload | null {
  const group = groupsOf(server).find((g) => g.channels.some((c) => c.id === channelId));
  if (!group) return null;
  const i = group.channels.findIndex((c) => c.id === channelId);
  const j = i + dir;
  if (j < 0 || j >= group.channels.length) return null;
  const neighbour = group.channels[j];
  return dir === -1 ? moveChannel(server, channelId, group.categoryId, neighbour.id) : moveChannel(server, channelId, group.categoryId, group.channels[j + 1]?.id ?? null);
}

/** Sobe (-1) ou desce (+1) uma categoria; null se já está na ponta. */
export function shiftCategory(server: Pick<ServerInfo, "channels" | "categories">, categoryId: number, dir: -1 | 1): OrderPayload | null {
  const cats = server.categories ?? [];
  const i = cats.findIndex((k) => k.id === categoryId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= cats.length) return null;
  return dir === -1 ? moveCategory(server, categoryId, cats[j].id) : moveCategory(server, categoryId, cats[j + 1]?.id ?? null);
}
