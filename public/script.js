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

// Deletar usuário
async function deletar(id) {
  await fetch(`/usuarios/${id}`, { method: 'DELETE' });
  carregarUsuarios();
}
