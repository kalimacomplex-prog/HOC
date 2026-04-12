// ============================================================
// global.js — Polling de status de assinatura em tempo real
// Incluir em TODAS as páginas do HOC System
// ============================================================

(function() {
  const INTERVALO_POLLING = 10000; // 10 segundos
  let _statusAnterior = null;
  let _pollingGlobal = null;
  let _iniciado = false;

  // ===== INICIALIZAÇÃO =====
  function iniciarPollingGlobal() {
    if (_iniciado) return;
    _iniciado = true;

    const token = localStorage.getItem('token');
    if (!token) return;

    // Carrega status inicial imediatamente
    verificarStatusAssinatura();

    // Polling a cada 10s
    _pollingGlobal = setInterval(verificarStatusAssinatura, INTERVALO_POLLING);
  }

  // ===== VERIFICAÇÃO PRINCIPAL =====
  async function verificarStatusAssinatura() {
    const token = localStorage.getItem('token');
    if (!token) { pararPolling(); return; }

    try {
      const res = await fetch('/api/notificacoes/resumo', {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      if (res.status === 401) { pararPolling(); return; }

      const data = await res.json();
      const assinatura = data.assinatura;
      if (!assinatura) return;

      const statusAtual = assinatura.status;

      // Só age se o status mudou
      if (_statusAnterior !== null && _statusAnterior !== statusAtual) {
        console.log(`[HOC] Status mudou: ${_statusAnterior} → ${statusAtual}`);
        aoStatusMudar(statusAtual, assinatura);
      }

      // Sempre sincroniza o estado visual
      sincronizarEstadoVisual(statusAtual, assinatura);
      _statusAnterior = statusAtual;

    } catch (err) {
      // Silencioso — não interrompe o sistema
    }
  }

  // ===== QUANDO O STATUS MUDA =====
  function aoStatusMudar(novoStatus, assinatura) {
    if (novoStatus === 'ativa') {
      // Pagamento confirmado — liberar tudo!
      mostrarToastSucesso();
      liberarInterface();
      fecharModalPagamento();
      atualizarBanner(assinatura);

      // Se estiver na página de plano-usuarios, recarrega os dados
      if (typeof carregarAssinatura === 'function') {
        carregarAssinatura();
      }

    } else if (novoStatus === 'inadimplente') {
      // Conta inadimplente — bloquear
      mostrarToastInadimplente(assinatura.diasAtraso);
      atualizarBanner(assinatura);

    } else if (novoStatus === 'trial') {
      atualizarBanner(assinatura);
    }
  }

  // ===== SINCRONIZAR ESTADO VISUAL =====
  function sincronizarEstadoVisual(status, assinatura) {
    if (status === 'ativa') {
      liberarInterface();
      atualizarBanner(assinatura);
    } else if (status === 'inadimplente') {
      atualizarBanner(assinatura);
    } else if (status === 'trial') {
      atualizarBanner(assinatura);
    }
  }

  // ===== LIBERAR INTERFACE =====
  function liberarInterface() {
    // Fechar overlay de bloqueio
    const overlay = document.getElementById('bloqueioOverlay');
    if (overlay) overlay.classList.remove('ativo');

    // Liberar menu lateral
    document.querySelectorAll('.menu-inadimplente-bloqueado').forEach(el => {
      el.classList.remove('menu-inadimplente-bloqueado');
    });

    // Liberar tabs bloqueadas
    document.querySelectorAll('.tab-bloqueada').forEach(el => {
      el.classList.remove('tab-bloqueada');
    });

    // Liberar conteúdo bloqueado
    document.querySelectorAll('.inadimplente-bloqueado').forEach(el => {
      el.classList.remove('inadimplente-bloqueado');
    });

    // Remover aviso de inadimplência
    const aviso = document.getElementById('avisoInadimplente');
    if (aviso) aviso.remove();

    // Marcar como não inadimplente
    window._sistemaInadimplente = false;
  }

  // ===== ATUALIZAR BANNER =====
  function atualizarBanner(assinatura) {
    const banner = document.getElementById('bannerAssinatura');
    if (!banner) return;

    // Se o usuário fechou o banner nessa sessão, respeitar
    if (sessionStorage.getItem('bannerFechado') === '1') {
      banner.style.display = 'none';
      const main = document.querySelector('.main');
      if (main) main.classList.remove('banner-visivel');
      return;
    }

    const { status, diasTrialRestantes, diasAtraso } = assinatura;

    if (status === 'ativa' || status === 'aguardando_confirmacao') {
      // Esconder banner se ativo
      banner.style.display = 'none';
      const main = document.querySelector('.main');
      if (main) main.classList.remove('banner-visivel');

    } else if (status === 'trial' && diasTrialRestantes !== null) {
      const expirando = diasTrialRestantes <= 5;
      banner.className = `banner-assinatura ${expirando ? 'trial-expirando' : 'trial'}`;
      banner.innerHTML = `
        <span>${expirando ? '⚠️' : '🎉'} Período de teste: <strong>${diasTrialRestantes} dia(s) restante(s)</strong></span>
        <button class="banner-assinatura-btn ${expirando ? 'trial-expirando' : 'trial'}" onclick="window.location.href='/plano-usuarios'">Ver planos</button>
        <button class="banner-fechar" onclick="fecharBanner()" title="Fechar">×</button>`;
      banner.style.display = 'flex';
      const main = document.querySelector('.main');
      if (main) main.classList.add('banner-visivel');

    } else if (status === 'inadimplente') {
      banner.className = 'banner-assinatura inadimplente';
      banner.innerHTML = `
        <span>⚠️ Fatura <strong>${diasAtraso} dia(s) em atraso</strong>. Regularize agora.</span>
        <button class="banner-assinatura-btn inadimplente" onclick="window.location.href='/plano-usuarios'">Pagar agora</button>
        <button class="banner-fechar" onclick="fecharBanner()" title="Fechar">×</button>`;
      banner.style.display = 'flex';
      const main = document.querySelector('.main');
      if (main) main.classList.add('banner-visivel');
    }
  }

  // ===== FECHAR MODAL DE PAGAMENTO =====
  function fecharModalPagamento() {
    const modal = document.getElementById('modalPagamento');
    if (modal) {
      modal.classList.remove('aberto');
      // Parar polling de PIX se estiver rodando
      if (window._pollingInterval) {
        clearInterval(window._pollingInterval);
        window._pollingInterval = null;
      }
    }
  }

  // ===== TOAST DE SUCESSO =====
  function mostrarToastSucesso() {
    const toast = criarToast(
      '🎉 Pagamento confirmado!',
      'Seu plano foi ativado. Todos os módulos estão liberados.',
      '#276749', '#f0fff4', '#9ae6b4'
    );
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 6000);
  }

  // ===== TOAST DE INADIMPLENTE =====
  function mostrarToastInadimplente(diasAtraso) {
    const toast = criarToast(
      '⚠️ Pagamento em atraso',
      `Sua fatura está ${diasAtraso || 0} dia(s) em atraso. Acesse Plano e Usuários para regularizar.`,
      '#c05621', '#fffaf0', '#f6ad55'
    );
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 8000);
  }

  // ===== CRIAR TOAST =====
  function criarToast(titulo, mensagem, corTexto, corFundo, corBorda) {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: ${corFundo};
      border: 1.5px solid ${corBorda};
      border-radius: 12px;
      padding: 16px 20px;
      max-width: 360px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.12);
      z-index: 99999;
      animation: slideInToast 0.3s ease;
      font-family: 'Segoe UI', sans-serif;
    `;
    toast.innerHTML = `
      <div style="font-size:14px;font-weight:700;color:${corTexto};margin-bottom:4px">${titulo}</div>
      <div style="font-size:12px;color:#4a5568;line-height:1.5">${mensagem}</div>
    `;

    // Animação CSS inline
    if (!document.getElementById('toastStyle')) {
      const style = document.createElement('style');
      style.id = 'toastStyle';
      style.textContent = `
        @keyframes slideInToast {
          from { transform: translateX(120%); opacity: 0; }
          to   { transform: translateX(0);   opacity: 1; }
        }
      `;
      document.head.appendChild(style);
    }

    return toast;
  }

  // ===== PARAR POLLING =====
  function pararPolling() {
    if (_pollingGlobal) {
      clearInterval(_pollingGlobal);
      _pollingGlobal = null;
    }
    _iniciado = false;
  }

  // ===== EXPOR FUNÇÕES GLOBAIS =====
  window.HOC = {
    iniciarPolling: iniciarPollingGlobal,
    pararPolling,
    verificarAgora: verificarStatusAssinatura,
    liberarInterface,
  };

  // ===== AUTO-INICIAR quando DOM estiver pronto =====
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', iniciarPollingGlobal);
  } else {
    iniciarPollingGlobal();
  }

})();
