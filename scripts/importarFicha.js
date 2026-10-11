import { MODULE_ID, buscarFichaPf2e, buscarPersonagens } from "./api.js";

/**
 * "Importar do mestre-weber": monta o Actor de Pathfinder 2e a partir da
 * ficha salva no construtor do site (`/api/foundry/personagens/{id}/ficha-pf2e`,
 * gerada por resources/js/lib/pf2e/exportarFoundry.ts no mestre-weber).
 *
 * Os itens vêm do compêndio do próprio pf2e (o site usa os mesmos ids). As
 * escolhas de regra (ChoiceSet) são respondidas sozinhas: enquanto a
 * importação roda, o `preCreate` do ChoiceSet é interceptado e recebe a
 * pré-seleção vinda do site — inclusive nos itens concedidos em cascata
 * (Portal Cinético → elemento → impulso), que o pf2e clona direto do
 * compêndio. Escolha que não casar cai no diálogo normal do sistema.
 */

/** Packs de cada sistema onde moram os itens que o construtor usa. */
const PACOTES = {
  pf2e: [
    "ancestries",
    "heritages",
    "backgrounds",
    "classes",
    "feats-srd",
    "classfeatures",
    "ancestryfeatures",
    "equipment-srd",
    "deities",
    "actionspf2e",
    "spells-srd",
  ],
  // No sf2e o pack tem o nome da pasta
  sf2e: [
    "ancestries",
    "heritages",
    "backgrounds",
    "classes",
    "feats",
    "class-features",
    "ancestry-features",
    "equipment",
    "deities",
    "actions",
    "spells",
  ],
};

/**
 * Graus do Starfinder 2e (armas e armaduras tech/analog), equivalentes às
 * runas fundamentais — mesma tabela do construtor (GRAUS_SF2E).
 */
const GRAUS_SF2E = [
  { slug: "commercial", potencia: 0, segundo: 0 },
  { slug: "tactical", potencia: 1, segundo: 0 },
  { slug: "advanced", potencia: 1, segundo: 1 },
  { slug: "superior", potencia: 2, segundo: 1 },
  { slug: "elite", potencia: 2, segundo: 2 },
  { slug: "ultimate", potencia: 3, segundo: 2 },
  { slug: "paragon", potencia: 3, segundo: 3 },
];

/** Flags do sistema: o pf2e grava em flags.pf2e, o sf2e em flags.sf2e. */
function flagsDoSistema(documento) {
  return documento?._source?.flags?.[game.system.id] ?? documento?.flags?.[game.system.id] ?? {};
}

/** Tipos de item que a ficha do site define — trocados a cada importação. */
const TIPOS_DA_FICHA = new Set(["ancestry", "heritage", "background", "class", "feat", "lore", "deity"]);

const cacheUuid = new Map();

async function uuidDoId(id) {
  if (cacheUuid.has(id)) return cacheUuid.get(id);

  const sistema = game.system.id;
  const packs = [
    ...(PACOTES[sistema] ?? []).map((nome) => game.packs.get(`${sistema}.${nome}`)),
    // Num mundo de Starfinder, o conteúdo do Pathfinder (que o construtor
    // também oferece) vem do módulo oficial pf2e-anachronism
    ...game.packs.filter((p) => p.documentName === "Item" && p.metadata.packageName === "pf2e-anachronism"),
    // Conteúdo do playtest do Starfinder (módulo starfinder-field-test-for-pf2e)
    ...game.packs.filter((p) => p.documentName === "Item" && p.metadata.packageName === "starfinder-field-test-for-pf2e"),
  ].filter(Boolean);

  for (const pack of packs) {
    const indice = pack.index.size ? pack.index : await pack.getIndex();
    if (indice.has(id)) {
      const uuid = `Compendium.${pack.collection}.Item.${id}`;
      cacheUuid.set(id, uuid);
      return uuid;
    }
  }

  cacheUuid.set(id, null);
  return null;
}

