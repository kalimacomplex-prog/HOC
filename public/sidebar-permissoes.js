// ============================================================
// sidebar-permissoes.js — esconde itens do menu lateral que o
// usuário não tem permissão de acessar (acessar:false).
// Incluir em toda página que tem a sidebar padrão.
// ============================================================

(function() {
  const token = localStorage.getItem('token');
  if (!token) return;

  // href exato do link -> [modulo, acao] em permissoes. "/plano-usuarios?tab=assinatura"
  // (Planos/assinatura) fica de fora de propósito — não é permissionado por módulo.
  const MAPA = {
    '/overview': ['overview', 'acessar'],
    '/gestao-metas': ['gestaoMetas', 'acessar'],
    '/operacoes': ['operacoes', 'acessar'],
    '/ideias-livres': ['ideiasLivres', 'acessar'],
    '/gestao-projetos': ['gestaoProjetos', 'acessar'],
    '/gestao-licencas': ['gestaoLicencas', 'acessar'],
    '/plano-usuarios': ['planoUsuarios', 'acessar'],
  };

  fetch('/api/usuarios/minhas-permissoes', { headers: { 'Authorization': 'Bearer ' + token } })
    .then(r => r.ok ? r.json() : null)
    .then(p => {
      if (!p || p.isAdmin) return;
      document.querySelectorAll('a.menu-item[href]').forEach(a => {
        const cfg = MAPA[a.getAttribute('href')];
        if (cfg && !(p.permissoes?.[cfg[0]]?.[cfg[1]])) a.style.display = 'none';
      });
    })
    .catch(() => {});
})();
