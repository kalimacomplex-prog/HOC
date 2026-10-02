/**
 * OAuth do Google (login "Conectar conta Google") pros Robôs de Google
 * Drive/Sheets. Cada empresa usa o PRÓPRIO app OAuth, criado no Google Cloud
 * dela: o client_id/client_secret ficam na credencial do cofre da empresa,
 * junto do refresh_token devolvido aqui. O HOC não tem app do Google próprio,
 * então não há verificação do Google nem lista de "usuários de teste" do lado
 * do HOC. O refresh_token só expira em 7 dias se o app da empresa estiver em
 * modo "Teste"; publicado ("Em produção") ou "Interno" (Workspace), não expira.
 *
 * Fluxo padrão "authorization code" com access_type=offline + prompt=consent
 * (garante que o Google sempre devolve um refresh_token novo, mesmo em
 * reconexões).
 */

let fetchFn = null;

function init(deps) {
  fetchFn = deps.fetch;
}

const SCOPE = 'https://www.googleapis.com/auth/drive';

function buildAuthUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCode({ code, clientId, clientSecret, redirectUri }) {
  const r = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error_description || data.error || `HTTP ${r.status}`);
  return data; // { access_token, refresh_token, expires_in, ... }
}

module.exports = { init, buildAuthUrl, exchangeCode };
