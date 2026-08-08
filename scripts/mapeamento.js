import { MODULE_ID, buscarPersonagens } from "./api.js";

/**
 * Menu de configuração do módulo: URL + token do mestre-weber, e o
 * mapeamento de cada Actor do tipo "character" do mundo pra um
 * personagem_id do mestre-weber. O mapeamento fica só aqui (world setting)
 * — o mestre-weber nunca sabe o id do Actor do Foundry, só recebe o
 * personagem_id já resolvido.
 */
export class MapeamentoApp extends FormApplication {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "mws-mapeamento",
      title: "Mestre Weber — Configuração",
      template: "modules/mestre-weber-sync/templates/mapeamento.hbs",
      width: 480,
      height: "auto",
      closeOnSubmit: false,
      submitOnChange: false,
    });
  }

  async getData() {
    const resultado = await buscarPersonagens();

    const mapa = game.settings.get(MODULE_ID, "mapeamentoAtores") ?? {};
    const atoresPersonagem = game.actors
      .filter((ator) => ator.type === "character")
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((ator) => ({ id: ator.id, nome: ator.name, personagemId: mapa[ator.id] ?? "" }));

    const campanha = resultado.ok ? resultado.campanha : null;

    return {
      url: game.settings.get(MODULE_ID, "mestreWeberUrl") ?? "",
      token: game.settings.get(MODULE_ID, "mestreWeberToken") ?? "",
      atores: atoresPersonagem,
      personagens: resultado.ok ? resultado.personagens : [],
      erro: resultado.ok ? null : resultado.erro,
      // A campanha só usa "um Actor representa o grupo inteiro" quando NÃO
      // tem nível/XP individual ligado — com individual ligado, cada
      // personagem já tem sua própria linha na tabela de cima.
      mostrarProgressoGrupo: Boolean(campanha && !campanha.nivelIndividualAtivo),
      nomeGrupo: campanha ? campanha.nomeGrupo || campanha.nome : "",
      atorGrupoAtual: game.settings.get(MODULE_ID, "atorGrupo") ?? "",
    };
  }

  async _updateObject(event, formData) {
    const dados = foundry.utils.expandObject(formData);

    await game.settings.set(MODULE_ID, "mestreWeberUrl", (dados.url ?? "").trim());
    await game.settings.set(MODULE_ID, "mestreWeberToken", (dados.token ?? "").trim());

    const mapa = {};
    for (const [actorId, personagemId] of Object.entries(dados.ator ?? {})) {
      if (personagemId) mapa[actorId] = Number(personagemId);
    }
    await game.settings.set(MODULE_ID, "mapeamentoAtores", mapa);
    await game.settings.set(MODULE_ID, "atorGrupo", dados.atorGrupo ?? "");

    ui.notifications.info("Mestre Weber Sync | Configuração salva.");
    this.render();
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find('[data-action="atualizar-lista"]').on("click", () => this.render());
  }
}