/** Source pronta pra criar no ator (sem _id, com compendiumSource). */
async function fonteDoCompendio(id) {
  const uuid = await uuidDoId(id);
  const documento = uuid ? await fromUuid(uuid) : null;
  if (!documento) return null;

  const fonte = game.items.fromCompendium(documento, { keepId: false });
  fonte._stats ??= {};
  fonte._stats.compendiumSource = uuid;
  fonte.flags ??= {};
  fonte.flags[MODULE_ID] = { importado: true };

  return fonte;
}

/** "Compendium.pf2e.classfeatures.Item.<id ou nome>" => "<id ou nome>" */
function cauda(uuid) {
  const resultado = /\.Item\.(.+)$/.exec(uuid ?? "");
  return resultado ? resultado[1] : null;
}

function origemDoItem(item) {
  return cauda(item?.sourceId ?? item?._stats?.compendiumSource ?? item?._source?._stats?.compendiumSource);
}

/** Itens que concederam este (do mais distante ao pai) e o item raiz. */
function linhagem(item, tempItems, ator) {
  const ancestrais = [];
  let atual = item;

  for (let guarda = 0; atual && guarda < 12; guarda++) {
    let pai = atual.grantedBy ?? null;

    if (!pai) {
      const idPai = flagsDoSistema(atual).grantedBy?.id;
      pai = idPai ? (tempItems.find((i) => i.id === idPai || i._source?._id === idPai) ?? ator.items.get(idPai)) : null;
    }

    if (!pai) break;

    ancestrais.unshift(pai);
    atual = pai;
  }

  return { ancestrais, raiz: atual };
}

/** A escolha exportada pelo site que corresponde a esta regra, se houver. */
function acharEscolha(regra, args, sessao) {
  const item = regra.item;
  const origem = origemDoItem(item);
  const nome = item._source?.name ?? item.name;

  const candidatas = sessao.escolhas.filter(
    (e) =>
      !e.usada &&
      (e.item === origem || e.nome === origem || e.nome === nome) &&
      (e.regra === regra.sourceIndex || (e.flag && e.flag === regra.flag)),
  );

  if (candidatas.length <= 1) return candidatas[0] ?? null;

  // Mesmo item com a mesma regra mais de uma vez (talento repetível,
  // característica concedida duas vezes): desempata pela linhagem.
  const { ancestrais, raiz } = linhagem(item, args.tempItems ?? [], regra.actor);
  const origensAncestrais = ancestrais.map((a) => origemDoItem(a));
  const nomesAncestrais = ancestrais.map((a) => a._source?.name ?? a.name);

  const pontuar = (e) =>
    (e.regra === regra.sourceIndex ? 4 : 0) +
    (e.local && raiz?.system?.location === e.local ? 3 : 0) +
    e.cadeia.filter((id) => origensAncestrais.includes(id) || nomesAncestrais.includes(id)).length;

  return [...candidatas].sort((a, b) => pontuar(b) - pontuar(a))[0];
}

function iguais(a, b) {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;

  return JSON.stringify(a) === JSON.stringify(b);
}

/** Valor da opção do pf2e equivalente ao que foi escolhido no site. */
async function valorParaRegra(regra, args, escolha) {
  const opcoesRolagem = new Set([regra.actor.getRollOptions(), regra.item.getRollOptions("parent")].flat());

  let opcoes = [];
  try {
    opcoes = await regra.inflateChoices(opcoesRolagem, args.tempItems ?? []);
  } catch (erro) {
    console.warn("Mestre Weber Sync | Não consegui listar as opções de", regra.item?.name, erro);
  }

  const valor = escolha.valor;
  let achada = null;

  if (escolha.tipo === "bruto") {
    achada = opcoes.find((o) => iguais(o.value, valor)) ?? opcoes.find((o) => String(o.value) === String(valor));
  } else if (escolha.tipo === "item") {
    achada = opcoes.find((o) => typeof o.value === "string" && cauda(o.value) === valor);
  } else if (escolha.tipo === "possuido") {
    achada = opcoes.find((o) => {
      const item = regra.actor.items.get(o.value) ?? (args.tempItems ?? []).find((i) => i.id === o.value);
      return origemDoItem(item) === valor;
    });
  } else {
    achada = opcoes.find((o) => String(o.value) === String(valor));
  }

  return achada ? achada.value : undefined;
}

