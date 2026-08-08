import { MODULE_ID } from "./api.js";
import { MapeamentoApp } from "./mapeamento.js";
import { registrarProtecaoNivelXp } from "./protecaoNivelXp.js";
import { ProgressoSync } from "./progresso.js";
import { RegistroTracker } from "./registro.js";
import { HudApp } from "./hud.js";

// Precisa rodar em TODOS os clientes (jogadores incluídos), não só no do
// mestre — a checagem `game.user.isGM` acontece dentro do próprio hook.
registrarProtecaoNivelXp();

Hooks.once("init", () => {
  const hidden = { scope: "world", config: false };

  game.settings.register(MODULE_ID, "mestreWeberUrl", {
    scope: "world",
    config: true,
    type: String,
    default: "http://mestre-weber.test",
    name: game.i18n.localize("MWS.Settings.Url.Name"),
    hint: game.i18n.localize("MWS.Settings.Url.Hint"),
    restricted: true,
  });

  game.settings.register(MODULE_ID, "mestreWeberToken", {
    scope: "world",
    config: true,
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
  game.settings.register(MODULE_ID, "gravando", { ...hidden, type: Boolean, default: false });
  game.settings.register(MODULE_ID, "registroAtaques", { ...hidden, type: Object, default: {} });
  // 0 = "nunca definido" — Number como tipo de setting não lida bem com
  // default null, então usamos 0 como sentinela (registro.js trata isso).
  game.settings.register(MODULE_ID, "sessionStart", { ...hidden, type: Number, default: 0 });

  game.settings.registerMenu(MODULE_ID, "mapeamentoMenu", {
    name: game.i18n.localize("MWS.Menu.Mapeamento.Name"),
    label: game.i18n.localize("MWS.Menu.Mapeamento.Label"),
    hint: game.i18n.localize("MWS.Menu.Mapeamento.Hint"),
    icon: "fa-solid fa-link",
    type: MapeamentoApp,
    restricted: true,
  });
});

Hooks.once("ready", () => {
  if (!game.user.isGM) return;

  game.mestreWeberSync = new RegistroTracker();
  game.mestreWeberSync.init();

  game.mestreWeberSync.progresso = new ProgressoSync();
  game.mestreWeberSync.progresso.init();

  console.log("Mestre Weber Sync | Pronto.");
});

Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;

  const entries = Object.entries(controls);
  let anchorIdx = entries.findIndex(([chave]) => chave === "combat-stats");
  if (anchorIdx === -1) anchorIdx = entries.length - 1;

  const nossaEntrada = ["mestre-weber-sync", {
    name: "mestre-weber-sync",
    title: game.i18n.localize("MWS.SceneControl.Title"),
    icon: "fa-solid fa-satellite-dish",
    visible: true,
    tools: {
      "open-hud": {
        name: "open-hud",
        title: game.i18n.localize("MWS.SceneControl.Title"),
        icon: "fa-solid fa-satellite-dish",
        button: true,
        onClick: () => {
          const existente = Object.values(ui.windows ?? {}).find((janela) => janela.constructor?.name === "HudApp");
          if (existente) existente.bringToFront?.() ?? existente.bringToTop?.();
          else new HudApp().render(true);
        },
      },
    },
  }];

  const antes = entries.slice(0, anchorIdx + 1);
  const depois = entries.slice(anchorIdx + 1);
  const reordenado = [...antes, nossaEntrada, ...depois];
  for (const chave of Object.keys(controls)) delete controls[chave];
  for (const [chave, valor] of reordenado) controls[chave] = valor;
});
