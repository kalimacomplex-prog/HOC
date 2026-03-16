require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Conexão com o MongoDB Atlas
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB conectado!'))
  .catch(err => console.error('Erro:', err));

// Model de usuário
const Usuario = mongoose.model('Usuario', new mongoose.Schema({
  nome: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  criadoEm: { type: Date, default: Date.now }
}));

// Serve o frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API - Listar usuários
app.get('/usuarios', async (req, res) => {
  try {
    const usuarios = await Usuario.find();
    res.json(usuarios);
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// API - Criar usuário
app.post('/usuarios', async (req, res) => {
  try {
    const { nome, email } = req.body;
    const usuario = await Usuario.create({ nome, email });
    res.status(201).json(usuario);
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

// API - Atualizar usuário
app.put('/usuarios/:id', async (req, res) => {
  try {
    const usuario = await Usuario.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );
    res.json(usuario);
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

// API - Deletar usuário
app.delete('/usuarios/:id', async (req, res) => {
  try {
    await Usuario.findByIdAndDelete(req.params.id);
    res.json({ mensagem: 'Deletado com sucesso!' });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
