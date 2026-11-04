<p align="center"><img src="client/public/logo-completa.svg" alt="Concord Hub" width="260"></p>

# Concord Hub

Chat para você e seus amigos: servidores, canais de texto, mensagens diretas, mensagens de áudio, canais de voz, câmera, compartilhamento de tela (meta 1080p a 120 fps) e chamadas na DM.

**O acesso é só por convite.** Em produção ninguém cria conta sem um link de convite de um servidor existente; quem nunca recebeu convite não consegue nem entrar.

**Cargos e convites.** Cada servidor tem cargos com permissões (criar convites, ver e revogar convites de todos, apagar mensagens de outros, expulsar e banir, criar canais, ver o log). O dono cria os cargos e escolhe o de cada membro. Cada pessoa pode ter no máximo **10 convites** (pendentes mais usados; revogar um que ninguém usou devolve a vaga) e **cada link vale uma única vez**. **Perfil e visual:** foto, nome de exibição, "sobre mim" e status; tema claro, escuro ou automático, cor de destaque e tamanho da letra (por aparelho); nome e ícone do servidor; app instalável no celular e no computador. Há painel de convites, expulsar, banir e desbanir, log de ações, trocar a senha, sair de todos os aparelhos e, para a administradora (a primeira conta), redefinir a senha de um amigo com uma senha temporária.

**Mensagens ricas.** Enviar imagem, GIF ou arquivo de até 8 MB (pelo 📎, colando ou arrastando; programas, scripts e páginas são recusados e só imagens aparecem na conversa, o resto baixa), responder a uma mensagem, reagir com emojis, texto com **negrito**, *itálico*, ~~riscado~~, `código` e links, aviso de "fulano está digitando", busca no canal ou na conversa, fixar mensagens (quem tem permissão no canal; os dois nas conversas diretas) e cartão de pré-visualização do primeiro link. A pré-visualização é buscada pelo servidor, que só acessa endereços públicos (nada de rede interna), e fica guardada por 24 h. Os arquivos usam a mesma pasta dos áudios (`AUDIO_DIR`), então o backup já os cobre.

**Enquetes, modo lento e formatação extra.** O 📊 do compositor cria uma enquete no canal (pergunta, 2 a 10 opções, escolha única ou várias; clicar na opção vota e clicar de novo tira o voto; todos veem as barras na hora). Em Configurar canal há o **modo lento**: de 5 s a 6 h entre mensagens de cada pessoa (texto, enquete, anexo e áudio); o dono e quem gerencia canais ou modera mensagens não são limitados. No texto: `||spoiler||` (borrado até clicar), `__sublinhado__` e citação com `> ` no começo da linha.

**Timeout e comandos de barra.** Quem pode expulsar/banir também deixa alguém em **timeout** (Configurações do servidor → Membros → "Timeout…": 1 min a 1 semana; a API aceita até 28 dias): a pessoa continua no servidor e lê tudo, mas não envia texto, enquete, anexo nem áudio nos canais até acabar; some do bloqueio ao tirar o timeout. Fica no log do servidor. Comandos de barra (digite `/` para ver a lista): `/dado 2d6`, `/moeda`, `/sortear a, b, c` (sorteio feito no servidor, ninguém forja o resultado), `/enquete Pergunta | opção 1 | opção 2`, `/spoiler`, `/me`, `/shrug`, `/tableflip`, `/unflip` e `/ajuda`. Texto que não é um comando conhecido (como `/home/pasta`) vai como mensagem normal. No celular, servidores, canais e conversa ficam lado a lado.

**Tópico do canal e Ctrl+K.** Em Configurar canal há o **tópico** (até 200 caracteres), mostrado acima das mensagens para todos. **Ctrl+K** (ou ⌘K) abre o seletor rápido: digite parte do nome (sem precisar de acento) e pule para qualquer canal de texto de qualquer servidor, com setas e Enter.