/**
 * Intercepta o preCreate do ChoiceSet enquanto a importação roda. Devolve a
 * função que desfaz a interceptação.
 */
function responderEscolhas(sessao) {
  const ChoiceSet = game.pf2e?.RuleElements?.builtin?.ChoiceSet;
  if (!ChoiceSet) throw new Error("ChoiceSet do sistema pf2e não encontrado.");

  const original = ChoiceSet.prototype.preCreate;

  ChoiceSet.prototype.preCreate = async function (args) {
    if (this.selection !== null && this.selection !== undefined) {
      // Já pré-selecionada pelo próprio pf2e (preselectChoices de um
      // GrantItem, como o elemento do Gate Junction): só dá baixa.
      const escolha = acharEscolha(this, args, sessao);
      if (escolha) escolha.usada = true;
    } else {
      try {
        const escolha = acharEscolha(this, args, sessao);

        if (escolha) {
          const valor = await valorParaRegra(this, args, escolha);

          if (valor !== undefined) {
            escolha.usada = true;
            this.selection = valor;
          } else {
            sessao.semOpcao.push(escolha);
          }
        }
      } catch (erro) {
        console.error("Mestre Weber Sync | Falha ao responder escolha de", this.item?.name, erro);
      }
    }

    return original.call(this, args);
  };

  return () => {
    ChoiceSet.prototype.preCreate = original;
  };
}

function aplicarRunasEUso(fonte, dados, tipo) {
  fonte.system.runes ??= {};
  fonte.system.equipped ??= {};

  // Starfinder: arma/armadura tech ou analog tem grau, não runas fundamentais
  const tracos = fonte.system.traits?.value ?? [];
  const usaGrau =
    game.system.id === "sf2e" && (tipo === "armor" || tipo === "weapon") && (tracos.includes("tech") || tracos.includes("analog"));

  if (usaGrau) {
    const potencia = dados.potencia ?? 0;
    const segundo = (tipo === "armor" ? dados.resiliente : dados.golpe) ?? 0;
    const grau = [...GRAUS_SF2E].reverse().find((g) => potencia >= g.potencia && segundo >= g.segundo) ?? GRAUS_SF2E[0];

    fonte.system.grade = grau.slug;
    fonte.system.runes.potency = 0;
    if (tipo === "armor") fonte.system.runes.resilient = 0;
    else fonte.system.runes.striking = 0;
  }

  if (tipo === "armor") {
    if (!usaGrau) {
      fonte.system.runes.potency = dados.potencia ?? 0;
      fonte.system.runes.resilient = dados.resiliente ?? 0;
    }
    fonte.system.equipped.carryType = "worn";
    fonte.system.equipped.inSlot = true;
  } else if (tipo === "weapon") {
    if (!usaGrau) {
      fonte.system.runes.potency = dados.potencia ?? 0;
      fonte.system.runes.striking = dados.golpe ?? 0;
    }
    fonte.system.equipped.carryType = "held";
    fonte.system.equipped.handsHeld = fonte.system.usage?.value === "held-in-two-hands" ? 2 : 1;
  } else {
    fonte.system.equipped.carryType = "held";
    fonte.system.equipped.handsHeld = 1;
  }
}

/**
 * Aplica a ficha exportada no ator: troca ancestralidade, herança,
 * antecedente, classe, talentos e conhecimentos, e o equipamento que veio de
 * uma importação anterior. Inventário, magias e efeitos ficam.
 *
 * @returns {Promise<{avisos: string[]}>}
 */
