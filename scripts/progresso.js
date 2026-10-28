import { MODULE_ID, buscarPersonagens, sincronizarProgresso, sincronizarProgressoGrupo } from "./api.js";
import { HudApp } from "./hud.js";

const S_MAPEAMENTO = "mapeamentoAtores";
const S_ATOR_GRUPO = "atorGrupo";
const S_CONFIRMADOS = "vinculosConfirmados";
const CHAVE_GRUPO = "__grupo__";
const DEBOUNCE_MS = 3000;
const PULL_INTERVAL_MS = 20000;

/**
 * Mantém nível/XP sincronizados nos dois sentidos entre o Foundry e o
 * mestre-weber, sem ação manual do mestre. Dois alvos independentes, ambos
 * cobertos aqui:
 *
 * - **Personagens mapeados** (`mapeamentoAtores`): nível/XP individual de
 *   cada um, usado quando a campanha liga "Nível e XP individuais".
 * - **Ator do grupo** (`atorGrupo`): um único Actor escolhido pelo mestre
 *   pra representar o nível/XP único do grupo inteiro (`campanhas.nivel`/
 *   `xp`), usado quando essa opção está desligada.
 *
 * **Foundry → site** (push): um hook em `updateActor` agenda (debounced) o
 * envio do nível/XP atual do Actor pro mestre-weber sempre que um Actor
 * relevante muda.
 *
 * **Site → Foundry** (pull): o Foundry não tem como "receber" uma chamada
 * do site (só ele consegue se conectar pra fora) — por isso, periodicamente
 * (a cada 20s), este módulo busca o nível/XP atual no mestre-weber e aplica
 * no Actor correspondente, se for diferente do que já está no Foundry. É
 * assim que uma edição feita direto no site (pelo mestre) chega até aqui.
 *
 * As duas pontas só escrevem quando o valor realmente muda, então o
 * round-trip (Foundry muda → push → site já tinha esse valor → pull não
 * muda nada) se estabiliza sozinho, sem loop infinito.
 *
 * **O Foundry manda no vínculo novo.** Um ator recém-ligado a um personagem
 * do site (ou escolhido como ator do grupo) nunca recebe o pull antes de o
 * nível/XP dele ter ido pro site pelo menos uma vez (`vinculosConfirmados`).
 * Sem isso, ligar um ator nível 5 a um personagem que no site ainda estava
 * nível 1 fazia o pull de 20s rebaixar a ficha do Foundry pro nível 1.
 * Pelo mesmo motivo, o pull nunca BAIXA o nível de um ator — rebaixar nível
 * no PF2e apaga características de classe; isso só o mestre faz, na ficha.
 */
export class ProgressoSync {
  constructor() {
    this._timeout = null;
    this._pullInterval = null;
    this._pullEmAndamento = false;
    this._ultimaSincronia = null;
    this._ultimoErro = null;
    // Contador de alterações locais (feitas no Foundry) ainda não confirmadas
    // pelo site. Um pull só é aplicado se nada mudou localmente desde que ele
    // começou e não há push pendente/em andamento — senão o pull traria o
    // valor ANTIGO do site e desfaria a edição recém-feita no Foundry (ex.:
    // Mestre muda XP 476→496, o pull de 20s cai dentro dos 3s de debounce do
    // push, reescreve 476 na ficha, e o push depois manda 476 pro site).
    this._versaoLocal = 0;
    this._pushEmAndamento = false;
  }

