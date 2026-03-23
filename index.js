require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));
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

async function verificarAlertasLicencas(empresaId, emailAdmin) {
  try {
    const hoje = new Date();
    const licencas = await Licenca.find({ empresa: empresaId, status: { $in: ['Ativa', 'Vencendo', 'Em Renovação'] } });
    for (const lic of licencas) {
      if (!lic.validade || !lic.alertaDias) continue;
      const validade = new Date(lic.validade);
      const diffDias = Math.ceil((validade - hoje) / (1000 * 60 * 60 * 24));
      if (diffDias <= lic.alertaDias && diffDias >= 0) {
        const emails = [];
        if (emailAdmin) emails.push(emailAdmin);
        if (lic.responsavelEmail && lic.responsavelEmail !== emailAdmin) emails.push(lic.responsavelEmail);
        for (const email of emails) {
          await enviarEmail(email, `⚠️ Licença vencendo em ${diffDias} dias — ${lic.nome}`, `
            <div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px">
              <h2 style="color:#2d1b69">⚠️ Alerta de Vencimento de Licença</h2>
              <p>A licença abaixo vence em <strong>${diffDias} dia(s)</strong>:</p>
              <table style="width:100%;border-collapse:collapse;margin:16px 0">
                <tr><td style="padding:8px;background:#f8fafc;font-weight:600;color:#718096;font-size:12px">NOME</td><td style="padding:8px">${lic.nome}</td></tr>
                <tr><td style="padding:8px;background:#f8fafc;font-weight:600;color:#718096;font-size:12px">CATEGORIA</td><td style="padding:8px">${lic.categoria}</td></tr>
                <tr><td style="padding:8px;background:#f8fafc;font-weight:600;color:#718096;font-size:12px">FORNECEDOR</td><td style="padding:8px">${lic.fornecedor}</td></tr>
                <tr><td style="padding:8px;background:#f8fafc;font-weight:600;color:#718096;font-size:12px">VALIDADE</td><td style="padding:8px">${new Date(lic.validade).toLocaleDateString('pt-BR')}</td></tr>
                <tr><td style="padding:8px;background:#f8fafc;font-weight:600;color:#718096;font-size:12px">RESPONSÁVEL</td><td style="padding:8px">${lic.responsavel}</td></tr>
                <tr><td style="padding:8px;background:#f8fafc;font-weight:600;color:#718096;font-size:12px">PENALIDADE</td><td style="padding:8px">${lic.penalidade}</td></tr>
              </table>
              <a href="${process.env.APP_URL}/gestao-licencas" style="display:inline-block;padding:12px 24px;background:#2d1b69;color:white;border-radius:8px;text-decoration:none;font-weight:600">Ver no HOC System</a>
              <p style="color:#a0aec0;font-size:12px;margin-top:24px">HOC System — Business Manager</p>
            </div>`);
        }
      }
    }
  } catch (err) { console.error('Erro ao verificar alertas:', err); }
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
  nome: { type: String, required: true }, tipo: { type: String, enum: ['tradicional', 'agil'], required: true },
  descricao: { type: String, default: '' }, categoria: { type: String, default: '' }, area: { type: String, default: '' },
  responsavel: { type: String, default: '' }, status: { type: String, default: 'Ativo' }, tags: { type: String, default: '' },
  dataInicio: { type: String, default: '' }, dataFim: { type: String, default: '' },
  empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  criadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  tap: { type: Object, default: {} }, estudosCaso: { type: Array, default: [] }, escopo: { type: Object, default: {} },
  cronograma: { type: Array, default: [] }, recursos: { type: Object, default: {} }, riscos: { type: Array, default: [] },
  qualidade: { type: Object, default: {} }, changeRequests: { type: Array, default: [] }, execucao: { type: Object, default: {} },
  encerramento: { type: Object, default: {} }, sprints: { type: Array, default: [] }, backlog: { type: Array, default: [] },
  retrospectivas: { type: Array, default: [] }, criadoEm: { type: Date, default: Date.now }, atualizadoEm: { type: Date, default: Date.now }
});
const Projeto = mongoose.model('Projeto', projetoSchema);

