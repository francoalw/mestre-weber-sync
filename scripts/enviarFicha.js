import { MODULE_ID, buscarPersonagens, enviarFichaPf2e } from "./api.js";

/**
 * "Enviar pro mestre-weber": o caminho inverso do "Importar do mestre-weber"
 * (`importarFicha.js`). Serializa o ator como está no Foundry e manda pro
 * site, pra um personagem que já existe ou pra um novo. Lá a ficha fica
 * pendente no construtor, que a converte em build (resources/js/lib/pf2e/
 * importarFoundry.ts no mestre-weber) pra ser conferida e salva.
 *
 * Aqui só se lê o ator, nada nele muda.
 */

/** Tipos de item que o construtor do site entende. */
const TIPOS_ENVIADOS = new Set([
  "ancestry",
  "heritage",
  "background",
  "class",
  "feat",
  "lore",
  "deity",
  "weapon",
  "armor",
  "shield",
  "action",
]);

/** Flags do sistema: o pf2e grava em flags.pf2e, o sf2e em flags.sf2e. */
function flagsDoSistema(item) {
  return item?._source?.flags?.[game.system.id] ?? item?.flags?.[game.system.id] ?? {};
}

/** "Compendium.pf2e.feats-srd.Item.<id ou nome>" => "<id ou nome>" */
function cauda(uuid) {
  const resultado = /\.Item\.(.+)$/.exec(uuid ?? "");
  return resultado ? resultado[1] : null;
}

function serializarItem(item) {
  const fonte = item._source?.system ?? {};
  const flags = flagsDoSistema(item);

  const dados = {
    id: item.id,
    origem: cauda(item._stats?.compendiumSource ?? item.sourceId ?? item.flags?.core?.sourceId),
    nome: item._source?.name ?? item.name,
    slug: fonte.slug ?? null,
    tipo: item.type,
    categoria: typeof fonte.category === "string" ? fonte.category : null,
    local: typeof fonte.location === "string" ? fonte.location : null,
    concedidoPor: flags.grantedBy?.id ?? null,
    selecoes: flags.rulesSelections ?? null,
    // O pf2e também grava a escolha na própria regra (system.rules[i].selection)
    // — em itens mais antigos, só lá
    regras: (fonte.rules ?? [])
      .map((regra, indice) => ({ indice, chave: regra?.key, flag: regra?.flag ?? null, selecao: regra?.selection }))
      .filter((r) => r.chave === "ChoiceSet" && r.selecao !== undefined && r.selecao !== null)
      .map(({ indice, flag, selecao }) => ({ indice, flag, selecao })),
  };

  if (item.type === "ancestry" || item.type === "background") {
    dados.aumentos = Object.fromEntries(Object.entries(fonte.boosts ?? {}).map(([chave, b]) => [chave, b?.selected ?? null]));
  }
  if (item.type === "ancestry") dados.alternativos = fonte.alternateAncestryBoosts ?? null;
  if (item.type === "class") dados.chave = fonte.keyAbility?.selected ?? null;

  if (["weapon", "armor", "shield"].includes(item.type)) {
    dados.equipado = {
      carryType: fonte.equipped?.carryType ?? null,
      inSlot: fonte.equipped?.inSlot ?? null,
      handsHeld: fonte.equipped?.handsHeld ?? null,
    };
    dados.runas = {
      potency: fonte.runes?.potency ?? 0,
      striking: fonte.runes?.striking ?? 0,
      resilient: fonte.runes?.resilient ?? 0,
    };
    dados.grau = fonte.grade ?? null;
  }

  if (item.type === "lore") dados.proficiencia = fonte.proficient?.value ?? 0;

  return dados;
}

/** O ator no formato que o construtor do site converte (AtorFoundry). */
export function serializarAtor(ator) {
  const sistema = ator._source?.system ?? {};

  const pericias = Object.fromEntries(
    Object.entries(sistema.skills ?? {}).map(([slug, pericia]) => [slug, Number(pericia?.rank ?? 0)]),
  );

  const itens = ator.items
    .filter((i) => TIPOS_ENVIADOS.has(i.type))
    .map(serializarItem);

  return {
    versao: 1,
    jogo: game.system.id,
    nome: ator.name,
    nivel: Number(sistema.details?.level?.value ?? ator.level ?? 1),
    xp: Number(sistema.details?.xp?.value ?? 0),
    aumentosNivel: sistema.build?.attributes?.boosts ?? {},
    pericias,
    idiomas: sistema.details?.languages?.value ?? [],
    itens,
  };
}

