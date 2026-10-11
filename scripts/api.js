export const MODULE_ID = "mestre-weber-sync";

const TIMEOUT_MS = 8000;

/**
 * Lê a URL/token configurados nas settings do módulo. Ambos ficam vazios até
 * o mestre preencher o menu de configurações (`mapeamento.js`).
 */
function credenciais() {
  const url = (game.settings.get(MODULE_ID, "mestreWeberUrl") ?? "").replace(/\/+$/, "");
  const token = game.settings.get(MODULE_ID, "mestreWeberToken") ?? "";
  return { url, token };
}

/**
 * `fetch` com timeout — sem isso, uma URL errada/inalcançável (ex.: mestre
 * digitou o endereço errado, ou o site caiu) deixaria o request pendurado
 * pelo tempo que o navegador demorar pra desistir sozinho (pode passar de
 * um minuto). Isso importa principalmente pro pull periódico de
 * `progresso.js`, que roda a cada 20s — sem um limite curto, requests
 * lentos poderiam se acumular (um novo começando antes do anterior falhar).
 */
async function fetchComTimeout(url, options) {
  const controlador = new AbortController();
  const timeoutId = setTimeout(() => controlador.abort(), TIMEOUT_MS);

  try {
    return await fetch(url, { ...options, signal: controlador.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function mensagemDeErro(erro, url) {
  if (erro.name === "AbortError") return `Tempo esgotado ao conectar em ${url}.`;
  return `Não foi possível conectar em ${url} (${erro.message}).`;
}

/**
 * Também usado pra puxar o nível/XP atual do site (`progresso.js`), não só
 * pra montar o mapeamento — cada personagem e a campanha já vêm com
 * `nivel`/`xp` atuais.
 *
 * @returns {Promise<{ok: true, personagens: Array<{id:number, nome:string, tipo:string|null, nivel:number, xp:number}>, campanha: {nome:string, nomeGrupo:string|null, nivelIndividualAtivo:boolean, nivel:number, xp:number}} | {ok:false, erro:string}>}
 */
export async function buscarPersonagens() {
  const { url, token } = credenciais();
  if (!url || !token) return { ok: false, erro: "Configure a URL e o token do mestre-weber primeiro." };

  try {
    const resposta = await fetchComTimeout(`${url}/api/foundry/personagens`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });

    if (!resposta.ok) return { ok: false, erro: `mestre-weber respondeu ${resposta.status}.` };

    const dados = await resposta.json();
    return {
      ok: true,
      personagens: dados.personagens ?? [],
      campanha: dados.campanha ?? { nome: "", nomeGrupo: null, nivelIndividualAtivo: false, nivel: null, xp: null },
    };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro, url) };
  }
}

/**
 * @param {Array<{personagem_id:number, nivel?:number, xp?:number}>} progresso
 * @returns {Promise<{ok:true, avisos:string[]} | {ok:false, erro:string}>}
 */
export async function sincronizarProgresso(progresso) {
  const { url, token } = credenciais();
  if (!url || !token) return { ok: false, erro: "Configure a URL e o token do mestre-weber primeiro." };

  try {
    const resposta = await fetchComTimeout(`${url}/api/foundry/personagens/progresso/sincronizar`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ progresso }),
    });

    if (!resposta.ok) {
      const corpo = await resposta.json().catch(() => null);
      const mensagem = corpo?.message ?? `mestre-weber respondeu ${resposta.status}.`;
      return { ok: false, erro: mensagem };
    }

    const dados = await resposta.json();
    return { ok: true, avisos: dados.avisos ?? [] };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro, url) };
  }
}

/**
 * @param {number|null} nivel
 * @param {number|null} xp
 * @returns {Promise<{ok:true, nivel:number, xp:number} | {ok:false, erro:string}>}
 */
