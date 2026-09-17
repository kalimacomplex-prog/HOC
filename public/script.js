// Carregar usuários ao abrir a página
document.addEventListener('DOMContentLoaded', carregarUsuarios);

async function carregarUsuarios() {
  const res = await fetch('/usuarios');
  const usuarios = await res.json();
  const lista = document.getElementById('lista');

  lista.innerHTML = usuarios.map(u => `
    <tr>
      <td>${u.nome}</td>
      <td>${u.email}</td>
      <td>
        <button class="btn-deletar" onclick="deletar('${u._id}')">
          Deletar
        </button>
      </td>
    </tr>
  `).join('');
}

// Cadastrar usuário
document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nome = document.getElementById('nome').value;
  const email = document.getElementById('email').value;

  await fetch('/usuarios', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nome, email })
  });

  document.getElementById('nome').value = '';
  document.getElementById('email').value = '';
  carregarUsuarios();
});

// ===== NOTIFICAÇÕES =====
  async function carregarNotificacoes() {
    try {
      const [resResumo, resNotifs] = await Promise.all([
        fetch('/api/notificacoes/resumo', { headers: HEADERS }),
        fetch('/api/notificacoes', { headers: HEADERS })
      ]);
      if (resResumo.status === 401) return;
      const resumo = await resResumo.json();
      const notifs = await resNotifs.json();
      atualizarSino(resumo);
      renderNotificacoes(notifs);
    } catch(err) { console.error(err); }
  }
  function atualizarSino(resumo) {
    const btn = document.getElementById('notifBtn');
    const badge = document.getElementById('notifBadge');
    if (!btn || !badge) return;
    btn.className = 'notif-btn';
    badge.style.display = 'none';
    if (resumo.temVencida > 0) {
      btn.classList.add('vermelho');
      badge.style.display = 'flex';
      badge.className = 'notif-badge vermelho';
      badge.textContent = resumo.naoLidas > 9 ? '9+' : resumo.naoLidas;
    } else if (resumo.temVencendo > 0 || resumo.naoLidas > 0) {
      btn.classList.add('amarelo');
      badge.style.display = 'flex';
      badge.className = 'notif-badge amarelo';
      badge.textContent = resumo.naoLidas > 9 ? '9+' : resumo.naoLidas;
    }
  }
  const NOTIF_ICON = {
    sucesso: {svg:'<circle cx="12" cy="12" r="9"/><polyline points="8 12.5 11 15.5 16 9"/>', color:'#00754F'},
    erro: {svg:'<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>', color:'#B3123A'},
    aviso: {svg:'<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>', color:'#8A6200'},
    info: {svg:'<circle cx="12" cy="12" r="9"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>', color:'var(--accent)'},
    licenca_vencendo: {svg:'<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>', color:'#8A6200'},
    licenca_vencida: {svg:'<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>', color:'#B3123A'},
  };
  function _notifIconHtml(tipo) {
    const cfg = NOTIF_ICON[tipo] || NOTIF_ICON.info;
    return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${cfg.color}" stroke-width="2">${cfg.svg}</svg>`;
  }
  function renderNotificacoes(notifs) {
    const lista = document.getElementById('notifLista');
    if (!lista) return;
    if (!notifs || notifs.length === 0) {
      lista.innerHTML = '<div class="notif-empty"><div class="notif-empty-icon"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#9CA0AC" stroke-width="1.5"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0"/></svg></div><div class="notif-empty-txt">Nenhuma notificação.</div></div>';
      return;
    }
    lista.innerHTML = notifs.map(n => `
      <div class="notif-item ${!n.lida?'nao-lida':''} tipo-${n.tipo}" onclick="abrirNotif('${n._id}','${n.link||''}')">
        <div class="notif-icone ${n.tipo}">${_notifIconHtml(n.tipo)}</div>
        <div class="notif-corpo">
          <div class="notif-titulo-item">${n.titulo}</div>
          <div class="notif-msg">${n.mensagem}</div>
          <div class="notif-tempo">${tempoNotif(n.criadoEm)}</div>
        </div>
        <button class="notif-del" onclick="deletarNotif('${n._id}',event)">×</button>
      </div>`).join('');
  }
  function tempoNotif(data) {
    if (!data) return '';
    const diff = Math.floor((new Date() - new Date(data)) / 1000);
    if (diff < 60) return 'Agora mesmo';
    if (diff < 3600) return `${Math.floor(diff/60)} min atrás`;
    if (diff < 86400) return `${Math.floor(diff/3600)}h atrás`;
    return `${Math.floor(diff/86400)} dia(s) atrás`;
  }
  async function abrirNotif(id, link) {
    try {
      await fetch(`/api/notificacoes/${id}/ler`, { method:'PUT', headers:HEADERS });
      await carregarNotificacoes();
      if (link && link !== 'undefined' && link !== window.location.pathname) window.location.href = link;
    } catch(err) { console.error(err); }
  }
  async function deletarNotif(id, e) {
    e.stopPropagation();
    try { await fetch(`/api/notificacoes/${id}`, { method:'DELETE', headers:HEADERS }); await carregarNotificacoes(); }
    catch(err) { console.error(err); }
  }
  async function lerTodas() {
    try { await fetch('/api/notificacoes/ler-todas', { method:'PUT', headers:HEADERS }); await carregarNotificacoes(); }
    catch(err) { console.error(err); }
  }
  function toggleNotif() {
    const dd = document.getElementById('notifDropdown');
    if (!dd) return;
    dd.classList.toggle('aberto');
    if (dd.classList.contains('aberto')) carregarNotificacoes();
  }
  document.addEventListener('click', e => {
    const wrap = document.getElementById('notifWrap');
    if (wrap && !wrap.contains(e.target)) {
      const dd = document.getElementById('notifDropdown');
      if (dd) dd.classList.remove('aberto');
    }
  });
  carregarNotificacoes();
  setInterval(carregarNotificacoes, 60000);

// Deletar usuário
async function deletar(id) {
  await fetch(`/usuarios/${id}`, { method: 'DELETE' });
  carregarUsuarios();
}
