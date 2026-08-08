import { MODULE_ID } from "./api.js";

const COMBAT_STATS_ID = "combat-stats-pf2e";
const S_MAPEAMENTO = "mapeamentoAtores";
const S_GRAVANDO = "gravando";
const S_REGISTRO = "registroAtaques";
const S_SESSION_START = "sessionStart";

/**
 * Captura o que o Combat Stats — PF2e (se instalado) não cobre: acertos e
 * erros de ataque (com d20 bruto, natural 1/20) e cura recebida.
 *
 * Estratégia pro dano/cura: NENHUMA — isso já é responsabilidade do
 * Combat Stats — PF2e, lido em `placarCombatStats()`. Reescrever aquela
 * parte do zero seria repetir um trabalho arriscado (a aplicação de dano no
 * PF2e passa por resistência/imunidade, então o valor "real" só existe
 * depois de aplicado) que o Combat Stats já resolve com uma técnica
 * validada: comparar o HP do actor antes/depois de cada updateActor.
 *
 * Estratégia pra cura recebida: a mesma técnica de "antes/depois do HP",
 * mas sem precisar identificar quem curou — só se o HP de um PJ mapeado
 * subiu enquanto a gravação estava ligada.
 *
 * Estratégia pra ataques: hook em createChatMessage nas mensagens com
 * `flags.pf2e.context.type === "attack-roll"`. O atacante vem de
 * `flags.pf2e.context.actor` (UUID) e o alvo de `flags.pf2e.target.actor`
 * (UUID) — mesmo formato de flags que o Combat Stats usa pras mensagens de
 * dano, então é razoável esperar que valha também pras de ataque.
 */
export class RegistroTracker {
  constructor() {
    this._hpAntes = {};
  }

  init() {
    if (!game.settings.get(MODULE_ID, S_SESSION_START)) {
      game.settings.set(MODULE_ID, S_SESSION_START, Date.now());
    }

    Hooks.on("preUpdateActor", (actor, changes) => {
      if (!game.user.isGM || !this.estaGravando()) return;
      if (changes?.system?.attributes?.hp?.value === undefined) return;
      this._hpAntes[actor.id] = actor.system.attributes.hp.value;
    });

    Hooks.on("updateActor", (actor, changes) => {
      if (!game.user.isGM || !this.estaGravando()) return;
      this._capturarCuraRecebida(actor, changes);
    });

    Hooks.on("createChatMessage", (message) => {
      if (!game.user.isGM || !this.estaGravando()) return;
      this._capturarAtaque(message);
    });
  }

  estaGravando() {
    return Boolean(game.settings.get(MODULE_ID, S_GRAVANDO));
  }

  async iniciar() {
    await game.settings.set(MODULE_ID, S_GRAVANDO, true);
  }

  async pausar() {
    await game.settings.set(MODULE_ID, S_GRAVANDO, false);
  }

  /**
   * Zera o registro próprio (ataques/cura recebida) e avança o início da
   * sessão — os combates do Combat Stats anteriores a este momento deixam
   * de entrar no placar. Não mexe nos dados do Combat Stats em si.
   */
  async novaSessao() {
    await game.settings.set(MODULE_ID, S_REGISTRO, {});
    await game.settings.set(MODULE_ID, S_SESSION_START, Date.now());
    await this.pausar();
  }

  _capturarCuraRecebida(actor, changes) {
    const novoHp = changes?.system?.attributes?.hp?.value;
    if (novoHp === undefined) return;

    const antes = this._hpAntes[actor.id];
    delete this._hpAntes[actor.id];
    if (antes === undefined) return;

    const personagemId = this._personagemDoAtor(actor.id);
    if (!personagemId) return;

    const delta = novoHp - antes;
    if (delta > 0) this._acumular(personagemId, "cura_sofrida", Math.floor(delta));
  }

  _capturarAtaque(message) {
    const pf2e = message.flags?.pf2e;
    if (!pf2e || pf2e.context?.type !== "attack-roll") return;

    const atacanteUuid = pf2e.context?.actor ?? null;
    const alvoUuid = pf2e.target?.actor ?? null;

    const atacante = atacanteUuid ? (fromUuidSync?.(atacanteUuid) ?? null) : null;
    const alvo = alvoUuid ? (fromUuidSync?.(alvoUuid) ?? null) : null;

    const acertou = ["success", "criticalSuccess"].includes(pf2e.context?.outcome ?? "");
    const bruto = this._d20Bruto(message);

    const personagemAtacante = atacante ? this._personagemDoAtor(atacante.id) : null;
    const personagemAlvo = alvo ? this._personagemDoAtor(alvo.id) : null;

    if (personagemAtacante) {
      this._acumular(personagemAtacante, acertou ? "ataques_acertados" : "ataques_errados", 1);

      if (bruto !== null) {
        this._acumular(personagemAtacante, "d20_rolados", 1);
        this._acumular(personagemAtacante, "somaD20", bruto);
        if (bruto === 1) this._acumular(personagemAtacante, "natural_1", 1);
        if (bruto === 20) this._acumular(personagemAtacante, "natural_20", 1);
      }
    } else if (personagemAlvo) {
      this._acumular(personagemAlvo, acertou ? "acertos_sofridos" : "erros_sofridos", 1);
    }
  }

