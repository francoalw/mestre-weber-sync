import { MODULE_ID } from "./api.js";

/**
 * HUD do mestre: nível/XP dos personagens mapeados (e do ator do grupo),
 * com o botão de forçar a sincronização. Outros módulos podem acrescentar
 * conteúdo pelo hook `renderHudApp` — por isso o id `mws-hud` e o nome da
 * classe são estáveis.
 */
export class HudApp extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "mws-hud",
      title: "Mestre Weber — Sync",
      template: "modules/mestre-weber-sync/templates/hud.hbs",
      width: 620,
      height: "auto",
      closeOnSubmit: false,
      submitOnChange: false,
      resizable: true,
    });
  }

  getData() {
    const mapa = game.settings.get(MODULE_ID, "mapeamentoAtores") ?? {};

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
      progresso,
      semProgresso: progresso.length === 0,
      grupo: atorGrupo
        ? {
            nome: atorGrupo.name,
            nivel: atorGrupo.system?.details?.level?.value ?? "—",
            xp: atorGrupo.system?.details?.xp?.value ?? "—",
          }
        : null,
      ultimaSincroniaProgresso: game.mestreWeberSync?.progresso?.ultimaSincroniaFormatada?.() ?? null,
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find('[data-action="sincronizar-progresso"]').on("click", async (event) => {
      const botao = event.currentTarget;
      botao.disabled = true;

      await game.mestreWeberSync.progresso.sincronizarAgora();

      botao.disabled = false;
      this.render();
    });
  }

  async _updateObject() {}
}