**Avisos.** Marcadores de não lidas em cada canal, servidor e conversa (até "99+"), menções `@usuario` em vermelho e com destaque na mensagem, silenciar canal, servidor ou conversa, título da aba com o total, sons de mensagem e de menção gerados no navegador (liga/desliga e volume em Minha conta → Avisos) e notificações do navegador com a janela em segundo plano. O status "Não perturbe" cala sons e notificações. Notificação com o app totalmente fechado (push) ainda não existe.

**Voz melhor.** Em "Ajustes de voz" (na barra de voz) dá para escolher microfone, câmera e caixa de som (a caixa só em Chrome/Edge), mudar o volume de cada pessoa, ensurdecer e falar só segurando uma tecla. Quem tem "expulsar e banir" pode tirar alguém da sala de voz (não é banimento e fica no log). Tudo isso é guardado por aparelho.

**Operação.** O app cria sozinho um backup do banco por dia (guarda os 14 mais recentes, em `BACKUP_DIR`) e confere que a cópia abre. A administradora vê o último backup e baixa um novo em Minha conta → Administração (guarde de vez em quando no seu computador: é a cópia que sobrevive se a VM se perder). Os arquivos anexados não entram no banco: `deploy/backup-arquivos.sh` os compacta toda semana na VM. Limites anti-spam por pessoa (12 mensagens a cada 10 s, 10 anexos ou áudios por minuto, 30 reações a cada 10 s) e por endereço (20 tentativas de entrar a cada 15 min, 10 contas por hora, 30 usos de convite por hora); passando, o servidor pede para esperar uns segundos.

**Servidor flexível.** Categorias para agrupar canais, canais privados (só os cargos escolhidos, o dono e quem gerencia canais enxergam), canais somente leitura (todos leem e reagem, só quem gerencia escreve), editar e apagar canais e apelido por servidor (Configurações do servidor → Meu apelido).

**Avisos de limite.** A administradora recebe uma notificação (push, mesmo com o app fechado, e aviso na tela) quando o uso do plano gratuito de voz passa de 70%, 90% e 100% (minutos de participante e tráfego estimado) e quando a VM fica com pouca memória, o disco enche, a troca (swap) quase acaba, o Concord chega perto do teto de memória ou o backup atrasa. O painel "Uso e limites" fica em Minha conta → Administração. Os limites vêm de `LIVEKIT_MINUTES_LIMIT` (padrão 5000) e `LIVEKIT_GB_LIMIT` (padrão 50); use 0 para desligar se hospedar o LiveKit você mesmo. Ative o interruptor de notificações com o app fechado na conta da administradora para receber os avisos fora do app.

**Economia de voz e memória.** Quem fica 10 minutos parado numa sala de voz (sozinho, com o microfone desligado sem nenhuma tela ou câmera para assistir, ou com a sala toda em silêncio) sai sozinho, com um aviso e o botão "Continuar na sala" um minuto antes: cada minuto conectado gasta o plano gratuito de voz. O servidor recebe no máximo 4 envios de arquivo ao mesmo tempo (os outros recebem "tente de novo em instantes"), para o teto de memória do container não estourar.

