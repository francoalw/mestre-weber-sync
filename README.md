# Mestre Weber — Sync

Módulo do Foundry VTT (v14, sistema PF2e) que sincroniza estatísticas de
combate e nível/XP dos personagens da campanha com o
[mestre-weber](http://mestre-weber.test).

## O que ele captura

- **Dano causado/sofrido e cura causada**: lidos do módulo
  [Combat Stats — PF2e](https://github.com/Smantella/combat-stats-pf2e) (não
  incluso — instale-o separadamente pra esses três campos funcionarem).
- **Ataques acertados/errados, d20 rolados, natural 1/20, acertos/erros
  sofridos e cura recebida**: capturados por este módulo.
- **Nível e XP**: sincronizado nos dois sentidos, sem precisar clicar em
  nada.
  - **Foundry → site**: lido de `system.details.level`/`system.details.xp`
    de cada Actor mapeado — assim que o nível ou o XP mudam no Foundry
    (level up, ajuste manual na ficha, etc.), o módulo espera alguns
    segundos (pra juntar mudanças que chegam em sequência) e sincroniza
    sozinho. O botão **Sincronizar agora** no placar força isso na hora,
    útil pra testar.
  - **Site → Foundry**: como o Foundry não tem como "receber" uma chamada
    de fora, o módulo busca o nível/XP atual no mestre-weber a cada ~20s e
    aplica no Actor correspondente, se o mestre tiver editado direto no
    site em vez do Foundry.

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

## Nível e XP travados pro jogador

Ninguém além do mestre consegue alterar o nível ou o XP de um personagem
pela ficha do Foundry — nem o próprio dono. Qualquer tentativa (pela ficha,
por macro ou pelo console) é revertida na hora, com um aviso explicando o
motivo. O mestre continua podendo alterar normalmente.

## Instalação

1. Copie (ou crie um link simbólico para) a pasta `mestre-weber-sync` pra
   dentro de `Data/modules/` da sua instalação do Foundry.
2. Ative o módulo no mundo (Configurações do Mundo → Gerenciar Módulos).
3. Recomendado: instale e ative também o **Combat Stats — PF2e**.

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

## Uso durante a sessão

1. Abra o placar pelo botão na barra de controles de cena (ícone de
   antena/satélite).
2. Clique em **Gravar** antes de começar a jogar — sem isso, ataques e cura
   recebida não são contados (o Combat Stats — PF2e captura dano/cura
   independente disso, sempre que houver um combate ativo).
3. Ao final da sessão (ou quando quiser), clique em **Sincronizar** — isso
   cria/atualiza a sessão de hoje no mestre-weber com os números atuais.
   Pode clicar quantas vezes quiser, não duplica nada.
4. Antes da próxima sessão, clique em **Nova sessão** pra zerar o registro
   de ataques/cura recebida (o histórico de combates do Combat Stats — PF2e
   anteriores a esse momento também deixa de entrar no placar).

Nível e XP não dependem de nada disso — a sincronização (nos dois sentidos)
acontece sozinha em segundo plano, gravando ou não a sessão.

## Limitações conhecidas (v0.5.1, ainda não testado ao vivo)

- O formato exato das flags `flags.pf2e.context`/`flags.pf2e.target` nas
  mensagens de rolagem de ataque foi inferido a partir do código do Combat
  Stats — PF2e (que usa esse mesmo formato pras mensagens de dano) — ainda
  não foi confirmado contra uma rolagem de ataque real. Ative o console do
  navegador (F12) durante uma sessão de teste e me mande qualquer erro.
- Ataque de um PJ contra outro PJ (fogo amigo) só conta pro atacante, não
  pro alvo — caso raro, não tratado nesta versão.
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
