(function () {
  var LBL = 'font-size:11px;font-weight:600;color:#6B7080;margin-bottom:5px;display:block;';
  var INP = 'width:100%;height:38px;padding:0 12px;border:1.5px solid #E5E7EB;border-radius:9px;font-size:13px;color:#0B0B0F;outline:none;font-family:inherit;background:white;box-sizing:border-box;';
  var MODAL_HTML = `
<div id="modalPerfilOverlay" style="position:fixed;inset:0;background:rgba(11,11,15,0.45);display:none;align-items:center;justify-content:center;z-index:2000;font-family:'Plus Jakarta Sans',sans-serif;">
  <div style="background:white;border-radius:16px;width:100%;max-width:480px;max-height:85vh;overflow-y:auto;box-shadow:0 24px 64px rgba(11,11,15,0.2);border:1px solid #ECEDF0;">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:20px 24px 0;">
      <span style="font-size:16px;font-weight:800;color:#0B0B0F;">Meu Perfil</span>
      <button id="btnFecharModalPerfil" style="width:34px;height:34px;box-sizing:border-box;border-radius:9px;background:#F1F2F5;color:#4A4E5A;border:none;cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center;line-height:1;flex-shrink:0;padding:0;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>
    <div style="display:inline-flex;background:#F1F2F5;border-radius:10px;padding:3px;gap:2px;margin:10px 24px 0;">
      <button id="perfilTabDados" onclick="__perfilTab('dados')" style="height:32px;padding:0 16px;border-radius:8px;font-size:12.5px;font-weight:700;border:none;cursor:pointer;background:white;color:#0B0B0F;box-shadow:0 1px 3px rgba(11,11,15,0.1);">Dados Pessoais</button>
      <button id="perfilTabSenha" onclick="__perfilTab('senha')" style="height:32px;padding:0 16px;border-radius:8px;font-size:12.5px;font-weight:700;border:none;cursor:pointer;background:transparent;color:#6B7080;">Senha</button>
    </div>

    <!-- Aba Dados Pessoais -->
    <div id="perfilSecDados" style="padding:20px 24px 24px;">
      <div style="display:flex;flex-direction:column;align-items:center;margin-bottom:20px;">
        <div id="perfilFotoPreview" style="width:72px;height:72px;border-radius:50%;background:var(--accent,#2F5CFF);display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:700;color:white;overflow:hidden;margin-bottom:8px;cursor:pointer;" onclick="document.getElementById('perfilFotoInput').click()">?</div>
        <input type="file" id="perfilFotoInput" accept="image/*" style="display:none;">
        <button style="font-size:12px;color:#0B0B0F;background:none;border:none;cursor:pointer;font-weight:600;font-family:inherit;" onclick="document.getElementById('perfilFotoInput').click()">Alterar foto</button>
      </div>
      <div style="margin-bottom:14px;">
        <label style="${LBL}">Nome</label>
        <input type="text" id="perfilNome" placeholder="Seu nome completo" style="${INP}">
      </div>
      <div style="margin-bottom:14px;">
        <label style="${LBL}">Cargo</label>
        <input type="text" id="perfilCargo" placeholder="Seu cargo ou função" style="${INP}">
      </div>
      <div id="perfilDadosMsg" style="font-size:12px;padding:8px 12px;border-radius:8px;display:none;margin-bottom:8px;"></div>
      <div style="display:flex;gap:10px;margin-top:20px;">
        <button id="perfilCancelarDados" style="flex:1;height:40px;padding:0 16px;background:#F1F2F5;color:#4A4E5A;border:none;border-radius:9px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;">Cancelar</button>
        <button onclick="__perfilSalvarDados()" style="flex:1;height:40px;padding:0 16px;background:linear-gradient(135deg, var(--accent,#2F5CFF), color-mix(in srgb, var(--accent,#2F5CFF) 80%, black));box-shadow:0 2px 8px color-mix(in srgb, var(--accent,#2F5CFF) 35%, transparent);border:none;border-radius:9px;color:white;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;">Salvar alterações</button>
      </div>
    </div>

    <!-- Aba Senha -->
    <div id="perfilSecSenha" style="padding:20px 24px 24px;display:none;">
      <div style="margin-bottom:14px;">
        <label style="${LBL}">Senha atual</label>
        <input type="password" id="perfilSenhaAtual" placeholder="Digite sua senha atual" style="${INP}">
      </div>
      <div style="margin-bottom:14px;">
        <label style="${LBL}">Nova senha</label>
        <input type="password" id="perfilNovaSenha" placeholder="Mínimo 6 caracteres" style="${INP}">
      </div>
      <div style="margin-bottom:14px;">
        <label style="${LBL}">Confirmar nova senha</label>
        <input type="password" id="perfilConfirmarSenha" placeholder="Repita a nova senha" style="${INP}">
      </div>
      <div id="perfilSenhaMsg" style="font-size:12px;padding:8px 12px;border-radius:8px;display:none;margin-bottom:8px;"></div>
      <div style="display:flex;gap:10px;margin-top:20px;">
        <button id="perfilCancelarSenha" style="flex:1;height:40px;padding:0 16px;background:#F1F2F5;color:#4A4E5A;border:none;border-radius:9px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;">Cancelar</button>
        <button onclick="__perfilSalvarSenha()" style="flex:1;height:40px;padding:0 16px;background:linear-gradient(135deg, var(--accent,#2F5CFF), color-mix(in srgb, var(--accent,#2F5CFF) 80%, black));box-shadow:0 2px 8px color-mix(in srgb, var(--accent,#2F5CFF) 35%, transparent);border:none;border-radius:9px;color:white;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;">Salvar senha</button>
      </div>
    </div>
  </div>
</div>`;

  var _fotoBase64 = null;

  function _token() { return localStorage.getItem('token'); }
  function _headers() { return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _token() }; }

  function _msg(id, texto, ok) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = texto;
    el.style.display = 'block';
    el.style.background = ok ? 'color-mix(in srgb,#00B37E 10%,white)' : 'color-mix(in srgb,#FF2E4D 8%,white)';
    el.style.color = ok ? '#00754F' : '#FF2E4D';
    el.style.border = ok ? '1px solid color-mix(in srgb,#00B37E 30%,white)' : '1px solid color-mix(in srgb,#FF2E4D 30%,white)';
  }

  function _hideMsg(id) {
    var el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }

  window.__perfilTab = function (tab) {
    ['Dados', 'Senha'].forEach(function (t) {
      var sec = document.getElementById('perfilSec' + t);
      var btn = document.getElementById('perfilTab' + t);
      var isAtivo = t.toLowerCase() === tab;
      if (sec) sec.style.display = isAtivo ? 'block' : 'none';
      if (btn) {
        btn.style.background = isAtivo ? 'white' : 'transparent';
        btn.style.color = isAtivo ? '#0B0B0F' : '#6B7080';
        btn.style.boxShadow = isAtivo ? '0 1px 3px rgba(11,11,15,0.1)' : 'none';
      }
    });
  };

  window.__perfilSalvarDados = async function () {
    var nome = document.getElementById('perfilNome').value.trim();
    var cargo = document.getElementById('perfilCargo').value.trim();
    _hideMsg('perfilDadosMsg');
    if (!nome || nome.length < 2) { _msg('perfilDadosMsg', 'Nome deve ter pelo menos 2 caracteres.', false); return; }
    var body = { nome: nome, cargo: cargo };
    if (_fotoBase64 !== null) body.foto = _fotoBase64;
    try {
      var res = await fetch('/api/perfil', { method: 'PUT', headers: _headers(), body: JSON.stringify(body) });
      var data = await res.json();
      if (!res.ok) { _msg('perfilDadosMsg', data.erro || 'Erro ao salvar.', false); return; }
      _msg('perfilDadosMsg', 'Perfil atualizado com sucesso!', true);
      var usuario = JSON.parse(localStorage.getItem('usuario') || '{}');
      usuario.nome = nome;
      usuario.cargo = cargo;
      if (_fotoBase64 !== null) usuario.foto = _fotoBase64;
      localStorage.setItem('usuario', JSON.stringify(usuario));
      _atualizarHeader(usuario);
    } catch (e) { _msg('perfilDadosMsg', 'Erro de conexão.', false); }
  };

  window.__perfilSalvarSenha = async function () {
    var senhaAtual = document.getElementById('perfilSenhaAtual').value;
    var novaSenha = document.getElementById('perfilNovaSenha').value;
    var confirmar = document.getElementById('perfilConfirmarSenha').value;
    _hideMsg('perfilSenhaMsg');
    if (!senhaAtual || !novaSenha || !confirmar) { _msg('perfilSenhaMsg', 'Preencha todos os campos.', false); return; }
    if (novaSenha !== confirmar) { _msg('perfilSenhaMsg', 'As senhas não coincidem.', false); return; }
    if (novaSenha.length < 6) { _msg('perfilSenhaMsg', 'Nova senha deve ter pelo menos 6 caracteres.', false); return; }
    try {
      var res = await fetch('/api/perfil/senha', { method: 'PUT', headers: _headers(), body: JSON.stringify({ senhaAtual: senhaAtual, novaSenha: novaSenha }) });
      var data = await res.json();
      if (!res.ok) { _msg('perfilSenhaMsg', data.erro || 'Erro ao salvar.', false); return; }
      _msg('perfilSenhaMsg', 'Senha alterada com sucesso!', true);
      document.getElementById('perfilSenhaAtual').value = '';
      document.getElementById('perfilNovaSenha').value = '';
      document.getElementById('perfilConfirmarSenha').value = '';
    } catch (e) { _msg('perfilSenhaMsg', 'Erro de conexão.', false); }
  };

  function _atualizarHeader(usuario) {
    var nomeEl = document.getElementById('userNome');
    var cargoEl = document.getElementById('userPerfil');
    var avatarEl = document.getElementById('userAvatar');
    if (nomeEl) nomeEl.textContent = usuario.nome || '-';
    if (cargoEl) cargoEl.textContent = usuario.cargo || usuario.perfil || '-';
    if (avatarEl) {
      if (usuario.foto) {
        avatarEl.innerHTML = '<img src="' + usuario.foto + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">';
        avatarEl.style.background = 'transparent';
      } else {
        avatarEl.innerHTML = '';
        avatarEl.textContent = (usuario.nome || '?')[0].toUpperCase();
        avatarEl.style.background = 'var(--accent, #2F5CFF)';
      }
    }
  }

  function _abrirModal() {
    var overlay = document.getElementById('modalPerfilOverlay');
    if (!overlay) return;
    _fotoBase64 = null;
    _hideMsg('perfilDadosMsg');
    _hideMsg('perfilSenhaMsg');
    ['perfilSenhaAtual', 'perfilNovaSenha', 'perfilConfirmarSenha'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.value = '';
    });
    window.__perfilTab('dados');
    overlay.style.display = 'flex';
    var usuario = JSON.parse(localStorage.getItem('usuario') || '{}');
    document.getElementById('perfilNome').value = usuario.nome || '';
    document.getElementById('perfilCargo').value = usuario.cargo || '';
    var preview = document.getElementById('perfilFotoPreview');
    if (usuario.foto) {
      preview.innerHTML = '<img src="' + usuario.foto + '" style="width:100%;height:100%;object-fit:cover;">';
      preview.style.background = 'transparent';
    } else {
      preview.innerHTML = '';
      preview.textContent = (usuario.nome || '?')[0].toUpperCase();
      preview.style.background = 'var(--accent, #2F5CFF)';
    }
  }

  function _fecharModal() {
    var overlay = document.getElementById('modalPerfilOverlay');
    if (overlay) overlay.style.display = 'none';
  }

  window.fecharModalPerfil = _fecharModal;

  window.limparNotificacoes = async function () {
    try {
      await fetch('/api/notificacoes', { method: 'DELETE', headers: _headers() });
      if (typeof carregarNotificacoes === 'function') carregarNotificacoes();
    } catch (e) { console.error(e); }
  };

  document.addEventListener('DOMContentLoaded', function () {
    document.body.insertAdjacentHTML('beforeend', MODAL_HTML);

    document.getElementById('modalPerfilOverlay').addEventListener('click', function (e) {
      if (e.target === this) _fecharModal();
    });
    document.getElementById('btnFecharModalPerfil').addEventListener('click', _fecharModal);
    document.getElementById('perfilCancelarDados').addEventListener('click', _fecharModal);
    document.getElementById('perfilCancelarSenha').addEventListener('click', _fecharModal);

    document.getElementById('perfilFotoInput').addEventListener('change', function () {
      var file = this.files[0];
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) { alert('Imagem muito grande. Máximo 2MB.'); return; }
      var reader = new FileReader();
      reader.onload = function (e) {
        _fotoBase64 = e.target.result;
        var preview = document.getElementById('perfilFotoPreview');
        preview.innerHTML = '<img src="' + _fotoBase64 + '" style="width:100%;height:100%;object-fit:cover;">';
        preview.style.background = 'transparent';
      };
      reader.readAsDataURL(file);
    });

    var headerUser = document.querySelector('.header-user');
    if (headerUser) {
      headerUser.style.cursor = 'pointer';
      headerUser.addEventListener('click', _abrirModal);
    }

    var sidebarLogo = document.querySelector('.sidebar-logo');
    if (sidebarLogo) {
      sidebarLogo.style.cursor = 'pointer';
      sidebarLogo.addEventListener('click', function () {
        window.location.href = '/dashboard';
      });
    }

    // Aplicar foto e cargo do localStorage no header ao carregar a página
    var usuario = JSON.parse(localStorage.getItem('usuario') || '{}');
    var cargoEl = document.getElementById('userPerfil');
    if (cargoEl && usuario.cargo) cargoEl.textContent = usuario.cargo;
    if (usuario.foto) {
      var avatarEl = document.getElementById('userAvatar');
      if (avatarEl) {
        avatarEl.innerHTML = '<img src="' + usuario.foto + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">';
        avatarEl.style.background = 'transparent';
      }
    }
  });
})();
