require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ==================== BREVO ====================

async function enviarEmail(para, assunto, html) {
  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'accept': 'application/json', 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ sender: { name: 'HOC System', email: 'kalimacomplex@gmail.com' }, to: [{ email: para }], subject: assunto, htmlContent: html })
    });
    const data = await response.json();
    console.log('Email enviado:', data);
    return data;
  } catch (err) { console.error('Erro ao enviar email:', err); }
}

// ==================== MONGODB ====================

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB conectado!'))
  .catch(err => console.error('Erro MongoDB:', err));

// ==================== MODELS ====================

const empresaSchema = new mongoose.Schema({ nome: { type: String, required: true, unique: true }, criadoEm: { type: Date, default: Date.now } });
const Empresa = mongoose.model('Empresa', empresaSchema);

const usuarioSchema = new mongoose.Schema({
  nome: { type: String, required: true }, email: { type: String, required: true, unique: true }, senha: { type: String },
  perfil: { type: String, default: 'Usuário' }, usuarioMestre: { type: Boolean, default: false }, status: { type: String, default: 'Ativo' },
  empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  permissoes: { acessoIndependente: { type: Boolean, default: false }, aprovacaoWikis: { type: Boolean, default: false }, aprovacaoIdeias: { type: Boolean, default: false }, gerenciamentoProjetos: { type: Boolean, default: false }, edicaoFluxoValor: { type: Boolean, default: false }, permissaoSeguranca: { type: Boolean, default: false } },
  criadoEm: { type: Date, default: Date.now }
});
const Usuario = mongoose.model('Usuario', usuarioSchema);

const conviteSchema = new mongoose.Schema({
  email: { type: String, required: true }, empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  token: { type: String, required: true }, permissoes: { type: Object, default: {} }, usuarioMestre: { type: Boolean, default: false },
  usado: { type: Boolean, default: false }, expiraEm: { type: Date, default: () => new Date(+new Date() + 48*60*60*1000) }
});
const Convite = mongoose.model('Convite', conviteSchema);

const projetoSchema = new mongoose.Schema({
  nome: { type: String, required: true },
  tipo: { type: String, enum: ['tradicional', 'agil'], required: true },
  descricao: { type: String, default: '' },
  categoria: { type: String, default: '' },
  area: { type: String, default: '' },
  responsavel: { type: String, default: '' },
  status: { type: String, default: 'Ativo' },
  tags: { type: String, default: '' },
  dataInicio: { type: String, default: '' },
  dataFim: { type: String, default: '' },
  empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  criadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  tap: { type: Object, default: {} },
  estudosCaso: { type: Array, default: [] },
  escopo: { type: Object, default: {} },
  cronograma: { type: Array, default: [] },
  recursos: { type: Object, default: {} },
  riscos: { type: Array, default: [] },
  qualidade: { type: Object, default: {} },
  changeRequests: { type: Array, default: [] },
  execucao: { type: Object, default: {} },
  encerramento: { type: Object, default: {} },
  sprints: { type: Array, default: [] },
  backlog: { type: Array, default: [] },
  retrospectivas: { type: Array, default: [] },
  criadoEm: { type: Date, default: Date.now },
  atualizadoEm: { type: Date, default: Date.now }
});
const Projeto = mongoose.model('Projeto', projetoSchema);

const templateSchema = new mongoose.Schema({
  nome: { type: String, required: true },
  tipo: { type: String, required: true },
  descricao: { type: String, default: '' },
  conteudo: { type: Object, default: {} },
  empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  criadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  publico: { type: Boolean, default: true },
  criadoEm: { type: Date, default: Date.now }
});
const Template = mongoose.model('Template', templateSchema);

// ==================== MIDDLEWARE ====================

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ erro: 'Token não fornecido' });
  try { const decoded = jwt.verify(token, process.env.JWT_SECRET || 'segredo123'); req.usuario = decoded; next(); }
  catch { res.status(401).json({ erro: 'Token inválido' }); }
}