  init() {
    // Propositalmente NÃO filtra por quais campos mudaram em `changes` — a
    // ficha do PF2e nem sempre envia nível/XP como objeto aninhado
    // (`system.details.xp.value`); alguns atalhos da ficha (botões +/-,
    // "Award XP" etc.) atualizam com uma chave pontilhada no nível raiz do
    // payload, que passaria despercebido por uma checagem estrutural. Mais
    // simples e confiável: qualquer atualização num Actor relevante agenda
    // uma resincronização, que sempre lê o nível/XP atual do Actor (não o
    // diff) — o debounce evita virar uma enxurrada de requests quando o
    // Actor muda por outro motivo (HP, itens etc.) no meio da sessão.
    Hooks.on("updateActor", (actor, changes, options) => {
      if (!game.user.isGM) return;
      if (actor.type !== "character") return;
      // Marcado por `_aplicarNoAtor` quando é o PRÓPRIO pull aplicando o
      // valor que acabou de vir do site — sem isso, toda aplicação de pull
      // reagendava um push (3s depois) mandando de volta pro site o mesmo
      // valor que ele mesmo acabou de mandar pra cá, um request HTTP à toa.
      if (options?.mwsSkipPush) return;

      const relevante = Boolean(this._personagemDoAtor(actor.id)) || actor.id === this._atorGrupo();
      if (!relevante) return;

      this._versaoLocal++;
      this._agendar();
    });

    // Vínculo salvo/trocado (janela Configurar, "Enviar pro mestre-weber",
    // "Importar"): conta como mudança local, pra nenhum pull em andamento ser
    // aplicado e o push do vínculo novo sair logo.
    Hooks.on("updateSetting", (setting) => {
      if (setting.key !== `${MODULE_ID}.${S_MAPEAMENTO}` && setting.key !== `${MODULE_ID}.${S_ATOR_GRUPO}`) return;

      this._versaoLocal++;
      this._agendar();
    });

    this._puxarDoSite();
    this._pullInterval = setInterval(() => this._puxarDoSite(), PULL_INTERVAL_MS);
  }

  _personagemDoAtor(actorId) {
    const mapa = game.settings.get(MODULE_ID, S_MAPEAMENTO) ?? {};
    return mapa[actorId] ?? null;
  }

  _atorGrupo() {
    return game.settings.get(MODULE_ID, S_ATOR_GRUPO) || null;
  }

  _confirmados() {
    return game.settings.get(MODULE_ID, S_CONFIRMADOS) ?? {};
  }

  /** Se o vínculo atual já mandou o nível/XP do Foundry pro site. */
  _vinculoConfirmado(chave, valor) {
    const confirmado = this._confirmados()[chave];
    return confirmado !== undefined && String(confirmado) === String(valor);
  }

  _haVinculoPendente() {
    const mapa = game.settings.get(MODULE_ID, S_MAPEAMENTO) ?? {};
    const pendentePersonagem = Object.entries(mapa).some(
      ([actorId, personagemId]) => game.actors.get(actorId) && !this._vinculoConfirmado(actorId, personagemId),
    );
    const atorGrupo = this._atorGrupo();
    const pendenteGrupo = Boolean(atorGrupo && game.actors.get(atorGrupo) && !this._vinculoConfirmado(CHAVE_GRUPO, atorGrupo));

    return pendentePersonagem || pendenteGrupo;
  }

  async _confirmar(novos) {
    if (foundry.utils.isEmpty(novos)) return;
    await game.settings.set(MODULE_ID, S_CONFIRMADOS, { ...this._confirmados(), ...novos });
  }

  _agendar() {
    clearTimeout(this._timeout);
    this._timeout = setTimeout(() => this.sincronizarAgora(), DEBOUNCE_MS);
  }

  ultimaSincroniaFormatada() {
    return this._ultimaSincronia ? new Date(this._ultimaSincronia).toLocaleTimeString() : null;
  }

  /**
   * Push: sincroniza os dois alvos (personagens mapeados + Actor do grupo,
   * se configurado) do Foundry pro site. Chamado tanto pelo debounce
   * automático quanto pelo botão "Sincronizar agora" do HUD.
   *
   * @returns {Promise<{personagens: object|null, grupo: object|null}>}
   */
  async sincronizarAgora() {
    clearTimeout(this._timeout);
    this._timeout = null;

    this._pushEmAndamento = true;
    let personagens, grupo;
    try {
      [personagens, grupo] = await Promise.all([this._sincronizarPersonagens(), this._sincronizarGrupo()]);
    } finally {
      this._pushEmAndamento = false;
    }

    this._atualizarHudAberto();

    return { personagens, grupo };
  }

