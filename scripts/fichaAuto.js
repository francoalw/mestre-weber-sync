import { MODULE_ID, enviarFichaFoundry } from "./api.js";

/**
 * Ficha automática: sempre que um ator mapeado muda no Foundry (subiu de
 * nível, pegou talento, trocou de arma, levou dano, ganhou uma condição),
 * a ficha dele vai pro site sozinha, alguns segundos depois — com os
 * números já calculados pelo sistema pf2e/sf2e, então o site mostra
 * exatamente o que a mesa vê. Só o sentido Foundry → site; o contrário
 * continua sendo o "Importar do mestre-weber", manual.
 *
 * Roda só no cliente do Mestre. Cada envio só acontece se a ficha mudou
 * desde o último (comparando o JSON), então rolar dados ou mexer no token
 * não gera tráfego.
 */

const ESPERA_MS = 4000;
const S_ATIVO = "fichaAutomatica";

const agendados = new Map(); // actorId → timeout
const ultimoEnviado = new Map(); // actorId → JSON da última ficha enviada

const cfg = () => CONFIG.PF2E ?? {};
const traduzir = (chave) => (chave ? game.i18n.localize(chave) : "");
const rotulo = (mapa, slug) => traduzir(mapa?.[slug]) || slug;

function personagemDoAtor(actorId) {
  const mapa = game.settings.get(MODULE_ID, "mapeamentoAtores") ?? {};
  return mapa[actorId] ?? null;
}

/** "Compendium.pf2e.feats-srd.Item.<id>" => "<id>" */
function idDeOrigem(item) {
  const uuid = item._stats?.compendiumSource ?? item.sourceId ?? item.flags?.core?.sourceId ?? "";
  const resultado = /\.Item\.([A-Za-z0-9]{16})$/.exec(uuid);
  return resultado ? resultado[1] : null;
}

const estatistica = (s) => (s ? { mod: Number(s.mod ?? s.totalModifier ?? 0), grau: Number(s.rank ?? 0) } : null);

function acoesDoItem(item) {
  const tipo = item.system?.actionType?.value;
  if (tipo === "reaction" || tipo === "free") return tipo;
  if (tipo === "action") return String(item.system?.actions?.value ?? 1);
  return null;
}

async function ataques(ator) {
  const golpes = (ator.system?.actions ?? []).filter((a) => a?.type === "strike" && a.visible !== false);
  const lista = [];

  for (const golpe of golpes) {
    let dano = null;
    try {
      dano = (await golpe.damage?.({ getFormula: true }))?.toString() ?? null;
    } catch {
      /* golpe sem dano calculável (ex.: escudo sem arma) */
    }

    lista.push({
      nome: golpe.label ?? golpe.item?.name ?? "Golpe",
      // "+15", "+10 (MAP -5)" → "+15", "+10"
      acertos: (golpe.variants ?? []).map((v) => String(v.label ?? "").replace(/\s*\(.*\)\s*$/, "")).filter(Boolean),
      dano,
      tracos: (golpe.traits ?? []).map((t) => t.label ? traduzir(t.label) : String(t.name ?? t)).filter(Boolean),
    });
  }

  return lista;
}

async function conjuracao(ator) {
  const colecoes = ator.spellcasting?.collections ? [...ator.spellcasting.collections.values()] : [];
  const entradas = [];

  for (const colecao of colecoes) {
    const entrada = colecao.entry;
    if (!entrada) continue;

    try {
      const dados = await entrada.getSheetData({ spells: colecao });
      const circulos = (dados.groups ?? [])
        .map((grupo) => ({
          circulo: grupo.id === "cantrips" ? 0 : Number(grupo.id) || 0,
          rotulo: String(grupo.label ?? ""),
          magias: [...new Set((grupo.active ?? []).filter(Boolean).map((a) => a.spell?.name ?? a.name).filter(Boolean))],
        }))
        .filter((c) => c.magias.length > 0);

      if (!circulos.length) continue;

      entradas.push({
        nome: entrada.name,
        tradicao: entrada.tradition ? rotulo(cfg().magicTraditions, entrada.tradition) : null,
        cd: entrada.statistic?.dc?.value ?? null,
        ataque: entrada.statistic?.check?.mod ?? null,
        circulos,
      });
    } catch (erro) {
      console.warn(`Mestre Weber Sync | Não consegui ler a conjuração "${entrada.name}" de ${ator.name}`, erro);
    }
  }

  return entradas;
}

