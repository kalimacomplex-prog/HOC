/**
 * OAuth do Google (login "Conectar com o Google") pra dar aos Robôs de
 * Google Drive a cota de armazenamento da conta do usuário — contas de
 * serviço não têm cota própria (ver lib/stepLibrary.js), só funcionam pra
 * ler/mover/excluir, nunca pra enviar/atualizar conteúdo de arquivo.
 *
 * Fluxo padrão "authorization code" com access_type=offline + prompt=consent
 * (garante que o Google sempre devolve um refresh_token novo, mesmo em
 * reconexões). App em modo Teste no Google Cloud: o refresh_token expira em
 * 7 dias — ver [[project-hoc-multitenant]] antes de trocar pra Produção.
 */

let cfg = null; // { fetch, clientId, clientSecret, redirectUri }

function init(deps) {
  cfg = deps;
}

const SCOPE = 'https://www.googleapis.com/auth/drive';

function buildAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCode(code) {
  const r = await cfg.fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error_description || data.error || `HTTP ${r.status}`);
  return data; // { access_token, refresh_token, expires_in, ... }
}

module.exports = { init, buildAuthUrl, exchangeCode };
