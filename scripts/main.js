import { MODULE_ID } from "./api.js";
import { MapeamentoApp } from "./mapeamento.js";
import { registrarProtecaoNivelXp } from "./protecaoNivelXp.js";
import { ProgressoSync } from "./progresso.js";
import { HudApp } from "./hud.js";
import { aplicarFicha, importarFicha, registrarBotaoImportar } from "./importarFicha.js";
import { enviarFicha, serializarAtor, registrarBotaoEnviar } from "./enviarFicha.js";
import { montarFicha, registrarFichaAutomatica } from "./fichaAuto.js";

// Precisa rodar em TODOS os clientes (jogadores incluídos), não só no do
// mestre — a checagem `game.user.isGM` acontece dentro do próprio hook.
registrarProtecaoNivelXp();
registrarBotaoImportar();
registrarBotaoEnviar();
registrarFichaAutomatica();

Hooks.once("init", () => {
  const hidden = { scope: "world", config: false };

  // URL e token ficam só na janela "Configurar" (MapeamentoApp), junto do
  // mapeamento — `config: false` pra não aparecerem de novo, soltos (e com o
  // token em texto aberto), na lista de configurações do módulo.
  game.settings.register(MODULE_ID, "mestreWeberUrl", {
    scope: "world",
    config: false,
    type: String,
    default: "http://mestre-weber.test",
    name: game.i18n.localize("MWS.Settings.Url.Name"),
    hint: game.i18n.localize("MWS.Settings.Url.Hint"),
    restricted: true,
  });

  game.settings.register(MODULE_ID, "mestreWeberToken", {
    scope: "world",
    config: false,
    type: String,
    default: "",
    name: game.i18n.localize("MWS.Settings.Token.Name"),
    hint: game.i18n.localize("MWS.Settings.Token.Hint"),
    restricted: true,
  });

  game.settings.register(MODULE_ID, "mapeamentoAtores", { ...hidden, type: Object, default: {} });
  // Actor único escolhido pelo mestre pra representar o nível/XP de todo o
  // grupo, usado só em campanhas que NÃO ligaram "Nível e XP individuais".
  game.settings.register(MODULE_ID, "atorGrupo", { ...hidden, type: String, default: "" });
  // Vínculos ator ↔ site que já mandaram o nível/XP do Foundry pro site pelo
  // menos uma vez. O pull (site → Foundry) só mexe num ator que está aqui —
  // ver `ProgressoSync`.
  game.settings.register(MODULE_ID, "vinculosConfirmados", { ...hidden, type: Object, default: {} });

  game.settings.registerMenu(MODULE_ID, "mapeamentoMenu", {
    name: game.i18n.localize("MWS.Menu.Mapeamento.Name"),
    label: game.i18n.localize("MWS.Menu.Mapeamento.Label"),
    hint: game.i18n.localize("MWS.Menu.Mapeamento.Hint"),
    icon: "fa-solid fa-link",
    type: MapeamentoApp,
    restricted: true,
  });

  // game.modules.get("mestre-weber-sync").api.importarFicha(actor)
  game.modules.get(MODULE_ID).api = { importarFicha, aplicarFicha, enviarFicha, serializarAtor, montarFicha };
});

Hooks.once("ready", () => {
  if (!game.user.isGM) return;

  game.mestreWeberSync = { progresso: new ProgressoSync() };
  game.mestreWeberSync.progresso.init();

  console.log("Mestre Weber Sync | Pronto.");
});

// Anexa nosso botão dentro do grupo "Token Controls" já existente, em vez
// de criar uma categoria própria — uma categoria nova sem um layer de canvas
// de verdade por trás deixava o Foundry num estado inconsistente ao ser
// selecionada (o efeito de "Alt preso" ao passar o mouse nos tokens). Mesmo
// padrão já usado pelos outros módulos mestre-weber-*.
Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;

  const tokenControls = controls.tokens;
  if (!tokenControls) return;

  const ordemBase = Object.keys(tokenControls.tools).length;

  tokenControls.tools.mwsOpenHud = {
    name: "mwsOpenHud",
    title: game.i18n.localize("MWS.SceneControl.Title"),
    icon: "fa-solid fa-satellite-dish",
    button: true,
    order: ordemBase,
    onClick: () => {
      const existente = Object.values(ui.windows ?? {}).find((janela) => janela instanceof HudApp);
      if (existente) existente.bringToFront?.() ?? existente.bringToTop?.();
      else new HudApp().render(true);
    },
  };
});