// Categorias que a ficha do Foundry sempre lista, mesmo destreinadas.
const ATAQUES_BASE = ["unarmed", "simple", "martial", "advanced"];
const DEFESAS_BASE = ["unarmored", "light", "medium", "heavy"];

function nomeProficiencia(slug, p, categorias) {
  if (p.label) return traduzir(p.label);
  if (categorias?.[slug]) return traduzir(categorias[slug]);
  const grupo = /^weapon-group-(.+)$/.exec(slug)?.[1];
  if (grupo) return rotulo(cfg().weaponGroups, grupo);
  const base = /^weapon-base-(.+)$/.exec(slug)?.[1];
  if (base) return rotulo(cfg().baseWeaponTypes?.[base] ? cfg().baseWeaponTypes : cfg().baseShieldTypes, base);
  return slug;
}

/** Proficiências de arma/armadura (com ordem: as de sempre primeiro, depois as extras). */
function listaProficiencias(mapa, base, categorias) {
  return Object.entries(mapa ?? {})
    .filter(([slug, p]) => p && p.visible !== false && (base.includes(slug) || Number(p.rank ?? 0) > 0))
    .map(([slug, p]) => ({ slug, nome: nomeProficiencia(slug, p, categorias), grau: Number(p.rank ?? 0) }))
    .sort((a, b) => {
      const ia = base.indexOf(a.slug), ib = base.indexOf(b.slug);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.nome.localeCompare(b.nome, "pt-BR");
    });
}

function proficiencias(ator) {
  const p = ator.system?.proficiencies;
  if (!p) return null;
  return {
    armas: listaProficiencias(p.attacks, ATAQUES_BASE, cfg().weaponCategories),
    armaduras: listaProficiencias(p.defenses, DEFESAS_BASE, cfg().armorCategories),
    magia: p.spellcasting ? Number(p.spellcasting.rank ?? 0) : null,
  };
}

/**
 * Nome do item que concedeu o talento (Grant Item): uma característica de
 * classe, outro talento, herança ou antecedente. Classe e ancestralidade
 * ficam de fora — elas concedem as próprias características, e isso só
 * repetiria o óbvio.
 */
function concedidoPor(ator, item) {
  const id = item.flags?.pf2e?.grantedBy?.id;
  const origem = id ? ator.items.get(id) : null;
  if (!origem || ["class", "ancestry"].includes(origem.type)) return null;
  return origem.name;
}

