require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const crypto = require('crypto');
const SibApiV3Sdk = require('@getbrevo/brevo');

const app = express();

app.use(express.json());
app.use(express.static('public'));


// ==================== BREVO ====================

const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

apiInstance.setApiKey(
  SibApiV3Sdk.TransactionalEmailsApiApiKeys.apiKey,
  process.env.BREVO_API_KEY
);

async function enviarEmail(para, assunto, html) {

  const email = new SibApiV3Sdk.SendSmtpEmail();

  email.to = [{ email: para }];

  email.sender = {
    name: "HOC System",
    email: "kalimacomplex@gmail.com"
  };

  email.subject = assunto;
  email.htmlContent = html;

  return await apiInstance.sendTransacEmail(email);
}


// ==================== MONGODB ====================

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB conectado"))
  .catch(err => console.log("Erro MongoDB:", err));


// ==================== MODELS ====================

const empresaSchema = new mongoose.Schema({
  nome: { type: String, required: true, unique: true },
  criadoEm: { type: Date, default: Date.now }
});

const Empresa = mongoose.model('Empresa', empresaSchema);


const usuarioSchema = new mongoose.Schema({

  nome: { type: String, required: true },

  email: { type: String, required: true, unique: true },

  senha: { type: String },

  perfil: { type: String, default: 'Usuário' },

  usuarioMestre: { type: Boolean, default: false },

  status: { type: String, default: 'Ativo' },

  empresa: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Empresa',
    required: true
  },

  permissoes: {

    acessoIndependente: { type: Boolean, default: false },

    aprovacaoWikis: { type: Boolean, default: false },

    aprovacaoIdeias: { type: Boolean, default: false },

    gerenciamentoProjetos: { type: Boolean, default: false },

    edicaoFluxoValor: { type: Boolean, default: false },

    permissaoSeguranca: { type: Boolean, default: false }

  },

  criadoEm: { type: Date, default: Date.now }

});

const Usuario = mongoose.model('Usuario', usuarioSchema);


const conviteSchema = new mongoose.Schema({

  email: { type: String, required: true },

  empresa: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Empresa',
    required: true
  },

  token: { type: String, required: true },

  permissoes: { type: Object, default: {} },

  usuarioMestre: { type: Boolean, default: false },

  usado: { type: Boolean, default: false },

  expiraEm: {
    type: Date,
    default: () => new Date(+new Date() + 48 * 60 * 60 * 1000)
  }

});

const Convite = mongoose.model('Convite', conviteSchema);


// ==================== MIDDLEWARE ====================

function authMiddleware(req, res, next) {

  const token = req.headers.authorization?.split(' ')[1];

  if (!token)
    return res.status(401).json({ erro: 'Token não fornecido' });

  try {

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || 'segredo123'
    );

    req.usuario = decoded;

    next();

  } catch {

    res.status(401).json({ erro: 'Token inválido' });

  }

}


// ==================== PÁGINAS ====================

app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'login.html'))
);

app.get('/cadastro', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'cadastro.html'))
);

app.get('/dashboard', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'))
);

app.get('/overview', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'overview.html'))
);

app.get('/gestao-metas', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'gestao-metas.html'))
);

app.get('/ideias-livres', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'ideias-livres.html'))
);

app.get('/aceitar-convite', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'aceitar-convite.html'))
);

app.get('/plano-usuarios', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'plano-usuarios.html'))
);


// ==================== CADASTRO ====================