const templateSchema = new mongoose.Schema({
  nome: { type: String, required: true }, tipo: { type: String, required: true }, descricao: { type: String, default: '' },
  conteudo: { type: Object, default: {} }, empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  criadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' }, publico: { type: Boolean, default: true },
  criadoEm: { type: Date, default: Date.now }
});
const Template = mongoose.model('Template', templateSchema);

const ideiaSchema = new mongoose.Schema({
  titulo: { type: String, required: true }, tipo: { type: String, default: '' }, responsavel: { type: String, default: '' },
  area: { type: String, default: '' }, data: { type: String, default: '' }, complexidade: { type: String, default: '' },
  descricao: { type: String, default: '' }, ganho: { type: String, default: '' }, periodo: { type: String, default: '' },
  tags: { type: String, default: '' }, aprovacao: { type: String, default: 'pendente' }, status: { type: String, default: 'Não Iniciada' },
  autor: { type: String, default: '' }, empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  criadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  criadoEm: { type: Date, default: Date.now }, atualizadoEm: { type: Date, default: Date.now }
});
const Ideia = mongoose.model('Ideia', ideiaSchema);

const bowlerSchema = new mongoose.Schema({
  empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  ano: { type: Number, required: true }, dados: { type: Array, default: [] }, atualizadoEm: { type: Date, default: Date.now }
});
const Bowler = mongoose.model('Bowler', bowlerSchema);

const overviewSchema = new mongoose.Schema({
  empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true, unique: true },
  info: { type: Object, default: {} }, mvv: { type: Object, default: {} }, timeline: { type: Array, default: [] },
  esg: { type: Object, default: {} }, organograma: { type: Object, default: {} }, atualizadoEm: { type: Date, default: Date.now }
});
const Overview = mongoose.model('Overview', overviewSchema);

const wikiSchema = new mongoose.Schema({
  titulo: { type: String, required: true }, conteudo: { type: String, default: '' }, tags: { type: String, default: '' },
  responsavel: { type: String, default: '' }, status: { type: String, default: 'Rascunho' }, versao: { type: String, default: 'v1.0' },
  versoes: { type: Array, default: [] }, empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  criadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  criadoEm: { type: Date, default: Date.now }, atualizadoEm: { type: Date, default: Date.now }
});
const Wiki = mongoose.model('Wiki', wikiSchema);