export async function aplicarFicha(ator, ficha) {
  const avisos = [];
  const sessao = {
    escolhas: (ficha.escolhas ?? []).map((e) => ({ ...e, usada: false })),
    semOpcao: [],
  };

  const criar = async (fonte, rotulo) => {
    if (!fonte) {
      avisos.push(
        game.system.id === "sf2e"
          ? `Não achei no compêndio: ${rotulo} (se for do Pathfinder, ative o módulo pf2e-anachronism).`
          : `Não achei no compêndio do pf2e: ${rotulo}.`,
      );
      return;
    }
    await ator.createEmbeddedDocuments("Item", [fonte]);
  };

  // 1. Limpa o que a ficha do site define
  const apagar = ator.items
    .filter((i) => TIPOS_DA_FICHA.has(i.type) || i.flags?.[MODULE_ID]?.importado || flagsDoSistema(i).grantedBy)
    .map((i) => i.id);
  if (apagar.length) await ator.deleteEmbeddedDocuments("Item", apagar);

  // 2. Nível, aumentos de atributo, perícias e idiomas
  const aumentos = { 1: [], 5: [], 10: [], 15: [], 20: [] };
  for (const [nivel, atributos] of Object.entries(ficha.aumentosNivel ?? {})) aumentos[nivel] = atributos;

  const atualizacao = {
    "system.details.level.value": ficha.nivel,
    "system.build.attributes.manual": false,
    "system.build.attributes.boosts": aumentos,
    "system.details.languages.value": ficha.idiomas ?? [],
  };
  for (const [pericia, grau] of Object.entries(ficha.pericias ?? {})) {
    atualizacao[`system.skills.${pericia}.rank`] = grau;
  }
  await ator.update(atualizacao);

  const restaurar = responderEscolhas(sessao);

  try {
    // 3. Ancestralidade, herança, antecedente e classe (a classe já traz as
    //    características até o nível do ator)
    if (ficha.ancestralidade) {
      const fonte = await fonteDoCompendio(ficha.ancestralidade.id);
      if (fonte) {
        for (const [chave, atributo] of Object.entries(ficha.ancestralidade.aumentos ?? {})) {
          if (fonte.system.boosts?.[chave]) fonte.system.boosts[chave].selected = atributo;
        }
        if (ficha.ancestralidade.alternativos) fonte.system.alternateAncestryBoosts = ficha.ancestralidade.alternativos;
      }
      await criar(fonte, "ancestralidade");
    }

    if (ficha.heranca) await criar(await fonteDoCompendio(ficha.heranca), "herança");

    if (ficha.antecedente) {
      const fonte = await fonteDoCompendio(ficha.antecedente.id);
      if (fonte) {
        for (const [chave, atributo] of Object.entries(ficha.antecedente.aumentos ?? {})) {
          if (fonte.system.boosts?.[chave]) fonte.system.boosts[chave].selected = atributo;
        }
      }
      await criar(fonte, "antecedente");
    }

    if (ficha.classe) {
      const fonte = await fonteDoCompendio(ficha.classe.id);
      if (fonte && ficha.classe.chave) fonte.system.keyAbility.selected = ficha.classe.chave;
      await criar(fonte, "classe");
    }

    // 4. Equipamento antes dos talentos: tem escolha de "item que já tenho"
    //    (Verdant Weapon, ícones do exemplar)
    const equipamento = ficha.equipamento ?? {};
    const pecas = [
      ...(equipamento.armadura ? [[equipamento.armadura, "armor"]] : []),
      ...(equipamento.escudo ? [[equipamento.escudo, "shield"]] : []),
      ...(equipamento.armas ?? []).map((arma) => [arma, "weapon"]),
    ];
    for (const [dados, tipo] of pecas) {
      const fonte = await fonteDoCompendio(dados.id);
      if (fonte) aplicarRunasEUso(fonte, dados, tipo);
      await criar(fonte, `equipamento ${dados.id}`);
    }

    // 5. Talentos, um a um em ordem de nível (pré-requisitos e predicados
    //    dos posteriores dependem dos anteriores)
    const talentos = [...(ficha.talentos ?? [])].sort((a, b) => a.nivel - b.nivel);
    for (const talento of talentos) {
      const fonte = await fonteDoCompendio(talento.id);
      if (fonte) {
        fonte.system.location = talento.local;
        fonte.system.level = { ...(fonte.system.level ?? {}), taken: talento.nivel };
      }
      await criar(fonte, `talento ${talento.id}`);
    }
  } finally {
    restaurar();
  }

  // 6. Conhecimentos (Lore): atualiza os que o pf2e já criou, cria os outros
  for (const { nome, grau } of ficha.conhecimentos ?? []) {
    const nomeLore = /lore$/i.test(nome) ? nome : `${nome} Lore`;
    const existente = ator.itemTypes.lore.find((l) => l.name.toLowerCase() === nomeLore.toLowerCase());

    if (existente) {
      if ((existente.system.proficient?.value ?? 0) < grau) {
        await existente.update({ "system.proficient.value": grau });
      }
    } else {
      await ator.createEmbeddedDocuments("Item", [
        { name: nomeLore, type: "lore", system: { proficient: { value: grau } }, flags: { [MODULE_ID]: { importado: true } } },
      ]);
    }
  }

  for (const escolha of [...sessao.semOpcao, ...sessao.escolhas.filter((e) => !e.usada && !sessao.semOpcao.includes(e))]) {
    avisos.push(`Escolha não aplicada automaticamente: ${escolha.nome} (${JSON.stringify(escolha.valor)}).`);
  }

  return { avisos };
}

