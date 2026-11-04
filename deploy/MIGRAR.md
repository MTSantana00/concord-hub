# Concord Hub: instalação provisória e como migrar

**Situação (2026-10-30, fases 1 e 2 no ar: cargos e convites, perfil e visual; banco na versão 6):** o Concord roda **provisoriamente** na VM atual (Oracle, micro de 1 GB, IP `IP_DA_VM`), ao lado do outro app, porque a Oracle devolveu "Out of capacity" para a VM ARM e para uma segunda micro. Voz, câmera e tela usam o **LiveKit Cloud (plano gratuito)** em vez de um servidor próprio.

## Endereços e contas
- App: **https://concord-hub.duckdns.org** (DuckDNS, apontando para IP_DA_VM; certificado Let's Encrypt pelo Caddy do outro app).
- LiveKit Cloud: projeto `concord` (`p_6sf1lutlymx`), endereço `wss://concord-zi2roy1j.livekit.cloud`, chave `concord-vm`. As chaves ficam só em `~/concord/concord.env` na VM.

## Como está montado na VM
- `~/concord/docker-compose.yml` e `~/concord/concord.env` (segredos, permissão 600). Container `concord` com **teto de 200 MB de memória** e meia CPU: se estourar, reinicia só o Concord.
- Mesma rede Docker do Caddy do outro app (`deploy_default`). O Caddy do outro app tem um bloco a mais para o domínio do Concord (`reverse_proxy concord:3001`).
- Dados em um volume Docker `concord-data` (`concord.db` e as pastas `audio/` e `images/`, esta com fotos de perfil e ícones de servidor).
- Swap extra de 2 GB (`/swapfile2`, também no `/etc/fstab`).
- Backups dos arquivos do outro app que foram editados: `~/backups-concord/<data>/`.

## Cuidado ao atualizar o outro app
O `deploy/Caddyfile` da VM tem um bloco do Concord. Se o outro app for atualizado extraindo o pacote por cima de `~/outro-app` (como no `ORACLE.md` dele), o `Caddyfile` volta ao original e **o site do Concord para de abrir**. Mantenha o mesmo bloco no `Caddyfile` do repositório do outro app ou recoloque-o depois de atualizar.

## Atualizar o Concord
No PC, na pasta `discord-amigos`:
```bash
docker build -t concord:latest .
docker save concord:latest | gzip -1 | ssh -i ~/.ssh/chave_oracle ubuntu@IP_DA_VM 'gunzip | sudo docker load'
ssh -i ~/.ssh/chave_oracle ubuntu@IP_DA_VM 'cd ~/concord && sudo docker compose up -d'
```

## Voltar atrás se uma atualização der problema
A cada atualização o Concord guarda a imagem anterior como `concord:previous` e faz um backup do banco em `~/concord/backups/`. Para voltar:
```bash
ssh -i ~/.ssh/chave_oracle ubuntu@IP_DA_VM "cd ~/concord && sudo docker tag concord:previous concord:latest && sudo docker compose up -d --force-recreate"
```
Se o banco já migrou para uma versão nova, a imagem antiga não o entende: restaure também o backup (`sudo docker cp ~/concord/backups/<arquivo>.db concord:/data/concord.db`, com o container parado).

## Limites do plano gratuito do LiveKit Cloud
5.000 minutos de participante e 50 GB de saída de dados por mês. Voz gasta pouco. Tela em 1080p/120 gasta muito (da ordem de 11 GB por hora por espectador). Não confirmei o que acontece ao passar dos limites.

## Migrar para uma VM própria (quando a Oracle liberar a ARM)
1. Criar a VM `VM.Standard.A1.Flex` Ubuntu 24.04 (Always Free) e seguir o `README.md` (Caddy, LiveKit, serviços systemd).
2. Levar os dados: na VM atual, `sudo docker run --rm -v concord_concord-data:/data -v $PWD:/out alpine tar czf /out/concord-dados.tgz -C /data .` e extrair em `/var/lib/concord/` na nova (banco `concord.db` e pasta `audio/`).
3. Apontar o nome do DuckDNS para o IP novo, trocar `LIVEKIT_URL` e as chaves para o LiveKit próprio e subir.
4. Remover o container `concord` e o bloco do `Caddyfile` do outro app na VM antiga, e o `/swapfile2` se não precisar mais.

## Voz própria na A1 com reserva automática (fase 15)
O Concord já sabe usar dois servidores de mídia: o **principal** (LiveKit próprio) e a **reserva** (LiveKit Cloud, as `LIVEKIT_*` de hoje). Sem `MEDIA_PRIMARY_*` nada muda. Para criar e configurar a máquina, veja `deploy/a1/LEIAME.md`; `deploy/a1/tentar-a1.sh` tenta criar a A1 sozinho enquanto a Oracle estiver sem capacidade. **Volta atrás:** apague `MEDIA_PRIMARY_URL/KEY/SECRET` de `~/concord/concord.env` e rode `sudo docker compose up -d` em `~/concord`.
