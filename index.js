require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");
const crypto = require("crypto");

const { TransactionalEmailsApi, SendSmtpEmail } = require("@getbrevo/brevo");

const app = express();

app.use(express.json());
app.use(express.static("public"));

/* ==========================
   VERIFICA VARIÁVEIS
========================== */

const requiredEnv = ["MONGO_URI", "BREVO_API_KEY", "JWT_SECRET", "APP_URL"];

requiredEnv.forEach((env) => {
  if (!process.env[env]) {
    console.error(`ERRO: variável ${env} não definida`);
    process.exit(1);
  }
});

/* ==========================
   BREVO EMAIL
========================== */

const emailAPI = new TransactionalEmailsApi();
emailAPI.authentications.apiKey.apiKey = process.env.BREVO_API_KEY;

async function enviarEmail(destino, assunto, html) {
  try {
    const email = new SendSmtpEmail();

    email.subject = assunto;
    email.htmlContent = html;

    email.sender = {
      name: "HOC System",
      email: "kalimacomplex@gmail.com",
    };

    email.to = [{ email: destino }];

    const response = await emailAPI.sendTransacEmail(email);

    console.log("Email enviado:", response.body);
  } catch (err) {
    console.error("Erro ao enviar email:", err.message);
  }
}

/* ==========================
   MONGODB
========================== */

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB conectado"))
  .catch((err) => {
    console.error("Erro MongoDB:", err);
    process.exit(1);
  });

/* ==========================
   MODELS
========================== */

const empresaSchema = new mongoose.Schema({
  nome: { type: String, required: true, unique: true },
  criadoEm: { type: Date, default: Date.now },
});

const Empresa = mongoose.model("Empresa", empresaSchema);

const usuarioSchema = new mongoose.Schema({
  nome: String,
  email: { type: String, unique: true },
  senha: String,

  perfil: { type: String, default: "Usuário" },

  usuarioMestre: { type: Boolean, default: false },

  status: { type: String, default: "Ativo" },

  empresa: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Empresa",
  },

  permissoes: {
    acessoIndependente: Boolean,
    aprovacaoWikis: Boolean,
    aprovacaoIdeias: Boolean,
    gerenciamentoProjetos: Boolean,
    edicaoFluxoValor: Boolean,
    permissaoSeguranca: Boolean,
  },

  criadoEm: { type: Date, default: Date.now },
});

const Usuario = mongoose.model("Usuario", usuarioSchema);

const conviteSchema = new mongoose.Schema({
  email: String,

  empresa: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Empresa",
  },

  token: String,

  permissoes: Object,

  usuarioMestre: Boolean,

  usado: { type: Boolean, default: false },

  expiraEm: {
    type: Date,
    default: () => new Date(Date.now() + 48 * 60 * 60 * 1000),
  },
});

const Convite = mongoose.model("Convite", conviteSchema);

/* ==========================
   AUTH MIDDLEWARE
========================== */

function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) {
    return res.status(401).json({ erro: "Token não fornecido" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    req.usuario = decoded;

    next();
  } catch {
    res.status(401).json({ erro: "Token inválido" });
  }
}

/* ==========================
   ROTAS HTML
========================== */

app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public/login.html"))
);

app.get("/cadastro", (req, res) =>
  res.sendFile(path.join(__dirname, "public/cadastro.html"))
);

app.get("/dashboard", (req, res) =>
  res.sendFile(path.join(__dirname, "public/dashboard.html"))
);

app.get("/aceitar-convite", (req, res) =>
  res.sendFile(path.join(__dirname, "public/aceitar-convite.html"))
);

/* ==========================
   CADASTRO
========================== */

app.post("/api/cadastro", async (req, res) => {
  try {
    const { nome, email, senha, nomeEmpresa } = req.body;

    if (!nome || !email || !senha || !nomeEmpresa)
      return res.status(400).json({ erro: "Campos obrigatórios" });

    const existe = await Usuario.findOne({ email });

    if (existe) return res.status(400).json({ erro: "Email já cadastrado" });

    let empresa = await Empresa.findOne({ nome: nomeEmpresa });

    if (!empresa) empresa = await Empresa.create({ nome: nomeEmpresa });

    const hash = await bcrypt.hash(senha, 10);

    await Usuario.create({
      nome,
      email,
      senha: hash,
      perfil: "Admin",
      usuarioMestre: true,
      empresa: empresa._id,
    });

    res.json({ mensagem: "Conta criada com sucesso" });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

/* ==========================
   LOGIN
========================== */

app.post("/api/login", async (req, res) => {
  try {
    const { email, senha } = req.body;

    const usuario = await Usuario.findOne({ email }).populate("empresa");

    if (!usuario)
      return res.status(400).json({ erro: "Email ou senha incorretos" });

    const ok = await bcrypt.compare(senha, usuario.senha);

    if (!ok)
      return res.status(400).json({ erro: "Email ou senha incorretos" });

    const token = jwt.sign(
      {
        id: usuario._id,
        empresa: usuario.empresa._id,
        nome: usuario.nome,
      },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );

    res.json({ token, usuario });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

/* ==========================
   CONVITES
========================== */

app.post("/api/convites", auth, async (req, res) => {
  try {
    const { email } = req.body;

    const token = crypto.randomBytes(32).toString("hex");

    await Convite.create({
      email,
      empresa: req.usuario.empresa,
      token,
    });

    const link = `${process.env.APP_URL}/aceitar-convite?token=${token}`;

    await enviarEmail(
      email,
      "Convite HOC System",
      `<h2>Você foi convidado</h2>
       <a href="${link}">Aceitar convite</a>`
    );

    res.json({ mensagem: "Convite enviado" });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

/* ==========================
   SERVIDOR
========================== */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Servidor rodando na porta", PORT);
});
