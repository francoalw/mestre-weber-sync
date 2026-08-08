const CAMPOS = ["system.details.level.value", "system.details.xp.value"];

/**
 * Lê o valor submetido pra um campo, cobrindo tanto `changes` aninhado
 * (`{system: {details: {level: {value: ...}}}}`, formato normal de um
 * formulário expandido) quanto uma chave pontilhada literal no nível raiz
 * (`{"system.details.level.value": ...}`, usado por alguns atalhos da ficha
 * do PF2e que chamam `.update()` direto, sem passar por `expandObject`).
 *
 * @returns {{presente: boolean, valor?: unknown}}
 */
function lerCampo(changes, caminho) {
  if (foundry.utils.hasProperty(changes, caminho)) {
    return { presente: true, valor: foundry.utils.getProperty(changes, caminho) };
  }
  if (caminho in changes) {
    return { presente: true, valor: changes[caminho] };
  }
  return { presente: false };
}

function removerCampo(changes, caminho) {
  foundry.utils.deleteProperty(changes, caminho);
  delete changes[caminho];
}

/**
 * Impede que qualquer um que não seja o mestre altere nível ou XP de um
 * Actor do tipo "character" — mesmo o próprio dono do personagem. Roda em
 * TODOS os clientes (não só no do mestre): `preUpdateActor` dispara
 * localmente, no client de quem chamou `actor.update()`, antes do pedido
 * seguir pro servidor — então intercepta tanto a edição pela ficha quanto
 * uma tentativa via macro/console do próprio jogador.
 *
 * A ficha do PF2e reenvia o cabeçalho inteiro (nível, XP etc.) a cada save,
 * mesmo quando só outro campo mudou — por isso só bloqueia (e avisa) quando
 * o valor submetido é DIFERENTE do valor atual do Actor, não só quando o
 * campo aparece no payload. Sem essa checagem, o aviso apareceria em
 * qualquer salvamento da ficha, não só numa tentativa de mudar nível/XP.
 *
 * Só remove os campos bloqueados do payload (não cancela a atualização
 * inteira), a menos que não sobre mais nada legítimo pra salvar — assim uma
 * mudança legítima simultânea em outro campo continua passando.
 *
 * O módulo mestre-weber-sync (`progresso.js`) só LÊ nível/XP do Actor, nunca
 * escreve neles — essa proteção não interfere na sincronização automática
 * com o mestre-weber.
 */
export function registrarProtecaoNivelXp() {
  Hooks.on("preUpdateActor", (actor, changes) => {
    if (game.user.isGM) return;
    if (actor.type !== "character") return;

    let tentouMudar = false;

    for (const caminho of CAMPOS) {
      const submetido = lerCampo(changes, caminho);
      if (!submetido.presente) continue;

      const atual = foundry.utils.getProperty(actor, caminho);
      if (Number(submetido.valor) === Number(atual)) continue;

      removerCampo(changes, caminho);
      tentouMudar = true;
    }

    if (!tentouMudar) return;

    ui.notifications.warn("Mestre Weber Sync | Só o mestre pode alterar nível ou XP.");

    // Limpa objetos que ficaram vazios depois da remoção acima, e cancela o
    // update inteiro em vez de mandar um request vazio se não sobrou mais
    // nenhum campo legítimo pra salvar.
    if (changes.system?.details?.level && foundry.utils.isEmpty(changes.system.details.level)) {
      delete changes.system.details.level;
    }
    if (changes.system?.details?.xp && foundry.utils.isEmpty(changes.system.details.xp)) {
      delete changes.system.details.xp;
    }
    if (changes.system?.details && foundry.utils.isEmpty(changes.system.details)) {
      delete changes.system.details;
    }
    if (changes.system && foundry.utils.isEmpty(changes.system)) {
      delete changes.system;
    }
    if (foundry.utils.isEmpty(changes)) return false;
  });
}
