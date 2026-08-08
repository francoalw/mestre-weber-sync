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
 * @param {string} data formato YYYY-MM-DD
 * @param {Array<Record<string, number|string>>} estatisticas uma entrada por personagem_id
 * @returns {Promise<{ok: true, sessaoId:number, sessaoUrl:string, avisos:string[]} | {ok:false, erro:string}>}
 */
export async function sincronizarEstatisticas(data, estatisticas) {
  const { url, token } = credenciais();
  if (!url || !token) return { ok: false, erro: "Configure a URL e o token do mestre-weber primeiro." };

  try {
    const resposta = await fetchComTimeout(`${url}/api/foundry/sessoes/sincronizar`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ data, estatisticas }),
    });

    if (!resposta.ok) {
      const corpo = await resposta.json().catch(() => null);
      const mensagem = corpo?.message ?? `mestre-weber respondeu ${resposta.status}.`;
      return { ok: false, erro: mensagem };
    }

    const dados = await resposta.json();
    return { ok: true, sessaoId: dados.sessao_id, sessaoUrl: dados.sessao_url, avisos: dados.avisos ?? [] };
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