async function escolherPersonagem(ator) {
  const resultado = await buscarPersonagens();
  if (!resultado.ok) {
    ui.notifications.error(`Mestre Weber Sync | ${resultado.erro}`);
    return null;
  }

  const opcoes = resultado.personagens
    .map((p) => `<option value="${p.id}">${foundry.utils.escapeHTML?.(p.nome) ?? p.nome}</option>`)
    .join("");

  const personagemId = await Dialog.prompt({
    title: "Importar do mestre-weber",
    content: `<p>${ator.name} ainda não está ligado a um personagem do site. Qual é?</p>
      <div class="form-group"><select name="personagem" style="width:100%">${opcoes}</select></div>`,
    label: "Ligar e continuar",
    callback: (html) => Number((html[0] ?? html).querySelector('[name="personagem"]').value),
    rejectClose: false,
  });

  if (!personagemId) return null;

  const mapa = { ...(game.settings.get(MODULE_ID, "mapeamentoAtores") ?? {}), [ator.id]: personagemId };
  await game.settings.set(MODULE_ID, "mapeamentoAtores", mapa);

  return personagemId;
}

/**
 * Cópia do ator como está, antes da importação mexer nele, numa pasta de
 * atores "backup DD/MM/AAAA" (a do dia, criada se não existir). A cópia fica
 * só pro Mestre, pros jogadores não verem a ficha duplicada.
 */
async function fazerBackup(ator) {
  const agora = new Date();
  const doisDigitos = (n) => String(n).padStart(2, "0");
  const nomePasta = `backup ${doisDigitos(agora.getDate())}/${doisDigitos(agora.getMonth() + 1)}/${agora.getFullYear()}`;

  const pasta =
    game.folders.find((f) => f.type === "Actor" && f.name === nomePasta) ??
    (await Folder.create({ name: nomePasta, type: "Actor" }));

  const dados = ator.toObject();
  delete dados._id;
  dados.name = `${ator.name} (antes da importação ${doisDigitos(agora.getHours())}h${doisDigitos(agora.getMinutes())})`;
  dados.folder = pasta.id;
  dados.ownership = { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE };

  return Actor.create(dados);
}

