(function () {
  var MODAL_HTML = `
<div id="modalPerfilOverlay" style="position:fixed;inset:0;background:rgba(0,0,0,0.45);display:none;align-items:center;justify-content:center;z-index:2000;">
  <div style="background:white;border-radius:12px;width:100%;max-width:480px;box-shadow:0 8px 32px rgba(0,0,0,0.12);overflow:hidden;">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:20px 24px 0;">
      <span style="font-size:16px;font-weight:700;color:#1e2a4a;">Meu Perfil</span>
      <button id="btnFecharModalPerfil" style="background:none;border:none;font-size:20px;cursor:pointer;color:#a0aec0;line-height:1;">×</button>
    </div>
    <div style="display:flex;gap:2px;margin:16px 24px 0;border-bottom:2px solid #e2e8f0;">
      <button class="tab active" id="perfilTabDados" onclick="__perfilTab('dados')">Dados Pessoais</button>
      <button class="tab" id="perfilTabSenha" onclick="__perfilTab('senha')">Senha</button>
    </div>

    <!-- Aba Dados Pessoais -->
    <div id="perfilSecDados" style="padding:20px 24px 24px;">
      <div style="display:flex;flex-direction:column;align-items:center;margin-bottom:20px;">
        <div id="perfilFotoPreview" style="width:72px;height:72px;border-radius:50%;background:#6b46c1;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:700;color:white;overflow:hidden;margin-bottom:8px;cursor:pointer;" onclick="document.getElementById('perfilFotoInput').click()">?</div>
        <input type="file" id="perfilFotoInput" accept="image/*" style="display:none;">
        <button style="font-size:12px;color:#2d1b69;background:none;border:none;cursor:pointer;font-weight:600;" onclick="document.getElementById('perfilFotoInput').click()">Alterar foto</button>
      </div>
      <div class="form-group">
        <label>Nome</label>
        <input type="text" id="perfilNome" placeholder="Seu nome completo">
      </div>
      <div class="form-group">
        <label>Cargo</label>
        <input type="text" id="perfilCargo" placeholder="Seu cargo ou função">
      </div>
      <div id="perfilDadosMsg" style="font-size:12px;padding:8px 12px;border-radius:6px;display:none;margin-bottom:8px;"></div>
      <div style="display:flex;gap:10px;margin-top:20px;">
        <button class="btn-cancelar" id="perfilCancelarDados" style="flex:1;">Cancelar</button>
        <button class="btn-confirmar" onclick="__perfilSalvarDados()" style="flex:2;">Salvar alterações</button>
      </div>
    </div>

    <!-- Aba Senha -->
    <div id="perfilSecSenha" style="padding:20px 24px 24px;display:none;">
      <div class="form-group">
        <label>Senha atual</label>
        <input type="password" id="perfilSenhaAtual" placeholder="Digite sua senha atual">
      </div>
      <div class="form-group">
        <label>Nova senha</label>
        <input type="password" id="perfilNovaSenha" placeholder="Mínimo 6 caracteres">
      </div>
      <div class="form-group">
        <label>Confirmar nova senha</label>
        <input type="password" id="perfilConfirmarSenha" placeholder="Repita a nova senha">
      </div>
      <div id="perfilSenhaMsg" style="font-size:12px;padding:8px 12px;border-radius:6px;display:none;margin-bottom:8px;"></div>
      <div style="display:flex;gap:10px;margin-top:20px;">
        <button class="btn-cancelar" id="perfilCancelarSenha" style="flex:1;">Cancelar</button>
        <button class="btn-confirmar" onclick="__perfilSalvarSenha()" style="flex:2;">Salvar senha</button>
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
    el.style.background = ok ? '#f0fff4' : '#fff5f5';
    el.style.color = ok ? '#276749' : '#c53030';
    el.style.border = ok ? '1px solid #c6f6d5' : '1px solid #fed7d7';
  }

  function _hideMsg(id) {
    var el = document.getElementById(id);
    if (el) el.style.display = 'none';
  }

  window.__perfilTab = function (tab) {
    ['Dados', 'Senha'].forEach(function (t) {
      var sec = document.getElementById('perfilSec' + t);
      var btn = document.getElementById('perfilTab' + t);
      if (sec) sec.style.display = (t.toLowerCase() === tab) ? 'block' : 'none';
      if (btn) btn.classList.toggle('active', t.toLowerCase() === tab);
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
        avatarEl.style.background = '#6b46c1';
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
      preview.style.background = '#6b46c1';
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