// ==================== PÁGINAS ====================

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/cadastro', (req, res) => res.sendFile(path.join(__dirname, 'public', 'cadastro.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/overview', (req, res) => res.sendFile(path.join(__dirname, 'public', 'overview.html')));
app.get('/gestao-metas', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gestao-metas.html')));
app.get('/ideias-livres', (req, res) => res.sendFile(path.join(__dirname, 'public', 'ideias-livres.html')));
app.get('/gestao-projetos', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gestao-projetos.html')));
app.get('/projeto-tradicional', (req, res) => res.sendFile(path.join(__dirname, 'public', 'projeto-tradicional.html')));
app.get('/projeto-agil', (req, res) => res.sendFile(path.join(__dirname, 'public', 'projeto-agil.html')));
app.get('/aceitar-convite', (req, res) => res.sendFile(path.join(__dirname, 'public', 'aceitar-convite.html')));
app.get('/plano-usuarios', (req, res) => res.sendFile(path.join(__dirname, 'public', 'plano-usuarios.html')));

// ==================== AUTH ====================

app.post('/api/cadastro', async (req, res) => {
  try {
    const { nome, email, senha, nomeEmpresa } = req.body;
    if (!nome || !email || !senha || !nomeEmpresa) return res.status(400).json({ erro: 'Preencha todos os campos' });
    const emailExiste = await Usuario.findOne({ email });
    if (emailExiste) return res.status(400).json({ erro: 'Email já cadastrado' });
    let empresa = await Empresa.findOne({ nome: nomeEmpresa });
    if (!empresa) empresa = await Empresa.create({ nome: nomeEmpresa });
    const hash = await bcrypt.hash(senha, 10);
    await Usuario.create({ nome, email, senha: hash, perfil: 'Admin', usuarioMestre: true, empresa: empresa._id, permissoes: { acessoIndependente: true, aprovacaoWikis: true, aprovacaoIdeias: true, gerenciamentoProjetos: true, edicaoFluxoValor: true, permissaoSeguranca: true } });
    res.status(201).json({ mensagem: 'Conta criada com sucesso!' });
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    const usuario = await Usuario.findOne({ email }).populate('empresa');
    if (!usuario) return res.status(400).json({ erro: 'Email ou senha incorretos' });
    const senhaCorreta = await bcrypt.compare(senha, usuario.senha);
    if (!senhaCorreta) return res.status(400).json({ erro: 'Email ou senha incorretos' });
    const token = jwt.sign({ id: usuario._id, nome: usuario.nome, email: usuario.email, perfil: usuario.perfil, empresa: usuario.empresa._id, empresaNome: usuario.empresa.nome }, process.env.JWT_SECRET || 'segredo123', { expiresIn: '8h' });
    res.json({ token, usuario: { nome: usuario.nome, email: usuario.email, perfil: usuario.perfil, empresaNome: usuario.empresa.nome } });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== USUÁRIOS ====================

app.get('/api/usuarios', authMiddleware, async (req, res) => {
  try { const usuarios = await Usuario.find({ empresa: req.usuario.empresa }).select('-senha'); res.json(usuarios); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

app.put('/api/usuarios/:id', authMiddleware, async (req, res) => {
  try {
    const { nome, perfil, status } = req.body;
    const usuario = await Usuario.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, { nome, perfil, status }, { new: true }).select('-senha');
    if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado' });
    res.json(usuario);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.delete('/api/usuarios/:id', authMiddleware, async (req, res) => {
  try {
    if (req.params.id === req.usuario.id) return res.status(400).json({ erro: 'Você não pode deletar sua própria conta' });
    const usuario = await Usuario.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa });
    if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado' });
    res.json({ mensagem: 'Usuário deletado com sucesso!' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== CONVITES ====================

app.post('/api/convites', authMiddleware, async (req, res) => {
  try {
    const { email, usuarioMestre, permissoes } = req.body;
    if (!email) return res.status(400).json({ erro: 'Email obrigatório' });
    const usuarioExiste = await Usuario.findOne({ email });
    if (usuarioExiste) return res.status(400).json({ erro: 'Este email já possui uma conta' });
    const token = crypto.randomBytes(32).toString('hex');
    await Convite.create({ email, empresa: req.usuario.empresa, token, usuarioMestre: usuarioMestre || false, permissoes: permissoes || {} });
    const linkConvite = `${process.env.APP_URL}/aceitar-convite?token=${token}`;
    await enviarEmail(email, 'Você foi convidado para o HOC System', `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
        <h2 style="color:#2d1b69">Você recebeu um convite!</h2>
        <p style="color:#718096">Você foi convidado para colaborar no <strong>HOC System</strong>.</p>
        <a href="${linkConvite}" style="display:inline-block;margin:24px 0;padding:14px 28px;background:#2d1b69;color:white;border-radius:8px;text-decoration:none;font-weight:600">Aceitar Convite</a>
        <p style="color:#a0aec0;font-size:13px">Este link expira em 48 horas.</p>
      </div>`);
    res.json({ mensagem: 'Convite enviado com sucesso!' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/convites/:token', async (req, res) => {
  try {
    const convite = await Convite.findOne({ token: req.params.token, usado: false }).populate('empresa');
    if (!convite) return res.status(404).json({ erro: 'Convite inválido ou expirado' });
    if (new Date() > convite.expiraEm) return res.status(400).json({ erro: 'Convite expirado' });
    res.json({ email: convite.email, empresa: convite.empresa.nome, permissoes: convite.permissoes });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/convites/:token/aceitar', async (req, res) => {
  try {
    const { nome, senha } = req.body;
    const convite = await Convite.findOne({ token: req.params.token, usado: false }).populate('empresa');
    if (!convite) return res.status(404).json({ erro: 'Convite inválido ou expirado' });
    if (new Date() > convite.expiraEm) return res.status(400).json({ erro: 'Convite expirado' });
    const hash = await bcrypt.hash(senha, 10);
    await Usuario.create({ nome, email: convite.email, senha: hash, empresa: convite.empresa._id, usuarioMestre: convite.usuarioMestre, perfil: convite.usuarioMestre ? 'Admin' : 'Usuário', permissoes: convite.permissoes });
    convite.usado = true;
    await convite.save();
    res.json({ mensagem: 'Conta criada com sucesso!' });
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

// ==================== PROJETOS ====================

app.get('/api/projetos', authMiddleware, async (req, res) => {
  try { const projetos = await Projeto.find({ empresa: req.usuario.empresa }).sort({ criadoEm: -1 }); res.json(projetos); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/projetos/:id', authMiddleware, async (req, res) => {
  try {
    const projeto = await Projeto.findOne({ _id: req.params.id, empresa: req.usuario.empresa });
    if (!projeto) return res.status(404).json({ erro: 'Projeto não encontrado' });
    res.json(projeto);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/projetos', authMiddleware, async (req, res) => {
  try {
    const projeto = await Projeto.create({ ...req.body, empresa: req.usuario.empresa, criadoPor: req.usuario.id });
    res.status(201).json(projeto);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.put('/api/projetos/:id', authMiddleware, async (req, res) => {
  try {
    const projeto = await Projeto.findOneAndUpdate(
      { _id: req.params.id, empresa: req.usuario.empresa },
      { ...req.body, atualizadoEm: new Date() },
      { new: true }
    );
    if (!projeto) return res.status(404).json({ erro: 'Projeto não encontrado' });
    res.json(projeto);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.delete('/api/projetos/:id', authMiddleware, async (req, res) => {
  try {
    const projeto = await Projeto.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa });
    if (!projeto) return res.status(404).json({ erro: 'Projeto não encontrado' });
    res.json({ mensagem: 'Projeto deletado!' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== TEMPLATES ====================

app.get('/api/templates', authMiddleware, async (req, res) => {
  try { const templates = await Template.find({ empresa: req.usuario.empresa }).sort({ criadoEm: -1 }); res.json(templates); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/templates', authMiddleware, async (req, res) => {
  try {
    const template = await Template.create({ ...req.body, empresa: req.usuario.empresa, criadoPor: req.usuario.id });
    res.status(201).json(template);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.put('/api/templates/:id', authMiddleware, async (req, res) => {
  try {
    const template = await Template.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, req.body, { new: true });
    if (!template) return res.status(404).json({ erro: 'Template não encontrado' });
    res.json(template);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.delete('/api/templates/:id', authMiddleware, async (req, res) => {
  try {
    await Template.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa });
    res.json({ mensagem: 'Template deletado!' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== SERVIDOR ====================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
