import { useState, type FormEvent } from "react";
import { api } from "./api";
import type { Role } from "./access";
import type { Channel, ServerInfo } from "./Workspace";
import { shiftCategory, shiftChannel, type OrderPayload } from "./order";
import { useDialog } from "./useDialog";

/** Opções do modo lento: segundos e o rótulo mostrado. */
const SLOWMODE_OPTIONS: [number, string][] = [
  [0, "Desligado"],
  [5, "5 segundos"],
  [10, "10 segundos"],
  [30, "30 segundos"],
  [60, "1 minuto"],
  [300, "5 minutos"],
  [900, "15 minutos"],
  [3600, "1 hora"],
  [21600, "6 horas"],
];

const errorText = (err: unknown) => (err instanceof Error ? err.message : "Algo deu errado");

/** Janela de um canal: nome, categoria, somente leitura, privado (e quais cargos enxergam) e apagar. */
export function ChannelSettings({
  server,
  channel,
  roles,
  onOrder,
  onClose,
}: {
  server: ServerInfo;
  channel: Channel;
  roles: Role[];
  /** Manda a nova ordem ao servidor (a lista é atualizada por quem chama). */
  onOrder: (order: OrderPayload) => void;
  onClose: () => void;
}) {
  const dialog = useDialog(onClose);
  const [name, setName] = useState(channel.name);
  const [categoryId, setCategoryId] = useState<number | null>(channel.categoryId ?? null);
  const [readOnly, setReadOnly] = useState(!!channel.readOnly);
  const [slowmode, setSlowmode] = useState(channel.slowmodeSeconds ?? 0);
  const [topic, setTopic] = useState(channel.topic ?? "");
  const [isPrivate, setIsPrivate] = useState(!!channel.private);
  const [roleIds, setRoleIds] = useState<number[]>(channel.roleIds ?? []);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const base = `/api/servers/${server.id}/channels/${channel.id}`;
  const voice = channel.type === "voice";
  const up = shiftChannel(server, channel.id, -1);
  const down = shiftChannel(server, channel.id, 1);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(base, "PATCH", { name, categoryId, readOnly: voice ? false : readOnly, slowmodeSeconds: voice ? 0 : slowmode, topic: voice ? "" : topic, private: isPrivate, roleIds: isPrivate ? roleIds : [] });
      onClose();
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function remove() {
    setError(null);
    try {
      await api<void>(base, "DELETE");
      onClose();
    } catch (err) {
      setError(errorText(err));
    }
  }

  const toggleRole = (id: number) => setRoleIds((prev) => (prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id]));

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal" role="dialog" aria-modal="true" aria-label={`Configurar canal ${channel.name}`} onSubmit={save} {...dialog}>
        <header className="modal-head">
          <h2>{voice ? "🔊" : "#"} {channel.name}</h2>
          <button type="button" className="small secondary" onClick={onClose} aria-label="Fechar">Fechar</button>
        </header>
        <div className="row" role="group" aria-label="Posição na lista">
          <span className="muted">Posição na lista:</span>
          <button type="button" className="small secondary" disabled={!up} onClick={() => up && onOrder(up)}>Subir</button>
          <button type="button" className="small secondary" disabled={!down} onClick={() => down && onOrder(down)}>Descer</button>
        </div>
        <label>
          Nome do canal
          <input value={name} maxLength={30} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          Categoria
          <select value={categoryId ?? ""} onChange={(e) => setCategoryId(e.target.value === "" ? null : Number(e.target.value))}>
            <option value="">Sem categoria</option>
            {(server.categories ?? []).map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        {!voice && (
          <label className="check">
            <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
            Somente leitura (só o dono e quem gerencia canais escrevem)
          </label>
        )}
        {!voice && (
          <label>
            Tópico (descrição do canal, até 200 caracteres)
            <input value={topic} maxLength={200} placeholder="Sobre o que é este canal?" onChange={(e) => setTopic(e.target.value)} />
          </label>
        )}
        {!voice && (
          <label>
            Modo lento (tempo entre mensagens de cada pessoa)
            <select value={slowmode} onChange={(e) => setSlowmode(Number(e.target.value))}>
              {SLOWMODE_OPTIONS.map(([seconds, label]) => (
                <option key={seconds} value={seconds}>{label}</option>
              ))}
              {!SLOWMODE_OPTIONS.some(([seconds]) => seconds === slowmode) && <option value={slowmode}>{slowmode} s</option>}
            </select>
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
          Privado (só alguns cargos enxergam este canal)
        </label>
        {isPrivate && (
          <fieldset className="role-picker">
            <legend>Cargos que enxergam</legend>
            {roles.map((r) => (
              <label key={r.id} className="check">
                <input type="checkbox" checked={roleIds.includes(r.id)} onChange={() => toggleRole(r.id)} />
                {r.name}
              </label>
            ))}
            <p className="muted">O dono e quem gerencia canais sempre enxergam.</p>
          </fieldset>
        )}
        {error && <p role="alert" className="error">{error}</p>}
        <div className="row">
          <button type="submit">Salvar</button>
          {!confirming ? (
            <button type="button" className="danger" onClick={() => setConfirming(true)}>Apagar canal</button>
          ) : (
            <span className="row" role="group" aria-label="Confirmar apagar canal">
              <span className="muted">Apaga também as mensagens.</span>
              <button type="button" className="danger" onClick={() => void remove()}>Apagar mesmo</button>
              <button type="button" className="secondary" onClick={() => setConfirming(false)}>Cancelar</button>
            </span>
          )}
        </div>
      </form>
    </div>
  );
}

/** Renomear ou apagar uma categoria (os canais dela ficam sem categoria). */
export function CategoryEditor({
  server,
  category,
  onOrder,
  onClose,
}: {
  server: ServerInfo;
  category: { id: number; name: string };
  onOrder: (order: OrderPayload) => void;
  onClose: () => void;
}) {
  const dialog = useDialog(onClose);
  const serverId = server.id;
  const up = shiftCategory(server, category.id, -1);
  const down = shiftCategory(server, category.id, 1);
  const [name, setName] = useState(category.name);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const base = `/api/servers/${serverId}/categories/${category.id}`;

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(base, "PATCH", { name });
      onClose();
    } catch (err) {
      setError(errorText(err));
    }
  }
  async function remove() {
    try {
      await api<void>(base, "DELETE");
      onClose();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal" role="dialog" aria-modal="true" aria-label={`Editar categoria ${category.name}`} onSubmit={save} {...dialog}>
        <header className="modal-head">
          <h2>Categoria</h2>
          <button type="button" className="small secondary" onClick={onClose} aria-label="Fechar">Fechar</button>
        </header>
        <div className="row" role="group" aria-label="Posição na lista">
          <span className="muted">Posição na lista:</span>
          <button type="button" className="small secondary" disabled={!up} onClick={() => up && onOrder(up)}>Subir</button>
          <button type="button" className="small secondary" disabled={!down} onClick={() => down && onOrder(down)}>Descer</button>
        </div>
        <label>
          Nome da categoria
          <input value={name} maxLength={30} onChange={(e) => setName(e.target.value)} required />
        </label>
        {error && <p role="alert" className="error">{error}</p>}
        <div className="row">
          <button type="submit">Salvar</button>
          {!confirming ? (
            <button type="button" className="danger" onClick={() => setConfirming(true)}>Apagar categoria</button>
          ) : (
            <span className="row" role="group" aria-label="Confirmar apagar categoria">
              <span className="muted">Os canais dela não são apagados.</span>
              <button type="button" className="danger" onClick={() => void remove()}>Apagar mesmo</button>
              <button type="button" className="secondary" onClick={() => setConfirming(false)}>Cancelar</button>
            </span>
          )}
        </div>
      </form>
    </div>
  );
}

/** Botão "+ Nova categoria" com o campo de nome. */
export function NewCategoryForm({ serverId }: { serverId: number }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(`/api/servers/${serverId}/categories`, "POST", { name });
      setName("");
      setOpen(false);
    } catch (err) {
      setError(errorText(err));
    }
  }

  if (!open) {
    return (
      <button type="button" className="small add-channel" onClick={() => setOpen(true)}>
        + Nova categoria
      </button>
    );
  }
  return (
    <form className="new-channel" onSubmit={submit}>
      <input aria-label="Nome da categoria" value={name} onChange={(e) => setName(e.target.value)} maxLength={30} required autoFocus />
      {error && <p role="alert" className="error">{error}</p>}
      <div className="row">
        <button type="submit" className="small">Criar categoria</button>
        <button type="button" className="small secondary" onClick={() => { setOpen(false); setError(null); }}>Cancelar</button>
      </div>
    </form>
  );
}
