import { MODULE_ID, sincronizarEstatisticas } from "./api.js";

const CAMPOS_LABEL = {
  dano_causado: "Dano causado",
  dano_sofrido: "Dano sofrido",
  cura_causada: "Cura causada",
  cura_sofrida: "Cura sofrida",
  ataques_acertados: "Ataques acertados",
  ataques_errados: "Ataques errados",
  acertos_sofridos: "Acertos sofridos",
  erros_sofridos: "Erros sofridos",
  d20_rolados: "d20 rolados",
  media_d20: "Média do d20",
  natural_1: "Natural 1",
  natural_20: "Natural 20",
};

/**
 * HUD do mestre: mostra o placar calculado (Combat Stats — PF2e + registro
 * próprio de ataques/cura recebida), com play/pause da gravação e o botão
 * de sincronizar com o mestre-weber.
 */
export class HudApp extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "mws-hud",
      title: "Mestre Weber — Placar da sessão",
      template: "modules/mestre-weber-sync/templates/hud.hbs",
      width: 620,
      height: "auto",
      closeOnSubmit: false,
      submitOnChange: false,
      resizable: true,
    });
  }

  getData() {
    const tracker = game.mestreWeberSync;
    const mapa = game.settings.get(MODULE_ID, "mapeamentoAtores") ?? {};

    const nomesPorPersonagem = {};
    for (const ator of game.actors.filter((a) => a.type === "character")) {
      const personagemId = mapa[ator.id];
      if (personagemId) nomesPorPersonagem[personagemId] = ator.name;
    }

    const placar = tracker.montarPlacar().map((linha) => ({
      nome: nomesPorPersonagem[linha.personagem_id] ?? `Personagem #${linha.personagem_id}`,
      campos: Object.entries(CAMPOS_LABEL)
        .filter(([chave]) => linha[chave] !== undefined)
        .map(([chave, label]) => ({ label, valor: linha[chave] })),
    }));

    const progresso = Object.entries(mapa).map(([actorId, personagemId]) => {
      const ator = game.actors.get(actorId);
      return {
        nome: ator?.name ?? `Personagem #${personagemId}`,
        nivel: ator?.system?.details?.level?.value ?? "—",
        xp: ator?.system?.details?.xp?.value ?? "—",
      };
    });

    const atorGrupoId = game.settings.get(MODULE_ID, "atorGrupo") || null;
    const atorGrupo = atorGrupoId ? game.actors.get(atorGrupoId) : null;

    return {
      gravando: tracker.estaGravando(),
      placar,
      semDados: placar.length === 0,
      combatStatsAtivo: Boolean(game.modules.get("combat-stats-pf2e")?.active),
      progresso,
      semProgresso: progresso.length === 0,
      grupo: atorGrupo
        ? {
            nome: atorGrupo.name,
            nivel: atorGrupo.system?.details?.level?.value ?? "—",
            xp: atorGrupo.system?.details?.xp?.value ?? "—",
          }
        : null,
      ultimaSincroniaProgresso: tracker.progresso?.ultimaSincroniaFormatada?.() ?? null,
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find('[data-action="alternar-gravacao"]').on("click", async () => {
      const tracker = game.mestreWeberSync;
      if (tracker.estaGravando()) await tracker.pausar();
      else await tracker.iniciar();
      this.render();
    });

    html.find('[data-action="nova-sessao"]').on("click", async () => {
      const confirmar = await Dialog.confirm({
        title: "Nova sessão",
        content: "<p>Isso zera os ataques/cura recebida registrados por este módulo (o Combat Stats — PF2e não é afetado). Continuar?</p>",
      });
      if (!confirmar) return;

      await game.mestreWeberSync.novaSessao();
      this.render();
    });

    html.find('[data-action="sincronizar"]').on("click", async (event) => {
      const botao = event.currentTarget;
      botao.disabled = true;

      const placar = game.mestreWeberSync.montarPlacar();
      const data = new Date().toISOString().slice(0, 10);

      const resultado = await sincronizarEstatisticas(data, placar);

      botao.disabled = false;

      if (!resultado.ok) {
        ui.notifications.error(`Mestre Weber Sync | ${resultado.erro}`);
        return;
      }

      for (const aviso of resultado.avisos) ui.notifications.warn(`Mestre Weber Sync | ${aviso}`);

      ui.notifications.info(`Mestre Weber Sync | Sincronizado: ${resultado.sessaoUrl}`);
    });

    html.find('[data-action="sincronizar-progresso"]').on("click", async (event) => {
      const botao = event.currentTarget;
      botao.disabled = true;

      await game.mestreWeberSync.progresso.sincronizarAgora();

      botao.disabled = false;
      this.render();
    });
  }

  // A cada re-render o placar pode ter mudado (novo ataque, nova cura) — o
  // FormApplication.render padrão já cobre isso, não precisa de setInterval.
  async _updateObject() {}
}
