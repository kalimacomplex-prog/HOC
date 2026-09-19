/**
 * Wrapper fino sobre a API de Actions do GitHub pra disparar um runner
 * efêmero (workflow_dispatch) que faz o papel de "Maquina" pra UM run de
 * automação por vez — mesma arquitetura já usada no HAC (ver
 * kalimacomplex-prog/HAC, api/github_actions.py), portada pro HOC.
 *
 * Diferente do HAC, aqui o runner não recebe o job inteiro no disparo —
 * ele recebe só uma `machineKey` temporária e passa a se comportar como
 * uma Maquina normal fazendo heartbeat em /api/maquinas/heartbeat (ver
 * public/hoc_ephemeral_runner.py), reaproveitando 100% do protocolo de
 * dispatch de step já existente (ver lib/automationEngine.js).
 */
let CFG = null;

function init(cfg) {
  CFG = cfg; // { fetch, token, owner, repo, workflowFile, ref }
}

class GithubDispatchError extends Error {}

async function dispatchEphemeralRunner({ machineKey, hocApiUrl }) {
  if (!CFG?.token || !CFG?.owner || !CFG?.repo) {
    throw new GithubDispatchError('GitHub Actions não configurado (GITHUB_TOKEN/GITHUB_OWNER/GITHUB_REPO)');
  }
  const url = `https://api.github.com/repos/${CFG.owner}/${CFG.repo}/actions/workflows/${CFG.workflowFile}/dispatches`;
  const resp = await CFG.fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CFG.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ref: CFG.ref || 'main',
      inputs: { machine_key: machineKey, hoc_api_url: hocApiUrl },
    }),
  });
  // workflow_dispatch responde 204 sem corpo em sucesso — não dá pra saber
  // o run_id direto daqui (limitação da API do GitHub); não precisamos
  // dele, o runner se identifica sozinho via heartbeat com a machineKey.
  if (resp.status >= 300) {
    throw new GithubDispatchError(`GitHub Actions API ${resp.status}: ${(await resp.text()).slice(0, 500)}`);
  }
}

module.exports = { init, dispatchEphemeralRunner, GithubDispatchError };