const escapar = (texto) => foundry.utils.escapeHTML?.(String(texto)) ?? String(texto);

/** Pergunta pra qual personagem do site vai a ficha. `"novo"` = criar um. */
async function escolherDestino(ator, personagens, ligadoId) {
  const opcoes = [
    `<option value="novo">+ Criar novo personagem "${escapar(ator.name)}"</option>`,
    ...personagens.map(
      (p) => `<option value="${p.id}" ${p.id === ligadoId ? "selected" : ""}>${escapar(p.nome)} (nível ${p.nivel ?? "?"})</option>`,
    ),
  ].join("");

  return Dialog.prompt({
    title: "Enviar pro mestre-weber",
    content: `<p>Pra qual personagem do site vai a ficha de <strong>${escapar(ator.name)}</strong> (nível ${escapar(ator.level ?? "?")})?</p>
      <div class="form-group"><select name="personagem" style="width:100%">${opcoes}</select></div>
      <p>A ficha fica pendente no construtor do site: abra, confira e salve. A ficha que já estiver lá só é trocada quando você aplicar e salvar. Nada muda neste ator.</p>`,
    label: "Enviar",
    callback: (html) => (html[0] ?? html).querySelector('[name="personagem"]').value,
    rejectClose: false,
  });
}

/** Fluxo completo do botão: escolhe o destino, serializa e envia. */
export async function enviarFicha(ator) {
  if (!game.user.isGM || ator?.type !== "character") return;

  const lista = await buscarPersonagens();
  if (!lista.ok) {
    ui.notifications.error(`Mestre Weber Sync | ${lista.erro}`);
    return;
  }

  const mapa = game.settings.get(MODULE_ID, "mapeamentoAtores") ?? {};
  const ligadoId = mapa[ator.id] ? Number(mapa[ator.id]) : null;

  const destino = await escolherDestino(ator, lista.personagens, ligadoId);
  if (!destino) return;

  const personagemId = destino === "novo" ? null : Number(destino);

  ui.notifications.info(`Mestre Weber Sync | Enviando ${ator.name}...`);

  const resultado = await enviarFichaPf2e(personagemId, ator.name, serializarAtor(ator));
  if (!resultado.ok) {
    ui.notifications.error(`Mestre Weber Sync | ${resultado.erro}`);
    return;
  }

  // Liga o ator ao personagem (nível/XP, estatísticas e o "Importar")
  if (mapa[ator.id] !== resultado.personagemId) {
    await game.settings.set(MODULE_ID, "mapeamentoAtores", { ...mapa, [ator.id]: resultado.personagemId });
  }

  ChatMessage.create({
    whisper: ChatMessage.getWhisperRecipients("GM"),
    speaker: { alias: "Mestre Weber Sync" },
    content: `<p><strong>${escapar(ator.name)}</strong> enviado pro site${resultado.criado ? ` como personagem novo (${escapar(resultado.nome)})` : ` (${escapar(resultado.nome)})`}.</p>
      <p><a href="${escapar(resultado.url)}" target="_blank" rel="noopener">Abrir o construtor</a> pra conferir e salvar a ficha.</p>`,
  });
  ui.notifications.info(`Mestre Weber Sync | ${ator.name} enviado — abra o construtor no site pra conferir e salvar (link no chat).`);
}

/** Ator da entrada do menu de contexto da aba de Atores. */
function atorDaEntrada(li) {
  const elemento = li?.[0] ?? li;
  const id = elemento?.dataset?.entryId ?? elemento?.dataset?.documentId ?? elemento?.dataset?.actorId;
  return id ? game.actors.get(id) : null;
}

/** Opção no menu de botão direito dos atores de personagem (só o Mestre vê). */
export function registrarBotaoEnviar() {
  Hooks.on("getActorContextOptions", (_app, opcoes) => {
    opcoes.push({
      name: "Enviar pro mestre-weber",
      icon: '<i class="fa-solid fa-file-export"></i>',
      condition: (li) => game.user.isGM && atorDaEntrada(li)?.type === "character",
      callback: (li) => enviarFicha(atorDaEntrada(li)),
    });
  });
}
