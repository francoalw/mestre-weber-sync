# Mestre Weber — Sync

Módulo do Foundry VTT (v14, sistemas PF2e e SF2e) que integra o mundo com o
[mestre-weber](http://mestre-weber.test): nível/XP dos personagens e fichas
(nos dois sentidos).

## O que ele sincroniza

- **Nível e XP**: sincronizado nos dois sentidos, sem precisar clicar em
  nada.
  - **Foundry → site**: lido de `system.details.level`/`system.details.xp`
    de cada Actor mapeado — assim que o nível ou o XP mudam no Foundry
    (level up, ajuste manual na ficha, etc.), o módulo espera alguns
    segundos (pra juntar mudanças que chegam em sequência) e sincroniza
    sozinho. O botão **Sincronizar agora** no painel do módulo força isso na hora,
    útil pra testar.
  - **Site → Foundry**: como o Foundry não tem como "receber" uma chamada
    de fora, o módulo busca o nível/XP atual no mestre-weber a cada ~20s e
    aplica no Actor correspondente, se o mestre tiver editado direto no
    site em vez do Foundry.
  - **Ao ligar um ator, o Foundry manda**: um vínculo novo primeiro envia o
    nível/XP do Foundry pro site, e só depois disso passa a receber o pull.
    E o pull nunca baixa o nível de um ator — se o site estiver num nível
    menor, a ficha do Foundry fica como está e o site é corrigido.

  No mestre-weber, esses valores só aparecem (na Campanha e na ficha do
  personagem) se a campanha tiver a opção **Nível e XP individuais** ligada
  em Configurações da Campanha.

  **Se essa opção estiver desligada** (nível/XP em grupo, o padrão), a
  campanha usa um nível/XP único compartilhado por todo mundo — pra
  sincronizar isso automaticamente, escolha (no menu **Configurar** do
  módulo) **um único personagem qualquer do Foundry** pra representar o
  progresso do grupo inteiro. A partir daí, todo level up/ajuste de XP
  desse personagem sincroniza o nível/XP do grupo no mestre-weber, do
  mesmo jeito automático (sem clicar em nada).

## Fichas

- **Ficha automática**: sempre que um personagem mapeado muda no Foundry
  (nível, talentos, equipamento, PV, condições), a ficha dele vai sozinha
  pro site uns segundos depois, com os números calculados pelo próprio
  sistema (PV, CA, percepção, salvamentos, perícias, golpes, conjuração,
  talentos, inventário). O site mostra essa ficha na aba do personagem e
  atualiza sozinho. Só o Mestre envia, e só quando algo mudou. Dá pra
  desligar em Configurações → **Ficha automática no site**.
- **Importar do mestre-weber** (botão direito no ator, só o Mestre): monta o
  ator com a ficha salva no construtor do site. Antes de mexer no ator, uma
  cópia dele vai pra pasta de atores **"backup DD/MM/AAAA"** do dia (só o
  Mestre vê); se o backup falhar, a importação é cancelada.
- **Enviar pro mestre-weber** (botão direito no ator, só o Mestre): manda o
  ator pro site, pra um personagem existente ou um novo. A ficha fica
  pendente no construtor do site até ser conferida e salva. Nada muda no
  ator.

## Nível e XP travados pro jogador

Ninguém além do mestre consegue alterar o nível ou o XP de um personagem
pela ficha do Foundry — nem o próprio dono. Qualquer tentativa (pela ficha,
por macro ou pelo console) é revertida na hora, com um aviso explicando o
motivo. O mestre continua podendo alterar normalmente.

## Instalação

1. Copie (ou crie um link simbólico para) a pasta `mestre-weber-sync` pra
   dentro de `Data/modules/` da sua instalação do Foundry.
2. Ative o módulo no mundo (Configurações do Mundo → Gerenciar Módulos).

## Configuração

1. No mestre-weber, vá em **Configurações da campanha → Integração Foundry
   VTT** e gere um token. Copie o token e a URL mostrados.
2. No Foundry, em **Configurações → Mestre Weber — Sync → Configurar**, cole
   a URL e o token, e clique em **Atualizar lista** pra carregar os
   personagens da campanha.
3. Mapeie cada personagem do Foundry pro personagem correspondente no
   mestre-weber. Só quem estiver mapeado entra na sincronização.
4. Se a campanha ativa **não** tiver "Nível e XP individuais" ligado, uma
   segunda tabela aparece embaixo — "Grupo no mestre-weber", com uma única
   linha. Escolha ali qualquer personagem do Foundry pra ser o rastreado
   como nível/XP do grupo.

## Painel

O painel de nível/XP abre pelo botão **Mestre Weber — Sync** (ícone de
antena/satélite) nos controles de token. Outros módulos podem acrescentar
conteúdo nele pelo hook `renderHudApp` (a janela tem id `mws-hud`).

## Limitações conhecidas

- No site, a Campanha e a ficha do personagem buscam o nível/XP atualizado
  sozinhos a cada ~15-20s enquanto a aba estiver aberta (sem precisar de
  F5) — não é instantâneo, só quase.
- Se dois mestres estiverem logados ao mesmo tempo, os dois clientes tentam
  sincronizar nível/XP de forma independente — inofensivo (o envio é
  idempotente), só redundante.
- A trava de nível/XP roda no navegador de quem tenta a mudança, que é como
  o Foundry funciona (não existe hook server-side em módulos padrão) — vale
  contra qualquer edição normal pela interface, macro ou console, mas não é
  à prova de um jogador tecnicamente hostil adulterando o próprio client.
  Suficiente pra impedir erro/gambiarra de jogador, não pra anti-cheat.
- Personagem mapeado individualmente e escolhido como Actor do grupo ao
  mesmo tempo sincronizam os dois alvos normalmente (não há conflito) — mas
  só um dos dois vai aparecer no site, dependendo do modo da campanha.
  Pra a mesma razão, o pull (site → Foundry) só aplica nível/XP individual
  quando a campanha está em modo individual, e só aplica no Actor do grupo
  quando está em modo grupo — assim os dois lados nunca ficam "brigando".
- A sincronização site → Foundry (pull, a cada ~20s) só roda no client do
  mestre (`game.user.isGM`) — se ele estiver deslogado do Foundry, uma
  edição feita no site só chega no Foundry quando ele voltar a se conectar.