  /**
   * Pega o resultado bruto (não modificado) do primeiro termo de d20 da
   * rolagem, preferindo o resultado ativo (caso de reroll, ex.: Ponto de
   * Herói no PF2e).
   */
  _d20Bruto(message) {
    for (const roll of message.rolls ?? []) {
      const termoD20 = roll.terms?.find((termo) => termo.faces === 20);
      if (!termoD20?.results?.length) continue;

      const ativo = termoD20.results.find((r) => r.active) ?? termoD20.results[0];
      return ativo?.result ?? null;
    }
    return null;
  }

  _personagemDoAtor(actorId) {
    const mapa = game.settings.get(MODULE_ID, S_MAPEAMENTO) ?? {};
    return mapa[actorId] ?? null;
  }

  _acumular(personagemId, campo, quantidade) {
    const registro = game.settings.get(MODULE_ID, S_REGISTRO) ?? {};
    if (!registro[personagemId]) registro[personagemId] = {};
    registro[personagemId][campo] = (registro[personagemId][campo] ?? 0) + quantidade;
    game.settings.set(MODULE_ID, S_REGISTRO, registro);
  }

  /**
   * Lê os dados de dano/cura do Combat Stats — PF2e (se o módulo estiver
   * ativo): o combate em andamento, se houver, mais os combates finalizados
   * depois do início da sessão atual deste módulo.
   *
   * @returns {Record<string, {damageDealt:number, damageTaken:number, healingDone:number}>} por Foundry Actor id
   */
  placarCombatStats() {
    if (!game.modules.get(COMBAT_STATS_ID)?.active) return {};

    const sessionStart = game.settings.get(MODULE_ID, S_SESSION_START) ?? 0;
    const atual = game.settings.get(COMBAT_STATS_ID, "currentCombatData") ?? {};
    const historico = game.settings.get(COMBAT_STATS_ID, "combatHistory") ?? [];

    const combatesRelevantes = [
      atual.characters ? atual : null,
      ...historico.filter((fight) => new Date(fight.date).getTime() >= sessionStart),
    ].filter(Boolean);

    const total = {};
    for (const fight of combatesRelevantes) {
      for (const [actorId, dados] of Object.entries(fight.characters ?? {})) {
        if (!total[actorId]) total[actorId] = { damageDealt: 0, damageTaken: 0, healingDone: 0 };
        total[actorId].damageDealt += dados.damageDealt ?? 0;
        total[actorId].damageTaken += dados.damageTaken ?? 0;
        total[actorId].healingDone += dados.healingDone ?? 0;
      }
    }
    return total;
  }

  /**
   * Monta o placar final por personagem_id, juntando o Combat Stats (dano
   * causado/sofrido, cura causada) com o registro próprio (ataques, cura
   * recebida) — no formato exato dos campos de `EstatisticaCombate` do
   * mestre-weber.
   *
   * @returns {Array<Record<string, number> & {personagem_id:number}>}
   */
  montarPlacar() {
    const mapa = game.settings.get(MODULE_ID, S_MAPEAMENTO) ?? {};
    const combatStats = this.placarCombatStats();
    const registro = game.settings.get(MODULE_ID, S_REGISTRO) ?? {};

    const porPersonagem = {};

    for (const [actorId, personagemId] of Object.entries(mapa)) {
      if (!porPersonagem[personagemId]) porPersonagem[personagemId] = { personagem_id: Number(personagemId) };

      const cs = combatStats[actorId];
      if (cs) {
        porPersonagem[personagemId].dano_causado = (porPersonagem[personagemId].dano_causado ?? 0) + cs.damageDealt;
        porPersonagem[personagemId].dano_sofrido = (porPersonagem[personagemId].dano_sofrido ?? 0) + cs.damageTaken;
        porPersonagem[personagemId].cura_causada = (porPersonagem[personagemId].cura_causada ?? 0) + cs.healingDone;
      }
    }

    for (const [personagemId, dados] of Object.entries(registro)) {
      if (!porPersonagem[personagemId]) porPersonagem[personagemId] = { personagem_id: Number(personagemId) };

      const alvo = porPersonagem[personagemId];
      alvo.ataques_acertados = (alvo.ataques_acertados ?? 0) + (dados.ataques_acertados ?? 0);
      alvo.ataques_errados = (alvo.ataques_errados ?? 0) + (dados.ataques_errados ?? 0);
      alvo.acertos_sofridos = (alvo.acertos_sofridos ?? 0) + (dados.acertos_sofridos ?? 0);
      alvo.erros_sofridos = (alvo.erros_sofridos ?? 0) + (dados.erros_sofridos ?? 0);
      alvo.natural_1 = (alvo.natural_1 ?? 0) + (dados.natural_1 ?? 0);
      alvo.natural_20 = (alvo.natural_20 ?? 0) + (dados.natural_20 ?? 0);
      alvo.cura_sofrida = (alvo.cura_sofrida ?? 0) + (dados.cura_sofrida ?? 0);

      const d20Rolados = dados.d20_rolados ?? 0;
      if (d20Rolados > 0) {
        alvo.d20_rolados = (alvo.d20_rolados ?? 0) + d20Rolados;
        alvo.media_d20 = Math.round(((dados.somaD20 ?? 0) / d20Rolados) * 100) / 100;
      }
    }

    return Object.values(porPersonagem);
  }
}