app.post('/api/cadastro', async (req, res) => {

  try {

    const { nome, email, senha, nomeEmpresa } = req.body;

    if (!nome || !email || !senha || !nomeEmpresa)
      return res.status(400).json({ erro: "Preencha todos os campos" });

    const emailExiste = await Usuario.findOne({ email });

    if (emailExiste)
      return res.status(400).json({ erro: "Email já cadastrado" });

    let empresa = await Empresa.findOne({ nome: nomeEmpresa });

    if (!empresa)
      empresa = await Empresa.create({ nome: nomeEmpresa });

    const hash = await bcrypt.hash(senha, 10);

    await Usuario.create({

      nome,
      email,
      senha: hash,

      perfil: "Admin",

      usuarioMestre: true,

      empresa: empresa._id,

      permissoes: {

        acessoIndependente: true,
        aprovacaoWikis: true,
        aprovacaoIdeias: true,
        gerenciamentoProjetos: true,
        edicaoFluxoValor: true,
        permissaoSeguranca: true

      }

    });

    res.status(201).json({ mensagem: "Conta criada com sucesso!" });

  } catch (err) {

    res.status(400).json({ erro: err.message });

  }

});


// ==================== LOGIN ====================

app.post('/api/login', async (req, res) => {

  try {

    const { email, senha } = req.body;

    const usuario = await Usuario
      .findOne({ email })
      .populate("empresa");

    if (!usuario)
      return res.status(400).json({ erro: "Email ou senha incorretos" });

    const senhaCorreta = await bcrypt.compare(senha, usuario.senha);

    if (!senhaCorreta)
      return res.status(400).json({ erro: "Email ou senha incorretos" });

    const token = jwt.sign({

      id: usuario._id,

      nome: usuario.nome,

      email: usuario.email,

      perfil: usuario.perfil,

      empresa: usuario.empresa._id,

      empresaNome: usuario.empresa.nome

    },
      process.env.JWT_SECRET || "segredo123",
      { expiresIn: "8h" }
    );

    res.json({

      token,

      usuario: {

        nome: usuario.nome,
        email: usuario.email,
        perfil: usuario.perfil,
        empresaNome: usuario.empresa.nome

      }

    });

  } catch (err) {

    res.status(500).json({ erro: err.message });

  }

});


// ==================== CONVITES ====================

app.post('/api/convites', authMiddleware, async (req, res) => {

  try {

    const { email, usuarioMestre, permissoes } = req.body;

    if (!email)
      return res.status(400).json({ erro: "Email obrigatório" });

    const usuarioExiste = await Usuario.findOne({ email });

    if (usuarioExiste)
      return res.status(400).json({ erro: "Este email já possui conta" });

    const token = crypto.randomBytes(32).toString("hex");

    await Convite.create({

      email,
      empresa: req.usuario.empresa,
      token,
      usuarioMestre: usuarioMestre || false,
      permissoes: permissoes || {}

    });

    const link = `${process.env.APP_URL}/aceitar-convite?token=${token}`;

    await enviarEmail(

      email,

      "Convite para HOC System",

      `
      <h2>Você foi convidado</h2>
      <p>Clique no link abaixo para entrar:</p>
      <a href="${link}">Aceitar convite</a>
      <p>Este link expira em 48 horas</p>
      `

    );

    res.json({ mensagem: "Convite enviado com sucesso!" });

  } catch (err) {

    res.status(500).json({ erro: err.message });

  }

});


// ==================== ACEITAR CONVITE ====================

app.post('/api/convites/:token/aceitar', async (req, res) => {

  try {

    const { nome, senha } = req.body;

    const convite = await Convite
      .findOne({ token: req.params.token, usado: false })
      .populate("empresa");

    if (!convite)
      return res.status(404).json({ erro: "Convite inválido" });

    if (new Date() > convite.expiraEm)
      return res.status(400).json({ erro: "Convite expirado" });

    const hash = await bcrypt.hash(senha, 10);

    await Usuario.create({

      nome,
      email: convite.email,
      senha: hash,
      empresa: convite.empresa._id,

      usuarioMestre: convite.usuarioMestre,

      perfil: convite.usuarioMestre ? "Admin" : "Usuário",

      permissoes: convite.permissoes

    });

    convite.usado = true;
    await convite.save();

    res.json({ mensagem: "Conta criada com sucesso!" });

  } catch (err) {

    res.status(400).json({ erro: err.message });

  }

});


// ==================== SERVIDOR ====================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