export async function sincronizarProgressoGrupo(nivel, xp) {
  const { url, token } = credenciais();
  if (!url || !token) return { ok: false, erro: "Configure a URL e o token do mestre-weber primeiro." };

  try {
    const resposta = await fetchComTimeout(`${url}/api/foundry/campanha/progresso/sincronizar`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ nivel, xp }),
    });

    if (!resposta.ok) {
      const corpo = await resposta.json().catch(() => null);
      const mensagem = corpo?.message ?? `mestre-weber respondeu ${resposta.status}.`;
      return { ok: false, erro: mensagem };
    }

    const dados = await resposta.json();
    return { ok: true, nivel: dados.nivel, xp: dados.xp };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro, url) };
  }
}

/**
 * Ficha de Pathfinder 2e montada no construtor do site, no formato do
 * importador (`importarFicha.js`). O site só tem essa exportação depois que
 * a ficha é salva no construtor.
 *
 * @param {number} personagemId
 * @returns {Promise<{ok:true, nome:string, atualizadaEm:string|null, ficha:object} | {ok:false, erro:string}>}
 */
export async function buscarFichaPf2e(personagemId) {
  const { url, token } = credenciais();
  if (!url || !token) return { ok: false, erro: "Configure a URL e o token do mestre-weber primeiro." };

  try {
    const resposta = await fetchComTimeout(`${url}/api/foundry/personagens/${personagemId}/ficha-pf2e`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });

    if (!resposta.ok) {
      const corpo = await resposta.json().catch(() => null);
      const mensagem = corpo?.message ?? `mestre-weber respondeu ${resposta.status}.`;
      return { ok: false, erro: mensagem };
    }

    const dados = await resposta.json();
    return { ok: true, nome: dados.nome, atualizadaEm: dados.atualizadaEm ?? null, ficha: dados.ficha };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro, url) };
  }
}

/**
 * Manda um ator do Foundry pro site ("Enviar pro mestre-weber"), pra um
 * personagem existente ou um novo (`personagemId` nulo, criado com `nome`).
 * A ficha fica pendente no construtor do site até ser conferida e salva.
 *
 * @param {number|null} personagemId
 * @param {string} nome
 * @param {object} ator serializado por `enviarFicha.js`
 * @returns {Promise<{ok:true, personagemId:number, nome:string, criado:boolean, url:string} | {ok:false, erro:string}>}
 */
export async function enviarFichaPf2e(personagemId, nome, ator) {
  const { url, token } = credenciais();
  if (!url || !token) return { ok: false, erro: "Configure a URL e o token do mestre-weber primeiro." };

  try {
    const resposta = await fetchComTimeout(`${url}/api/foundry/personagens/ficha-pf2e`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ personagem_id: personagemId, nome, ator }),
    });

    if (!resposta.ok) {
      const corpo = await resposta.json().catch(() => null);
      const mensagem = corpo?.message ?? `mestre-weber respondeu ${resposta.status}.`;
      return { ok: false, erro: mensagem };
    }

    const dados = await resposta.json();
    return { ok: true, personagemId: dados.personagemId, nome: dados.nome, criado: !!dados.criado, url: dados.url };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro, url) };
  }
}

/**
 * Ficha do ator como está no Foundry (números já calculados pelo sistema),
 * enviada sozinha sempre que o ator mapeado muda — ver `fichaAuto.js`.
 *
 * @param {number} personagemId
 * @param {object} ficha
 * @returns {Promise<{ok:true} | {ok:false, erro:string}>}
 */
export async function enviarFichaFoundry(personagemId, ficha) {
  const { url, token } = credenciais();
  if (!url || !token) return { ok: false, erro: "Configure a URL e o token do mestre-weber primeiro." };

  try {
    const resposta = await fetchComTimeout(`${url}/api/foundry/personagens/${personagemId}/ficha-foundry`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ficha }),
    });

    if (!resposta.ok) {
      const corpo = await resposta.json().catch(() => null);
      return { ok: false, erro: corpo?.message ?? `mestre-weber respondeu ${resposta.status}.` };
    }

    return { ok: true };
  } catch (erro) {
    return { ok: false, erro: mensagemDeErro(erro, url) };
  }
}