/** Fluxo completo do botão: acha o personagem, busca a ficha, confirma e aplica. */
export async function importarFicha(ator) {
  if (!game.user.isGM || ator?.type !== "character") return;

  const mapa = game.settings.get(MODULE_ID, "mapeamentoAtores") ?? {};
  const personagemId = mapa[ator.id] ?? (await escolherPersonagem(ator));
  if (!personagemId) return;

  const resultado = await buscarFichaPf2e(personagemId);
  if (!resultado.ok) {
    ui.notifications.error(`Mestre Weber Sync | ${resultado.erro}`);
    return;
  }

  const jogoDaFicha = resultado.ficha.jogo ?? "pf2e";
  if (jogoDaFicha !== game.system.id) {
    const nomes = { pf2e: "Pathfinder 2e", sf2e: "Starfinder 2e" };
    ui.notifications.error(
      `Mestre Weber Sync | A ficha de ${resultado.nome} é de ${nomes[jogoDaFicha] ?? jogoDaFicha}, mas este mundo usa ${nomes[game.system.id] ?? game.system.id}.`,
    );
    return;
  }

  const confirmar = await Dialog.confirm({
    title: "Importar do mestre-weber",
    content: `<p>Montar <strong>${ator.name}</strong> com a ficha de <strong>${resultado.nome}</strong> (nível ${resultado.ficha.nivel}) salva no site?</p>
      <p>Ancestralidade, herança, antecedente, classe, talentos, conhecimentos, perícias, idiomas e aumentos de atributo serão substituídos, junto do equipamento de importações anteriores. Inventário, magias e efeitos ficam.</p>
      <p>Uma cópia do ator como está agora vai pra pasta de backup do dia.</p>`,
  });
  if (!confirmar) return;

  try {
    const copia = await fazerBackup(ator);
    ui.notifications.info(`Mestre Weber Sync | Backup salvo: ${copia.name} (pasta ${copia.folder?.name}).`);
  } catch (erro) {
    console.error("Mestre Weber Sync | Falha no backup", erro);
    ui.notifications.error(`Mestre Weber Sync | Não consegui fazer o backup de ${ator.name}, importação cancelada: ${erro.message}`);
    return;
  }

  ui.notifications.info(`Mestre Weber Sync | Importando ${resultado.nome}...`);

  try {
    const { avisos } = await aplicarFicha(ator, resultado.ficha);

    if (avisos.length) {
      ChatMessage.create({
        whisper: ChatMessage.getWhisperRecipients("GM"),
        speaker: { alias: "Mestre Weber Sync" },
        content: `<p><strong>${ator.name}</strong> importado, com ressalvas:</p><ul>${avisos.map((a) => `<li>${a}</li>`).join("")}</ul>`,
      });
      ui.notifications.warn(`Mestre Weber Sync | ${ator.name} importado com ${avisos.length} ressalva(s) — veja o chat.`);
    } else {
      ui.notifications.info(`Mestre Weber Sync | ${ator.name} importado.`);
    }
  } catch (erro) {
    console.error("Mestre Weber Sync | Falha na importação", erro);
    ui.notifications.error(`Mestre Weber Sync | Falha ao importar: ${erro.message}`);
  }
}

/** Ator da entrada do menu de contexto da aba de Atores. */
function atorDaEntrada(li) {
  const elemento = li?.[0] ?? li;
  const id = elemento?.dataset?.entryId ?? elemento?.dataset?.documentId ?? elemento?.dataset?.actorId;
  return id ? game.actors.get(id) : null;
}

/** Opção no menu de botão direito dos atores de personagem (só o Mestre vê). */
export function registrarBotaoImportar() {
  Hooks.on("getActorContextOptions", (_app, opcoes) => {
    opcoes.push({
      name: "Importar do mestre-weber",
      icon: '<i class="fa-solid fa-file-import"></i>',
      condition: (li) => game.user.isGM && atorDaEntrada(li)?.type === "character",
      callback: (li) => importarFicha(atorDaEntrada(li)),
    });
  });
}