**E-mail, confirmação e "esqueci a senha".** Com o envio de e-mail ligado (`SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, opcional `MAIL_FROM`; o Gmail grátis com "senha de app" serve, veja `.env.example`), o cadastro pede um e-mail e manda um código de 6 dígitos (vale 15 minutos, 5 tentativas, 1 envio por minuto e no máximo 5 por hora). A conta nova só abre o app depois de confirmar; contas antigas não são obrigadas, mas podem adicionar o e-mail em Minha conta. O e-mail só passa a valer na conta depois de confirmado, e é único por conta. Na tela de entrada, "Esqueci a senha" manda um código ao e-mail confirmado (a resposta é igual exista a conta ou não), a pessoa escolhe a senha nova, entra já logada e os outros aparelhos caem. Saem ainda um e-mail de boas-vindas (na primeira confirmação) e um aviso de "senha alterada". Os códigos ficam no banco só como hash (HMAC com o `JWT_SECRET`). Sem as variáveis de SMTP nada disso aparece e o app funciona como antes.

**Termos, privacidade e exclusão da conta.** Login e cadastro linkam `/termos.html` e `/privacidade.html` (o cadastro avisa que criar a conta é aceitar). A política traz base legal por dado, os prestadores que recebem dados (Gmail para os e-mails, Google/GitHub no login, LiveKit, Oracle Cloud, DuckDNS), o contato do responsável e o prazo de 15 dias para pedidos da LGPD. Em Minha conta → Excluir minha conta (`POST /api/auth/delete-account`), a pessoa confirma com o usuário e a senha e a conta some: mensagens, conversas diretas, membros, convites, logins externos, notificações, foto e arquivos em disco. Dono de servidor e a administradora da plataforma não excluem por aí (apague o servidor antes). As cópias de segurança antigas somem em até 14 dias. Para trocar o contato da política, edite o e-mail em `client/public/privacidade.html`.

**Licenças de terceiros.** `client/public/licencas.html` lista as 123 bibliotecas que vão para produção (cliente e servidor, sem as de desenvolvimento), com a licença e o texto de cada uma; é linkada do cadastro, de Minha conta e das páginas de termos e privacidade. Ela é gerada por `npm run licencas` (script `scripts/gerar-licencas.mjs`): refaça sempre que mudar uma dependência. Logo, ícones do app e ícones de voz são criação do autor; os sons são gerados por código; o site não carrega fontes de terceiros.

**Testar como iPhone no Windows.** O Simulador iOS só existe no macOS. No Windows, o mais próximo é o WebKit (o motor do Safari) com o perfil de iPhone do Playwright, já instalado (`playwright-cli install-browser webkit`). Com o servidor de desenvolvimento no ar (`npm run dev`, porta 5173): `playwright-cli open http://localhost:5173 --browser=webkit --device="iPhone 15"`, depois `playwright-cli screenshot --filename=tela.png`, `click`, `fill`, `console` e `close`. Não substitui um teste no iPhone de verdade (barra do Safari, teclado e zoom), mas pega as diferenças de renderização do Safari.

**Notificações logo ao criar a conta.** Depois de criar a conta (e de confirmar o e-mail, quando pede), o app mostra uma tela cheia perguntando se pode mandar avisos de mensagens privadas, menções e ligações, mesmo com o app fechado. "Permitir" pede a permissão do navegador e assina o aparelho no push; "Agora não" segue sem nada. A permissão é por aparelho: ao entrar em outro (PC ou celular) aparece um aviso no alto da tela com "Ativar avisos", uma vez por aparelho e por conta. No iPhone só funciona com o app instalado na tela de início (o próprio aviso explica o passo a passo). Ligação recebida com o app fechado: o servidor manda uma notificação ("📞 fulano está ligando", vale 30 s, vibra e fica na tela); ao tocar nela o app abre e, se a chamada ainda toca, ela aparece para atender. Quem está em "Não perturbe" não recebe esse aviso.

**Mencionar alguém com @.** No campo de mensagem de um canal, digitar `@` abre a lista de membros do servidor (busca por usuário, apelido ou nome de exibição, sem acento); setas escolhem, Enter ou Tab inserem `@usuario `, Esc fecha. Quem é mencionado recebe o aviso de menção. Nas conversas diretas não há lista (toda mensagem já avisa).

**Atalhos de teclado configuráveis.** Em Minha conta → Atalhos de teclado cada pessoa grava a combinação de cada ação: mutar, ensurdecer, câmera, tela, sair da chamada, busca rápida de canal (Ctrl+K) e canal anterior/seguinte. Precisam de Ctrl, Alt ou Cmd junto (ou teclas F1 a F12), repetidos são recusados e dá para limpar e restaurar os padrões; vale por aparelho. No navegador valem com a aba aberta; no **app de computador** (pasta `desktop/`) os de chamada são globais e funcionam até com o jogo em primeiro plano.

**App de computador e celular.** `desktop/` tem o app Electron (Windows, Mac e Linux; veja `desktop/LEIAME.md`), com instaladores gerados de graça pelo GitHub Actions (`.github/workflows/desktop.yml`) e publicados em Releases. **Android:** abra o site no Chrome, menu ⋮ → "Instalar app" (ou "Adicionar à tela inicial"). **iPhone/iPad:** abra no Safari, Compartilhar → "Adicionar à Tela de Início" (é o único jeito sem pagar a conta de desenvolvedor da Apple; as notificações com o app fechado só funcionam assim). Esses dois usam o mesmo site, então recebem as atualizações na hora.

**Entrar com Google ou GitHub.** Além de usuário e senha, a pessoa pode entrar com a conta do Google ou do GitHub e depois escolhe o apelido. **O convite continua obrigatório** para criar conta (quem nunca foi convidado é barrado); quem já tem conta vincula o Google/GitHub em Minha conta → Contas vinculadas. Só guardamos o número de identificação da pessoa no serviço (nem e-mail, nem nome). Liga com `PUBLIC_URL`, `GOOGLE_CLIENT_ID/SECRET` e `GITHUB_CLIENT_ID/SECRET` (veja `tasks/oauth-credenciais.md` e `deploy/definir-login-externo.sh`); sem as credenciais os botões não aparecem.

**Voz própria e reserva.** A voz pode usar um LiveKit próprio (por exemplo na máquina A1 da Oracle, grátis) como **principal** e o LiveKit Cloud como **reserva automática**. O Concord confere a principal a cada 30 s (precisa de 2 falhas seguidas para trocar e 2 acertos para voltar) e cada sala fica no servidor em que começou até esvaziar. Quando a principal cai ou volta, a administradora recebe um aviso. Configure com `MEDIA_PRIMARY_URL/KEY/SECRET` (as `LIVEKIT_*` continuam valendo como reserva); o passo a passo da máquina está em `deploy/a1/LEIAME.md`. Para voltar atrás, apague as `MEDIA_PRIMARY_*` e reinicie.

**Mais recursos.** Notificação com o app fechado (mensagens diretas e menções; precisa de chaves VAPID, veja `.env.example`; no iPhone só com o app instalado na tela de início), reordenar categorias e canais (arrastar, ou Subir/Descer nas janelas de edição), moderar o apelido de outras pessoas e carregamento inicial bem menor (a parte de voz só baixa ao entrar numa sala). A revisão de segurança está em `tasks/revisao-seguranca.md`.

## Rodar no seu computador

Precisa do Node 24 ou mais novo.

```bash
npm install
npm run dev        # app (5173), API (3001) e servidor de mídia LiveKit (7880)
```

O servidor de mídia (`media/livekit/livekit-server.exe`) é baixado à parte (não vai para o repositório): pegue o zip `livekit_<versão>_windows_amd64.zip` em <https://github.com/livekit/livekit/releases> e extraia o `.exe` em `media/livekit/`. Sem ele, só voz, câmera e tela ficam de fora.

```bash
npm test           # testes do servidor e do cliente
npm run build && npm start   # modo produção, tudo numa porta só (precisa do .env, ver abaixo)
```

## Publicar (resumo)

Tudo grátis, numa VM da Oracle Cloud "Always Free" + domínio grátis do DuckDNS + HTTPS automático do Caddy.

> Atenção ao custo: crie só recursos marcados como **Always Free** e **não** converta a conta para "Pay As You Go". A Oracle pede um cartão só para confirmar a identidade.

### 1. Antes de começar (no navegador)
1. Conta na Oracle Cloud e uma VM **Ubuntu 24.04** Always Free (a de 1–4 CPUs ARM serve; fica com IP público).
2. Dois nomes em <https://www.duckdns.org>, ambos apontando para o IP público da VM. Exemplo: `concord-amigos.duckdns.org` (app) e `concord-amigos-media.duckdns.org` (mídia).
3. No painel da Oracle (Rede → lista de segurança da sub-rede), libere de entrada: **TCP 80, TCP 443, TCP 7881, UDP 7882, UDP 3478**. Dentro da VM, o firewall do Ubuntu também precisa liberar essas portas (`sudo iptables`/`ufw`; na imagem da Oracle é o `iptables`).

### 2. Na VM (por SSH)
```bash
# Node 24, Caddy e git
sudo apt update && sudo apt install -y git caddy
# Node 24: instale pelo método oficial em https://nodejs.org (NodeSource ou nvm)

sudo useradd -r -m -s /usr/sbin/nologin concord
sudo mkdir -p /opt/concord /var/lib/concord /etc/concord
sudo chown -R concord:concord /opt/concord /var/lib/concord

# código do app
sudo -u concord git clone <SEU-REPOSITORIO> /opt/concord      # ou copie a pasta pelo scp
cd /opt/concord && sudo -u concord npm ci && sudo -u concord npm run build

# LiveKit (escolha linux_arm64 para a VM ARM, linux_amd64 para a x86)
sudo mkdir -p /opt/livekit && cd /opt/livekit
sudo curl -L -o lk.tar.gz https://github.com/livekit/livekit/releases/download/v1.13.11/livekit_1.13.11_linux_arm64.tar.gz
sudo tar xzf lk.tar.gz livekit-server && sudo rm lk.tar.gz
```

### 3. Segredos e configuração
```bash
sudo cp /opt/concord/.env.example /etc/concord/.env && sudo nano /etc/concord/.env
```
Preencha: `JWT_SECRET`, `OWNER_SETUP_CODE` (12+ caracteres, só você sabe), `LIVEKIT_URL=wss://concord-amigos-media.duckdns.org`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (invente os dois; o segredo com 32+ caracteres).
Crie `/etc/concord/livekit.env` com **uma linha**: `LIVEKIT_KEYS=SUA_CHAVE: SEU_SEGREDO` (os mesmos valores). Proteja os dois: `sudo chmod 600 /etc/concord/*.env`.

Troque `EXEMPLO.duckdns.org` pelos seus nomes em `deploy/Caddyfile` e em `deploy/livekit.yaml`.

### 4. Ligar tudo
```bash
sudo cp /opt/concord/deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl restart caddy
sudo cp /opt/concord/deploy/concord.service /opt/concord/deploy/livekit.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now concord livekit
```
Os dois reiniciam sozinhos se caírem e quando a VM reinicia.

### 5. Criar sua conta e convidar amigos
1. Abra uma vez `https://concord-amigos.duckdns.org/convite/<OWNER_SETUP_CODE>` e crie a sua conta. (Aparecerá um aviso de convite inválido: é normal, clique no **+** e crie o seu servidor.) Esse código **só funciona enquanto não existe nenhuma conta**.
2. Dentro do app, no servidor, clique em **Convidar amigos** e mande o link para cada amigo. Só o dono do servidor gera convites.

## Atualizar
```bash
cd /opt/concord && sudo -u concord git pull && sudo -u concord npm ci && sudo -u concord npm run build
sudo systemctl restart concord
```
O banco migra sozinho para o formato novo na primeira subida.

## Backup
Tudo que importa está em `/var/lib/concord` (`concord.db` e a pasta `audio/`).
```bash
sudo -u concord /opt/concord/deploy/backup.sh ~/backups    # guarda os 14 mais recentes
```
Agende com `crontab -e` (ex.: todo dia às 4h) e copie os backups para fora da VM de vez em quando. Para restaurar: pare o `concord`, ponha o `.db` de volta como `/var/lib/concord/concord.db`, extraia o `audio-*.tar.gz` em `/var/lib/concord/` e inicie de novo.

## Variáveis de ambiente
Veja `.env.example`. Em produção o servidor **se recusa a iniciar** sem `JWT_SECRET` e sem as três `LIVEKIT_*`.

## Qualidade da tela compartilhada
O app pede 1920×1080 a 120 fps e mostra no quadro o que foi **medido de verdade**, avisando quando fica abaixo. O resultado depende do monitor (120 Hz ou mais), do navegador (Chrome e Edge costumam aceitar 120 fps), da placa de vídeo e da internet de quem compartilha (algo como 15 a 40 Mbps de envio).