/** A ficha do ator no formato que o site mostra (FichaFoundry). */
export async function montarFicha(ator) {
  const sistema = ator.system ?? {};
  const pv = ator.hitPoints ?? sistema.attributes?.hp ?? {};
  const recursos = sistema.resources ?? {};
  const velocidades = sistema.movement?.speeds ?? {};

  const pericias = Object.entries(ator.skills ?? {})
    .map(([slug, s]) => ({
      slug,
      nome: traduzir(s.label) || slug,
      mod: Number(s.mod ?? 0),
      grau: Number(s.rank ?? 0),
      conhecimento: Boolean(s.lore),
    }))
    .sort((a, b) => Number(a.conhecimento) - Number(b.conhecimento) || a.nome.localeCompare(b.nome, "pt-BR"));

  return {
    versao: 1,
    jogo: game.system.id,
    nivel: Number(ator.level ?? sistema.details?.level?.value ?? 0),
    ancestralidade: ator.ancestry?.name ?? null,
    heranca: ator.heritage?.name ?? null,
    antecedente: ator.background?.name ?? null,
    classe: ator.class?.name ?? null,
    tamanho: ator.size ?? null,
    tracos: (sistema.traits?.value ?? []).map((t) => rotulo(cfg().creatureTraits, t)),
    pv: { valor: Number(pv.value ?? 0), max: Number(pv.max ?? 0), temp: Number(pv.temp ?? 0) },
    ca: ator.armorClass?.value ?? sistema.attributes?.ac?.value ?? null,
    percepcao: estatistica(ator.perception),
    cdClasse: ator.classDC ? { cd: Number(ator.classDC.dc?.value ?? 0), grau: Number(ator.classDC.rank ?? 0) } : null,
    heroismo: recursos.heroPoints?.max > 0 ? { valor: Number(recursos.heroPoints.value ?? 0), max: Number(recursos.heroPoints.max) } : null,
    foco: recursos.focus?.max > 0 ? { valor: Number(recursos.focus.value ?? 0), max: Number(recursos.focus.max) } : null,
    atributos: Object.fromEntries(Object.entries(ator.abilities ?? {}).map(([a, v]) => [a, Number(v?.mod ?? 0)])),
    salvamentos: Object.fromEntries(
      ["fortitude", "reflex", "will"].map((s) => [s, estatistica(ator.saves?.[s])]).filter(([, v]) => v),
    ),
    pericias,
    proficiencias: proficiencias(ator),
    deslocamentos: Object.entries(velocidades)
      .filter(([, v]) => v && Number(v.value) > 0)
      .map(([tipo, v]) => ({ tipo, valor: Number(v.value) })),
    sentidos: (sistema.perception?.senses ?? []).map((s) => {
      const nome = s.label ? traduzir(s.label) : rotulo(cfg().senses, s.type);
      return s.range && Number.isFinite(s.range) ? `${nome} ${s.range} ft` : nome;
    }),
    idiomas: (sistema.details?.languages?.value ?? []).map((l) => rotulo(cfg().languages, l)),
    ataques: await ataques(ator),
    conjuracao: await conjuracao(ator),
    talentos: (ator.itemTypes?.feat ?? []).map((t) => ({
      nome: t.name,
      nivel: t.system?.level?.taken ?? t.system?.level?.value ?? null,
      categoria: t.system?.category ?? null,
      origem: idDeOrigem(t),
      acoes: acoesDoItem(t),
      tracos: (t.system?.traits?.value ?? []).map((tr) => rotulo(cfg().featTraits, tr)),
      concedidoPor: concedidoPor(ator, t),
    })),
    inventario: (ator.inventory?.contents ?? [])
      .filter((i) => i.type !== "treasure" || i.isEquipped)
      .map((i) => ({ nome: i.name, quantidade: Number(i.quantity ?? 1), equipado: Boolean(i.isEquipped), tipo: i.type })),
    condicoes: (ator.itemTypes?.condition ?? [])
      .filter((c) => c.active !== false)
      .map((c) => ({ nome: c.name, valor: c.value ?? null })),
  };
}

async function enviar(ator) {
  const personagemId = personagemDoAtor(ator.id);
  if (!personagemId) return;

  let ficha;
  try {
    ficha = await montarFicha(ator);
  } catch (erro) {
    console.error(`Mestre Weber Sync | Falha ao montar a ficha de ${ator.name}`, erro);
    return;
  }

  const json = JSON.stringify(ficha);
  if (ultimoEnviado.get(ator.id) === json) return;

  const resultado = await enviarFichaFoundry(personagemId, ficha);
  if (resultado.ok) ultimoEnviado.set(ator.id, json);
  else console.warn(`Mestre Weber Sync | Ficha de ${ator.name} não foi pro site: ${resultado.erro}`);
}

/** Envia a ficha do ator daqui a alguns segundos (junta mudanças em sequência). */
export function agendarFicha(ator) {
  if (!game.user.isGM || ator?.type !== "character") return;
  if (!game.settings.get(MODULE_ID, S_ATIVO)) return;
  if (!personagemDoAtor(ator.id)) return;

  clearTimeout(agendados.get(ator.id));
  agendados.set(
    ator.id,
    setTimeout(() => {
      agendados.delete(ator.id);
      enviar(ator);
    }, ESPERA_MS),
  );
}

export function registrarFichaAutomatica() {
  Hooks.once("init", () => {
    game.settings.register(MODULE_ID, S_ATIVO, {
      scope: "world",
      config: true,
      type: Boolean,
      default: true,
      name: game.i18n.localize("MWS.Settings.FichaAutomatica.Name"),
      hint: game.i18n.localize("MWS.Settings.FichaAutomatica.Hint"),
      restricted: true,
    });
  });

  Hooks.once("ready", () => {
    if (!game.user.isGM) return;
    // Na abertura do mundo, manda a ficha de todo ator mapeado (só vai o que
    // mudou desde que o site recebeu por último, porque o próprio site não
    // guarda nada aqui — na primeira vez, vão todos).
    for (const ator of game.actors.filter((a) => a.type === "character")) agendarFicha(ator);
  });

  Hooks.on("updateActor", (ator) => agendarFicha(ator));

  const doItem = (item) => {
    if (item.parent instanceof Actor) agendarFicha(item.parent);
  };
  Hooks.on("createItem", doItem);
  Hooks.on("updateItem", doItem);
  Hooks.on("deleteItem", doItem);
}