  async _sincronizarPersonagens() {
    const mapa = game.settings.get(MODULE_ID, S_MAPEAMENTO) ?? {};
    const progresso = [];
    const enviados = {};

    for (const [actorId, personagemId] of Object.entries(mapa)) {
      const actor = game.actors.get(actorId);
      if (!actor) continue;

      const nivel = actor.system?.details?.level?.value;
      const xp = actor.system?.details?.xp?.value;
      if (nivel === undefined && xp === undefined) continue;

      progresso.push({ personagem_id: Number(personagemId), nivel, xp });
      enviados[actorId] = Number(personagemId);
    }

    if (progresso.length === 0) return null;

    const resultado = await sincronizarProgresso(progresso);
    this._registrarResultado(resultado);

    if (resultado.ok) {
      await this._confirmar(enviados);
      for (const aviso of resultado.avisos) ui.notifications.warn(`Mestre Weber Sync | ${aviso}`);
    }

    return resultado;
  }

  async _sincronizarGrupo() {
    const atorGrupoId = this._atorGrupo();
    if (!atorGrupoId) return null;

    const actor = game.actors.get(atorGrupoId);
    if (!actor) return null;

    const nivel = actor.system?.details?.level?.value ?? null;
    const xp = actor.system?.details?.xp?.value ?? null;
    if (nivel === null && xp === null) return null;

    const resultado = await sincronizarProgressoGrupo(nivel, xp);
    this._registrarResultado(resultado);
    if (resultado.ok) await this._confirmar({ [CHAVE_GRUPO]: atorGrupoId });

    return resultado;
  }

  _registrarResultado(resultado) {
    if (resultado.ok) {
      this._ultimaSincronia = Date.now();
      this._ultimoErro = null;
    } else {
      this._ultimoErro = resultado.erro;
      ui.notifications.error(`Mestre Weber Sync | Falha ao sincronizar nível/XP: ${resultado.erro}`);
    }
  }

  /**
   * Pull: busca o nível/XP atual no mestre-weber e aplica nos Actors
   * correspondentes, quando diferente do que já está no Foundry — é assim
   * que uma edição feita direto no site chega até aqui. Silencioso em caso
   * de erro (só loga no console): isso roda em background a cada 20s, e
   * ficar aparecendo toast de erro nesse ritmo seria mais incômodo que
   * ajuda — falhas "de verdade" (token/URL errados) já aparecem quando o
   * mestre tenta o push manual ou uma sincronização automática.
   */
  async _puxarDoSite() {
    // Sem nada mapeado, não há o que buscar — evita um request a cada 20s
    // à toa numa campanha que não usa nível/XP individual nem tem Actor do
    // grupo configurado.
    const mapa = game.settings.get(MODULE_ID, S_MAPEAMENTO) ?? {};
    if (foundry.utils.isEmpty(mapa) && !this._atorGrupo()) return;

    // Evita que um request lento (ou travado) se sobreponha ao próximo tick
    // do intervalo — sem isso, uma conexão ruim poderia ir empilhando
    // requests simultâneos em vez de simplesmente atrasar o próximo.
    if (this._pullEmAndamento) return;
    // Push agendado ou em andamento = o site ainda não tem o valor atual do
    // Foundry; o que viesse do pull agora seria velho.
    if (this._timeout || this._pushEmAndamento) return;

    this._pullEmAndamento = true;
    const versaoNoInicio = this._versaoLocal;

    try {
      // Vínculo novo (ou ainda não confirmado, ex.: logo depois de atualizar
      // o módulo): o Foundry manda primeiro o nível/XP dele pro site. Os
      // vínculos não confirmados ficam de fora do pull de qualquer jeito.
      if (this._haVinculoPendente()) await this.sincronizarAgora();
      if (this._versaoLocal !== versaoNoInicio || this._timeout || this._pushEmAndamento) return;

      const resultado = await buscarPersonagens();

      // Algo mudou no Foundry enquanto o request estava no ar: a resposta
      // reflete o site de antes dessa mudança. Descarta — o push dessa
      // mudança já está agendado e o próximo pull confere de novo.
      if (this._versaoLocal !== versaoNoInicio || this._timeout || this._pushEmAndamento) return;

      if (!resultado.ok) {
        console.warn(`Mestre Weber Sync | Falha ao puxar progresso do site: ${resultado.erro}`);
        return;
      }

      const mudouAlgo = [
        ...this._aplicarProgressoPersonagens(resultado.personagens, resultado.campanha),
        this._aplicarProgressoGrupo(resultado.campanha),
      ].some(Boolean);

      if (mudouAlgo) this._atualizarHudAberto();
    } finally {
      this._pullEmAndamento = false;
    }
  }

