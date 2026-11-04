# Concord Hub para computador

O site do Concord numa janela própria (Electron, grátis e de código aberto), para **Windows, Mac e Linux**.
Como o app carrega o site no ar, **toda atualização do site chega sozinha**: não precisa instalar de novo.

O que o app tem a mais que o navegador:
- ícone na **bandeja** (fechar a janela só esconde; a chamada continua) e opção de abrir junto com o computador;
- **atalhos globais** de chamada (mutar, ensurdecer, câmera, tela, sair), que valem com o jogo em primeiro plano. Cada pessoa escolhe as teclas em *Minha conta → Atalhos de teclado*;
- **seletor de tela e janela** ao compartilhar, com o **som do computador** no Windows;
- notificações do sistema e uma única janela por vez.

## Rodar e testar

```bash
cd desktop
npm install
npm start                       # abre o app (usa https://concord-hub.duckdns.org)
CONCORD_URL=http://localhost:5173 npm start   # aponta para o servidor de desenvolvimento
npm test                        # testes da conversão de atalhos
CONCORD_SMOKE=1 npm start       # abre, confere que a ponte existe e fecha sozinho
```

## Gerar os instaladores

```bash
npm run dist:win     # Windows: dist/Concord-Hub-Setup-<versão>.exe
npm run dist:mac     # Mac (só no Mac): dist/Concord-Hub-<versão>-<arq>.dmg
npm run dist:linux   # Linux: dist/Concord-Hub-<versão>.AppImage e .deb
```

Pelo GitHub (sem precisar de Mac nem de Linux): o fluxo `.github/workflows/desktop.yml` gera os três.
Mude `version` em `package.json`, faça `git tag v1.0.1 && git push origin v1.0.1` e os instaladores aparecem na aba
**Releases** do repositório, de graça. O app instalado se atualiza sozinho a partir dessa Release.

## Avisos de segurança do sistema (sem certificado pago)

Os instaladores **não são assinados**: o certificado de assinatura é um serviço pago e separado (não tem a ver com ter o Windows
ou o Mac original). Por isso o sistema desconfia na primeira instalação:

- **Windows (SmartScreen):** aparece "O Windows protegeu o seu PC". Clique em **Mais informações** e depois em **Executar assim mesmo**.
  Só na primeira vez; o aviso vai diminuindo quando muita gente baixa o mesmo arquivo.
- **Mac (Gatekeeper):** "não é possível verificar o desenvolvedor". Clique com o botão direito no app, escolha **Abrir** e confirme.
  Se disser que o app "está danificado", rode uma vez no Terminal: `xattr -cr "/Applications/Concord Hub.app"`.
- **Linux:** no AppImage, marque como executável (`chmod +x Concord-Hub-*.AppImage`); o `.deb` instala com `sudo apt install ./Concord-Hub-*.deb`.

## Limites conhecidos

- **Entrar com Google** é bloqueado pelo Google dentro de apps como este; use usuário e senha, ou o GitHub, ou o navegador.
- **Android e iPhone** não usam este app: instale o site como aplicativo (veja o README da raiz).
