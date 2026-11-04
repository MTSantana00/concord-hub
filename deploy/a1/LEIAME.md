# Voz própria na máquina A1 da Oracle (grátis)

O Concord usa este servidor como **principal**. Se ele cair, as salas novas nascem no LiveKit Cloud (reserva) sozinhas. Nada aqui custa dinheiro.

## Regras da Oracle que importam
- A máquina é `VM.Standard.A1.Flex` com **no máximo 2 OCPU, 12 GB e 50 GB de disco** (limite do plano grátis). Os scripts recusam passar disso.
- **Máquina parada à toa pode ser recolhida (risco real).** A Oracle pode recolher uma A1 ociosa (a regra publicada fala em ~7 dias com CPU, rede e memória baixas, em torno de 20%; confira no console, a regra muda). Um LiveKit com poucos amigos fica abaixo disso quase sempre, então **não conte com o uso normal para evitar**. Hoje a mitigação é só o aviso "Servidor de voz próprio fora do ar" e a reserva (LiveKit Cloud) assumindo. Qualquer solução paga precisa do seu "sim".
- **O limite vale para a CONTA toda:** 4 OCPU e 24 GB de A1 no total e 200 GB de disco somando todos os volumes. Some o disco da VM atual (`a-vm-atual`) + 50 GB e confira que fica abaixo de 200 GB. O `tentar-a1.sh` só confere a máquina nova.
- **"Principal saudável" só prova que HTTPS/sinalização respondem.** Se o UDP 7882/3478 estiver fechado na lista de segurança, o áudio não passa mesmo com a principal "saudável": por isso o teste com celular em dados móveis (T10) é obrigatório.
- **Cron das tentativas:** `*/10 * * * * bash $HOME/a1/tentar-a1.sh >> $HOME/a1/tentar-a1.log 2>&1` (o script já cuida do PATH e de não rodar duas vezes ao mesmo tempo).
- **Duas portas de proteção:** o firewall do Ubuntu (o `instalar.sh` cuida) **e** a lista de segurança da sub-rede no console da Oracle (você cuida, abaixo). As duas precisam liberar as mesmas portas.

## Portas
| Porta | Para quê | Onde abrir |
|---|---|---|
| TCP 80 e 443 | HTTPS (Caddy, certificado grátis) | Ubuntu **e** console |
| TCP 7881 | áudio/vídeo quando o UDP é bloqueado | Ubuntu **e** console |
| UDP 7882 | áudio/vídeo (a principal) | Ubuntu **e** console |
| UDP 3478 | TURN (rede de celular e redes difíceis) | Ubuntu **e** console |
| TCP 7880 | sinalização interna | **não abrir** (só o Caddy fala com ela) |

**No console da Oracle:** Rede → Redes virtuais de nuvem → sua VCN → sub-rede → Lista de segurança → *Adicionar regras de entrada*, origem `0.0.0.0/0`, uma regra para cada linha da tabela acima (exceto a 7880).

## Passo a passo
1. **Criar a máquina** (se ainda não existe): veja `tentar-a1.sh` (tenta sozinho) ou crie à mão no console escolhendo o formato `VM.Standard.A1.Flex`, Ubuntu 24.04, 2 OCPU, 12 GB, disco 50 GB.
2. **Nome no DuckDNS:** em <https://www.duckdns.org> crie um nome novo (ex.: `concord-voz`) apontando para o **IP público da A1**. Não reaproveite o nome do Concord.
3. **Copiar e rodar na A1:**
   ```bash
   scp -i ~/.ssh/chave_oracle -r deploy/a1 ubuntu@IP_DA_A1:~/a1
   ssh -i ~/.ssh/chave_oracle ubuntu@IP_DA_A1 "bash ~/a1/instalar.sh concord-voz.duckdns.org IP_DA_A1"
   ```
   O script mostra **uma vez** a chave e o segredo novos. Anote os três valores `MEDIA_PRIMARY_*` na hora (num gerenciador de senhas, não no chat nem no repositório).
4. **Testar isolado, antes de ligar no Concord:** `curl -s https://concord-voz.duckdns.org/` deve responder `OK`.
5. **Ligar no Concord** (na VM atual): ponha as três `MEDIA_PRIMARY_*` em `~/concord/concord.env` (permissão 600) e rode `cd ~/concord && sudo docker compose up -d`.

## Como testar a voz de verdade
Duas abas do navegador e **um celular em rede de dados móveis** (não no mesmo Wi-Fi), todos na mesma sala: fale, ligue a câmera, compartilhe a tela em 1080p. Se o celular não ouvir ou não conectar, o problema quase sempre é uma porta (UDP 7882 ou 3478) liberada só no Ubuntu e não na lista de segurança do console.

## Como saber se a Oracle recuperou (ou recolheu) a máquina
- Quando a principal para de responder, a administradora recebe o aviso **"Servidor de voz próprio fora do ar"** (no app e por notificação) e a voz segue na reserva.
- Quando volta, vem **"Servidor de voz próprio voltou"**.
- Para ver por dentro: `sudo systemctl status livekit` e `sudo journalctl -u livekit -n 50`.

## Voltar atrás
Apague as três `MEDIA_PRIMARY_*` de `~/concord/concord.env` e reinicie o Concord. A voz volta a ser só pelo LiveKit Cloud, como antes.