  /**
   * @returns {boolean[]} se cada personagem mapeado foi (ou não) atualizado.
   */
  _aplicarProgressoPersonagens(personagens, campanha) {
    // Só aplica no modo individual — no modo grupo, o nível/XP de cada
    // personagem não é o que o site mostra, então não há por que empurrar
    // pro Foundry (evita sobrescrever o Actor com um valor irrelevante).
    if (!campanha?.nivelIndividualAtivo) return [];

    const mapa = game.settings.get(MODULE_ID, S_MAPEAMENTO) ?? {};
    const porId = new Map(personagens.map((p) => [p.id, p]));

    return Object.entries(mapa).map(([actorId, personagemId]) => {
      if (!this._vinculoConfirmado(actorId, personagemId)) return false;

      const personagem = porId.get(Number(personagemId));
      if (!personagem) return false;

      return this._aplicarNoAtor(actorId, personagem.nivel, personagem.xp);
    });
  }

  _aplicarProgressoGrupo(campanha) {
    // Só aplica no modo grupo — no modo individual, `campanha.nivel`/`xp`
    // não é o que o site mostra pro Actor do grupo.
    if (!campanha || campanha.nivelIndividualAtivo) return false;

    const atorGrupoId = this._atorGrupo();
    if (!atorGrupoId) return false;
    if (!this._vinculoConfirmado(CHAVE_GRUPO, atorGrupoId)) return false;

    return this._aplicarNoAtor(atorGrupoId, campanha.nivel, campanha.xp);
  }

  /**
   * Aplica nível/XP num Actor só se algum dos dois for diferente do valor
   * atual — evita um `.update()` (e o `updateActor` que ele dispara) toda
   * vez que o pull roda, mesmo sem nada ter mudado de verdade.
   *
   * @returns {boolean} se aplicou alguma mudança.
   */
  _aplicarNoAtor(actorId, nivel, xp) {
    const actor = game.actors.get(actorId);
    if (!actor) return false;

    const atualizacoes = {};
    const nivelAtual = Number(actor.system?.details?.level?.value);

    // Site com nível MENOR que o Foundry: não rebaixa a ficha (nem mexe no
    // XP, que é do nível do site). O próximo push corrige o site.
    if (nivel !== undefined && nivel !== null && Number(nivel) < nivelAtual) {
      console.warn(
        `Mestre Weber Sync | ${actor.name}: site no nível ${nivel}, Foundry no ${nivelAtual} — ficha não rebaixada.`,
      );
      this._agendar();
      return false;
    }

    if (nivel !== undefined && nivel !== null && Number(nivel) !== nivelAtual) {
      atualizacoes["system.details.level.value"] = nivel;
    }
    if (xp !== undefined && xp !== null && Number(xp) !== Number(actor.system?.details?.xp?.value)) {
      atualizacoes["system.details.xp.value"] = xp;
    }

    if (foundry.utils.isEmpty(atualizacoes)) return false;

    // `mwsSkipPush` avisa o hook `updateActor` acima que essa mudança já
    // veio do site — não precisa reagendar um push pra devolver o mesmo
    // valor (ver comentário em `init()`).
    // `mwXpOrigem` identifica a origem no histórico de XP do mestre-weber
    // (o stack trace se perde aqui, já que o update não é aguardado).
    actor.update(atualizacoes, { mwsSkipPush: true, mwXpOrigem: "Mestre Weber Sync (site)" });
    return true;
  }

  // O HUD pode estar aberto durante uma sincronização automática (push
  // debounced ou pull periódico) — sem isso, o placar de nível/XP só
  // atualizaria na tela da próxima vez que o mestre reabrisse a janela.
  _atualizarHudAberto() {
    for (const janela of Object.values(ui.windows ?? {})) {
      if (janela instanceof HudApp) janela.render();
    }
  }
}