const licencaSchema = new mongoose.Schema({
  nome: { type: String, required: true },
  categoria: { type: String, default: '' },
  fornecedor: { type: String, default: '' },
  unidade: { type: String, default: '' },
  responsavel: { type: String, default: '' },
  responsavelEmail: { type: String, default: '' },
  dataEmissao: { type: String, default: '' },
  validade: { type: String, default: '' },
  quantidade: { type: String, default: '' },
  custo: { type: Number, default: 0 },
  status: { type: String, default: 'Ativa', enum: ['Ativa', 'Vencendo', 'Vencida', 'Em Renovação'] },
  penalidade: { type: String, default: '' },
  alertaDias: { type: Number, default: 30 },
  observacoes: { type: String, default: '' },
  documentos: [{
    nome: { type: String },
    tipo: { type: String },
    tamanho: { type: Number },
    base64: { type: String }
  }],
  empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  criadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  criadoEm: { type: Date, default: Date.now },
  atualizadoEm: { type: Date, default: Date.now }
});
const Licenca = mongoose.model('Licenca', licencaSchema);

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
app.get('/repositorio-templates', (req, res) => res.sendFile(path.join(__dirname, 'public', 'repositorio-templates.html')));
app.get('/gestao-licencas', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gestao-licencas.html')));
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
    // Verificar alertas de licenças ao fazer login
    verificarAlertasLicencas(usuario.empresa._id, usuario.email).catch(console.error);
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
      { ...req.body, atualizadoEm: new Date() }, { new: true }
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

// ==================== IDEIAS ====================

app.get('/api/ideias', authMiddleware, async (req, res) => {
  try { const ideias = await Ideia.find({ empresa: req.usuario.empresa }).sort({ criadoEm: -1 }); res.json(ideias); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/ideias', authMiddleware, async (req, res) => {
  try {
    const ideia = await Ideia.create({ ...req.body, empresa: req.usuario.empresa, criadoPor: req.usuario.id });
    res.status(201).json(ideia);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.put('/api/ideias/:id', authMiddleware, async (req, res) => {
  try {
    const ideia = await Ideia.findOneAndUpdate(
      { _id: req.params.id, empresa: req.usuario.empresa },
      { ...req.body, atualizadoEm: new Date() }, { new: true }
    );
    if (!ideia) return res.status(404).json({ erro: 'Ideia não encontrada' });
    res.json(ideia);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.delete('/api/ideias/:id', authMiddleware, async (req, res) => {
  try {
    await Ideia.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa });
    res.json({ mensagem: 'Ideia deletada!' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== BOWLER ====================

app.get('/api/bowler/:ano', authMiddleware, async (req, res) => {
  try {
    const bowler = await Bowler.findOne({ empresa: req.usuario.empresa, ano: req.params.ano });
    if (!bowler) return res.json(null);
    res.json(bowler);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.put('/api/bowler/:ano', authMiddleware, async (req, res) => {
  try {
    const bowler = await Bowler.findOneAndUpdate(
      { empresa: req.usuario.empresa, ano: req.params.ano },
      { dados: req.body.dados, atualizadoEm: new Date() },
      { new: true, upsert: true }
    );
    res.json(bowler);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

// ==================== OVERVIEW ====================

app.get('/api/overview', authMiddleware, async (req, res) => {
  try {
    const overview = await Overview.findOne({ empresa: req.usuario.empresa });
    if (!overview) return res.json(null);
    res.json(overview);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.put('/api/overview', authMiddleware, async (req, res) => {
  try {
    const overview = await Overview.findOneAndUpdate(
      { empresa: req.usuario.empresa },
      { ...req.body, atualizadoEm: new Date() },
      { new: true, upsert: true }
    );
    res.json(overview);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

// ==================== WIKIS ====================

app.get('/api/wikis', authMiddleware, async (req, res) => {
  try { const wikis = await Wiki.find({ empresa: req.usuario.empresa }).sort({ criadoEm: -1 }); res.json(wikis); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/wikis', authMiddleware, async (req, res) => {
  try {
    const wiki = await Wiki.create({ ...req.body, empresa: req.usuario.empresa, criadoPor: req.usuario.id });
    res.status(201).json(wiki);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.put('/api/wikis/:id', authMiddleware, async (req, res) => {
  try {
    const wiki = await Wiki.findOneAndUpdate(
      { _id: req.params.id, empresa: req.usuario.empresa },
      { ...req.body, atualizadoEm: new Date() }, { new: true }
    );
    if (!wiki) return res.status(404).json({ erro: 'Wiki não encontrado' });
    res.json(wiki);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.delete('/api/wikis/:id', authMiddleware, async (req, res) => {
  try {
    await Wiki.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa });
    res.json({ mensagem: 'Wiki deletado!' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== LICENÇAS ====================

app.get('/api/licencas', authMiddleware, async (req, res) => {
  try {
    const licencas = await Licenca.find({ empresa: req.usuario.empresa }).select('-documentos.base64').sort({ criadoEm: -1 });
    res.json(licencas);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/licencas/:id', authMiddleware, async (req, res) => {
  try {
    const licenca = await Licenca.findOne({ _id: req.params.id, empresa: req.usuario.empresa });
    if (!licenca) return res.status(404).json({ erro: 'Licença não encontrada' });
    res.json(licenca);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/licencas', authMiddleware, async (req, res) => {
  try {
    const licenca = await Licenca.create({ ...req.body, empresa: req.usuario.empresa, criadoPor: req.usuario.id });
    res.status(201).json(licenca);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.put('/api/licencas/:id', authMiddleware, async (req, res) => {
  try {
    const licenca = await Licenca.findOneAndUpdate(
      { _id: req.params.id, empresa: req.usuario.empresa },
      { ...req.body, atualizadoEm: new Date() }, { new: true }
    );
    if (!licenca) return res.status(404).json({ erro: 'Licença não encontrada' });
    res.json(licenca);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.delete('/api/licencas/:id', authMiddleware, async (req, res) => {
  try {
    await Licenca.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa });
    res.json({ mensagem: 'Licença deletada!' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== SERVIDOR ====================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
