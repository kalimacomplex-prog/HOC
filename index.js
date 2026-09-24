require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const crypto = require('crypto');
const fetch = require('node-fetch');
const nodemailer = require('nodemailer');
const multer = require('multer');
const fs = require('fs');

// URL pública deste servidor (e-mails de tracking, config.json do Agent, runner efêmero do
// GitHub Actions). BASE_URL manda; no Render, RENDER_EXTERNAL_URL vem preenchida sozinha —
// sem esse fallback o runner tentava falar com localhost:3000 de dentro do GitHub.
const PUBLIC_URL = (process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000').replace(/\/+$/, '');

// ==================== ZIP builder (sem dependência externa) ====================
// Usado só pra empacotar o pacote do Agent (config.json + agent.py + iniciar.vbs)
// num único .zip — evita o usuário ter que gerenciar 3 downloads separados
// (o navegador renomeia arquivos duplicados com "(1)", quebrando o instalador
// silenciosamente pois ele espera nomes exatos).
const _CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function _crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = _CRC32_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// files: [{ name: 'agent.py', data: Buffer }]. Método STORED (sem compressão) —
// arquivos são pequenos, prioriza simplicidade/robustez sobre tamanho.
function buildZip(files) {
  const localParts = [], centralParts = [];
  let offset = 0;
  const dosTime = 0, dosDate = (2026 - 1980) << 9 | (1 << 5) | 1; // data fixa, irrelevante aqui

  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = _crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const centralOffset = offset;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, end]);
}

const app = express();

// Webhook Asaas precisa do body RAW — deve vir ANTES do express.json()
app.use('/api/webhook/asaas', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    // .html sempre fresco (mudanças no app têm que aparecer sem hard-refresh) e os
    // arquivos do Agent também — cache de navegador nesses já causou gente testar
    // versão antiga do agent.py/iniciar.vbs mesmo depois de eu corrigir algo.
    if (filePath.endsWith('.html') || filePath.endsWith('.py') || filePath.endsWith('.vbs') || filePath.endsWith('.bat') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      cb(null, Date.now() + '-' + Math.round(Math.random() * 1e6) + ext);
    }
  }),
  limits: { fileSize: 30 * 1024 * 1024 }
});

// ==================== HELPERS UTILITÁRIOS ====================

function validarEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validarCNPJ(cnpj) {
  cnpj = cnpj.replace(/[^\d]/g, '');
  if (cnpj.length !== 14) return false;
  if (/^(\d)\1+$/.test(cnpj)) return false;
  let soma = 0, resto;
  for (let i = 1; i <= 12; i++) soma += parseInt(cnpj[i - 1]) * (i < 5 ? 5 - i + 1 : 13 - i + 1);
  resto = soma % 11;
  if (parseInt(cnpj[12]) !== (resto < 2 ? 0 : 11 - resto)) return false;
  soma = 0;
  for (let i = 1; i <= 13; i++) soma += parseInt(cnpj[i - 1]) * (i < 6 ? 6 - i + 1 : 14 - i + 1);
  resto = soma % 11;
  return parseInt(cnpj[13]) === (resto < 2 ? 0 : 11 - resto);
}

// ==================== ASAAS HELPER ====================

const ASAAS_BASE_URL = process.env.ASAAS_ENV === 'production'
  ? 'https://api.asaas.com/api/v3'
  : 'https://sandbox.asaas.com/api/v3';

async function asaasRequest(method, endpoint, body = null) {
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'access_token': process.env.ASAAS_API_KEY
    }
  };
  if (body) options.body = JSON.stringify(body);
  const response = await fetch(`${ASAAS_BASE_URL}${endpoint}`, options);
  const data = await response.json();
  if (!response.ok) {
    const erroMsg = data?.errors?.[0]?.description || data?.message || JSON.stringify(data);
    throw new Error(`Asaas API erro [${response.status}]: ${erroMsg}`);
  }
  return data;
}

const VALOR_PLANO_CENTAVOS = { basico: 4900, intermediario: 14900, avancado: 34900, enterprise: 0 };
const NOME_PLANO = { basico: 'Básico', intermediario: 'Intermediário', avancado: 'Avançado', enterprise: 'Enterprise' };

// ==================== EMAIL (SMTP via nodemailer) ====================

async function _getSmtpTransporter(empresa) {
  const cfg = await SmtpConfig.findOne({ empresa }).lean();
  if (!cfg || !cfg.servidor) throw new Error('SMTP não configurado. Configure em Configurações → SMTP.');
  return { transporter: nodemailer.createTransport({
    host: cfg.servidor, port: parseInt(cfg.porta)||587,
    secure: parseInt(cfg.porta)===465,
    auth: { user: cfg.usuario, pass: cfg.senha },
    tls: { rejectUnauthorized: false }
  }), cfg };
}

// Empresa dona do HOC — serve de remetente de reserva pra e-mails de sistema (ex.: confirmação de
// cadastro) quando a empresa de destino ainda não tem SMTP próprio configurado (caso de toda
// empresa recém-criada, já que o SMTP só é configurado depois que alguém consegue logar).
const EMPRESA_SMTP_FALLBACK = '69b94dbb2adbe3bba6bf6e70';

// E-mails de sistema (convite, redefinição de senha, alertas) usam o SMTP da própria empresa —
// não existe mais um provedor global (Brevo/Resend) desde a migração pra SMTP por empresa em julho.
// Sem SMTP próprio, cai pro SMTP de reserva; só lança erro se nem esse estiver configurado.
async function enviarEmail(empresa, para, assunto, html) {
  let transporter, cfg;
  try {
    ({ transporter, cfg } = await _getSmtpTransporter(empresa));
  } catch (err) {
    if (String(empresa) === EMPRESA_SMTP_FALLBACK) throw err;
    ({ transporter, cfg } = await _getSmtpTransporter(EMPRESA_SMTP_FALLBACK));
  }
  await transporter.sendMail({ from: cfg.remetente || cfg.usuario, to: para, subject: assunto, html });
}

async function enviarEmailTarefa(tarefaId, empresa, assinaturaHtml) {
  const tarefa = await Tarefa.findById(tarefaId).lean();
  if (!tarefa) throw new Error('Tarefa não encontrada.');
  // Inherit emailTemplateId from model if not set directly on item
  if (!tarefa.emailTemplateId && tarefa.modeloId) {
    const modelo = await Tarefa.findById(tarefa.modeloId).lean();
    if (modelo?.emailTemplateId) tarefa.emailTemplateId = modelo.emailTemplateId;
  }
  if (!tarefa.emailTemplateId) throw new Error('Tarefa sem template de email configurado.');
  const template = await EmailTemplate.findById(tarefa.emailTemplateId).lean();
  if (!template) throw new Error('Template não encontrado.');
  const smtpCfg = await SmtpConfig.findOne({ empresa }).lean();
  if (!smtpCfg || !smtpCfg.servidor) throw new Error('SMTP não configurado.');
  const contatosIds = tarefa.contatosIds || (tarefa.contatoId ? [tarefa.contatoId] : []);
  const gruposIds = tarefa.gruposIds || [];
  let contatos = await Contato.find({ empresa, _id: { $in: contatosIds } }).lean();
  if (gruposIds.length) {
    const grupoContatos = await Contato.find({ empresa, grupo: { $in: gruposIds } }).lean();
    const existingIds = new Set(contatos.map(c => c._id.toString()));
    grupoContatos.forEach(c => { if (!existingIds.has(c._id.toString())) contatos.push(c); });
  }
  if (!contatos.length) throw new Error('Nenhum contato associado.');
  const anexos = tarefa.anexos || [];
  const baseUrl = PUBLIC_URL;
  // Generate tracking tokens per doc
  const tokens = [];
  for (let i = 0; i < anexos.length; i++) {
    const token = crypto.randomBytes(20).toString('hex');
    await LinkTracking.create({ token, tarefaId, empresa, docNome: anexos[i].nome, docIdx: i });
    tokens.push(token);
  }
  // Compute vencData from config if not stored directly on item
  let vencData = tarefa.vencData || '';
  if (!vencData && tarefa.vencTipo && tarefa.prazo) {
    if (tarefa.vencTipo === 'igual_prazo') {
      vencData = tarefa.prazo;
    } else if (tarefa.vencTipo === 'offset_prazo') {
      const _vd = new Date(tarefa.prazo + 'T12:00:00');
      const _v = parseInt(tarefa.vencOffV)||0;
      const _u = tarefa.vencOffU||'dias';
      if (_u==='dias') _vd.setDate(_vd.getDate()+_v);
      else if (_u==='semanas') _vd.setDate(_vd.getDate()+_v*7);
      else if (_u==='meses') _vd.setMonth(_vd.getMonth()+_v);
      else if (_u==='anos') _vd.setFullYear(_vd.getFullYear()+_v);
      vencData = _vd.toISOString().split('T')[0];
    }
  }
  const transporter = nodemailer.createTransport({
    host: smtpCfg.servidor, port: parseInt(smtpCfg.porta)||587,
    secure: parseInt(smtpCfg.porta)===465,
    auth: { user: smtpCfg.usuario, pass: smtpCfg.senha },
    tls: { rejectUnauthorized: false }
  });
  const dataConclusao = tarefa.dataConclusao ? new Date(tarefa.dataConclusao).toLocaleDateString('pt-BR') : '';
  const docLinks = anexos.map((d,i) => {
    const texto = d.nome || d.nomeOriginal || 'Documento';
    return `<a href="${baseUrl}/link/${tokens[i]}" style="color:#2d1b69">${texto}</a>`;
  }).join('<br>');
  const variavelDoc = anexos.map(d => d.obs||'').filter(Boolean).join('; ');
  const variavelAvulsa = tarefa.observacao || tarefa.variavelAvulsa || '';
  const assinHtml = assinaturaHtml || '';
  const buildCorpo = (contato) => {
    const primeiroNome = (contato.nome||'').split(' ')[0];
    let corpo = (template.corpo||'')
      .replace(/\{nomeCompleto\}/g, contato.nome||'')
      .replace(/\{primeiroNome\}/g, primeiroNome)
      .replace(/\{cpfCnpj\}/g, contato.cpfCnpj||'')
      .replace(/\{prazo\}/g, tarefa.prazo||'')
      .replace(/\{competencia\}/g, tarefa.competenciaFixa||tarefa.competencia||'')
      .replace(/\{dataEfetivacao\}/g, dataConclusao)
      .replace(/\{vencimento\}/g, vencData)
      .replace(/\{documentos\}/g, docLinks)
      .replace(/\{variavelDoc\}/g, variavelDoc)
      .replace(/\{variavelAvulsa\}/g, variavelAvulsa)
      .replace(/\{cliente\}/g, contato.nome||'')
      .replace(/\{empresa\}/g, contato.empresa_contato||'')
      .replace(/\{data\}/g, new Date().toLocaleDateString('pt-BR'))
      .replace(/\{assinatura\}/g, assinHtml);
    if (assinHtml && !corpo.includes(assinHtml)) {
      corpo += `<br><br><hr style="border:none;border-top:1px solid #e2e8f0;margin:16px 0">${assinHtml}`;
    }
    return corpo;
  };
  if (gruposIds.length) {
    // Group task: ONE email with all group contacts, first in TO rest in CC
    const comEmail = contatos.filter(c => c.email);
    if (!comEmail.length) throw new Error('Nenhum contato do grupo possui e-mail.');
    const [primeiro, ...resto] = comEmail;
    const corpo = buildCorpo(primeiro);
    const mailOpts = {
      from: smtpCfg.remetente || smtpCfg.usuario,
      to: primeiro.email,
      subject: template.assunto||'',
      html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">${corpo}</div>`,
    };
    if (resto.length) mailOpts.cc = resto.map(c => c.email).join(', ');
    if (tarefa.bccEmails) mailOpts.bcc = tarefa.bccEmails;
    await transporter.sendMail(mailOpts);
  } else {
    // Individual contacts: one email per contact
    for (const contato of contatos) {
      if (!contato.email) continue;
      const corpo = buildCorpo(contato);
      const mailOpts = {
        from: smtpCfg.remetente || smtpCfg.usuario,
        to: contato.email,
        subject: template.assunto||'',
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">${corpo}</div>`,
      };
      if (tarefa.bccEmails) mailOpts.bcc = tarefa.bccEmails;
      await transporter.sendMail(mailOpts);
    }
  }
  await Tarefa.findByIdAndUpdate(tarefaId, { emailEnviado:true, emailEnviadoEm:new Date() }, { strict:false });
}

// ==================== MONGODB ====================

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB conectado!'))
  .catch(err => console.error('Erro MongoDB:', err));

// ==================== MODELS ====================

const empresaSchema = new mongoose.Schema({
  nome: { type: String, required: true },
  cnpj: { type: String, required: true, unique: true },
  criadoEm: { type: Date, default: Date.now }
});
const Empresa = mongoose.model('Empresa', empresaSchema);

const assinaturaSchema = new mongoose.Schema({
  empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true, unique: true },
  plano: { type: String, default: 'basico', enum: ['basico', 'intermediario', 'avancado', 'enterprise'] },
  status: { type: String, default: 'trial', enum: ['trial', 'ativa', 'inadimplente', 'cancelada', 'aguardando_confirmacao'] },
  trialFim: { type: Date },
  vencimento: { type: Date },
  diasCarencia: { type: Number, default: 1 },
  planoSolicitado: { type: String, default: null },
  solicitadoEm: { type: Date, default: null },
  solicitadoPor: { type: String, default: null },
  coraCobrancaId: { type: String, default: null },
  coraBoletoUrl: { type: String, default: null },
  coraPixQrCode: { type: String, default: null },
  coraPixCopiaECola: { type: String, default: null },
  // ===== CAMPOS ASAAS =====
  asaasClienteId: { type: String, default: null },
  asaasAssinaturaId: { type: String, default: null },
  asaasCobrancaId: { type: String, default: null },
  asaasPixCopiaECola: { type: String, default: null },
  asaasBoletoUrl: { type: String, default: null },
  asaasBoletoLinhaDigitavel: { type: String, default: null },
  asaasFormaPagamento: { type: String, default: null },
  asaasPixQrCodeBase64: { type: String, default: null },
  // ========================
  historicoFaturas: { type: Array, default: [] },
  criadoEm: { type: Date, default: Date.now },
  atualizadoEm: { type: Date, default: Date.now }
});
const Assinatura = mongoose.model('Assinatura', assinaturaSchema);

const usuarioSchema = new mongoose.Schema({
  nome: { type: String, required: true }, email: { type: String, required: true, unique: true }, senha: { type: String },
  perfil: { type: String, default: 'Usuário' }, usuarioMestre: { type: Boolean, default: false },
  status: { type: String, default: 'Pendente', enum: ['Ativo', 'Pendente', 'Inativo'] },
  emailConfirmado: { type: Boolean, default: false },
  tokenConfirmacao: { type: String, default: null },
  empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  // ideiasLivres, gestaoProjetos e operacoes não têm campo `editar` de propósito — edição geral
  // é livre pra quem tem `acessar` (só as ações de aprovação têm permissão dedicada nesses módulos).
  permissoes: {
    overview:       { acessar: { type: Boolean, default: true },  editar: { type: Boolean, default: false }, aprovar: { type: Boolean, default: false } },
    ideiasLivres:   { acessar: { type: Boolean, default: true },  aprovar:   { type: Boolean, default: false } },
    gestaoMetas:    { acessar: { type: Boolean, default: true },  editar:    { type: Boolean, default: false } },
    gestaoProjetos: { acessar: { type: Boolean, default: true },  aprovarCriacao: { type: Boolean, default: false }, aprovarExecucao: { type: Boolean, default: false } },
    gestaoLicencas: { acessar: { type: Boolean, default: true },  editar:    { type: Boolean, default: false } },
    operacoes:      { acessar: { type: Boolean, default: true } },
    planoUsuarios:  { acessar: { type: Boolean, default: false }, editarUsuarios: { type: Boolean, default: false }, convidarUsuarios: { type: Boolean, default: false } },
  },
  foto: { type: String, default: null },
  cargo: { type: String, default: '' },
  criadoEm: { type: Date, default: Date.now }
});
const Usuario = mongoose.model('Usuario', usuarioSchema);

const tokenRecuperacaoSchema = new mongoose.Schema({
  usuarioId: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario', required: true },
  token: { type: String, required: true },
  usado: { type: Boolean, default: false },
  expiraEm: { type: Date, default: () => new Date(+new Date() + 60 * 60 * 1000) }
});
const TokenRecuperacao = mongoose.model('TokenRecuperacao', tokenRecuperacaoSchema);

const conviteSchema = new mongoose.Schema({
  email: { type: String, required: true }, empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  token: { type: String, required: true }, permissoes: { type: Object, default: {} }, perfil: { type: String, default: 'Usuário' },
  criadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  usado: { type: Boolean, default: false }, expiraEm: { type: Date, default: () => new Date(+new Date() + 48*60*60*1000) }
});
const Convite = mongoose.model('Convite', conviteSchema);

const projetoSchema = new mongoose.Schema({
  nome: { type: String, required: true }, tipo: { type: String, enum: ['tradicional', 'agil'], required: true },
  descricao: { type: String, default: '' }, categoria: { type: String, default: '' }, area: { type: String, default: '' },
  responsavel: { type: String, default: '' }, status: { type: String, default: 'Ativo' }, tags: { type: String, default: '' },
  dataInicio: { type: String, default: '' }, dataFim: { type: String, default: '' },
  budget: { type: Number, default: 0 }, repositorioId: { type: mongoose.Schema.Types.ObjectId, ref: 'Projeto', default: null },
  empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  criadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  tap: { type: Object, default: {} }, estudosCaso: { type: Array, default: [] }, escopo: { type: Object, default: {} },
  cronograma: { type: Array, default: [] }, recursos: { type: Object, default: {} }, riscos: { type: Array, default: [] },
  qualidade: { type: Object, default: {} }, changeRequests: { type: Array, default: [] }, execucao: { type: Object, default: {} },
  encerramento: { type: Object, default: {} }, sprints: { type: Array, default: [] }, backlog: { type: Array, default: [] },
  retrospectivas: { type: Array, default: [] },
  ecPastas: { type: Array, default: [] }, ecMateriais: { type: Array, default: [] },
  criadoEm: { type: Date, default: Date.now }, atualizadoEm: { type: Date, default: Date.now }
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
  descricao: { type: String, default: '' }, ganho: { type: String, default: '' }, outrosGanhos: { type: String, default: '' }, periodo: { type: String, default: '' },
  tags: { type: String, default: '' }, aprovacao: { type: String, default: 'pendente' }, status: { type: String, default: 'Não Iniciada' },
  autor: { type: String, default: '' }, empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  criadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  criadoEm: { type: Date, default: Date.now }, atualizadoEm: { type: Date, default: Date.now },
  destacada: { type: Boolean, default: false }, destacadaEm: { type: Date, default: null },
  anexos: [{ url: String, nome: String, tamanho: Number }]
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
  esg: { type: Object, default: {} }, organograma: { type: Object, default: {} },
  pastas: { type: Array, default: [] },
  atualizadoEm: { type: Date, default: Date.now }
});
const Overview = mongoose.model('Overview', overviewSchema);

const wikiSchema = new mongoose.Schema({
  titulo: { type: String, required: true }, conteudo: { type: String, default: '' }, tags: { type: String, default: '' },
  responsavel: { type: String, default: '' }, status: { type: String, default: 'Rascunho' }, versao: { type: String, default: 'v1.0' },
  versoes: { type: Array, default: [] },
  pastaId: { type: Number, default: null },
  tipo: { type: String, default: 'wiki' },
  urlExterno: { type: String, default: null },
  nomeArquivo: { type: String, default: null },
  grupoId: { type: mongoose.Schema.Types.ObjectId, default: null },
  ativo: { type: Boolean, default: false },
  empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  criadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  criadoEm: { type: Date, default: Date.now }, atualizadoEm: { type: Date, default: Date.now }
});
const Wiki = mongoose.model('Wiki', wikiSchema);

const licencaSchema = new mongoose.Schema({
  nome: { type: String, required: true }, categoria: { type: String, default: '' }, fornecedor: { type: String, default: '' },
  unidade: { type: String, default: '' }, responsavel: { type: String, default: '' }, responsavelEmail: { type: String, default: '' },
  dataEmissao: { type: String, default: '' }, validade: { type: String, default: '' }, quantidade: { type: String, default: '' },
  custo: { type: Number, default: 0 }, custoUnitario: { type: Number, default: 0 }, frequencia: { type: String, default: 'Mensal' },
  status: { type: String, default: 'Ativa', enum: ['Ativa', 'Vencendo', 'Vencida', 'Em Renovação'] },
  penalidade: { type: String, default: '' }, alertaDias: { type: Number, default: 30 }, observacoes: { type: String, default: '' },
  documentos: [{ nome: { type: String }, tipo: { type: String }, tamanho: { type: Number }, base64: { type: String } }],
  renovacoes: [{ inicio: { type: String }, fim: { type: String }, registradoEm: { type: Date, default: Date.now }, registradoPor: { type: String, default: '' } }],
  empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  criadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  criadoEm: { type: Date, default: Date.now }, atualizadoEm: { type: Date, default: Date.now }
});
const Licenca = mongoose.model('Licenca', licencaSchema);

const fluxoValorSchema = new mongoose.Schema({
  empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true, unique: true },
  blocos: { type: Array, default: [] }, conexoes: { type: Array, default: [] }, textos: { type: Array, default: [] },
  atualizadoEm: { type: Date, default: Date.now }
});
const FluxoValor = mongoose.model('FluxoValor', fluxoValorSchema);

const contatoSchema = new mongoose.Schema({
  nome: { type: String, required: true }, descricao: { type: String, default: '' },
  email: { type: String, default: '' }, telefone: { type: String, default: '' },
  empresa_contato: { type: String, default: '' }, grupo: { type: String, default: 'Clientes' },
  cpfCnpj: { type: String, default: '' }, responsavel: { type: String, default: '' },
  infoAdicionais: { type: String, default: '' },
  empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  criadoEm: { type: Date, default: Date.now }
}, { strict: false });
const Contato = mongoose.model('Contato', contatoSchema);

const emailTemplateSchema = new mongoose.Schema({
  nome: { type: String, required: true }, assunto: { type: String, default: '' },
  corpo: { type: String, default: '' }, variaveis: { type: Array, default: [] },
  categoria: { type: String, default: '' },
  assinaturaId: { type: String, default: '' },
  empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  criadoEm: { type: Date, default: Date.now }, atualizadoEm: { type: Date, default: Date.now }
});
const EmailTemplate = mongoose.model('EmailTemplate', emailTemplateSchema);

const smtpConfigSchema = new mongoose.Schema({
  empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true, unique: true },
  servidor: { type: String, default: '' }, porta: { type: Number, default: 587 },
  usuario: { type: String, default: '' }, senha: { type: String, default: '' },
  remetente: { type: String, default: '' },
});
const SmtpConfig = mongoose.model('SmtpConfig', smtpConfigSchema);

const configIASchema = new mongoose.Schema({
  empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true, unique: true },
  provedor: { type: String, default: 'claude-sonnet' },
  credencialNome: { type: String, default: '' },
  campoCred: { type: String, default: 'api_key' },
});
const ConfigIA = mongoose.model('ConfigIA', configIASchema);

const linkTrackingSchema = new mongoose.Schema({
  token: { type: String, required: true, unique: true },
  tarefaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tarefa' },
  empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa' },
  docNome: { type: String, default: '' }, docIdx: { type: Number, default: 0 },
  criadoEm: { type: Date, default: Date.now },
  acessadoEm: { type: Date, default: null }, acessos: { type: Number, default: 0 },
});
const LinkTracking = mongoose.model('LinkTracking', linkTrackingSchema);

const tarefaSchema = new mongoose.Schema({
  titulo: { type: String, required: true }, descricao: { type: String, default: '' },
  responsaveis: { type: Array, default: [] }, areas: { type: Array, default: [] },
  prazo: { type: String, default: '' }, competencia: { type: String, default: '' },
  tags: { type: Array, default: [] }, status: { type: String, default: 'Pendente', enum: ['Pendente', 'Em Progresso', 'Concluída', 'Dispensada', 'Concluída Atrasada'] },
  prioridade: { type: String, default: 'Media', enum: ['Baixa', 'Media', 'Alta', 'Urgente'] },
  progresso: { type: Number, default: 0 }, grupo: { type: String, default: '' },
  recorrente: { type: Boolean, default: false }, frequencia: { type: String, default: '' },
  contatoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contato' },
  emailTemplateId: { type: mongoose.Schema.Types.ObjectId, ref: 'EmailTemplate' },
  lembretes: { type: Array, default: [] },
  anexos: [{ nome: String, nomeOriginal: String, tipo: String, tamanho: Number, base64: String, prazoVencimento: String, fileUrl: String, obs: String }],
  tarefaVinculadaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tarefa' },
  emailEnviado: { type: Boolean, default: false }, emailAberto: { type: Boolean, default: false },
  empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  criadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  criadoEm: { type: Date, default: Date.now }, atualizadoEm: { type: Date, default: Date.now },
  // HOC extended fields
  isModelo: { type: Boolean, default: false },
  modeloId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tarefa' },
  tipo: { type: String, default: 'unica' },
  prazoTipo: { type: String, default: 'fixa' },
  qtdGeradas: { type: Number, default: 1 },
  compGranularidade: { type: String, default: 'mes' },
  competenciaFixa: { type: String, default: '' },
  contatosIds: { type: Array, default: [] },
  gruposIds: { type: Array, default: [] },
  bccEmails: { type: String, default: '' },
  apelido: { type: String, default: '' },
  detalhamento: { type: String, default: '' },
  agrupamento: { type: String, default: '' },
  observacao: { type: String, default: '' },
  comentarios: { type: Array, default: [] },
  vencTipo: { type: String, default: 'nenhum' },
  vencData: { type: String, default: '' },
  vencGranularidade: { type: String, default: 'mes' },
  vencimentosPorCliente: { type: Array, default: [] },
  prazosFixos: { type: Array, default: [] },
  compTipo: { type: String, default: 'igual_prazo' },
  compOffV: { type: Number, default: 0 },
  compOffU: { type: String, default: 'meses' },
  variavelAvulsa: { type: String, default: '' },
  dataConclusao: { type: Date, default: null },
  emailEnviadoEm: { type: Date, default: null },
}, { strict: false });
const Tarefa = mongoose.model('Tarefa', tarefaSchema);

const processoSchema = new mongoose.Schema({
  nome: { type: String, required: true }, descricao: { type: String, default: '' },
  categoria: { type: String, default: '' }, responsaveis: { type: Array, default: [] },
  areas: { type: Array, default: [] },
  tags: { type: Array, default: [] },
  versao: { type: String, default: 'v1.0' }, ativo: { type: Boolean, default: true },
  // 'paralelo' = todas as tarefas do fluxo ativam de uma vez; 'sequencial' = uma tarefa só ativa quando a anterior (tarefa/robô/ia/wait/email) estiver concluída/dispensada/etc
  ativacaoTarefas: { type: String, default: 'paralelo', enum: ['paralelo', 'sequencial'] },
  // Meta em MINUTOS do início ao fim de uma execução (ProExec.criadoEm -> concluidoEm) — usada no dashboard pra medir % de atingimento
  leadTimeEsperado: { type: Number, default: 0 },
  // Builder canvas: array of {id, tipo, titulo, dados, x, y} + conexoes [{de,para,tipo}]
  elementos: { type: Array, default: [] }, conexoes: { type: Array, default: [] },
  // Documentation tabs
  sipoc: { type: Object, default: {} }, cincoW2H: { type: Object, default: {} },
  swimlane: { type: String, default: '' }, playbook: { type: String, default: '' },
  docAnexos: { type: Array, default: [] },
  // Audit checklists
  checklists: { type: Array, default: [] },
  // Version history
  versoes: { type: Array, default: [] },
  empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  criadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  criadoEm: { type: Date, default: Date.now }, atualizadoEm: { type: Date, default: Date.now }
}, { strict: false });
const Processo = mongoose.model('Processo', processoSchema);

const proExecSchema = new mongoose.Schema({
  processoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Processo' },
  titulo: { type: String, required: true }, descricao: { type: String, default: '' },
  responsaveis: { type: Array, default: [] }, tags: { type: Array, default: [] },
  prazo: { type: String, default: '' },
  status: { type: String, default: 'Em Execução', enum: ['Em Execução','Pausado','Suspenso','Desistente','Concluído com Sucesso','Concluído com Falha'] },
  etapas: { type: Array, default: [] }, // [{elementoId, status, obs, completadoEm, loopPagina}]
  variavelGlobal: { type: Object, default: {} },
  versaoModelo: { type: String, default: '' },
  logs: { type: Array, default: [] },
  empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  criadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  criadoEm: { type: Date, default: Date.now }, atualizadoEm: { type: Date, default: Date.now },
  // Carimbado quando o status vira um dos terminais (Concluído com Sucesso/Falha, Desistente) —
  // usado pra calcular Lead Time no dashboard (criadoEm até concluidoEm).
  concluidoEm: { type: Date, default: null },
}, { strict: false });
const ProExec = mongoose.model('ProExec', proExecSchema);
const PROEXEC_STATUS_TERMINAIS = ['Concluído com Sucesso', 'Concluído com Falha', 'Desistente'];

const robotSchema = new mongoose.Schema({
  nome: { type: String, required: true }, descricao: { type: String, default: '' },
  versao: { type: String, default: 'v1.0' },
  tipo: { type: String, default: 'Background', enum: ['Background', 'Interface'] },
  ambiente: { type: String, default: 'local', enum: ['local', 'nuvem'] },
  // Vínculo do robô
  vinculo: { type: Object, default: {} }, // { tipo:'zip'|'git'|'webhook', zipNome, gitUrl, gitBranch, webhookUrl }
  comandoExecucao: { type: String, default: '' }, // local: command; nuvem: ignored
  webhookPayload: { type: Array, default: [] }, // [{chave, valor}] for cloud
  requirementsTxt: { type: String, default: '' },
  venvCache: { type: String, default: 'cache', enum: ['sempre', 'cache'] },
  // Classificação
  tag: { type: String, default: '' }, categoria: { type: String, default: '' },
  tempoManual: { type: Number, default: 0 }, // minutes human time
  areasBeneficiadas: { type: Array, default: [] },
  sla: { type: Number, default: 0 }, // minutes
  timeout: { type: Number, default: 300 }, // seconds
  prioridade: { type: String, default: 'Media', enum: ['Baixa', 'Media', 'Alta'] },
  // Infraestrutura
  maquinas: { type: Array, default: [] }, // machine/group names
  // Schedules
  schedules: { type: Array, default: [] }, // [{tipo:'manual'|'unico'|'recorrente', dataHora, cron, considerarFeriados, considerarFds, ativo}]
  // Versões/Deploy
  versoes: { type: Array, default: [] }, // [{versao, comando, ativo, criadoEm}]
  // Runtime
  ativo: { type: Boolean, default: true },
  // Métricas (computed/cached)
  totalExecucoes: { type: Number, default: 0 }, totalErros: { type: Number, default: 0 },
  tempoMedioExecucao: { type: Number, default: 0 }, // seconds
  empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  criadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  criadoEm: { type: Date, default: Date.now }, atualizadoEm: { type: Date, default: Date.now },
  apiKey: { type: String, default: () => crypto.randomUUID() },
  // 'comando': fluxo atual (comandoExecucao/webhookUrl). 'builder': robô criado pelo
  // builder visual de automação — execução vai pro automationEngine em vez do
  // dispatch local/webhook tradicional (ver /api/robos/:id/executar).
  origem: { type: String, default: 'comando', enum: ['comando', 'builder'] },
  automacaoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Automacao', default: null },
}, { strict: false });
const Robot = mongoose.model('Robot', robotSchema);

const filaItemSchema = new mongoose.Schema({
  roboId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Robot', required: true },
  empresaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  itemId:    { type: String, default: () => crypto.randomUUID() },
  nome:      { type: String, default: '' },
  status:    { type: String, default: 'aguardando', enum: ['aguardando','em_execucao','concluido','erro'] },
  conteudo:  { type: mongoose.Schema.Types.Mixed, default: {} },
  posicao:   { type: Number, default: 0 },
  criadoEm:  { type: Date, default: Date.now },
  atualizadoEm: { type: Date, default: Date.now }
});
const FilaItem = mongoose.model('FilaItem', filaItemSchema);

const auditoriaRoboSchema = new mongoose.Schema({
  roboId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Robot', required: true },
  empresaId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  usuarioNome:  { type: String, default: '' },
  usuarioEmail: { type: String, default: '' },
  acao:         { type: String, default: '' },
  detalhes:     { type: String, default: '' },
  timestamp:    { type: Date, default: Date.now }
});
const AuditoriaRobo = mongoose.model('AuditoriaRobo', auditoriaRoboSchema);

const execucaoRoboSchema = new mongoose.Schema({
  roboId: { type: mongoose.Schema.Types.ObjectId, ref: 'Robot', required: true },
  roboNome: { type: String, default: '' },
  status: { type: String, default: 'em_execucao', enum: ['em_execucao','na_fila','interrompido','erro','concluido','nao_disparado'] },
  motivoInterrupcao: { type: String, default: '' },
  maquina: { type: String, default: '' },
  gatilho: { type: String, default: 'manual', enum: ['manual','schedule','webhook','workflow'] },
  prioridade: { type: String, default: 'Media' },
  iniciadoEm: { type: Date, default: null }, finalizadoEm: { type: Date, default: null },
  duracao: { type: Number, default: 0 }, // seconds
  logs: { type: Array, default: [] }, // [{timestamp, nivel:'info'|'aviso'|'erro', mensagem}]
  artifacts: { type: Array, default: [] }, // [{nome, tamanho, url}]
  empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  criadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  criadoEm: { type: Date, default: Date.now },
  // Presente só quando a execução veio de um robô origem='builder' — liga pro
  // detalhe step-a-step em AutomacaoRun (a aba Execuções continua mostrando só
  // este registro normalmente; o detalhe fica um nível abaixo).
  automacaoRunId: { type: mongoose.Schema.Types.ObjectId, ref: 'AutomacaoRun', default: null },
}, { strict: false });
const ExecucaoRobo = mongoose.model('ExecucaoRobo', execucaoRoboSchema);

const agenteRoboSchema = new mongoose.Schema({
  nome: { type: String, required: true }, descricao: { type: String, default: '' },
  token: { type: String, default: '' }, // agent auth token
  maquina: { type: String, default: '' }, grupo: { type: String, default: '' },
  status: { type: String, default: 'desconectado', enum: ['conectado','desconectado'] },
  ultimoHeartbeat: { type: Date, default: null },
  robosAtivos: { type: Number, default: 0 }, capacidadeMaxima: { type: Number, default: 3 },
  empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  criadoEm: { type: Date, default: Date.now }, atualizadoEm: { type: Date, default: Date.now }
}, { strict: false });
const AgenteRobo = mongoose.model('AgenteRobo', agenteRoboSchema);

const maquinaSchema = new mongoose.Schema({
  nome:            { type: String, required: true },
  machineId:       { type: String, required: true },
  machineKey:      { type: String, default: '' },
  grupo:           { type: String, default: '' },
  descricao:       { type: String, default: '' },
  capacidadeMaxima:{ type: Number, default: 4 },
  status:          { type: String, default: 'offline', enum: ['online','offline','busy','maintenance'] },
  cpu:             { type: Number, default: 0 },
  ram:             { type: Number, default: 0 },
  robosAtivos:     { type: Number, default: 0 },
  robosAtivosList: { type: Array, default: [] },
  ultimoHeartbeat: { type: Date, default: null },
  maintenanceMode: { type: Boolean, default: false },
  ativo:           { type: Boolean, default: true },
  // Runner do GitHub Actions criado sob demanda pelo automationEngine
  // quando não tem máquina física do tenant online (ver lib/automationEngine.js
  // ::criarMaquinaEfemera) — some sozinha quando o run termina.
  efemera:         { type: Boolean, default: false },
  // Só máquina da Nuvem: execuções rodando nela (usos), senhas de quem espera vaga em ordem de chegada (filaOrdem),
  // marca de "sendo apagada" e desde quando está sem uso — ver
  // lib/automationEngine.js::obterMaquinaEfemera.
  usos:            { type: Number, default: 0 },
  encerrando:      { type: Boolean, default: false },
  ociosaDesde:     { type: Date, default: null },
  filaOrdem:       { type: [String], default: [] },
  empresa:         { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  criadoPor:       { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  criadoEm:        { type: Date, default: Date.now },
  atualizadoEm:    { type: Date, default: Date.now }
}, { strict: false });
// No máximo UMA máquina da Nuvem (runner do GitHub Actions) viva por empresa:
// o índice recusa a 2ª criação mesmo com duas execuções chegando juntas.
maquinaSchema.index({ empresa: 1 }, { unique: true, name: 'uma_maquina_nuvem_por_empresa', partialFilterExpression: { efemera: true, encerrando: false } });
const Maquina = mongoose.model('Maquina', maquinaSchema);

// ==================== AUTOMAÇÃO (builder visual de Robôs) ====================
// Modelo de dados do motor de automação — porte do "HAC Studio" pro conceito de
// Robô do HOC. `steps` é uma árvore recursiva (não uma lista plana): cada step
// pode ter `children` (loop/foreach/while/parallel) ou `children_true`/
// `children_false` (condition/try_catch). Deixado solto (Mixed/strict:false)
// de propósito, no mesmo padrão já usado em Processo.elementos/Robot — brigar
// com o Mongoose pra tipar uma árvore auto-referente não vale a pena aqui.
const automacaoSchema = new mongoose.Schema({
  nome: { type: String, required: true },
  descricao: { type: String, default: '' },
  roboId: { type: mongoose.Schema.Types.ObjectId, ref: 'Robot', default: null },
  gatilho: {
    tipo: { type: String, default: 'manual', enum: ['manual', 'cron', 'webhook'] },
    cron: { type: String, default: '' },
    webhookToken: { type: String, default: '' },
  },
  steps: { type: mongoose.Schema.Types.Mixed, default: [] },
  ativo: { type: Boolean, default: true },
  empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  criadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  criadoEm: { type: Date, default: Date.now }, atualizadoEm: { type: Date, default: Date.now },
}, { strict: false });
automacaoSchema.index({ 'gatilho.webhookToken': 1 });
const Automacao = mongoose.model('Automacao', automacaoSchema);

const automacaoRunSchema = new mongoose.Schema({
  automacaoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Automacao', required: true },
  automacaoNome: { type: String, default: '' },
  execucaoRoboId: { type: mongoose.Schema.Types.ObjectId, ref: 'ExecucaoRobo', default: null },
  empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  gatilhoTipo: { type: String, default: 'manual', enum: ['manual', 'cron', 'webhook'] },
  input: { type: String, default: '' },
  stepsResult: { type: Array, default: [] }, // [{stepId, stepName, stepType, status, output, error, durationMs, conditionResult}]
  output: { type: String, default: null },
  status: { type: String, default: 'running', enum: ['running', 'success', 'failed', 'cancelled'] },
  cancelRequested: { type: Boolean, default: false },
  iniciadoEm: { type: Date, default: Date.now },
  finalizadoEm: { type: Date, default: null },
  duracaoMs: { type: Number, default: 0 },
}, { strict: false });
automacaoRunSchema.index({ automacaoId: 1 });
automacaoRunSchema.index({ empresa: 1 });
const AutomacaoRun = mongoose.model('AutomacaoRun', automacaoRunSchema);

// Dispatch de UM step pra uma Maquina — fila leve consumida pelo heartbeat
// (mesmo contrato de claim atômico que ExecucaoRobo já usa, ver
// /api/maquinas/heartbeat). O motor de execução (lib/automationEngine.js) cria
// uma entrada e faz polling nela até a máquina reportar o resultado.
const automacaoStepDispatchSchema = new mongoose.Schema({
  runId: { type: mongoose.Schema.Types.ObjectId, ref: 'AutomacaoRun', required: true },
  maquinaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Maquina', required: true },
  step: { type: mongoose.Schema.Types.Mixed, required: true }, // {id, type, config}
  ctxSnapshot: { type: mongoose.Schema.Types.Mixed, default: {} }, // {input, output, vars}
  status: { type: String, default: 'pendente', enum: ['pendente', 'enviado', 'concluido', 'erro'] },
  resultado: { type: mongoose.Schema.Types.Mixed, default: null }, // {output, error}
  criadoEm: { type: Date, default: Date.now },
});
automacaoStepDispatchSchema.index({ maquinaId: 1, status: 1 });
const AutomacaoStepDispatch = mongoose.model('AutomacaoStepDispatch', automacaoStepDispatchSchema);

const credencialSchema = new mongoose.Schema({
  nome:         { type: String, required: true },
  proprietario: { type: String, default: '' },
  validade:     { type: String, default: '' },
  campos:       { type: Object, default: {} },
  empresa:      { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  criadoEm:     { type: Date, default: Date.now },
  atualizadoEm: { type: Date, default: Date.now }
}, { strict: false });
const Credencial = mongoose.model('Credencial', credencialSchema);

const notificacaoSchema = new mongoose.Schema({
  empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  titulo: { type: String, required: true }, mensagem: { type: String, default: '' },
  tipo: { type: String, default: 'info', enum: ['info', 'sucesso', 'aviso', 'erro', 'licenca_vencendo', 'licenca_vencida'] },
  icone: { type: String, default: '🔔' }, link: { type: String, default: '' },
  lida: { type: Boolean, default: false }, criadoEm: { type: Date, default: Date.now },
  destinatario: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario', default: null }
});
const Notificacao = mongoose.model('Notificacao', notificacaoSchema);

// ==================== HELPERS ====================

async function criarNotificacao(empresaId, titulo, mensagem, tipo, icone, link, destinatario = null) {
  try { await Notificacao.create({ empresa: empresaId, titulo, mensagem, tipo, icone, link, destinatario }); }
  catch (err) { console.error('Erro ao criar notificação:', err); }
}

// Não existe "notificar por cargo" nativo no modelo — para avisos que devem ir só pros Admins
// (ex.: licença vencendo), cria uma notificação direcionada por Admin em vez de broadcast pra empresa toda.
async function notificarAdmins(empresaId, titulo, mensagem, tipo, icone, link) {
  try {
    const admins = await Usuario.find({ empresa: empresaId, perfil: 'Admin' }).select('_id');
    await Promise.all(admins.map(a => criarNotificacao(empresaId, titulo, mensagem, tipo, icone, link, a._id)));
  } catch (err) { console.error('Erro ao notificar admins:', err); }
}

// Notifica Admin + quem tiver a permissão de aprovação daquele módulo — usado pra "algo foi
// enviado pra aprovar", já que não existe um aprovador único fixo, e sim um grupo com a permissão.
// Detecta se este PUT em /api/projetos/:id contém uma decisão de aprovação de execução
// (TAP, Escopo/EAP, Cronograma, Change Request ou Termo de Encerramento). Como tudo isso é salvo
// pelo mesmo PUT genérico (o front manda o projeto inteiro), comparamos antes/depois: se o número
// de versões/itens marcados como aprovados (ou reprovados, no caso de CR) aumentou, é uma decisão.
function detectaDecisaoExecucaoProjeto(anterior, body) {
  if (body.tap?.status === 'Aprovado' && anterior.tap?.status !== 'Aprovado') return true;
  const contaAprovados = arr => (Array.isArray(arr) ? arr.filter(v => v?.status === 'aprovado').length : 0);
  if (body.escopoVersoes !== undefined && contaAprovados(body.escopoVersoes) > contaAprovados(anterior.escopoVersoes)) return true;
  if (body.cronogramaVersoes !== undefined && contaAprovados(body.cronogramaVersoes) > contaAprovados(anterior.cronogramaVersoes)) return true;
  if (body.changeRequests !== undefined) {
    const contaDecididos = arr => (Array.isArray(arr) ? arr.filter(c => ['aprovado', 'reprovado', 'dispensado'].includes(c?.docStatus)).length : 0);
    if (contaDecididos(body.changeRequests) > contaDecididos(anterior.changeRequests)) return true;
  }
  if (body.encerramento?.termo?.status === 'Aprovado' && anterior.encerramento?.termo?.status !== 'Aprovado') return true;
  return false;
}

// `responsaveis` guarda nomes livres (do organograma), não IDs de Usuario — casa por nome exato
// pra achar quem tem conta no sistema e avisar só quem foi associado agora (não quem já estava).
async function notificarResponsaveisNovos(empresaId, titulo, mensagem, tipo, icone, link, nomesAntigos, nomesNovos) {
  const novos = (nomesNovos || []).filter(n => !(nomesAntigos || []).includes(n));
  if (!novos.length) return;
  try {
    const usuarios = await Usuario.find({ empresa: empresaId, nome: { $in: novos } }).select('_id');
    await Promise.all(usuarios.map(u => criarNotificacao(empresaId, titulo, mensagem, tipo, icone, link, u._id)));
  } catch (err) { console.error('Erro ao notificar responsáveis:', err); }
}

async function verificarAlertasLicencas(empresaId, emailAdmin) {
  try {
    const hoje = new Date();
    const licencas = await Licenca.find({ empresa: empresaId });
    for (const lic of licencas) {
      if (!lic.validade) continue;
      const validade = new Date(lic.validade);
      const diffDias = Math.ceil((validade - hoje) / (1000 * 60 * 60 * 24));
      if (diffDias < 0 && lic.status !== 'Vencida') {
        await Licenca.findByIdAndUpdate(lic._id, { status: 'Vencida' });
        await notificarAdmins(empresaId, `Licença Vencida: ${lic.nome}`, `A licença "${lic.nome}" venceu há ${Math.abs(diffDias)} dia(s).`, 'licenca_vencida', '🔴', '/gestao-licencas');
        if (emailAdmin) await enviarEmail(empresaId, emailAdmin, `🔴 Licença Vencida — ${lic.nome}`, gerarHtmlAlertaLicenca(lic, diffDias)).catch(err => console.error('Erro ao enviar email de licença:', err.message));
        if (lic.responsavelEmail && lic.responsavelEmail !== emailAdmin) await enviarEmail(empresaId, lic.responsavelEmail, `🔴 Licença Vencida — ${lic.nome}`, gerarHtmlAlertaLicenca(lic, diffDias)).catch(err => console.error('Erro ao enviar email de licença:', err.message));
      } else if (diffDias >= 0 && diffDias <= (lic.alertaDias || 30) && lic.status !== 'Vencendo') {
        await Licenca.findByIdAndUpdate(lic._id, { status: 'Vencendo' });
        await notificarAdmins(empresaId, `Licença Vencendo: ${lic.nome}`, `A licença "${lic.nome}" vence em ${diffDias} dia(s).`, 'licenca_vencendo', '⚠️', '/gestao-licencas');
        if (emailAdmin) await enviarEmail(empresaId, emailAdmin, `⚠️ Licença vencendo em ${diffDias} dias — ${lic.nome}`, gerarHtmlAlertaLicenca(lic, diffDias)).catch(err => console.error('Erro ao enviar email de licença:', err.message));
        if (lic.responsavelEmail && lic.responsavelEmail !== emailAdmin) await enviarEmail(empresaId, lic.responsavelEmail, `⚠️ Licença vencendo em ${diffDias} dias — ${lic.nome}`, gerarHtmlAlertaLicenca(lic, diffDias)).catch(err => console.error('Erro ao enviar email de licença:', err.message));
      }
    }
  } catch (err) { console.error('Erro ao verificar alertas:', err); }
}

function gerarHtmlAlertaLicenca(lic, diffDias) {
  const vencida = diffDias < 0;
  return `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px">
    <h2 style="color:${vencida?'#c53030':'#c05621'}">${vencida?'🔴 Licença Vencida':'⚠️ Licença Vencendo'}</h2>
    <p>${vencida?`A licença venceu há <strong>${Math.abs(diffDias)} dia(s)</strong>.`:`A licença vence em <strong>${diffDias} dia(s)</strong>.`}</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0">
      <tr><td style="padding:8px;background:#f8fafc;font-weight:600;color:#718096;font-size:12px">NOME</td><td style="padding:8px">${lic.nome}</td></tr>
      <tr><td style="padding:8px;background:#f8fafc;font-weight:600;color:#718096;font-size:12px">FORNECEDOR</td><td style="padding:8px">${lic.fornecedor||'—'}</td></tr>
      <tr><td style="padding:8px;background:#f8fafc;font-weight:600;color:#718096;font-size:12px">VALIDADE</td><td style="padding:8px">${new Date(lic.validade).toLocaleDateString('pt-BR')}</td></tr>
      <tr><td style="padding:8px;background:#f8fafc;font-weight:600;color:#718096;font-size:12px">RESPONSÁVEL</td><td style="padding:8px">${lic.responsavel||'—'}</td></tr>
      <tr><td style="padding:8px;background:#f8fafc;font-weight:600;color:#718096;font-size:12px">PENALIDADE</td><td style="padding:8px">${lic.penalidade||'—'}</td></tr>
    </table>
    <a href="${process.env.APP_URL}/gestao-licencas" style="display:inline-block;padding:12px 24px;background:#2d1b69;color:white;border-radius:8px;text-decoration:none;font-weight:600">Ver no HOC System</a>
  </div>`;
}

// ==================== MIDDLEWARE ====================

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ erro: 'Token não fornecido' });
  try { const decoded = jwt.verify(token, process.env.JWT_SECRET || 'segredo123'); req.usuario = decoded; next(); }
  catch { res.status(401).json({ erro: 'Token inválido' }); }
}

async function filaAuth(req, res, next) {
  // Aceita JWT (SaaS) ou x-robot-key (ferramenta externa)
  const auth = req.headers['authorization'];
  if (auth?.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'segredo123');
      req.usuario = decoded;
      req.filaEmpresa = decoded.empresa;
      return next();
    } catch {}
  }
  const apiKey = req.headers['x-robot-key'];
  if (apiKey) {
    try {
      const robo = await Robot.findOne({ apiKey }).lean();
      if (!robo) return res.status(401).json({ erro: 'x-robot-key inválida' });
      // aceita tanto o _id do MongoDB quanto a própria apiKey como :id na URL
      if (req.params.id && req.params.id !== robo._id.toString() && req.params.id !== robo.apiKey)
        return res.status(403).json({ erro: 'Chave não autorizada para este robô' });
      req.roboFromKey = robo;
      req.roboId = robo._id;          // sempre o ObjectId real
      req.filaEmpresa = robo.empresa;
      return next();
    } catch (e) { return res.status(500).json({ erro: e.message }); }
  }
  return res.status(401).json({ erro: 'Autenticação necessária: Authorization Bearer ou x-robot-key' });
}

async function verificarAssinatura(req, res, next) {
  try {
    const rotasLiberadas = [
      '/api/assinatura',
      '/api/assinatura/fatura',
      '/api/assinatura/webhook',
      '/api/assinatura/checkout',
      '/api/assinatura/cobranca-ativa',
      '/api/assinatura/solicitar',
      '/api/webhook/asaas',
      '/api/notificacoes',
      '/api/notificacoes/resumo',
      '/api/usuarios',
      '/api/perfil'
    ];
    const rota = req.path;
    if (rotasLiberadas.some(r => rota.startsWith(r))) return next();
    const empresaId = req.usuario?.empresa;
    if (!empresaId) return next();
    const assinatura = await Assinatura.findOne({ empresa: empresaId });
    if (!assinatura) return next();
    const agora = new Date();
    if (assinatura.status === 'trial') {
      if (agora <= assinatura.trialFim) return next();
      await Assinatura.findByIdAndUpdate(assinatura._id, { status: 'inadimplente', atualizadoEm: new Date() });
      return res.status(402).json({ bloqueado: true, motivo: 'trial_expirado', mensagem: 'Seu período de teste gratuito expirou. Regularize sua assinatura para continuar.' });
    }
    if (assinatura.status === 'ativa' || assinatura.status === 'aguardando_confirmacao') return next();
    if (assinatura.status === 'inadimplente') {
      const diasAtraso = Math.floor((agora - assinatura.vencimento) / (1000 * 60 * 60 * 24));
      return res.status(402).json({
        bloqueado: true, motivo: 'fatura_atrasada', diasAtraso,
        mensagem: `Sua fatura está ${diasAtraso} dia(s) em atraso.`,
        boletoUrl: assinatura.asaasBoletoUrl || assinatura.coraBoletoUrl,
        pixCopiaECola: assinatura.asaasPixCopiaECola || assinatura.coraPixCopiaECola
      });
    }
    if (assinatura.status === 'cancelada') return res.status(402).json({ bloqueado: true, motivo: 'assinatura_cancelada', mensagem: 'Sua assinatura foi cancelada.' });
    next();
  } catch (err) { console.error('Erro ao verificar assinatura:', err); next(); }
}

function criarMiddlewarePermissao(modulo, acao) {
  return async function(req, res, next) {
    try {
      // Sempre reconsulta o banco — nunca confia no `perfil` do JWT sozinho. Um token emitido
      // antes de alguém ser rebaixado de Admin continuaria liberando tudo até expirar (até 8h)
      // se a gente confiasse só no claim; assim, o rebaixamento vale já na próxima requisição.
      const usuario = await Usuario.findById(req.usuario.id).select('permissoes perfil');
      if (!usuario) return res.status(401).json({ erro: 'Usuário não encontrado' });
      if (usuario.perfil === 'Admin') return next();
      const permMod = usuario.permissoes?.[modulo];
      if (!permMod || !permMod[acao]) return res.status(403).json({ erro: 'Sem permissão', modulo, acao });
      next();
    } catch (err) { res.status(500).json({ erro: err.message }); }
  };
}

const permOverview       = (acao) => criarMiddlewarePermissao('overview', acao);
const permIdeiasLivres   = (acao) => criarMiddlewarePermissao('ideiasLivres', acao);
const permGestaoMetas    = (acao) => criarMiddlewarePermissao('gestaoMetas', acao);
const permGestaoProjetos = (acao) => criarMiddlewarePermissao('gestaoProjetos', acao);
const permGestaoLicencas = (acao) => criarMiddlewarePermissao('gestaoLicencas', acao);
const permOperacoes      = (acao) => criarMiddlewarePermissao('operacoes', acao);
const permPlanoUsuarios  = (acao) => criarMiddlewarePermissao('planoUsuarios', acao);

// ==================== PÁGINAS ====================
const _SF_OPTS = { etag: false, lastModified: false };
const _noCache = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };

app.get('/permissionamentos', _noCache, (req, res) => res.sendFile(path.join(__dirname, 'public', 'permissionamentos.html'), _SF_OPTS));
app.get('/', _noCache, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html'), _SF_OPTS));
app.get('/cadastro', _noCache, (req, res) => res.sendFile(path.join(__dirname, 'public', 'cadastro.html'), _SF_OPTS));
app.get('/confirmar-email', _noCache, (req, res) => res.sendFile(path.join(__dirname, 'public', 'confirmar-email.html'), _SF_OPTS));
app.get('/recuperar-senha', _noCache, (req, res) => res.sendFile(path.join(__dirname, 'public', 'recuperar-senha.html'), _SF_OPTS));
app.get('/redefinir-senha', _noCache, (req, res) => res.sendFile(path.join(__dirname, 'public', 'redefinir-senha.html'), _SF_OPTS));
app.get('/dashboard', (req, res) => res.redirect('/overview'));
app.get('/overview', _noCache, (req, res) => res.sendFile(path.join(__dirname, 'public', 'overview.html'), _SF_OPTS));
app.get('/gestao-metas', _noCache, (req, res) => res.sendFile(path.join(__dirname, 'public', 'gestao-metas.html'), _SF_OPTS));
app.get('/ideias-livres', _noCache, (req, res) => res.sendFile(path.join(__dirname, 'public', 'ideias-livres.html'), _SF_OPTS));
app.get('/gestao-projetos', _noCache, (req, res) => res.sendFile(path.join(__dirname, 'public', 'gestao-projetos.html'), _SF_OPTS));
app.get('/projeto-tradicional', _noCache, (req, res) => res.sendFile(path.join(__dirname, 'public', 'projeto-tradicional.html'), _SF_OPTS));
app.get('/projeto-agil', _noCache, (req, res) => res.sendFile(path.join(__dirname, 'public', 'projeto-agil.html'), _SF_OPTS));
app.get('/repositorio-templates', _noCache, (req, res) => res.sendFile(path.join(__dirname, 'public', 'repositorio-templates.html'), _SF_OPTS));
app.get('/gestao-licencas', _noCache, (req, res) => res.sendFile(path.join(__dirname, 'public', 'gestao-licencas.html'), _SF_OPTS));
app.get('/operacoes', _noCache, (req, res) => res.sendFile(path.join(__dirname, 'public', 'operacoes.html'), _SF_OPTS));
app.get('/robos', _noCache, (req, res) => res.sendFile(path.join(__dirname, 'public', 'robos.html'), _SF_OPTS));
app.get('/robo-builder', _noCache, (req, res) => res.sendFile(path.join(__dirname, 'public', 'robo-builder.html'), _SF_OPTS));
app.get('/aceitar-convite', _noCache, (req, res) => res.sendFile(path.join(__dirname, 'public', 'aceitar-convite.html'), _SF_OPTS));
app.get('/plano-usuarios', _noCache, (req, res) => res.sendFile(path.join(__dirname, 'public', 'plano-usuarios.html'), _SF_OPTS));

// ==================== AUTH ====================

app.post('/api/cadastro', async (req, res) => {
  try {
    const { nome, email, senha, nomeEmpresa, cnpj } = req.body;
    if (!nome || !email || !senha || !nomeEmpresa || !cnpj) return res.status(400).json({ erro: 'Preencha todos os campos obrigatórios' });
    if (!validarEmail(email)) return res.status(400).json({ erro: 'Email inválido.' });
    const cnpjLimpo = cnpj.replace(/[^\d]/g, '');
    if (!validarCNPJ(cnpjLimpo)) return res.status(400).json({ erro: 'CNPJ inválido.' });
    const emailExiste = await Usuario.findOne({ email });
    if (emailExiste) return res.status(400).json({ erro: 'Email já cadastrado' });
    const cnpjExiste = await Empresa.findOne({ cnpj: cnpjLimpo });
    if (cnpjExiste) return res.status(400).json({ erro: 'CNPJ já cadastrado. Entre em contato com o administrador.' });
    const empresa = await Empresa.create({ nome: nomeEmpresa.trim(), cnpj: cnpjLimpo });
    const trialFim = new Date();
    trialFim.setDate(trialFim.getDate() + 30);
    await Assinatura.create({ empresa: empresa._id, status: 'trial', trialFim, plano: 'basico' });
    const tokenConfirmacao = crypto.randomBytes(32).toString('hex');
    const hash = await bcrypt.hash(senha, 10);
    await Usuario.create({
      nome, email, senha: hash, perfil: 'Admin', usuarioMestre: true,
      status: 'Pendente', emailConfirmado: false, tokenConfirmacao, empresa: empresa._id,
      permissoes: { overview:{acessar:true,editar:true,aprovar:true}, ideiasLivres:{acessar:true,aprovar:true}, gestaoMetas:{acessar:true,editar:true}, gestaoProjetos:{acessar:true,aprovarCriacao:true,aprovarExecucao:true}, gestaoLicencas:{acessar:true,editar:true}, operacoes:{acessar:true}, planoUsuarios:{acessar:true,editarUsuarios:true,convidarUsuarios:true} }
    });
    const linkConfirmacao = `${process.env.APP_URL}/confirmar-email?token=${tokenConfirmacao}`;
    // Empresa recém-criada ainda não tem SMTP configurado (isso só é feito depois de logar) —
    // não deixa o cadastro (já persistido acima) virar erro só porque o email não pôde ser enviado.
    try {
      await enviarEmail(empresa._id, email, 'Confirme seu email — HOC System', `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px"><h2 style="color:#2d1b69">Confirme seu email 📧</h2><p>Olá <strong>${nome}</strong>! Sua conta foi criada.</p><p style="margin-bottom:24px">Você tem <strong>30 dias gratuitos</strong> para explorar o HOC System.</p><a href="${linkConfirmacao}" style="display:inline-block;padding:14px 28px;background:#2d1b69;color:white;border-radius:8px;text-decoration:none;font-weight:600">Confirmar meu email</a></div>`);
    } catch (emailErr) { console.error('Erro ao enviar email de confirmação de cadastro:', emailErr.message); }
    res.status(201).json({ mensagem: 'Conta criada! Verifique seu email para confirmar o cadastro.' });
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.get('/api/confirmar-email/:token', async (req, res) => {
  try {
    const usuario = await Usuario.findOne({ tokenConfirmacao: req.params.token });
    if (!usuario) return res.status(404).json({ erro: 'Link inválido ou expirado.' });
    if (usuario.emailConfirmado) return res.json({ mensagem: 'Email já confirmado.' });
    await Usuario.findByIdAndUpdate(usuario._id, { emailConfirmado: true, status: 'Ativo', tokenConfirmacao: null });
    const assinatura = await Assinatura.findOne({ empresa: usuario.empresa });
    const diasTrial = assinatura ? Math.ceil((assinatura.trialFim - new Date()) / (1000 * 60 * 60 * 24)) : 30;
    await criarNotificacao(usuario.empresa, 'Bem-vindo ao HOC System!', `Você tem ${diasTrial} dias gratuitos para explorar.`, 'sucesso', '', '/dashboard');
    res.json({ mensagem: 'Email confirmado! Você já pode fazer login.' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    const usuario = await Usuario.findOne({ email }).populate('empresa');
    if (!usuario) return res.status(400).json({ erro: 'Email ou senha incorretos' });
    const senhaCorreta = await bcrypt.compare(senha, usuario.senha);
    if (!senhaCorreta) return res.status(400).json({ erro: 'Email ou senha incorretos' });
    if (!usuario.emailConfirmado) return res.status(400).json({ erro: 'Email não confirmado. Verifique sua caixa de entrada.' });
    if (usuario.status === 'Inativo') return res.status(400).json({ erro: 'Conta inativa.' });
    const assinatura = await Assinatura.findOne({ empresa: usuario.empresa._id });
    const statusAssinatura = assinatura ? assinatura.status : 'trial';
    const trialFim = assinatura ? assinatura.trialFim : null;
    const diasTrialRestantes = (statusAssinatura === 'trial' && trialFim) ? Math.max(0, Math.ceil((new Date(trialFim) - new Date()) / (1000 * 60 * 60 * 24))) : null;
    const token = jwt.sign(
      { id: usuario._id, nome: usuario.nome, email: usuario.email, perfil: usuario.perfil, empresa: usuario.empresa._id, empresaNome: usuario.empresa.nome },
      process.env.JWT_SECRET || 'segredo123', { expiresIn: '8h' }
    );
    verificarAlertasLicencas(usuario.empresa._id, usuario.email).catch(console.error);
    res.json({ token, usuario: { nome: usuario.nome, email: usuario.email, perfil: usuario.perfil, empresaNome: usuario.empresa.nome, foto: usuario.foto || null, cargo: usuario.cargo || '' }, assinatura: { status: statusAssinatura, diasTrialRestantes } });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/recuperar-senha', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ erro: 'Email obrigatório' });
    const usuario = await Usuario.findOne({ email });
    if (!usuario) return res.json({ mensagem: 'Se este email estiver cadastrado, você receberá as instruções em breve.' });
    await TokenRecuperacao.updateMany({ usuarioId: usuario._id, usado: false }, { usado: true });
    const token = crypto.randomBytes(32).toString('hex');
    await TokenRecuperacao.create({ usuarioId: usuario._id, token });
    const linkRedefinicao = `${process.env.APP_URL}/redefinir-senha?token=${token}`;
    // Não deixa falha de SMTP vazar se o email existe ou não (resposta é sempre a mesma genérica).
    await enviarEmail(usuario.empresa, email, 'Redefinição de senha — HOC System', `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px"><h2 style="color:#2d1b69">Redefinir senha 🔐</h2><p>Olá <strong>${usuario.nome}</strong>!</p><p style="margin-bottom:24px">Clique abaixo para criar uma nova senha. Este link expira em <strong>1 hora</strong>.</p><a href="${linkRedefinicao}" style="display:inline-block;padding:14px 28px;background:#2d1b69;color:white;border-radius:8px;text-decoration:none;font-weight:600">Redefinir minha senha</a></div>`).catch(err => console.error('Erro ao enviar email de redefinição de senha:', err.message));
    res.json({ mensagem: 'Se este email estiver cadastrado, você receberá as instruções em breve.' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/recuperar-senha/:token', async (req, res) => {
  try {
    const tokenDoc = await TokenRecuperacao.findOne({ token: req.params.token, usado: false });
    if (!tokenDoc) return res.status(404).json({ erro: 'Link inválido ou expirado.' });
    if (new Date() > tokenDoc.expiraEm) return res.status(400).json({ erro: 'Link expirado.' });
    res.json({ valido: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/redefinir-senha/:token', async (req, res) => {
  try {
    const { senha } = req.body;
    if (!senha || senha.length < 6) return res.status(400).json({ erro: 'A senha deve ter pelo menos 6 caracteres.' });
    const tokenDoc = await TokenRecuperacao.findOne({ token: req.params.token, usado: false });
    if (!tokenDoc) return res.status(404).json({ erro: 'Link inválido ou expirado.' });
    if (new Date() > tokenDoc.expiraEm) return res.status(400).json({ erro: 'Link expirado.' });
    const hash = await bcrypt.hash(senha, 10);
    await Usuario.findByIdAndUpdate(tokenDoc.usuarioId, { senha: hash });
    tokenDoc.usado = true; await tokenDoc.save();
    res.json({ mensagem: 'Senha redefinida com sucesso!' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== ASSINATURA ====================

app.get('/api/assinatura', authMiddleware, async (req, res) => {
  try {
    let assinatura = await Assinatura.findOne({ empresa: req.usuario.empresa });
    if (!assinatura) {
      const trialFim = new Date(); trialFim.setDate(trialFim.getDate() + 30);
      assinatura = await Assinatura.create({ empresa: req.usuario.empresa, status: 'trial', trialFim, plano: 'basico' });
    }
    const agora = new Date();
    const diasTrialRestantes = (assinatura.status === 'trial' && assinatura.trialFim) ? Math.max(0, Math.ceil((new Date(assinatura.trialFim) - agora) / (1000 * 60 * 60 * 24))) : null;
    const diasAtraso = (assinatura.status === 'inadimplente' && assinatura.vencimento) ? Math.floor((agora - new Date(assinatura.vencimento)) / (1000 * 60 * 60 * 24)) : null;
    res.json({
      ...assinatura.toObject(),
      diasTrialRestantes, diasAtraso,
      pixCopiaECola: assinatura.asaasPixCopiaECola || assinatura.coraPixCopiaECola || null,
      pixQrCodeBase64: assinatura.asaasPixQrCodeBase64 || null,
      boletoUrl: assinatura.asaasBoletoUrl || assinatura.coraBoletoUrl || null,
      boletoLinhaDigitavel: assinatura.asaasBoletoLinhaDigitavel || null,
      pixChave: process.env.PIX_CHAVE || null,
      pixNome: process.env.PIX_NOME || null,
      pixBanco: process.env.PIX_BANCO || null,
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== ASAAS — CHECKOUT ====================

app.post('/api/assinatura/checkout', authMiddleware, async (req, res) => {
  try {
    const { plano, formaPagamento } = req.body;
    if (!['basico','intermediario','avancado'].includes(plano)) return res.status(400).json({ erro: 'Plano inválido. Enterprise requer contato comercial.' });
    if (!['PIX','BOLETO','CREDIT_CARD'].includes(formaPagamento)) return res.status(400).json({ erro: 'Forma de pagamento inválida. Use PIX, BOLETO ou CREDIT_CARD.' });

    const empresa = await Empresa.findById(req.usuario.empresa);
    if (!empresa) return res.status(404).json({ erro: 'Empresa não encontrada.' });
    const admin = await Usuario.findOne({ empresa: req.usuario.empresa, perfil: 'Admin' }).select('nome email');
    if (!admin) return res.status(404).json({ erro: 'Admin não encontrado.' });

    let assinatura = await Assinatura.findOne({ empresa: req.usuario.empresa });
    let asaasClienteId = assinatura?.asaasClienteId;

    if (!asaasClienteId) {
      try {
        const busca = await asaasRequest('GET', `/customers?cpfCnpj=${empresa.cnpj}`);
        if (busca.data && busca.data.length > 0) asaasClienteId = busca.data[0].id;
      } catch (e) { console.log('Buscando cliente Asaas:', e.message); }
      if (!asaasClienteId) {
        const novoCliente = await asaasRequest('POST', '/customers', { name: empresa.nome, cpfCnpj: empresa.cnpj, email: admin.email, notificationDisabled: false });
        asaasClienteId = novoCliente.id;
        console.log('Cliente Asaas criado:', asaasClienteId);
      }
    }

    if (assinatura?.asaasAssinaturaId) {
      try { await asaasRequest('DELETE', `/subscriptions/${assinatura.asaasAssinaturaId}`); console.log('Assinatura anterior cancelada'); } catch (e) { console.log('Cancelando anterior:', e.message); }
    }

    const proximoVencimento = new Date();
    proximoVencimento.setDate(proximoVencimento.getDate() + 1);
    const dataVencimentoStr = proximoVencimento.toISOString().split('T')[0];

    const novaAssinaturaAsaas = await asaasRequest('POST', '/subscriptions', {
      customer: asaasClienteId, billingType: formaPagamento,
      value: VALOR_PLANO_CENTAVOS[plano] / 100,
      nextDueDate: dataVencimentoStr, cycle: 'MONTHLY',
      description: `HOC System — Plano ${NOME_PLANO[plano]}`,
      externalReference: req.usuario.empresa.toString()
    });
    console.log('Assinatura Asaas criada:', novaAssinaturaAsaas.id);

    let pixCopiaECola = null, pixQrCodeBase64 = null, boletoUrl = null, boletoLinhaDigitavel = null, cobrancaId = null;
    await new Promise(resolve => setTimeout(resolve, 2000));

    try {
      const cobranças = await asaasRequest('GET', `/subscriptions/${novaAssinaturaAsaas.id}/payments`);
      if (cobranças.data && cobranças.data.length > 0) {
        const cobranca = cobranças.data[0];
        cobrancaId = cobranca.id;
        if (formaPagamento === 'PIX') {
          try {
            const pixData = await asaasRequest('GET', `/payments/${cobranca.id}/pixQrCode`);
            pixCopiaECola = pixData.payload || null;
            pixQrCodeBase64 = pixData.encodedImage || null;
          } catch (e) { console.log('Erro PIX:', e.message); }
        }
        if (formaPagamento === 'BOLETO') {
          boletoUrl = cobranca.bankSlipUrl || null;
          try { const bdData = await asaasRequest('GET', `/payments/${cobranca.id}/identificationField`); boletoLinhaDigitavel = bdData.identificationField || null; } catch (e) { console.log('Erro boleto:', e.message); }
        }
      }
    } catch (e) { console.log('Erro ao buscar cobrança:', e.message); }

    const updateData = {
      planoSolicitado: plano, solicitadoEm: new Date(), solicitadoPor: admin.nome,
      status: 'aguardando_confirmacao', asaasClienteId,
      asaasAssinaturaId: novaAssinaturaAsaas.id, asaasCobrancaId: cobrancaId,
      asaasPixCopiaECola: pixCopiaECola, asaasBoletoUrl: boletoUrl,
      asaasBoletoLinhaDigitavel: boletoLinhaDigitavel, asaasFormaPagamento: formaPagamento,
      asaasPixQrCodeBase64: pixQrCodeBase64 || null,
      atualizadoEm: new Date()
    };

    if (assinatura) { assinatura = await Assinatura.findOneAndUpdate({ empresa: req.usuario.empresa }, updateData, { new: true }); }
    else { assinatura = await Assinatura.create({ empresa: req.usuario.empresa, ...updateData }); }

    await notificarAdmins(req.usuario.empresa, `Cobrança gerada — Plano ${NOME_PLANO[plano]}`, `Cobrança gerada via ${formaPagamento}. Aguardando pagamento.`, 'aviso', '', '/plano-usuarios');

    res.json({ mensagem: 'Checkout iniciado! Realize o pagamento para ativar o plano.', formaPagamento, plano, pixCopiaECola, pixQrCodeBase64: pixQrCodeBase64 || null, boletoUrl, boletoLinhaDigitavel, asaasAssinaturaId: novaAssinaturaAsaas.id, cobrancaId });
  } catch (err) { console.error('Erro checkout Asaas:', err); res.status(500).json({ erro: err.message || 'Erro ao processar checkout.' }); }
});

// Buscar cobrança ativa — polling do frontend
app.get('/api/assinatura/cobranca-ativa', authMiddleware, async (req, res) => {
  try {
    const assinatura = await Assinatura.findOne({ empresa: req.usuario.empresa });
    if (!assinatura || !assinatura.asaasCobrancaId) return res.json({ status: null });
    let cobranca = null;
    try { cobranca = await asaasRequest('GET', `/payments/${assinatura.asaasCobrancaId}`); } catch (e) { return res.json({ status: 'ERRO', erro: e.message }); }
    let pixCopiaECola = assinatura.asaasPixCopiaECola;
    let boletoUrl = assinatura.asaasBoletoUrl;
    if (!pixCopiaECola && assinatura.asaasFormaPagamento === 'PIX') {
      try { const pixData = await asaasRequest('GET', `/payments/${assinatura.asaasCobrancaId}/pixQrCode`); pixCopiaECola = pixData.payload || null; if (pixCopiaECola) await Assinatura.findOneAndUpdate({ empresa: req.usuario.empresa }, { asaasPixCopiaECola: pixCopiaECola }); } catch (e) {}
    }
    if (!boletoUrl && assinatura.asaasFormaPagamento === 'BOLETO') {
      boletoUrl = cobranca.bankSlipUrl || null;
      if (boletoUrl) await Assinatura.findOneAndUpdate({ empresa: req.usuario.empresa }, { asaasBoletoUrl: boletoUrl });
    }
    res.json({ status: cobranca.status, value: cobranca.value, dueDate: cobranca.dueDate, pixCopiaECola, pixQrCodeBase64: assinatura.asaasPixQrCodeBase64 || null, boletoUrl, boletoLinhaDigitavel: assinatura.asaasBoletoLinhaDigitavel, formaPagamento: assinatura.asaasFormaPagamento });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== WEBHOOK ASAAS ====================

app.post('/api/webhook/asaas', async (req, res) => {
  try {
    const tokenRecebido = req.headers['asaas-access-token'] || req.headers['access-token'] || '';
    const tokenEsperado = process.env.ASAAS_WEBHOOK_TOKEN || '';
    if (tokenEsperado && tokenRecebido !== tokenEsperado) { console.log('Webhook Asaas: token inválido'); return res.status(401).json({ erro: 'Token inválido' }); }

    let body;
    try { body = JSON.parse(req.body.toString()); } catch (e) { body = req.body; }
    const { event, payment, subscription } = body;
    console.log('Webhook Asaas recebido:', event, payment?.id || subscription?.id);

    if (event === 'PAYMENT_RECEIVED' || event === 'PAYMENT_CONFIRMED') {
      const assinatura = await Assinatura.findOne({ $or: [{ asaasCobrancaId: payment?.id }, { asaasAssinaturaId: payment?.subscription }] });
      if (assinatura) {
        const plano = assinatura.planoSolicitado || assinatura.plano;
        const vencimento = new Date(); vencimento.setDate(vencimento.getDate() + 30);
        const novaFatura = { plano, valor: payment?.value ? Math.round(payment.value * 100) : VALOR_PLANO_CENTAVOS[plano], vencimento, pagoEm: new Date(), confirmadoPor: 'asaas_webhook', asaasPaymentId: payment?.id };
        await Assinatura.findByIdAndUpdate(assinatura._id, { plano, status: 'ativa', vencimento, planoSolicitado: null, solicitadoEm: null, solicitadoPor: null, asaasCobrancaId: payment?.id || assinatura.asaasCobrancaId, atualizadoEm: new Date(), $push: { historicoFaturas: novaFatura } });
        await notificarAdmins(assinatura.empresa, `Pagamento confirmado — Plano ${NOME_PLANO[plano] || plano}`, 'Seu pagamento foi confirmado automaticamente. Acesso liberado!', 'sucesso', '', '/plano-usuarios');
        console.log('Assinatura ativada via webhook:', assinatura.empresa);
      }
    }
    else if (event === 'PAYMENT_OVERDUE') {
      const assinatura = await Assinatura.findOne({ $or: [{ asaasCobrancaId: payment?.id }, { asaasAssinaturaId: payment?.subscription }] });
      if (assinatura && assinatura.status === 'ativa') {
        await Assinatura.findByIdAndUpdate(assinatura._id, { status: 'inadimplente', vencimento: payment?.dueDate ? new Date(payment.dueDate) : new Date(), atualizadoEm: new Date() });
        await notificarAdmins(assinatura.empresa, 'Pagamento em atraso', 'Identificamos um atraso no pagamento. Regularize para continuar usando o HOC System.', 'aviso', '', '/plano-usuarios');
        console.log('Inadimplente via webhook:', assinatura.empresa);
      }
    }
    else if (event === 'SUBSCRIPTION_DELETED') {
      const assinatura = await Assinatura.findOne({ asaasAssinaturaId: subscription?.id });
      if (assinatura) {
        await Assinatura.findByIdAndUpdate(assinatura._id, { status: 'cancelada', atualizadoEm: new Date() });
        await notificarAdmins(assinatura.empresa, 'Assinatura cancelada', 'Sua assinatura foi cancelada. Entre em contato para reativá-la.', 'erro', '', '/plano-usuarios');
        console.log('Cancelada via webhook:', assinatura.empresa);
      }
    }
    else if (event === 'PAYMENT_CREATED') {
      const assinatura = await Assinatura.findOne({ asaasAssinaturaId: payment?.subscription });
      if (assinatura && payment?.id) {
        await Assinatura.findByIdAndUpdate(assinatura._id, { asaasCobrancaId: payment.id, asaasPixCopiaECola: null, asaasBoletoUrl: null, asaasBoletoLinhaDigitavel: null, atualizadoEm: new Date() });
        console.log('Nova cobrança mensal registrada:', payment.id);
      }
    }
    res.json({ ok: true });
  } catch (err) { console.error('Erro no webhook Asaas:', err); res.status(500).json({ erro: err.message }); }
});


// ==================== ASAAS — CHECKOUT CARTÃO ====================

app.post('/api/assinatura/checkout-cartao', authMiddleware, async (req, res) => {
  try {
    const { plano, cartao, parcelas } = req.body;
    if (!['basico','intermediario','avancado'].includes(plano)) return res.status(400).json({ erro: 'Plano inválido.' });
    if (!cartao?.numero || !cartao?.nome || !cartao?.mes || !cartao?.ano || !cartao?.cvv || !cartao?.cpfCnpj) return res.status(400).json({ erro: 'Dados do cartão incompletos.' });

    const empresa = await Empresa.findById(req.usuario.empresa);
    if (!empresa) return res.status(404).json({ erro: 'Empresa não encontrada.' });
    const admin = await Usuario.findOne({ empresa: req.usuario.empresa, perfil: 'Admin' }).select('nome email');

    let assinatura = await Assinatura.findOne({ empresa: req.usuario.empresa });
    let asaasClienteId = assinatura?.asaasClienteId;

    // Criar ou reutilizar cliente Asaas
    if (!asaasClienteId) {
      try {
        const busca = await asaasRequest('GET', `/customers?cpfCnpj=${empresa.cnpj}`);
        if (busca.data && busca.data.length > 0) asaasClienteId = busca.data[0].id;
      } catch (e) {}
      if (!asaasClienteId) {
        const novoCliente = await asaasRequest('POST', '/customers', { name: empresa.nome, cpfCnpj: empresa.cnpj, email: admin?.email, notificationDisabled: false });
        asaasClienteId = novoCliente.id;
      }
    }

    // Cancelar assinatura anterior se existir
    if (assinatura?.asaasAssinaturaId) {
      try { await asaasRequest('DELETE', `/subscriptions/${assinatura.asaasAssinaturaId}`); } catch (e) {}
    }

    const proximoVencimento = new Date();
    proximoVencimento.setDate(proximoVencimento.getDate() + 1);
    const dataVencimentoStr = proximoVencimento.toISOString().split('T')[0];

    // Criar assinatura com cartão
    const payload = {
      customer: asaasClienteId,
      billingType: 'CREDIT_CARD',
      value: VALOR_PLANO_CENTAVOS[plano] / 100,
      nextDueDate: dataVencimentoStr,
      cycle: 'MONTHLY',
      description: `HOC System — Plano ${NOME_PLANO[plano]}`,
      externalReference: req.usuario.empresa.toString(),
      installmentCount: parcelas && parcelas > 1 ? parcelas : undefined,
      creditCard: {
        holderName: cartao.nome,
        number: cartao.numero,
        expiryMonth: cartao.mes,
        expiryYear: cartao.ano,
        ccv: cartao.cvv
      },
      creditCardHolderInfo: {
        name: cartao.nome,
        email: admin?.email || '',
        cpfCnpj: cartao.cpfCnpj,
        postalCode: '01310100',
        addressNumber: '1',
        phone: ''
      }
    };

    const novaAssinaturaAsaas = await asaasRequest('POST', '/subscriptions', payload);
    console.log('Assinatura cartão criada:', novaAssinaturaAsaas.id);

    // Se aprovado imediatamente
    const planoAtivado = novaAssinaturaAsaas.status === 'ACTIVE';
    const vencimento = new Date(); vencimento.setDate(vencimento.getDate() + 30);

    const updateData = {
      planoSolicitado: planoAtivado ? null : plano,
      solicitadoEm: planoAtivado ? null : new Date(),
      solicitadoPor: planoAtivado ? null : admin?.nome,
      plano: planoAtivado ? plano : assinatura?.plano,
      status: planoAtivado ? 'ativa' : 'aguardando_confirmacao',
      vencimento: planoAtivado ? vencimento : assinatura?.vencimento,
      asaasClienteId,
      asaasAssinaturaId: novaAssinaturaAsaas.id,
      asaasFormaPagamento: 'CREDIT_CARD',
      atualizadoEm: new Date()
    };

    if (planoAtivado) {
      const novaFatura = { plano, valor: VALOR_PLANO_CENTAVOS[plano], vencimento, pagoEm: new Date(), confirmadoPor: 'asaas_cartao' };
      updateData.$push = { historicoFaturas: novaFatura };
    }

    if (assinatura) {
      assinatura = await Assinatura.findOneAndUpdate({ empresa: req.usuario.empresa }, updateData, { new: true });
    } else {
      assinatura = await Assinatura.create({ empresa: req.usuario.empresa, ...updateData });
    }

    if (planoAtivado) {
      await notificarAdmins(req.usuario.empresa, `Plano ${NOME_PLANO[plano]} ativado!`, 'Pagamento via cartão aprovado. Acesso liberado!', 'sucesso', '', '/plano-usuarios');
    }

    res.json({ mensagem: planoAtivado ? 'Pagamento aprovado! Plano ativado.' : 'Processando pagamento...', aprovado: planoAtivado, asaasAssinaturaId: novaAssinaturaAsaas.id });
  } catch (err) {
    console.error('Erro checkout cartão:', err);
    // Tratar erros específicos do Asaas
    const msg = err.message || '';
    if (msg.includes('invalid') || msg.includes('card')) return res.status(400).json({ erro: 'Dados do cartão inválidos. Verifique e tente novamente.' });
    if (msg.includes('declined') || msg.includes('recusado')) return res.status(400).json({ erro: 'Cartão recusado. Tente outro cartão ou forma de pagamento.' });
    res.status(500).json({ erro: msg || 'Erro ao processar pagamento com cartão.' });
  }
});

// ==================== SOLICITAR PLANO (fallback manual) ====================

app.post('/api/assinatura/solicitar', authMiddleware, async (req, res) => {
  try {
    const { plano } = req.body;
    const planosValidos = ['basico', 'intermediario', 'avancado', 'enterprise'];
    if (!planosValidos.includes(plano)) return res.status(400).json({ erro: 'Plano inválido' });
    const usuarioReq = await Usuario.findById(req.usuario.id).select('nome email');
    if (!usuarioReq) return res.status(404).json({ erro: 'Usuário não encontrado' });
    let assinatura = await Assinatura.findOne({ empresa: req.usuario.empresa });
    const updateData = { planoSolicitado: plano, solicitadoEm: new Date(), solicitadoPor: usuarioReq.nome, status: 'aguardando_confirmacao', atualizadoEm: new Date() };
    if (assinatura) { assinatura = await Assinatura.findOneAndUpdate({ empresa: req.usuario.empresa }, updateData, { new: true }); }
    else { assinatura = await Assinatura.create({ empresa: req.usuario.empresa, ...updateData }); }
    await notificarAdmins(req.usuario.empresa, `Pagamento aguardando confirmação`, `${usuarioReq.nome} solicitou o Plano ${NOME_PLANO[plano]}. Confirme o pagamento para liberar o acesso.`, 'aviso', '', '/plano-usuarios');
    try {
      const admin = await Usuario.findOne({ empresa: req.usuario.empresa, perfil: 'Admin' }).select('email nome');
      if (admin) await enviarEmail(req.usuario.empresa, admin.email, `💳 HOC System — Pagamento aguardando confirmação`, `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px"><h2 style="color:#2d1b69">Pagamento aguardando confirmação</h2><p>${usuarioReq.nome} realizou o pagamento e solicitou a ativação do <strong>Plano ${NOME_PLANO[plano]}</strong>.</p><a href="${process.env.APP_URL}/plano-usuarios" style="display:inline-block;margin-top:20px;padding:12px 24px;background:#2d1b69;color:white;border-radius:8px;text-decoration:none;font-weight:600">Confirmar Pagamento</a></div>`);
    } catch(emailErr) { console.error('Erro email admin:', emailErr); }
    res.json({ mensagem: 'Solicitação registrada! Aguarde a confirmação.', assinatura });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== ADMIN — PAINEL DE PAGAMENTOS ====================

function adminSecretMiddleware(req, res, next) {
  const secret = (req.headers['x-admin-secret'] || '').trim();
  const adminSecret = (process.env.ADMIN_SECRET || '').trim();
  if (!secret || !adminSecret || secret !== adminSecret) return res.status(403).json({ erro: 'Acesso negado.' });
  next();
}

app.post('/api/admin/verificar-senha', (req, res) => {
  const { senha } = req.body;
  const adminSecret = (process.env.ADMIN_SECRET || '').trim();
  if (!senha || !adminSecret || senha.trim() !== adminSecret) return res.status(401).json({ erro: 'Senha incorreta.' });
  res.json({ ok: true });
});

app.get('/api/admin/pagamentos-pendentes', adminSecretMiddleware, async (req, res) => {
  try {
    const assinaturas = await Assinatura.find({ status: 'aguardando_confirmacao' }).populate('empresa', 'nome cnpj').sort({ solicitadoEm: -1 });
    const valorPlano = { basico:'R$ 49,00', intermediario:'R$ 149,00', avancado:'R$ 349,00', enterprise:'Sob consulta' };
    res.json(assinaturas.map(a => ({ _id: a._id, empresaId: a.empresa?._id, empresaNome: a.empresa?.nome||'—', empresaCnpj: a.empresa?.cnpj||'—', planoSolicitado: a.planoSolicitado, planoNome: NOME_PLANO[a.planoSolicitado]||a.planoSolicitado, planoValor: valorPlano[a.planoSolicitado]||'—', solicitadoPor: a.solicitadoPor, solicitadoEm: a.solicitadoEm, asaasAssinaturaId: a.asaasAssinaturaId, formaPagamento: a.asaasFormaPagamento||'manual' })));
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/admin/confirmar-pagamento', adminSecretMiddleware, async (req, res) => {
  try {
    const { empresaId } = req.body;
    if (!empresaId) return res.status(400).json({ erro: 'empresaId obrigatório.' });
    const assinatura = await Assinatura.findOne({ empresa: empresaId, status: 'aguardando_confirmacao' });
    if (!assinatura) return res.status(404).json({ erro: 'Nenhuma solicitação pendente.' });
    const plano = assinatura.planoSolicitado || assinatura.plano;
    const vencimento = new Date(); vencimento.setDate(vencimento.getDate() + 30);
    const valorPlano = { basico:4900, intermediario:14900, avancado:34900, enterprise:0 };
    const novaFatura = { plano, valor: valorPlano[plano], vencimento, pagoEm: new Date(), confirmadoPor: 'admin_manual' };
    await Assinatura.findOneAndUpdate({ empresa: empresaId }, { plano, status: 'ativa', vencimento, planoSolicitado: null, solicitadoEm: null, solicitadoPor: null, atualizadoEm: new Date(), $push: { historicoFaturas: novaFatura } });
    await notificarAdmins(empresaId, `Plano ${NOME_PLANO[plano]} ativado!`, 'Seu pagamento foi confirmado. O acesso completo está liberado.', 'sucesso', '', '/plano-usuarios');
    res.json({ mensagem: `Plano ${NOME_PLANO[plano]} confirmado.` });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/admin/rejeitar-pagamento', adminSecretMiddleware, async (req, res) => {
  try {
    const { empresaId, motivo } = req.body;
    if (!empresaId) return res.status(400).json({ erro: 'empresaId obrigatório.' });
    const assinatura = await Assinatura.findOne({ empresa: empresaId, status: 'aguardando_confirmacao' });
    if (!assinatura) return res.status(404).json({ erro: 'Nenhuma solicitação pendente.' });
    const statusAnterior = assinatura.vencimento ? 'inadimplente' : 'trial';
    await Assinatura.findOneAndUpdate({ empresa: empresaId }, { status: statusAnterior, planoSolicitado: null, solicitadoEm: null, solicitadoPor: null, atualizadoEm: new Date() });
    await notificarAdmins(empresaId, `Pagamento não confirmado`, motivo || 'Não foi possível confirmar o pagamento. Entre em contato.', 'erro', '', '/plano-usuarios');
    res.json({ mensagem: 'Pagamento rejeitado.' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/admin/contas-ativas', adminSecretMiddleware, async (req, res) => {
  try {
    const assinaturas = await Assinatura.find({ status: 'ativa' }).populate('empresa', 'nome cnpj criadoEm').sort({ atualizadoEm: -1 });
    const valorPlano = { basico:'R$ 49,00', intermediario:'R$ 149,00', avancado:'R$ 349,00', enterprise:'Sob consulta' };
    res.json(assinaturas.map(a => ({ _id: a._id, empresaId: a.empresa?._id, empresaNome: a.empresa?.nome||'—', empresaCnpj: a.empresa?.cnpj||'—', plano: a.plano, planoNome: NOME_PLANO[a.plano]||a.plano, planoValor: valorPlano[a.plano]||'—', vencimento: a.vencimento, atualizadoEm: a.atualizadoEm, asaasAssinaturaId: a.asaasAssinaturaId||null })));
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/admin/contas-bloqueadas', adminSecretMiddleware, async (req, res) => {
  try {
    const assinaturas = await Assinatura.find({ status: { $in: ['inadimplente', 'cancelada', 'trial'] } }).populate('empresa', 'nome cnpj criadoEm').sort({ atualizadoEm: -1 });
    const statusLabel = { inadimplente:'Inadimplente', cancelada:'Cancelada', trial:'Trial' };
    res.json(assinaturas.map(a => ({ _id: a._id, empresaId: a.empresa?._id, empresaNome: a.empresa?.nome||'—', empresaCnpj: a.empresa?.cnpj||'—', plano: a.plano, planoNome: NOME_PLANO[a.plano]||a.plano, status: a.status, statusLabel: statusLabel[a.status]||a.status, vencimento: a.vencimento, atualizadoEm: a.atualizadoEm, diasAtraso: a.status==='inadimplente'&&a.vencimento ? Math.floor((new Date()-new Date(a.vencimento))/(1000*60*60*24)) : null })));
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/admin/historico-pagamentos', adminSecretMiddleware, async (req, res) => {
  try {
    const assinaturas = await Assinatura.find({ 'historicoFaturas.0': { $exists: true } }).populate('empresa', 'nome cnpj').sort({ atualizadoEm: -1 });
    const valorPlano = { basico:4900, intermediario:14900, avancado:34900, enterprise:0 };
    const historico = [];
    assinaturas.forEach(a => { (a.historicoFaturas||[]).forEach(f => { historico.push({ empresaId: a.empresa?._id, empresaNome: a.empresa?.nome||'—', empresaCnpj: a.empresa?.cnpj||'—', plano: f.plano, planoNome: NOME_PLANO[f.plano]||f.plano, valor: f.valor||valorPlano[f.plano]||0, vencimento: f.vencimento, pagoEm: f.pagoEm, confirmadoPor: f.confirmadoPor||'admin', asaasPaymentId: f.asaasPaymentId||null }); }); });
    historico.sort((a, b) => new Date(b.pagoEm) - new Date(a.pagoEm));
    res.json(historico);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/admin/dashboard', adminSecretMiddleware, async (req, res) => {
  try {
    const [ativas, inadimplentes, canceladas, trial, pendentes, totalEmpresas] = await Promise.all([
      Assinatura.countDocuments({ status: 'ativa' }), Assinatura.countDocuments({ status: 'inadimplente' }),
      Assinatura.countDocuments({ status: 'cancelada' }), Assinatura.countDocuments({ status: 'trial' }),
      Assinatura.countDocuments({ status: 'aguardando_confirmacao' }), Empresa.countDocuments()
    ]);
    const assinaturasAtivas = await Assinatura.find({ status: 'ativa' }).select('plano');
    const valorPlano = { basico:49, intermediario:149, avancado:349, enterprise:0 };
    const receitaMensal = assinaturasAtivas.reduce((s, a) => s + (valorPlano[a.plano]||0), 0);
    res.json({ ativas, inadimplentes, canceladas, trial, pendentes, totalEmpresas, receitaMensal });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/admin/cancelar-conta', adminSecretMiddleware, async (req, res) => {
  try {
    const { empresaId, motivo } = req.body;
    if (!empresaId) return res.status(400).json({ erro: 'empresaId obrigatório.' });
    const assinatura = await Assinatura.findOne({ empresa: empresaId });
    if (assinatura?.asaasAssinaturaId) { try { await asaasRequest('DELETE', `/subscriptions/${assinatura.asaasAssinaturaId}`); } catch (e) { console.log('Erro cancelar Asaas:', e.message); } }
    await Assinatura.findOneAndUpdate({ empresa: empresaId }, { status: 'cancelada', atualizadoEm: new Date() });
    await notificarAdmins(empresaId, 'Assinatura cancelada', motivo||'Sua assinatura foi cancelada.', 'erro', '', '/plano-usuarios');
    res.json({ mensagem: 'Conta cancelada.' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/admin/marcar-inadimplente', adminSecretMiddleware, async (req, res) => {
  try {
    const { empresaId } = req.body;
    if (!empresaId) return res.status(400).json({ erro: 'empresaId obrigatório.' });
    await Assinatura.findOneAndUpdate({ empresa: empresaId }, { status: 'inadimplente', vencimento: new Date(), atualizadoEm: new Date() });
    await notificarAdmins(empresaId, 'Pagamento em atraso', 'Identificamos um atraso no pagamento. Regularize para continuar usando o HOC System.', 'aviso', '', '/plano-usuarios');
    res.json({ mensagem: 'Conta marcada como inadimplente.' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/admin/reativar-conta', adminSecretMiddleware, async (req, res) => {
  try {
    const { empresaId } = req.body;
    if (!empresaId) return res.status(400).json({ erro: 'empresaId obrigatório.' });
    const vencimento = new Date(); vencimento.setDate(vencimento.getDate() + 30);
    await Assinatura.findOneAndUpdate({ empresa: empresaId }, { status: 'ativa', vencimento, atualizadoEm: new Date() });
    await notificarAdmins(empresaId, 'Assinatura reativada!', 'Sua assinatura foi reativada. O acesso completo está liberado.', 'sucesso', '', '/plano-usuarios');
    res.json({ mensagem: 'Conta reativada.' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/admin/trocar-plano', adminSecretMiddleware, async (req, res) => {
  try {
    const { empresaId, plano } = req.body;
    if (!empresaId) return res.status(400).json({ erro: 'empresaId obrigatório.' });
    if (!['basico','intermediario','avancado','enterprise'].includes(plano)) return res.status(400).json({ erro: 'Plano inválido.' });
    const vencimento = new Date(); vencimento.setDate(vencimento.getDate() + 30);
    await Assinatura.findOneAndUpdate({ empresa: empresaId }, { plano, status: 'ativa', vencimento, atualizadoEm: new Date() });
    await notificarAdmins(empresaId, `Plano alterado para ${NOME_PLANO[plano]}`, `Seu plano foi atualizado para ${NOME_PLANO[plano]}.`, 'sucesso', '', '/plano-usuarios');
    res.json({ mensagem: `Plano alterado para ${NOME_PLANO[plano]}.` });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== NOTIFICAÇÕES ====================

app.post('/api/notificacoes', authMiddleware, async (req, res) => {
  try {
    const { titulo, mensagem, tipo, icone, link, destinatario } = req.body;
    const notif = await Notificacao.create({ empresa: req.usuario.empresa, titulo, mensagem: mensagem||'', tipo: tipo||'info', icone: icone||'🔔', link: link||'', destinatario: destinatario||null });
    res.status(201).json(notif);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.get('/api/notificacoes', authMiddleware, async (req, res) => {
  try {
    const userId = req.usuario.id;
    const notificacoes = await Notificacao.find({ empresa: req.usuario.empresa, $or: [{ destinatario: null }, { destinatario: { $exists: false } }, { destinatario: userId }] }).sort({ criadoEm: -1 }).limit(50);
    res.json(notificacoes);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/notificacoes/resumo', authMiddleware, async (req, res) => {
  try {
    const userId = req.usuario.id;
    const baseFilter = { empresa: req.usuario.empresa, $or: [{ destinatario: null }, { destinatario: { $exists: false } }, { destinatario: userId }] };
    const naoLidas = await Notificacao.countDocuments({ ...baseFilter, lida: false });
    const temVencida = await Notificacao.countDocuments({ ...baseFilter, tipo: 'licenca_vencida', lida: false });
    const temVencendo = await Notificacao.countDocuments({ ...baseFilter, tipo: 'licenca_vencendo', lida: false });
    const assinatura = await Assinatura.findOne({ empresa: req.usuario.empresa });
    const statusAssinatura = assinatura ? {
      status: assinatura.status,
      diasTrialRestantes: assinatura.status === 'trial' ? Math.max(0, Math.ceil((new Date(assinatura.trialFim) - new Date()) / (1000 * 60 * 60 * 24))) : null,
      diasAtraso: assinatura.status === 'inadimplente' ? Math.floor((new Date() - new Date(assinatura.vencimento)) / (1000 * 60 * 60 * 24)) : null,
      boletoUrl: assinatura.asaasBoletoUrl || assinatura.coraBoletoUrl,
      pixCopiaECola: assinatura.asaasPixCopiaECola || assinatura.coraPixCopiaECola
    } : null;
    res.json({ naoLidas, temVencida, temVencendo, assinatura: statusAssinatura });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.put('/api/notificacoes/:id/ler', authMiddleware, async (req, res) => {
  try { await Notificacao.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, { lida: true }); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

app.put('/api/notificacoes/ler-todas', authMiddleware, async (req, res) => {
  try { await Notificacao.updateMany({ empresa: req.usuario.empresa, lida: false }, { lida: true }); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

app.delete('/api/notificacoes', authMiddleware, async (req, res) => {
  try { await Notificacao.deleteMany({ empresa: req.usuario.empresa }); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

app.delete('/api/notificacoes/:id', authMiddleware, async (req, res) => {
  try { await Notificacao.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa }); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== PERFIL ====================

app.get('/api/perfil', authMiddleware, async (req, res) => {
  try {
    const usuario = await Usuario.findById(req.usuario.id).select('-senha');
    if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado' });
    res.json(usuario);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.put('/api/perfil', authMiddleware, async (req, res) => {
  try {
    const { nome, cargo, foto } = req.body;
    if (!nome || nome.trim().length < 2) return res.status(400).json({ erro: 'Nome deve ter pelo menos 2 caracteres.' });
    // Validar tamanho da foto (base64 ~1.33x do arquivo original — limite 2MB)
    if (foto && foto.length > 2800000) return res.status(400).json({ erro: 'Foto muito grande. Máximo 2MB.' });
    const update = { nome: nome.trim(), cargo: cargo?.trim() || '' };
    if (foto !== undefined) update.foto = foto;
    const usuario = await Usuario.findByIdAndUpdate(req.usuario.id, update, { new: true }).select('-senha');
    if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado' });
    res.json({ mensagem: 'Perfil atualizado!', usuario });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.put('/api/perfil/senha', authMiddleware, async (req, res) => {
  try {
    const { senhaAtual, novaSenha } = req.body;
    if (!senhaAtual || !novaSenha) return res.status(400).json({ erro: 'Preencha todos os campos.' });
    if (novaSenha.length < 6) return res.status(400).json({ erro: 'Nova senha deve ter pelo menos 6 caracteres.' });
    const usuario = await Usuario.findById(req.usuario.id);
    if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado' });
    const senhaCorreta = await bcrypt.compare(senhaAtual, usuario.senha);
    if (!senhaCorreta) return res.status(400).json({ erro: 'Senha atual incorreta.' });
    const hash = await bcrypt.hash(novaSenha, 10);
    await Usuario.findByIdAndUpdate(req.usuario.id, { senha: hash });
    res.json({ mensagem: 'Senha alterada com sucesso!' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.put('/api/perfil/email', authMiddleware, async (req, res) => {
  try {
    const { novoEmail, senha } = req.body;
    if (!novoEmail || !senha) return res.status(400).json({ erro: 'Preencha todos os campos.' });
    if (!validarEmail(novoEmail)) return res.status(400).json({ erro: 'E-mail inválido.' });
    const usuario = await Usuario.findById(req.usuario.id);
    if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado' });
    const senhaCorreta = await bcrypt.compare(senha, usuario.senha);
    if (!senhaCorreta) return res.status(400).json({ erro: 'Senha incorreta.' });
    const emailExiste = await Usuario.findOne({ email: novoEmail, _id: { $ne: req.usuario.id } });
    if (emailExiste) return res.status(400).json({ erro: 'E-mail já em uso por outro usuário.' });
    await Usuario.findByIdAndUpdate(req.usuario.id, { email: novoEmail });
    res.json({ mensagem: 'E-mail alterado com sucesso!' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== USUÁRIOS ====================

app.get('/api/usuarios', authMiddleware, async (req, res) => {
  try { const usuarios = await Usuario.find({ empresa: req.usuario.empresa }).select('-senha'); res.json(usuarios); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

// Lista restrita — usada pelos modais de "enviar para aprovação" (Ideias, Wikis, Projetos), pra
// só oferecer quem realmente pode aprovar aquilo. Allowlist evita interpolar modulo/acao livres na query.
const PERMISSOES_APROVACAO_VALIDAS = new Set([
  'overview.aprovar', 'ideiasLivres.aprovar', 'gestaoProjetos.aprovarCriacao', 'gestaoProjetos.aprovarExecucao'
]);
app.get('/api/usuarios/com-permissao/:modulo/:acao', authMiddleware, async (req, res) => {
  try {
    const { modulo, acao } = req.params;
    if (!PERMISSOES_APROVACAO_VALIDAS.has(`${modulo}.${acao}`)) return res.status(400).json({ erro: 'Permissão inválida' });
    const usuarios = await Usuario.find({
      empresa: req.usuario.empresa,
      $or: [{ perfil: 'Admin' }, { [`permissoes.${modulo}.${acao}`]: true }]
    }).select('nome email');
    res.json(usuarios);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/usuarios/minhas-permissoes', authMiddleware, async (req, res) => {
  try {
    const usuario = await Usuario.findById(req.usuario.id).select('permissoes perfil');
    if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado' });
    if (usuario.perfil === 'Admin') {
      return res.json({ isAdmin: true, permissoes: { overview:{acessar:true,editar:true,aprovar:true}, ideiasLivres:{acessar:true,aprovar:true}, gestaoMetas:{acessar:true,editar:true}, gestaoProjetos:{acessar:true,aprovarCriacao:true,aprovarExecucao:true}, gestaoLicencas:{acessar:true,editar:true}, operacoes:{acessar:true}, planoUsuarios:{acessar:true,editarUsuarios:true,convidarUsuarios:true} } });
    }
    res.json({ isAdmin: false, permissoes: usuario.permissoes });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.put('/api/usuarios/:id', authMiddleware, verificarAssinatura, permPlanoUsuarios('editarUsuarios'), async (req, res) => {
  try {
    const alvo = await Usuario.findOne({ _id: req.params.id, empresa: req.usuario.empresa }).select('usuarioMestre');
    if (!alvo) return res.status(404).json({ erro: 'Usuário não encontrado' });
    // O dono original da empresa (usuarioMestre) não pode ser alterado por esta rota administrativa,
    // nem por outro Admin — evita que ele seja rebaixado, desativado ou tenha permissões retiradas.
    if (alvo.usuarioMestre) return res.status(403).json({ erro: 'Não é possível alterar o dono original da empresa' });
    const { nome, perfil, status, permissoes } = req.body;
    const update = { nome, perfil, status };
    if (permissoes !== undefined) update.permissoes = permissoes;
    const usuario = await Usuario.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, update, { new: true }).select('-senha');
    if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado' });
    res.json(usuario);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.delete('/api/usuarios/:id', authMiddleware, verificarAssinatura, permPlanoUsuarios('editarUsuarios'), async (req, res) => {
  try {
    if (req.params.id === req.usuario.id) return res.status(400).json({ erro: 'Você não pode deletar sua própria conta' });
    const alvo = await Usuario.findOne({ _id: req.params.id, empresa: req.usuario.empresa }).select('usuarioMestre');
    if (!alvo) return res.status(404).json({ erro: 'Usuário não encontrado' });
    if (alvo.usuarioMestre) return res.status(403).json({ erro: 'Não é possível excluir o dono original da empresa' });
    const usuario = await Usuario.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa });
    if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado' });
    res.json({ mensagem: 'Usuário deletado!' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== CONVITES ====================

app.post('/api/convites', authMiddleware, verificarAssinatura, permPlanoUsuarios('convidarUsuarios'), async (req, res) => {
  try {
    const { email, perfil, permissoes } = req.body;
    if (!email) return res.status(400).json({ erro: 'Email obrigatório' });
    if (!validarEmail(email)) return res.status(400).json({ erro: 'Email inválido' });
    const usuarioExiste = await Usuario.findOne({ email });
    if (usuarioExiste) return res.status(400).json({ erro: 'Este email já possui uma conta' });
    const token = crypto.randomBytes(32).toString('hex');
    // usuarioMestre nunca é concedido por convite — é exclusivo de quem cria a empresa (dono
    // original protegido). Um Admin convidado é só perfil:'Admin', sem a proteção contra remoção.
    await Convite.create({ email, empresa: req.usuario.empresa, token, perfil: perfil === 'Admin' ? 'Admin' : 'Usuário', permissoes: permissoes||{}, criadoPor: req.usuario.id });
    const linkConvite = `${process.env.APP_URL}/aceitar-convite?token=${token}`;
    await enviarEmail(req.usuario.empresa, email, 'Você foi convidado para o HOC System', `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px"><h2 style="color:#2d1b69">Você recebeu um convite!</h2><p>Você foi convidado para colaborar no <strong>HOC System</strong>.</p><a href="${linkConvite}" style="display:inline-block;margin:24px 0;padding:14px 28px;background:#2d1b69;color:white;border-radius:8px;text-decoration:none;font-weight:600">Aceitar Convite</a><p style="color:#a0aec0;font-size:13px">Este link expira em 48 horas.</p></div>`);
    await criarNotificacao(req.usuario.empresa, `Convite enviado para ${email}`, `Um convite foi enviado para ${email}.`, 'info', '👤', '/plano-usuarios', req.usuario.id);
    res.json({ mensagem: 'Convite enviado!' });
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
    await Usuario.create({ nome, email: convite.email, senha: hash, empresa: convite.empresa._id, usuarioMestre: false, perfil: convite.perfil, permissoes: convite.permissoes, status: 'Ativo', emailConfirmado: true });
    convite.usado = true; await convite.save();
    // Direcionada só pra quem mandou o convite — antes era broadcast, e o próprio convidado
    // via essa notificação sobre si mesmo assim que entrava.
    if (convite.criadoPor) {
      await criarNotificacao(convite.empresa._id, `Novo usuário: ${nome}`, `${nome} aceitou o convite.`, 'sucesso', '👤', '/plano-usuarios', convite.criadoPor);
    } else {
      await notificarAdmins(convite.empresa._id, `Novo usuário: ${nome}`, `${nome} aceitou o convite.`, 'sucesso', '👤', '/plano-usuarios');
    }
    res.json({ mensagem: 'Conta criada com sucesso!' });
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

// ==================== PROJETOS ====================

app.get('/api/projetos', authMiddleware, verificarAssinatura, permGestaoProjetos('acessar'), async (req, res) => {
  try { const projetos = await Projeto.find({ empresa: req.usuario.empresa }).sort({ criadoEm: -1 }); res.json(projetos); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.get('/api/projetos/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    const projeto = await Projeto.findOne({ _id: req.params.id, empresa: req.usuario.empresa });
    if (!projeto) return res.status(404).json({ erro: 'Projeto não encontrado' });
    res.json(projeto);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/projetos', authMiddleware, verificarAssinatura, permGestaoProjetos('acessar'), async (req, res) => {
  try {
    const usuario = await Usuario.findById(req.usuario.id).select('permissoes perfil');
    // Publicar direto (pular a fila) é um efeito de já poder aprovar criação — igual ideias,
    // onde publicar imediato está embutido em "aprovar", sem interruptor separado.
    const podePublicarImediato = usuario?.perfil === 'Admin' || !!(usuario?.permissoes?.gestaoProjetos?.aprovarCriacao);
    const dados = { ...req.body, empresa: req.usuario.empresa, criadoPor: req.usuario.id };
    // Sem a permissão de aprovar criação, todo projeto novo entra na fila de aprovação —
    // não importa o que o cliente mandou em `status` (evita pular a fila só omitindo o campo).
    if (!podePublicarImediato) dados.status = 'Aguardando Aprovação';
    // Notificação de "enviado para aprovação" é responsabilidade do front (modal de escolher
    // a pessoa) — quem tem a permissão sempre pode agir, mas só quem foi escolhido é avisado.
    const projeto = await Projeto.create(dados);
    res.status(201).json(projeto);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.put('/api/projetos/:id', authMiddleware, verificarAssinatura, permGestaoProjetos('acessar'), async (req, res) => {
  try {
    const usuario = await Usuario.findById(req.usuario.id).select('permissoes perfil');
    if (!usuario) return res.status(401).json({ erro: 'Usuário não encontrado' });
    const anterior = await Projeto.findOne({ _id: req.params.id, empresa: req.usuario.empresa });
    if (!anterior) return res.status(404).json({ erro: 'Projeto não encontrado' });
    // Edição geral é livre pra quem acessa o módulo — só aprovar/reprovar criação e execução
    // exige permissão dedicada, checado à parte abaixo.

    // Aprovar/reprovar a criação (sair de "Aguardando Aprovação") exige permissão dedicada —
    // antes disso bastava ter `editar` ou ser o próprio criador (autoaprovação possível).
    const decisaoCriacao = anterior.status === 'Aguardando Aprovação' && req.body.status !== undefined && req.body.status !== 'Aguardando Aprovação';
    if (decisaoCriacao) {
      const podeAprovarCriacao = usuario.perfil === 'Admin' || !!(usuario.permissoes?.gestaoProjetos?.aprovarCriacao);
      if (!podeAprovarCriacao) return res.status(403).json({ erro: 'Sem permissão para aprovar ou reprovar projetos' });
    }
    const decisaoExecucao = detectaDecisaoExecucaoProjeto(anterior, req.body);
    if (decisaoExecucao) {
      const podeAprovarExecucao = usuario.perfil === 'Admin' || !!(usuario.permissoes?.gestaoProjetos?.aprovarExecucao);
      if (!podeAprovarExecucao) return res.status(403).json({ erro: 'Sem permissão para aprovar itens de execução do projeto' });
    }

    const projeto = await Projeto.findOneAndUpdate(
      { _id: req.params.id, empresa: req.usuario.empresa },
      { $set: { ...req.body, atualizadoEm: new Date() } },
      { new: true, strict: false }
    );
    if (!projeto) return res.status(404).json({ erro: 'Projeto não encontrado' });
    if (decisaoCriacao && anterior.criadoPor) {
      if (projeto.status === 'Ativo') await criarNotificacao(req.usuario.empresa, `Projeto aprovado: ${projeto.nome}`, `Seu projeto "${projeto.nome}" foi aprovado.`, 'sucesso', '✅', '/gestao-projetos', anterior.criadoPor);
      else if (projeto.status === 'Reprovado') await criarNotificacao(req.usuario.empresa, `Projeto reprovado: ${projeto.nome}`, `Seu projeto "${projeto.nome}" foi reprovado.`, 'erro', '❌', '/gestao-projetos', anterior.criadoPor);
    }
    if (decisaoExecucao && anterior.criadoPor) {
      await criarNotificacao(req.usuario.empresa, `Aprovação registrada: ${projeto.nome}`, `Um item de execução do projeto "${projeto.nome}" foi aprovado ou decidido.`, 'sucesso', '✅', '/projeto-tradicional?id=' + projeto._id, anterior.criadoPor);
    }
    res.json(projeto);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.delete('/api/projetos/:id', authMiddleware, verificarAssinatura, permGestaoProjetos('acessar'), async (req, res) => {
  try {
    const projeto = await Projeto.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa });
    if (!projeto) return res.status(404).json({ erro: 'Projeto não encontrado' });
    res.json({ mensagem: 'Projeto deletado!' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== TEMPLATES ====================

app.get('/api/templates', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try { const templates = await Template.find({ empresa: req.usuario.empresa }).sort({ criadoEm: -1 }); res.json(templates); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/templates', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try { const template = await Template.create({ ...req.body, empresa: req.usuario.empresa, criadoPor: req.usuario.id }); res.status(201).json(template); }
  catch (err) { res.status(400).json({ erro: err.message }); }
});
app.put('/api/templates/:id', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    const template = await Template.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, req.body, { new: true });
    if (!template) return res.status(404).json({ erro: 'Template não encontrado' });
    res.json(template);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.delete('/api/templates/:id', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try { await Template.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa }); res.json({ mensagem: 'Template deletado!' }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== IDEIAS ====================

app.get('/api/ideias', authMiddleware, verificarAssinatura, permIdeiasLivres('acessar'), async (req, res) => {
  try { const ideias = await Ideia.find({ empresa: req.usuario.empresa }).sort({ criadoEm: -1 }); res.json(ideias); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/ideias', authMiddleware, verificarAssinatura, permIdeiasLivres('acessar'), async (req, res) => {
  try {
    // Notificação de "enviado para aprovação" é responsabilidade do front (modal de escolher
    // a pessoa) — quem tem a permissão sempre pode agir, mas só quem foi escolhido é avisado.
    const ideia = await Ideia.create({ ...req.body, empresa: req.usuario.empresa, criadoPor: req.usuario.id });
    res.status(201).json(ideia);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.put('/api/ideias/:id', authMiddleware, verificarAssinatura, permIdeiasLivres('acessar'), async (req, res) => {
  try {
    const anterior = await Ideia.findOne({ _id: req.params.id, empresa: req.usuario.empresa });
    if (!anterior) return res.status(404).json({ erro: 'Ideia não encontrada' });
    // Edição geral é livre pra quem acessa o módulo — só aprovar/dispensar (inclusive "publicar
    // imediato" na criação) exige a permissão dedicada, checada à parte abaixo.
    const usuario = await Usuario.findById(req.usuario.id).select('permissoes perfil');
    const podeAprovar = usuario?.perfil === 'Admin' || !!(usuario?.permissoes?.ideiasLivres?.aprovar);
    const alvoDeAprovacao = req.body.aprovacao !== undefined && ['aprovada', 'dispensada'].includes(req.body.aprovacao) && req.body.aprovacao !== anterior.aprovacao;
    if (alvoDeAprovacao && !podeAprovar) return res.status(403).json({ erro: 'Sem permissão para aprovar ou dispensar ideias' });
    const ideia = await Ideia.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, { ...req.body, atualizadoEm: new Date() }, { new: true });
    if (!ideia) return res.status(404).json({ erro: 'Ideia não encontrada' });
    if (anterior && anterior.aprovacao !== ideia.aprovacao && anterior.criadoPor) {
      if (ideia.aprovacao === 'aprovada') await criarNotificacao(req.usuario.empresa, `Ideia aprovada: ${ideia.titulo}`, `Sua ideia "${ideia.titulo}" foi aprovada.`, 'sucesso', '✅', '/ideias-livres', anterior.criadoPor);
      if (ideia.aprovacao === 'dispensada') await criarNotificacao(req.usuario.empresa, `Ideia dispensada: ${ideia.titulo}`, `Sua ideia "${ideia.titulo}" foi dispensada.`, 'erro', '❌', '/ideias-livres', anterior.criadoPor);
    }
    res.json(ideia);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.delete('/api/ideias/:id', authMiddleware, verificarAssinatura, permIdeiasLivres('acessar'), async (req, res) => {
  try { await Ideia.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa }); res.json({ mensagem: 'Ideia deletada!' }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== BOWLER ====================

app.get('/api/bowler/:ano', authMiddleware, verificarAssinatura, permGestaoMetas('acessar'), async (req, res) => {
  try { const bowler = await Bowler.findOne({ empresa: req.usuario.empresa, ano: req.params.ano }); res.json(bowler || null); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.put('/api/bowler/:ano', authMiddleware, verificarAssinatura, permGestaoMetas('editar'), async (req, res) => {
  try {
    const bowler = await Bowler.findOneAndUpdate({ empresa: req.usuario.empresa, ano: req.params.ano }, { dados: req.body.dados, atualizadoEm: new Date() }, { new: true, upsert: true });
    res.json(bowler);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

// ==================== OVERVIEW ====================

app.get('/api/overview', authMiddleware, verificarAssinatura, async (req, res) => {
  try { const overview = await Overview.findOne({ empresa: req.usuario.empresa }); res.json(overview || null); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== PASTAS DA BIBLIOTECA ====================

app.get('/api/pastas', authMiddleware, permOverview('acessar'), async (req, res) => {
  try {
    const overview = await Overview.findOne({ empresa: req.usuario.empresa }).select('pastas');
    res.json(overview?.pastas || []);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/pastas', authMiddleware, permOverview('editar'), async (req, res) => {
  try {
    const { nome, parentId } = req.body;
    if (!nome?.trim()) return res.status(400).json({ erro: 'Nome obrigatório.' });
    const novaPasta = { id: Date.now(), nome: nome.trim(), parentId: parentId || null, criadoEm: new Date() };
    await Overview.findOneAndUpdate(
      { empresa: req.usuario.empresa },
      { $push: { pastas: novaPasta }, atualizadoEm: new Date() },
      { upsert: true }
    );
    res.status(201).json(novaPasta);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.put('/api/pastas/:id', authMiddleware, permOverview('editar'), async (req, res) => {
  try {
    const pastaId = parseInt(req.params.id);
    const { nome, parentId } = req.body;
    const overview = await Overview.findOne({ empresa: req.usuario.empresa });
    if (!overview) return res.status(404).json({ erro: 'Não encontrado.' });
    const pasta = overview.pastas.find(p => p.id === pastaId);
    if (!pasta) return res.status(404).json({ erro: 'Pasta não encontrada.' });
    if (nome !== undefined) pasta.nome = nome.trim();
    if (parentId !== undefined) pasta.parentId = parentId === null ? null : parseInt(parentId);
    await overview.save();
    res.json(pasta);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.delete('/api/pastas/:id', authMiddleware, permOverview('editar'), async (req, res) => {
  try {
    const pastaId = parseInt(req.params.id);
    await Overview.findOneAndUpdate(
      { empresa: req.usuario.empresa },
      { $pull: { pastas: { id: pastaId } }, atualizadoEm: new Date() }
    );
    // Desassociar wikis desta pasta
    await Wiki.updateMany({ empresa: req.usuario.empresa, pastaId }, { $unset: { pastaId: '' } });
    res.json({ mensagem: 'Pasta removida.' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});
app.put('/api/overview', authMiddleware, verificarAssinatura, permOverview('editar'), async (req, res) => {
  try {
    const overview = await Overview.findOneAndUpdate({ empresa: req.usuario.empresa }, { ...req.body, atualizadoEm: new Date() }, { new: true, upsert: true });
    res.json(overview);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

// ==================== UPLOAD DE ARQUIVOS ====================

app.post('/api/uploads', authMiddleware, upload.single('arquivo'), (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado.' });
  res.json({ url: '/uploads/' + req.file.filename, nomeOriginal: req.file.originalname, tamanho: req.file.size });
});

// ==================== WIKIS ====================

app.get('/api/wikis', authMiddleware, verificarAssinatura, permOverview('acessar'), async (req, res) => {
  try { const wikis = await Wiki.find({ empresa: req.usuario.empresa }).sort({ criadoEm: -1 }); res.json(wikis); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/wikis', authMiddleware, verificarAssinatura, permOverview('editar'), async (req, res) => {
  try {
    const usuario = await Usuario.findById(req.usuario.id).select('permissoes perfil');
    const podeAprovar = usuario?.perfil === 'Admin' || !!(usuario?.permissoes?.overview?.aprovar);
    const dados = { ...req.body };
    // Só quem tem overview.aprovar pode criar já com status Aprovado — sem a permissão, força
    // Rascunho (evita que qualquer editor publique direto forjando o status no corpo da requisição).
    if (dados.status === 'Aprovado' && !podeAprovar) dados.status = 'Rascunho';
    const id = new mongoose.Types.ObjectId();
    const grupoId = dados.grupoId ? new mongoose.Types.ObjectId(dados.grupoId) : id;
    const isFirst = !dados.grupoId;
    const wiki = await Wiki.create({ _id: id, ...dados, grupoId, ativo: isFirst, empresa: req.usuario.empresa, criadoPor: req.usuario.id });
    res.status(201).json(wiki);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.get('/api/wikis/:id/versoes', authMiddleware, async (req, res) => {
  try {
    const wiki = await Wiki.findOne({ _id: req.params.id, empresa: req.usuario.empresa });
    if (!wiki) return res.status(404).json({ erro: 'Não encontrado.' });
    const grupoId = wiki.grupoId || wiki._id;
    const versoes = await Wiki.find({
      empresa: req.usuario.empresa,
      $or: [{ grupoId }, { _id: grupoId, grupoId: null }]
    }).sort({ criadoEm: 1 }).select('_id titulo versao status responsavel criadoEm grupoId ativo');
    res.json(versoes);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.put('/api/wikis/:id/ativar', authMiddleware, async (req, res) => {
  try {
    const wiki = await Wiki.findOne({ _id: req.params.id, empresa: req.usuario.empresa });
    if (!wiki) return res.status(404).json({ erro: 'Não encontrado.' });
    const grupoId = wiki.grupoId || wiki._id;
    await Wiki.updateMany({ empresa: req.usuario.empresa, $or: [{ grupoId }, { _id: grupoId }] }, { ativo: false });
    await Wiki.findByIdAndUpdate(req.params.id, { ativo: true });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.put('/api/wikis/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    const anterior = await Wiki.findOne({ _id: req.params.id, empresa: req.usuario.empresa });
    if (!anterior) return res.status(404).json({ erro: 'Wiki não encontrado' });
    const usuario = await Usuario.findById(req.usuario.id).select('permissoes perfil');
    const temPermEditar = usuario?.perfil === 'Admin' || !!(usuario?.permissoes?.overview?.editar);
    const souAutor = anterior.criadoPor?.toString() === req.usuario.id;
    if (!temPermEditar && !souAutor) return res.status(403).json({ erro: 'Sem permissão para editar este wiki' });
    // Aprovar (status → 'Aprovado') exige Admin ou a permissão dedicada — antes disso o botão
    // "Aprovar" existia só no front, e qualquer editor conseguia aprovar via PUT direto.
    const viraAprovado = req.body.status === 'Aprovado' && anterior.status !== 'Aprovado';
    if (viraAprovado) {
      const podeAprovar = usuario?.perfil === 'Admin' || !!(usuario?.permissoes?.overview?.aprovar);
      if (!podeAprovar) return res.status(403).json({ erro: 'Sem permissão para aprovar wikis' });
    }
    const wiki = await Wiki.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, { ...req.body, atualizadoEm: new Date() }, { new: true });
    if (viraAprovado && wiki.criadoPor) await criarNotificacao(req.usuario.empresa, `Wiki aprovado: ${wiki.titulo}`, `O wiki "${wiki.titulo}" foi aprovado.`, 'sucesso', '✅', '/overview', wiki.criadoPor);
    res.json(wiki);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.delete('/api/wikis/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    const anterior = await Wiki.findOne({ _id: req.params.id, empresa: req.usuario.empresa });
    if (!anterior) return res.status(404).json({ erro: 'Wiki não encontrado' });
    const usuario = await Usuario.findById(req.usuario.id).select('permissoes perfil');
    const temPermEditar = usuario?.perfil === 'Admin' || !!(usuario?.permissoes?.overview?.editar);
    if (!temPermEditar && anterior.criadoPor?.toString() !== req.usuario.id) return res.status(403).json({ erro: 'Sem permissão para excluir este wiki' });
    await Wiki.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa }); res.json({ mensagem: 'Wiki deletado!' });
  }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== LICENÇAS ====================

app.get('/api/licencas', authMiddleware, verificarAssinatura, permGestaoLicencas('acessar'), async (req, res) => {
  try { const licencas = await Licenca.find({ empresa: req.usuario.empresa }).select('-documentos.base64').sort({ criadoEm: -1 }); res.json(licencas); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.get('/api/licencas/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    const licenca = await Licenca.findOne({ _id: req.params.id, empresa: req.usuario.empresa });
    if (!licenca) return res.status(404).json({ erro: 'Licença não encontrada' });
    res.json(licenca);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/licencas', authMiddleware, verificarAssinatura, permGestaoLicencas('editar'), async (req, res) => {
  try {
    const licenca = await Licenca.create({ ...req.body, empresa: req.usuario.empresa, criadoPor: req.usuario.id });
    res.status(201).json(licenca);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.put('/api/licencas/:id', authMiddleware, verificarAssinatura, permGestaoLicencas('editar'), async (req, res) => {
  try {
    const licenca = await Licenca.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, { ...req.body, atualizadoEm: new Date() }, { new: true });
    if (!licenca) return res.status(404).json({ erro: 'Licença não encontrada' });
    res.json(licenca);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.post('/api/licencas/:id/renovacoes', authMiddleware, verificarAssinatura, permGestaoLicencas('editar'), async (req, res) => {
  try {
    const { inicio, fim } = req.body;
    if (!inicio || !fim) return res.status(400).json({ erro: 'Data de início e fim são obrigatórias.' });
    const licenca = await Licenca.findOneAndUpdate(
      { _id: req.params.id, empresa: req.usuario.empresa },
      { $push: { renovacoes: { inicio, fim, registradoEm: new Date(), registradoPor: req.usuario.nome || '' } }, $set: { atualizadoEm: new Date() } },
      { new: true }
    );
    if (!licenca) return res.status(404).json({ erro: 'Licença não encontrada' });
    res.json(licenca);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});
app.put('/api/licencas/:id/renovacoes/:renovId', authMiddleware, verificarAssinatura, permGestaoLicencas('editar'), async (req, res) => {
  try {
    const { inicio, fim } = req.body;
    if (!inicio || !fim) return res.status(400).json({ erro: 'Data de início e fim são obrigatórias.' });
    const licenca = await Licenca.findOneAndUpdate(
      { _id: req.params.id, empresa: req.usuario.empresa, 'renovacoes._id': req.params.renovId },
      { $set: { 'renovacoes.$.inicio': inicio, 'renovacoes.$.fim': fim, atualizadoEm: new Date() } },
      { new: true }
    );
    if (!licenca) return res.status(404).json({ erro: 'Licença ou renovação não encontrada' });
    res.json(licenca);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});
app.delete('/api/licencas/:id/renovacoes/:renovId', authMiddleware, verificarAssinatura, permGestaoLicencas('editar'), async (req, res) => {
  try {
    const licenca = await Licenca.findOneAndUpdate(
      { _id: req.params.id, empresa: req.usuario.empresa },
      { $pull: { renovacoes: { _id: req.params.renovId } }, $set: { atualizadoEm: new Date() } },
      { new: true }
    );
    if (!licenca) return res.status(404).json({ erro: 'Licença não encontrada' });
    res.json(licenca);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});
app.delete('/api/licencas/:id', authMiddleware, verificarAssinatura, permGestaoLicencas('editar'), async (req, res) => {
  try { await Licenca.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa }); res.json({ mensagem: 'Licença deletada!' }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== FLUXO DE VALOR ====================

app.get('/api/fluxo-valor', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try { const fv = await FluxoValor.findOne({ empresa: req.usuario.empresa }); res.json(fv || { blocos: [], conexoes: [], textos: [] }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.put('/api/fluxo-valor', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try { const fv = await FluxoValor.findOneAndUpdate({ empresa: req.usuario.empresa }, { ...req.body, atualizadoEm: new Date() }, { new: true, upsert: true }); res.json(fv); }
  catch (err) { res.status(400).json({ erro: err.message }); }
});

// ==================== CONTATOS ====================

app.get('/api/contatos', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try { const contatos = await Contato.find({ empresa: req.usuario.empresa }).sort({ criadoEm: -1 }); res.json(contatos); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/contatos', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try { const contato = await Contato.create({ ...req.body, empresa: req.usuario.empresa }); res.status(201).json(contato); }
  catch (err) { res.status(400).json({ erro: err.message }); }
});
app.put('/api/contatos/:id', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try { const contato = await Contato.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, req.body, { new: true }); if (!contato) return res.status(404).json({ erro: 'Contato não encontrado' }); res.json(contato); }
  catch (err) { res.status(400).json({ erro: err.message }); }
});
app.delete('/api/contatos/:id', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try { await Contato.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa }); res.json({ mensagem: 'Contato deletado!' }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== EMAIL TEMPLATES ====================

app.get('/api/email-templates', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try { const templates = await EmailTemplate.find({ empresa: req.usuario.empresa }).sort({ criadoEm: -1 }); res.json(templates); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/email-templates', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try { const template = await EmailTemplate.create({ ...req.body, empresa: req.usuario.empresa }); res.status(201).json(template); }
  catch (err) { res.status(400).json({ erro: err.message }); }
});
app.put('/api/email-templates/:id', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try { const template = await EmailTemplate.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, { ...req.body, atualizadoEm: new Date() }, { new: true }); if (!template) return res.status(404).json({ erro: 'Template não encontrado' }); res.json(template); }
  catch (err) { res.status(400).json({ erro: err.message }); }
});
app.delete('/api/email-templates/:id', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try { await EmailTemplate.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa }); res.json({ mensagem: 'Template deletado!' }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== TAREFAS ====================

app.get('/api/tarefas', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  // lean() returns plain JS objects (not Mongoose documents), so ALL fields stored in MongoDB
  // are returned — including extended fields like isModelo, gruposIds, modeloId, etc.
  // This works even if the running server hasn't been restarted with the updated schema.
  try { const tarefas = await Tarefa.find({ empresa: req.usuario.empresa }).sort({ criadoEm: -1 }).lean(); res.json(tarefas); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.get('/api/tarefas/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try { const tarefa = await Tarefa.findOne({ _id: req.params.id, empresa: req.usuario.empresa }); if (!tarefa) return res.status(404).json({ erro: 'Tarefa não encontrada' }); res.json(tarefa); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/tarefas', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    // Use collection.insertOne to bypass Mongoose schema strict mode on the running instance,
    // ensuring extended fields (isModelo, modeloId, gruposIds, etc.) are always persisted.
    const doc = {
      ...req.body,
      empresa: mongoose.Types.ObjectId.isValid(req.usuario.empresa) ? new mongoose.Types.ObjectId(req.usuario.empresa) : req.usuario.empresa,
      criadoPor: mongoose.Types.ObjectId.isValid(req.usuario.id) ? new mongoose.Types.ObjectId(req.usuario.id) : req.usuario.id,
      criadoEm: new Date(), atualizadoEm: new Date(),
    };
    if (doc.contatoId && mongoose.Types.ObjectId.isValid(doc.contatoId)) doc.contatoId = new mongoose.Types.ObjectId(doc.contatoId);
    if (doc.modeloId && mongoose.Types.ObjectId.isValid(doc.modeloId)) doc.modeloId = new mongoose.Types.ObjectId(doc.modeloId);
    if (doc.tarefaVinculadaId && mongoose.Types.ObjectId.isValid(doc.tarefaVinculadaId)) doc.tarefaVinculadaId = new mongoose.Types.ObjectId(doc.tarefaVinculadaId);
    if (doc.emailTemplateId && mongoose.Types.ObjectId.isValid(doc.emailTemplateId)) doc.emailTemplateId = new mongoose.Types.ObjectId(doc.emailTemplateId);
    const result = await Tarefa.collection.insertOne(doc);
    const tarefa = await Tarefa.findById(result.insertedId).lean();
    await notificarResponsaveisNovos(req.usuario.empresa, `Nova tarefa: ${tarefa.titulo}`, `Você foi associado à tarefa "${tarefa.titulo}".`, 'info', '📋', '/operacoes', [], tarefa.responsaveis);
    res.status(201).json(tarefa);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.put('/api/tarefas/:id', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    const anterior = await Tarefa.findById(req.params.id);
    const tarefa = await Tarefa.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, { ...req.body, atualizadoEm: new Date() }, { new: true, strict: false });
    if (!tarefa) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    if (req.body.responsaveis !== undefined) {
      await notificarResponsaveisNovos(req.usuario.empresa, `Tarefa associada: ${tarefa.titulo}`, `Você foi associado à tarefa "${tarefa.titulo}".`, 'info', '📋', '/operacoes', anterior?.responsaveis, tarefa.responsaveis);
    }
    // Sincroniza baixa/dispensa com a etapa do processo que gerou esta tarefa (se houver).
    const _statusEtapaMap = { 'Concluída': 'Concluído', 'Concluída Atrasada': 'Concluído', 'Dispensada': 'Dispensado' };
    if (req.body.status && _statusEtapaMap[req.body.status] && tarefa.processoExecId && tarefa.processoElementoId) {
      const exec = await ProExec.findOne({ _id: tarefa.processoExecId, empresa: req.usuario.empresa });
      if (exec) {
        const etapas = exec.etapas || [];
        const etapa = etapas.find(e => e.elementoId === tarefa.processoElementoId);
        if (etapa && etapa.status !== _statusEtapaMap[req.body.status]) {
          etapa.status = _statusEtapaMap[req.body.status];
          etapa.completadoEm = new Date().toISOString();
          const allDone = etapas.length && etapas.every(e => ['Concluído', 'Dispensado', 'Concluído com Pendência', 'Erro'].includes(e.status));
          const update = { etapas };
          if (allDone && !['Concluído com Sucesso', 'Concluído com Pendência'].includes(exec.status)) { update.status = 'Concluído com Sucesso'; update.concluidoEm = new Date(); }
          await ProExec.findByIdAndUpdate(exec._id, update, { strict: false });
        }
      }
    }
    res.json(tarefa);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.delete('/api/tarefas/:id', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try { await Tarefa.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa }); res.json({ mensagem: 'Tarefa deletada!' }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/tarefas/:id/enviar-email', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    await enviarEmailTarefa(req.params.id, req.usuario.empresa, req.body?.assinaturaHtml || '');
    res.json({ mensagem: 'Email enviado!' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ── Tracking link (unauthenticated) ──────────────────────────────────────────
app.get('/link/:token', async (req, res) => {
  try {
    const tracking = await LinkTracking.findOne({ token: req.params.token });
    if (!tracking) return res.status(404).send('<h2 style="font-family:sans-serif;text-align:center;padding:40px">Link inválido ou expirado.</h2>');
    const isFirst = !tracking.acessadoEm;
    await LinkTracking.findByIdAndUpdate(tracking._id, {
      acessadoEm: tracking.acessadoEm || new Date(),
      $inc: { acessos: 1 }
    });
    if (isFirst) {
      const allLinks = await LinkTracking.find({ tarefaId: tracking.tarefaId });
      if (allLinks.every(l => l._id.equals(tracking._id) || l.acessadoEm)) {
        await Tarefa.findByIdAndUpdate(tracking.tarefaId, { emailAberto: true }, { strict: false });
      }
    }
    // If doc has a file URL, redirect to the actual file
    const tarefa = await Tarefa.findById(tracking.tarefaId).lean();
    const doc = tarefa?.anexos?.[tracking.docIdx];
    if (doc?.fileUrl) {
      const filePath = path.join(__dirname, 'public', doc.fileUrl);
      if (fs.existsSync(filePath)) return res.sendFile(filePath);
      return res.redirect(doc.fileUrl);
    }
    res.send(`<!DOCTYPE html><html><head><meta charset='UTF-8'><meta name='viewport' content='width=device-width,initial-scale=1'><title>${tracking.docNome}</title><style>*{box-sizing:border-box}body{font-family:sans-serif;background:#f5f0ff;min-height:100vh;display:flex;align-items:center;justify-content:center;margin:0}.card{background:white;padding:40px;border-radius:16px;text-align:center;box-shadow:0 4px 24px rgba(45,27,105,.15);max-width:420px;width:90%}.ico{font-size:52px;margin-bottom:12px}.title{font-size:20px;font-weight:700;color:#2d1b69;margin-bottom:8px}.sub{font-size:14px;color:#718096}</style></head><body><div class='card'><div class='ico'>📄</div><div class='title'>${tracking.docNome}</div><div class='sub'>Documento acessado com sucesso.</div></div></body></html>`);
  } catch (err) { res.status(500).send('Erro interno.'); }
});

app.get('/api/tarefas/:id/trackings', authMiddleware, async (req, res) => {
  try {
    const trackings = await LinkTracking.find({ tarefaId: req.params.id }).lean();
    res.json(trackings);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ── SMTP Config ───────────────────────────────────────────────────────────────
app.get('/api/smtp-config', authMiddleware, permOperacoes('acessar'), async (req, res) => {
  try {
    const cfg = await SmtpConfig.findOne({ empresa: req.usuario.empresa }).lean();
    if (!cfg) return res.json({});
    const { senha, ...safe } = cfg;
    res.json({ ...safe, temSenha: !!senha });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});
app.put('/api/smtp-config', authMiddleware, permOperacoes('acessar'), async (req, res) => {
  try {
    const { servidor, porta, usuario, senha, remetente } = req.body;
    const upd = { servidor, porta: parseInt(porta)||587, usuario, remetente: remetente||usuario };
    if (senha) upd.senha = senha;
    await SmtpConfig.findOneAndUpdate(
      { empresa: req.usuario.empresa },
      { ...upd, empresa: req.usuario.empresa },
      { upsert: true, new: true }
    );
    res.json({ mensagem: 'Configurações salvas.' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/smtp-config/testar', authMiddleware, permOperacoes('acessar'), async (req, res) => {
  try {
    const cfg = await SmtpConfig.findOne({ empresa: req.usuario.empresa }).lean();
    if (!cfg || !cfg.servidor) return res.json({ ok: false, erro: 'SMTP não configurado.' });
    const t = nodemailer.createTransport({
      host: cfg.servidor, port: parseInt(cfg.porta)||587,
      secure: parseInt(cfg.porta)===465,
      auth: { user: cfg.usuario, pass: cfg.senha },
      tls: { rejectUnauthorized: false }
    });
    await t.verify();
    res.json({ ok: true });
  } catch (err) { res.json({ ok: false, erro: err.message }); }
});

// ── Config IA ──────────────────────────────────────────────────────────────────
app.get('/api/config-ia', authMiddleware, permOperacoes('acessar'), async (req, res) => {
  try {
    const cfg = await ConfigIA.findOne({ empresa: req.usuario.empresa }).lean() || {};
    res.json(cfg);
  } catch(err) { res.status(500).json({ erro: err.message }); }
});
app.put('/api/config-ia', authMiddleware, permOperacoes('acessar'), async (req, res) => {
  try {
    const { provedor, credencialNome, campoCred } = req.body;
    const cfg = await ConfigIA.findOneAndUpdate(
      { empresa: req.usuario.empresa },
      { provedor, credencialNome, campoCred, empresa: req.usuario.empresa },
      { new: true, upsert: true }
    );
    res.json(cfg);
  } catch(err) { res.status(500).json({ erro: err.message }); }
});

// ==================== PROCESSOS ====================

app.get('/api/processos', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try { const processos = await Processo.find({ empresa: req.usuario.empresa }).sort({ criadoEm: -1 }); res.json(processos); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/processos', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try { const processo = await Processo.create({ ...req.body, empresa: req.usuario.empresa, criadoPor: req.usuario.id }); res.status(201).json(processo); }
  catch (err) { res.status(400).json({ erro: err.message }); }
});
app.put('/api/processos/:id', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    const prev = await Processo.findById(req.params.id).lean();
    const body = { ...req.body, atualizadoEm: new Date() };
    // versioning: if caller passes versionar:true, snapshot current before saving and lock canvas
    if (req.body.versionar && prev) {
      body.versoes = [...(prev.versoes||[]), { versao: prev.versao, elementos: prev.elementos, conexoes: prev.conexoes, data: new Date(), autor: req.usuario.nome||req.usuario.email||'—' }];
      body.bloqueado = true;
    }
    if (req.body.desbloquear) { body.bloqueado = false; delete body.desbloquear; }
    const processo = await Processo.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, body, { new: true, strict: false });
    if (!processo) return res.status(404).json({ erro: 'Processo não encontrado' });
    res.json(processo);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.delete('/api/processos/:id', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try { await Processo.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa }); res.json({ mensagem: 'Processo deletado!' }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

// Resolve provedor+credencial (override do chamador OU default da empresa em
// ConfigIA) e chama a API de IA correspondente. Extraído da rota abaixo pra
// também ser reaproveitado pelo step `call_ai_agent` do automationEngine —
// mesma lógica, dois chamadores, sem duplicar as três integrações de provider.
// Extras usados pelas sessões de IA do builder (ver lib/automationEngine.js::aiChat):
// `apiKey` já resolvida (pula a busca no cofre), `history` (conversa anterior:
// [{role:'user'|'assistant', content}]), `temperature` e `maxTokens`. A temperatura
// NÃO é enviada à Anthropic (Claude) — só a OpenAI e ao Gemini.
async function resolverEChamarIA(empresa, { systemMessage, userMessage, provedor: provedorReq, credencialNome: credNomeReq, campoCred: campoReq, formatoSaida, camposJson, apiKey: apiKeyDireta, history, temperature, maxTokens, modelo: modeloReq }) {
  if (!userMessage) throw new Error('Mensagem do usuário não informada');
  const hist = Array.isArray(history) ? history : [];

  let provedor = provedorReq, credNome = credNomeReq, campo = campoReq;
  if (!provedor || provedor === 'empresa') {
    const cfgIA = await ConfigIA.findOne({ empresa }).lean();
    provedor = cfgIA?.provedor || 'claude-sonnet';
    if (!credNome) credNome = cfgIA?.credencialNome;
    if (!campo)   campo   = cfgIA?.campoCred || 'api_key';
  }
  let apiKey = apiKeyDireta || '';
  if (!apiKey) {
    const cred = await Credencial.findOne({ nome: credNome, empresa }).lean();
    apiKey = cred?.campos?.[campo || 'api_key'] || '';
  }
  if (!apiKey) throw new Error('Credencial de API não encontrada. Configure em Configurações → IA ou informe uma credencial na action.');

  let finalUserMsg = userMessage;
  if (formatoSaida === 'json' && camposJson?.length) {
    const schema = '{' + camposJson.map(f => `"${f.nome}": <${f.tipo||'string'}>`).join(', ') + '}';
    finalUserMsg += `\n\nResponda APENAS com um JSON válido, sem texto adicional, no formato exato:\n${schema}`;
  }

  let resposta = '';

  if (provedor === 'claude-sonnet' || provedor === 'claude-haiku') {
    const modelId = modeloReq || (provedor === 'claude-sonnet' ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001');
    const body = { model: modelId, max_tokens: maxTokens || 2048, messages: [...hist, { role: 'user', content: finalUserMsg }] };
    if (systemMessage) body.system = systemMessage;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || 'Erro na API Anthropic');
    resposta = d.content?.[0]?.text || '';

  } else if (provedor === 'gpt-4o' || provedor === 'gpt-4' || provedor === 'groq') {
    // A Groq usa a mesma API da OpenAI (chat/completions), só muda a URL, a chave e o modelo.
    const ehGroq = provedor === 'groq';
    const messages = [];
    if (systemMessage) messages.push({ role: 'system', content: systemMessage });
    messages.push(...hist, { role: 'user', content: finalUserMsg });
    const body = { model: modeloReq || (ehGroq ? 'openai/gpt-oss-20b' : provedor === 'gpt-4o' ? 'gpt-4o' : 'gpt-4'), messages };
    if (typeof temperature === 'number') body.temperature = temperature;
    if (maxTokens) body.max_tokens = maxTokens;
    if (formatoSaida === 'json') body.response_format = { type: 'json_object' };
    const r = await fetch(ehGroq ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || (ehGroq ? 'Erro na API Groq' : 'Erro na API OpenAI'));
    resposta = d.choices?.[0]?.message?.content || '';

  } else if (provedor === 'gemini') {
    // Gemini chama o papel do assistente de "model".
    const body = { contents: [...hist.map(h => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] })), { role: 'user', parts: [{ text: finalUserMsg }] }] };
    const genCfg = {};
    if (typeof temperature === 'number') genCfg.temperature = temperature;
    if (maxTokens) genCfg.maxOutputTokens = maxTokens;
    if (Object.keys(genCfg).length) body.generationConfig = genCfg;
    if (systemMessage) body.systemInstruction = { parts: [{ text: systemMessage }] };
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modeloReq || 'gemini-1.5-pro'}:generateContent?key=${apiKey}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || 'Erro na API Gemini');
    resposta = d.candidates?.[0]?.content?.parts?.[0]?.text || '';

  } else {
    throw new Error('Provedor não suportado: ' + (provedor||'?'));
  }

  let campos = null;
  if (formatoSaida === 'json') {
    try {
      const match = resposta.match(/\{[\s\S]*\}/);
      campos = JSON.parse(match ? match[0] : resposta);
    } catch(e) { campos = null; }
  }

  return { resposta, campos };
}

app.post('/api/processos/ia/executar', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    const { systemMessage, userMessage, provedor, credencialNome, campoCred, formatoSaida, camposJson, varSaida, execId } = req.body;
    const { resposta, campos } = await resolverEChamarIA(req.usuario.empresa, { systemMessage, userMessage, provedor, credencialNome, campoCred, formatoSaida, camposJson });

    // Store results in process variables
    if (execId) {
      const exec = await ProExec.findById(execId).lean();
      if (exec) {
        const vars = exec.variavelGlobal || {};
        if (campos) {
          for (const [k, v] of Object.entries(campos)) vars[k] = String(v);
        } else if (varSaida) {
          vars[varSaida] = resposta;
        }
        await ProExec.findByIdAndUpdate(execId, { variavelGlobal: vars });
      }
    }

    res.json({ ok: true, resposta, campos });
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

// Execuções de processo
app.get('/api/pro-execucoes', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try { const execs = await ProExec.find({ empresa: req.usuario.empresa }).sort({ criadoEm: -1 }).lean(); res.json(execs); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/pro-execucoes', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    const proc = await Processo.findById(req.body.processoId).lean();
    const flatElems = [];
    for (const e of (proc?.elementos||[])) {
      flatElems.push(e);
      if (e.tipo === 'condicional') {
        for (const b of (e.dados?.branchVerd||[])) flatElems.push(b);
        for (const b of (e.dados?.branchFalso||[])) flatElems.push(b);
      }
      if (e.tipo === 'loop') {
        for (const b of (e.dados?.loopBody||[])) flatElems.push(b);
      }
    }
    const etapas = flatElems
      .filter(e => !['break_loop','try_catch'].includes(e.tipo))
      .map(e => ({ elementoId: e.id, status: 'Pendente', obs: '', completadoEm: null }));
    const exec = await ProExec.create({ ...req.body, etapas, versaoModelo: proc?.versao||'', empresa: req.usuario.empresa, criadoPor: req.usuario.id });
    await notificarResponsaveisNovos(req.usuario.empresa, `Nova execução: ${exec.titulo}`, `Você foi associado à execução de processo "${exec.titulo}".`, 'info', '⚙️', '/operacoes', [], exec.responsaveis);
    res.status(201).json(exec);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.put('/api/pro-execucoes/:id', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    const body = { ...req.body, atualizadoEm: new Date() };
    // Carimba concluidoEm na primeira vez que o status vira terminal (pra Lead Time do dashboard)
    if (body.status && PROEXEC_STATUS_TERMINAIS.includes(body.status)) {
      const atual = await ProExec.findOne({ _id: req.params.id, empresa: req.usuario.empresa }).select('status').lean();
      if (atual && !PROEXEC_STATUS_TERMINAIS.includes(atual.status)) body.concluidoEm = new Date();
    }
    const anterior = req.body.responsaveis !== undefined ? await ProExec.findById(req.params.id).select('responsaveis titulo').lean() : null;
    const exec = await ProExec.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, body, { new: true, strict: false });
    if (!exec) return res.status(404).json({ erro: 'Execução não encontrada' });
    if (anterior) {
      await notificarResponsaveisNovos(req.usuario.empresa, `Execução associada: ${exec.titulo}`, `Você foi associado à execução de processo "${exec.titulo}".`, 'info', '⚙️', '/operacoes', anterior.responsaveis, exec.responsaveis);
    }
    // auto-complete: if all non-structural etapas done, mark process status
    if (!req.body.status) {
      const etapas = exec.etapas || [];
      const allDone = etapas.length && etapas.every(e => ['Concluído','Dispensado'].includes(e.status));
      if (allDone) await ProExec.findByIdAndUpdate(exec._id, { status: 'Concluído com Sucesso', concluidoEm: new Date() }, { strict: false });
    }
    res.json(exec);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.delete('/api/pro-execucoes/:id', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try { await ProExec.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa }); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/pro-execucoes/:id/enviar-email', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    const { emailTemplateId, emailContatoId, emailGrupoId, assinaturaHtml } = req.body;
    if (!emailTemplateId) return res.status(400).json({ erro: 'Template de e-mail não configurado.' });
    const template = await EmailTemplate.findById(emailTemplateId).lean();
    if (!template) return res.status(400).json({ erro: 'Template não encontrado.' });
    const smtpCfg = await SmtpConfig.findOne({ empresa: req.usuario.empresa }).lean();
    if (!smtpCfg || !smtpCfg.servidor) return res.status(400).json({ erro: 'SMTP não configurado.' });
    let contatos = [];
    if (emailGrupoId) {
      contatos = await Contato.find({ empresa: req.usuario.empresa, grupo: emailGrupoId }).lean();
    } else if (emailContatoId) {
      const c = await Contato.findById(emailContatoId).lean();
      if (c) contatos = [c];
    }
    if (!contatos.length) return res.status(400).json({ erro: 'Nenhum contato configurado.' });
    const transporter = nodemailer.createTransport({
      host: smtpCfg.servidor, port: parseInt(smtpCfg.porta)||587,
      secure: parseInt(smtpCfg.porta)===465,
      auth: { user: smtpCfg.usuario, pass: smtpCfg.senha },
      tls: { rejectUnauthorized: false }
    });
    const assinHtml = assinaturaHtml || '';
    for (const contato of contatos) {
      if (!contato.email) continue;
      const primeiroNome = (contato.nome||'').split(' ')[0];
      let corpo = (template.corpo||'')
        .replace(/\{nomeCompleto\}/g, contato.nome||'')
        .replace(/\{primeiroNome\}/g, primeiroNome)
        .replace(/\{data\}/g, new Date().toLocaleDateString('pt-BR'))
        .replace(/\{assinatura\}/g, assinHtml);
      if (assinHtml && !corpo.includes(assinHtml)) {
        corpo += `<br><br><hr style="border:none;border-top:1px solid #e2e8f0;margin:16px 0">${assinHtml}`;
      }
      await transporter.sendMail({
        from: smtpCfg.remetente || smtpCfg.usuario,
        to: contato.email,
        subject: template.assunto||'',
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">${corpo}</div>`,
      });
    }
    res.json({ mensagem: 'E-mail enviado!' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== ROBÔS ====================

app.get('/api/robos', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try { const robos = await Robot.find({ empresa: req.usuario.empresa }).sort({ criadoEm: -1 }); res.json(robos); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/robos', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    const body = { ...req.body, empresa: req.usuario.empresa, criadoPor: req.usuario.id };
    if (body.schedule?.ativo) body.schedule.proximaExec = calcularProximaExec(body.schedule);
    const robo = await Robot.create(body);
    await AuditoriaRobo.create({ roboId: robo._id, empresaId: req.usuario.empresa, usuarioNome: req.usuario.nome || '', usuarioEmail: req.usuario.email || '', acao: 'criou', detalhes: `Robô "${robo.nome}" criado.` });
    res.status(201).json(robo);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.put('/api/robos/:id', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    const body = { ...req.body, atualizadoEm: new Date() };
    if (body.schedule?.ativo) body.schedule.proximaExec = calcularProximaExec(body.schedule);
    const robo = await Robot.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, body, { new: true, strict: false });
    if (!robo) return res.status(404).json({ erro: 'Robô não encontrado' });
    if (robo) await AuditoriaRobo.create({ roboId: robo._id, empresaId: req.usuario.empresa, usuarioNome: req.usuario.nome || '', usuarioEmail: req.usuario.email || '', acao: 'editou', detalhes: `Robô "${robo.nome}" atualizado.` });
    res.json(robo);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.delete('/api/robos/:id', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    await Robot.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa });
    await ExecucaoRobo.deleteMany({ roboId: req.params.id, empresa: req.usuario.empresa });
    res.json({ mensagem: 'Robô deletado!' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.patch('/api/robos/:id/ativar', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    const robo = await Robot.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, { ativo: req.body.ativo, atualizadoEm: new Date() }, { new: true });
    if (!robo) return res.status(404).json({ erro: 'Robô não encontrado' });
    const acao = req.body.ativo ? 'ativou' : 'inativou';
    await AuditoriaRobo.create({ roboId: robo._id, empresaId: req.usuario.empresa, usuarioNome: req.usuario.nome || '', usuarioEmail: req.usuario.email || '', acao, detalhes: `Robô "${robo.nome}" ${acao}.` });
    res.json(robo);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

// ==================== FILA DE PROCESSAMENTO ====================

// GET /api/robos/:id/fila — lista itens (JWT ou x-robot-key)
app.get('/api/robos/:id/fila', filaAuth, async (req, res) => {
  try {
    const roboId = req.roboId || req.params.id;
    const items = await FilaItem.find({ roboId, empresaId: req.filaEmpresa }).sort({ posicao: 1, criadoEm: 1 });
    res.json(items);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// GET /api/robos/:id/fila/proximo — próximo item aguardando (ANTES de /:itemId para não conflitar)
app.get('/api/robos/:id/fila/proximo', filaAuth, async (req, res) => {
  try {
    const roboId = req.roboId || req.params.id;
    const item = await FilaItem.findOne({ roboId, empresaId: req.filaEmpresa, status: 'aguardando' }).sort({ posicao: 1, criadoEm: 1 });
    if (!item) return res.json(null);
    res.json(item);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// POST /api/robos/:id/fila — adiciona item
app.post('/api/robos/:id/fila', filaAuth, async (req, res) => {
  try {
    const robo = req.roboFromKey || await Robot.findById(req.params.id).lean();
    if (!robo || robo.empresa.toString() !== req.filaEmpresa.toString()) return res.status(404).json({ erro: 'Robô não encontrado' });
    const roboId = robo._id;
    const count = await FilaItem.countDocuments({ roboId, empresaId: req.filaEmpresa });
    const item = await FilaItem.create({
      roboId,
      empresaId: req.filaEmpresa,
      itemId: req.body.itemId || crypto.randomUUID(),
      nome: req.body.nome || '',
      status: req.body.status || 'aguardando',
      conteudo: req.body.conteudo || {},
      posicao: req.body.posicao ?? count
    });
    res.status(201).json(item);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

// PATCH /api/robos/:id/fila/:itemId — atualiza status ou campos
app.patch('/api/robos/:id/fila/:itemId', filaAuth, async (req, res) => {
  try {
    const roboId = req.roboId || req.params.id;
    const updates = { ...req.body, atualizadoEm: new Date() };
    const item = await FilaItem.findOneAndUpdate(
      { _id: req.params.itemId, roboId, empresaId: req.filaEmpresa },
      updates, { new: true }
    );
    if (!item) return res.status(404).json({ erro: 'Item não encontrado' });
    res.json(item);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

// DELETE /api/robos/:id/fila/:itemId — remove item
app.delete('/api/robos/:id/fila/:itemId', filaAuth, async (req, res) => {
  try {
    const roboId = req.roboId || req.params.id;
    await FilaItem.findOneAndDelete({ _id: req.params.itemId, roboId, empresaId: req.filaEmpresa });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// PUT /api/robos/:id/fila/reorder — reordena (body: { ids: ['id1','id2',...] })
app.put('/api/robos/:id/fila/reorder', filaAuth, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids)) return res.status(400).json({ erro: 'ids deve ser array' });
    await Promise.all(ids.map((id, i) => FilaItem.findByIdAndUpdate(id, { posicao: i, atualizadoEm: new Date() })));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// GET /api/robos/:id/auditoria — histórico de auditoria
app.get('/api/robos/:id/auditoria', authMiddleware, permOperacoes('acessar'), async (req, res) => {
  try {
    const logs = await AuditoriaRobo.find({ roboId: req.params.id, empresaId: req.usuario.empresa }).sort({ timestamp: -1 }).limit(100);
    res.json(logs);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Robô "Nuvem" roda num runner efêmero do GitHub Actions. Robôs legados com
// webhookUrl preenchido continuam no fluxo antigo (o agent local dispara o webhook).
function roboRodaNoGithub(robo) {
  return robo.ambiente === 'nuvem' && !robo.webhookUrl;
}

// Decide onde a execução de um robô (não-builder) vai rodar. Nuvem: sobe um
// runner efêmero (Maquina temporária + workflow_dispatch) que faz heartbeat e
// pega o comando como um agent normal. Local: máquina vinculada, senão qualquer
// online com slot livre.
async function alocarMaquinaDoRobo(robo, empresa) {
  // Nuvem não passa por aqui: ver dispararExecucaoRobo (fila FIFO em segundo plano).
  let maquina = null;
  if (robo.maquinaId) {
    maquina = await Maquina.findOne({ _id: robo.maquinaId, empresa, status: { $in: ['online','busy'] }, ativo: true });
  }
  if (!maquina) {
    // Agent local (máquina física): sem limite de execuções simultâneas.
    maquina = await Maquina.findOne({
      empresa, status: { $in: ['online', 'busy'] }, ativo: true, efemera: { $ne: true },
    }).sort({ robosAtivos: 1 });
  }
  return { maquina, motivo: maquina ? '' : 'Nenhuma máquina online disponível' };
}

// Cria a ExecucaoRobo de um robô não-builder e a encaminha. Local: máquina física
// na hora (ou "não disparado"). Nuvem: a execução nasce "na_fila", a requisição
// responde na hora e a espera pela máquina da Nuvem da empresa (FIFO, uma por
// vez) roda em segundo plano; quando chega a vez vira "em_execucao" apontando
// para a máquina, e o heartbeat do runner a pega. Interromper na fila cancela.
async function dispararExecucaoRobo(robo, { empresa, gatilho, criadoPor = null }) {
  const base = { roboId: robo._id, roboNome: robo.nome, gatilho, prioridade: robo.prioridade || 'Media', empresa, ...(criadoPor ? { criadoPor } : {}) };
  if (roboRodaNoGithub(robo)) {
    const exec = await ExecucaoRobo.create({ ...base, status: 'na_fila', maquina: '', maquinaId: null, iniciadoEm: null });
    (async () => {
      try {
        const maquina = await automationEngine.obterMaquinaEfemera(empresa, {
          deveCancelar: async () => (await ExecucaoRobo.findById(exec._id).select('status').lean())?.status !== 'na_fila',
        });
        const ok = await ExecucaoRobo.findOneAndUpdate({ _id: exec._id, status: 'na_fila' },
          { $set: { status: 'em_execucao', maquina: maquina.machineId, maquinaId: maquina._id, iniciadoEm: new Date() } });
        if (!ok) await automationEngine.liberarMaquinaEfemera(maquina._id); // interrompida no último instante
      } catch (e) {
        if (!e.cancelled) {
          await ExecucaoRobo.updateOne({ _id: exec._id, status: 'na_fila' },
            { $set: { status: 'nao_disparado', motivoInterrupcao: `Não foi possível usar a máquina da Nuvem: ${e.message}` } });
        }
      }
    })().catch((err) => console.error('Erro na fila da Nuvem:', err));
    return exec;
  }
  const { maquina, motivo } = await alocarMaquinaDoRobo(robo, empresa);
  const exec = await ExecucaoRobo.create({
    ...base,
    status: maquina ? 'em_execucao' : 'nao_disparado',
    motivoInterrupcao: maquina ? '' : motivo,
    maquina: maquina ? maquina.machineId : '',
    maquinaId: maquina ? maquina._id : null,
    iniciadoEm: maquina ? new Date() : null,
  });
  if (maquina) await Maquina.findByIdAndUpdate(maquina._id, { $inc: { robosAtivos: 1 } });
  return exec;
}

// Executar robô manualmente
app.post('/api/robos/:id/executar', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    const robo = await Robot.findOne({ _id: req.params.id, empresa: req.usuario.empresa });
    if (!robo) return res.status(404).json({ erro: 'Robô não encontrado' });

    // Robô criado pelo builder visual de automação: motor próprio
    // (automationEngine), não o dispatch local/webhook tradicional abaixo.
    if (robo.origem === 'builder') {
      if (!robo.automacaoId) return res.status(400).json({ erro: 'Robô do builder sem automação vinculada' });
      const exec = await ExecucaoRobo.create({
        roboId: robo._id, roboNome: robo.nome, status: 'em_execucao', maquina: '',
        gatilho: req.body.gatilho || 'manual', prioridade: robo.prioridade || 'Media',
        iniciadoEm: new Date(), empresa: req.usuario.empresa, criadoPor: req.usuario.id,
      });
      const run = await automationEngine.iniciarRunEmBackground({
        automacaoId: robo.automacaoId, input: req.body.input || '', gatilhoTipo: 'manual',
        empresa: req.usuario.empresa, roboId: robo._id, execucaoRoboId: exec._id,
      });
      await ExecucaoRobo.findByIdAndUpdate(exec._id, { automacaoRunId: run._id });
      // Quando o run terminar, reflete o resultado no registro público
      // (ExecucaoRobo) que a aba Execuções já sabe mostrar — sem isso, a
      // execução ficaria "em_execucao" pra sempre nessa tela.
      _espelharRunNaExecucao(run._id, exec._id).catch((err) => console.error('Erro ao espelhar run na execução:', err));
      res.status(201).json({ ...exec.toObject(), status: exec.status });
      return;
    }

    const exec = await dispararExecucaoRobo(robo, { empresa: req.usuario.empresa, gatilho: req.body.gatilho || 'manual', criadoPor: req.usuario.id });
    res.status(201).json({ ...exec.toObject(), status: exec.status });
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

// Interromper execução
app.post('/api/robos/execucoes/:id/interromper', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    const atual = await ExecucaoRobo.findOne({ _id: req.params.id, empresa: req.usuario.empresa, status: { $in: ['em_execucao', 'na_fila'] } });
    if (!atual) return res.status(404).json({ erro: 'Execução não encontrada ou já finalizada' });

    // Execução vinda do builder: cancelamento é cooperativo (cancelRequested no
    // AutomacaoRun) — não marca "interrompido" aqui na hora, quem faz isso é o
    // _espelharRunNaExecucao quando o motor efetivamente parar (ver acima).
    if (atual.automacaoRunId) {
      await AutomacaoRun.findByIdAndUpdate(atual.automacaoRunId, { cancelRequested: true });
      return res.json(atual);
    }

    const exec = await ExecucaoRobo.findOneAndUpdate(
      { _id: req.params.id, empresa: req.usuario.empresa, status: { $in: ['em_execucao', 'na_fila'] } },
      { status: 'interrompido', motivoInterrupcao: req.body.motivo || 'Interrupção manual', finalizadoEm: new Date() },
      { new: true }
    );
    if (!exec) return res.status(404).json({ erro: 'Execução não encontrada ou já finalizada' });
    res.json(exec);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

// CRUD execuções
app.get('/api/robos/execucoes', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    const filter = { empresa: req.usuario.empresa };
    if (req.query.status) filter.status = req.query.status;
    if (req.query.roboId) filter.roboId = req.query.roboId;
    const execs = await ExecucaoRobo.find(filter).sort({ criadoEm: -1 }).limit(200);
    res.json(execs);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});
app.get('/api/robos/execucoes/:id', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    const exec = await ExecucaoRobo.findOne({ _id: req.params.id, empresa: req.usuario.empresa });
    if (!exec) return res.status(404).json({ erro: 'Execução não encontrada' });
    res.json(exec);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});
app.put('/api/robos/execucoes/:id', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    const exec = await ExecucaoRobo.findOneAndUpdate(
      { _id: req.params.id, empresa: req.usuario.empresa },
      { ...req.body },
      { new: true, strict: false }
    );
    if (!exec) return res.status(404).json({ erro: 'Execução não encontrada' });
    res.json(exec);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

// Logs da execução (agent posts here)

// Métricas resumo
app.get('/api/robos/metricas', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    const empresa = req.usuario.empresa;
    const [robos, execs, agentes] = await Promise.all([
      Robot.find({ empresa }).lean(),
      ExecucaoRobo.find({ empresa }).lean(),
      AgenteRobo.find({ empresa }).lean()
    ]);
    const total = execs.length;
    const concluidos = execs.filter(e => e.status === 'concluido').length;
    const erros = execs.filter(e => e.status === 'erro').length;
    const emExecucao = execs.filter(e => e.status === 'em_execucao').length;
    const taxaSucesso = total > 0 ? Math.round(concluidos / total * 100) : 0;
    const backlog = execs.filter(e => e.status === 'nao_disparado').length;
    // Top 5 erros por robo
    const errosPorRobo = {};
    for (const e of execs.filter(x => x.status === 'erro')) {
      errosPorRobo[e.roboNome] = (errosPorRobo[e.roboNome] || 0) + 1;
    }
    const top5Erros = Object.entries(errosPorRobo).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([nome,erros])=>({nome,erros}));
    // Tempo médio por robo
    const tempoPorRobo = {};
    for (const e of execs.filter(x => x.status === 'concluido' && x.duracao)) {
      if (!tempoPorRobo[e.roboNome]) tempoPorRobo[e.roboNome] = [];
      tempoPorRobo[e.roboNome].push(e.duracao);
    }
    const tempoMedio = Object.entries(tempoPorRobo).map(([nome, durs]) => ({
      nome, media: Math.round(durs.reduce((a,b)=>a+b,0)/durs.length)
    }));
    // SLA atingimento per robot
    const slaMap = {};
    for (const r of robos) if (r.sla) slaMap[r._id.toString()] = r.sla * 60;
    const slaPorRobo = {};
    for (const e of execs.filter(x => x.status === 'concluido')) {
      const rid = e.roboId?.toString();
      const sla = slaMap[rid];
      if (!sla) continue;
      if (!slaPorRobo[e.roboNome]) slaPorRobo[e.roboNome] = {total:0, ok:0};
      slaPorRobo[e.roboNome].total++;
      if ((e.duracao||0) <= sla) slaPorRobo[e.roboNome].ok++;
    }
    const slaAtingimento = Object.entries(slaPorRobo).map(([nome,v])=>({ nome, pct: Math.round(v.ok/v.total*100) }));
    // Volumetria por area
    const areaCounts = {};
    for (const r of robos) for (const a of (r.areasBeneficiadas||[])) areaCounts[a] = (areaCounts[a]||0) + 1;
    const volumetria = Object.entries(areaCounts).sort((a,b)=>b[1]-a[1]).map(([area,count])=>({area,count}));
    // FTE saved: avg human time vs avg exec time
    const ftePorRobo = robos.map(r => {
      const exeRobo = execs.filter(e => e.roboId?.toString()===r._id.toString() && e.status==='concluido' && e.duracao);
      const avgExec = exeRobo.length ? exeRobo.reduce((a,e)=>a+e.duracao,0)/exeRobo.length : 0;
      const humanSec = (r.tempoManual||0)*60;
      const pct = humanSec > 0 && avgExec > 0 ? Math.round((humanSec - avgExec)/humanSec*100) : null;
      return { nome: r.nome, pct };
    }).filter(x=>x.pct!==null);
    res.json({ taxaSucesso, total, concluidos, erros, emExecucao, backlog, top5Erros, tempoMedio, slaAtingimento, volumetria, ftePorRobo, agentes: agentes.map(a=>({nome:a.nome,status:a.status,robosAtivos:a.robosAtivos,capacidadeMaxima:a.capacidadeMaxima})) });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// CRUD agentes
app.get('/api/robos/agentes', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try { const agentes = await AgenteRobo.find({ empresa: req.usuario.empresa }).sort({ criadoEm: -1 }); res.json(agentes); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/robos/agentes', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    const token = require('crypto').randomBytes(32).toString('hex');
    const agente = await AgenteRobo.create({ ...req.body, token, empresa: req.usuario.empresa });
    res.status(201).json(agente);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.put('/api/robos/agentes/:id', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    const agente = await AgenteRobo.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, { ...req.body, atualizadoEm: new Date() }, { new: true, strict: false });
    if (!agente) return res.status(404).json({ erro: 'Agente não encontrado' });
    res.json(agente);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.delete('/api/robos/agentes/:id', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try { await AgenteRobo.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa }); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
// Heartbeat — called by worker agent (auth by token header)
app.post('/api/robos/agentes/:id/heartbeat', async (req, res) => {
  try {
    const agente = await AgenteRobo.findById(req.params.id);
    if (!agente) return res.status(404).json({ erro: 'Agente não encontrado' });
    const token = req.headers['x-agent-token'];
    if (token && agente.token && token !== agente.token) return res.status(401).json({ erro: 'Token inválido' });
    await AgenteRobo.findByIdAndUpdate(agente._id, { status: 'conectado', ultimoHeartbeat: new Date(), robosAtivos: req.body.robosAtivos || 0 });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

// ==================== MÁQUINAS ====================

app.get('/api/maquinas', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    const lista = await Maquina.find({ empresa: req.usuario.empresa, ativo: true }).sort({ criadoEm: -1 }).select('-machineKey');
    res.json(lista);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/maquinas', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    const machineKey = crypto.randomUUID();
    // Campos da máquina da Nuvem são controlados só pelo servidor.
    const { efemera, usos, filaOrdem, encerrando, ociosaDesde, ...dados } = req.body;
    const maquina = await Maquina.create({
      ...dados, machineKey,
      empresa: req.usuario.empresa, criadoPor: req.usuario.id
    });
    res.status(201).json({ ...maquina.toObject() }); // key included only on creation
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.put('/api/maquinas/:id', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    const { machineKey, efemera, usos, filaOrdem, encerrando, ociosaDesde, ...updates } = req.body;
    const maquina = await Maquina.findOneAndUpdate(
      { _id: req.params.id, empresa: req.usuario.empresa },
      { ...updates, atualizadoEm: new Date() },
      { new: true }
    ).select('-machineKey');
    if (!maquina) return res.status(404).json({ erro: 'Máquina não encontrada' });
    res.json(maquina);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.delete('/api/maquinas/:id', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    await Maquina.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, { ativo: false });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/maquinas/:id/manutencao', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    const maquina = await Maquina.findOne({ _id: req.params.id, empresa: req.usuario.empresa });
    if (!maquina) return res.status(404).json({ erro: 'Não encontrada' });
    const modo = !maquina.maintenanceMode;
    const novoStatus = modo ? 'maintenance' : (maquina.ultimoHeartbeat && (Date.now() - new Date(maquina.ultimoHeartbeat)) < 90000 ? 'online' : 'offline');
    await Maquina.findByIdAndUpdate(maquina._id, { maintenanceMode: modo, status: novoStatus });
    res.json({ maintenanceMode: modo, status: novoStatus });
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

// Gera config.json para download do agent — inclui machineKey
app.get('/api/maquinas/:id/agent-config', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    const maquina = await Maquina.findOne({ _id: req.params.id, empresa: req.usuario.empresa });
    if (!maquina) return res.status(404).json({ erro: 'Máquina não encontrada' });
    res.json({
      server: PUBLIC_URL,
      workspace: req.usuario.empresa.toString(),
      machineKey: maquina.machineKey,
      machineId: maquina.machineId
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Pacote completo do Agent num único .zip (config.json + agent.py + iniciar.vbs) —
// evita o problema de downloads separados virarem "agent (1).py" etc quando já
// existe um arquivo com o mesmo nome na pasta de downloads do usuário.
app.get('/api/maquinas/:id/agent-package.zip', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    const maquina = await Maquina.findOne({ _id: req.params.id, empresa: req.usuario.empresa });
    if (!maquina) return res.status(404).json({ erro: 'Máquina não encontrada' });
    const config = {
      server: PUBLIC_URL,
      workspace: req.usuario.empresa.toString(),
      machineKey: maquina.machineKey,
      machineId: maquina.machineId
    };
    const files = [
      { name: 'config.json', data: Buffer.from(JSON.stringify(config, null, 2), 'utf8') },
      { name: 'agent.py', data: fs.readFileSync(path.join(__dirname, 'public', 'agent.py')) },
      { name: 'hoc_step_executor.py', data: fs.readFileSync(path.join(__dirname, 'public', 'hoc_step_executor.py')) },
      { name: 'iniciar.vbs', data: fs.readFileSync(path.join(__dirname, 'public', 'iniciar.vbs')) },
    ];
    const zipBuf = buildZip(files);
    const nomeSeguro = (maquina.nome || maquina.machineId || 'agent').replace(/[^a-zA-Z0-9_-]/g, '_');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="hoc-agent-${nomeSeguro}.zip"`);
    // Sem isso o navegador pode servir um .zip antigo do cache mesmo depois do
    // agent.py ser atualizado no servidor — sempre gerar fresco.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.send(zipBuf);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Runner da Nuvem avisa que terminou o(s) comando(s) dele. Como a máquina é
// compartilhada pela empresa, só apaga se ninguém estiver usando nem na fila;
// apagada, o próximo heartbeat volta 401 e o runner encerra sozinho. Só age em
// Maquina efemera:true; agent de máquina real recebe 404.
app.post('/api/maquinas/efemera/encerrar', async (req, res) => {
  try {
    const { machineKey } = req.body;
    if (!machineKey) return res.status(400).json({ erro: 'machineKey obrigatória' });
    const maquina = await Maquina.findOne({ machineKey, efemera: true });
    if (!maquina) return res.status(404).json({ erro: 'Máquina efêmera não encontrada' });
    const encerrada = await automationEngine.encerrarMaquinaEfemeraSeOciosa(maquina._id);
    res.json({ ok: true, encerrada });
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

// Heartbeat — chamado pelo agent.py a cada 20s (autenticado por machineKey no body)
app.post('/api/maquinas/heartbeat', async (req, res) => {
  try {
    const { machineKey, cpu, ram, robosAtivos, robosAtivosList } = req.body;
    if (!machineKey) return res.status(400).json({ erro: 'machineKey obrigatória' });
    const maquina = await Maquina.findOne({ machineKey, ativo: true });
    if (!maquina) return res.status(401).json({ erro: 'Chave inválida' });
    const ativos = robosAtivos || 0;
    const status = maquina.maintenanceMode ? 'maintenance'
      : ativos >= (maquina.capacidadeMaxima || 4) ? 'busy'
      : 'online';
    await Maquina.findByIdAndUpdate(maquina._id, {
      cpu: cpu || 0, ram: ram || 0,
      robosAtivos: ativos, robosAtivosList: robosAtivosList || [],
      ultimoHeartbeat: new Date(), status
    });
    // Retorna comandos pendentes — mark atômico (findOneAndUpdate) evita double-dispatch
    // mesmo com múltiplos agentes ou heartbeats concorrentes
    const pendentes = [];
    for (let i = 0; i < 3; i++) {
      const exec = await ExecucaoRobo.findOneAndUpdate(
        { maquina: maquina.machineId, status: 'em_execucao', comandoEnviado: { $ne: true } },
        { $set: { comandoEnviado: true } },
        { new: true }
      );
      if (!exec) break;
      pendentes.push(exec);
    }
    const roboIds = [...new Set(pendentes.map(e => e.roboId?.toString()).filter(Boolean))];
    const robosEncontrados = roboIds.length ? await Robot.find({ _id: { $in: roboIds } }) : [];
    const roboMap = Object.fromEntries(robosEncontrados.map(r => [r._id.toString(), r]));
    const INTERP = { py:'python', js:'node', ts:'npx ts-node', rb:'ruby', sh:'bash', php:'php', r:'Rscript' };
    const commands = pendentes.map(e => {
      const robo = roboMap[e.roboId?.toString()] || {};
      let command = robo.comandoExecucao || '';
      if (!command && robo.arquivoPrincipal) {
        const arq = robo.arquivoPrincipal;
        if (/\s/.test(arq.trim())) {
          // Já parece um comando completo (tem espaço) — usa como está, evita
          // duplicar o interpretador (ex: virar "python python main.py").
          command = arq.trim();
        } else {
          const ext = (arq.split('.').pop()||'').toLowerCase();
          if (INTERP[ext]) command = `${INTERP[ext]} ${arq}`;
          else if (['exe','bat','cmd'].includes(ext)) command = arq;
          else command = `python ${arq}`;
        }
      }
      return {
        execId:           e._id,
        roboId:           e.roboId?.toString() || '',
        roboNome:         robo.nome || 'Robô',
        command,
        arquivoPrincipal: robo.arquivoPrincipal || '',
        tipo:             robo.ambiente || 'local',
        webhookUrl:       robo.webhookUrl || '',
        webhookPayload:   robo.webhookPayload || {},
        gitUrl:           robo.gitUrl || '',
        gitBranch:        robo.gitBranch || 'main',
        // O painel de detalhes salva como array, o modal de criação como string —
        // o agent espera string (usa .splitlines()).
        pacotesPip:       Array.isArray(robo.pacotesPip) ? robo.pacotesPip.join('\n') : (robo.pacotesPip || ''),
        preComando:       robo.preComando || '',
        timeout:          robo.timeout || 30,
        apiKey:           robo.apiKey || ''
      };
    });
    // Dispatches de step do builder de automação pendentes pra essa máquina —
    // mesmo claim atômico dos comandos de robô acima, array separado porque o
    // formato não tem nada a ver com os campos de Robot (ver
    // lib/automationEngine.js::dispatchStepToAgent e hoc_step_executor.py).
    const automacaoSteps = [];
    for (let i = 0; i < 3; i++) {
      const disp = await AutomacaoStepDispatch.findOneAndUpdate(
        { maquinaId: maquina._id, status: 'pendente' },
        { $set: { status: 'enviado' } },
        { new: true, sort: { criadoEm: 1 } }
      );
      if (!disp) break;
      automacaoSteps.push({
        dispatchId: disp._id, step: disp.step,
        // run_id separa sessões de browser concorrentes na mesma máquina
        // (ver hoc_step_executor.py::_session_key) — sem isso, duas
        // automações usando o mesmo nome de sessão colidiriam.
        ctx: { ...disp.ctxSnapshot, run_id: String(disp.runId) },
      });
    }

    res.json({ ok: true, status, commands, automacaoSteps });
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

// Log de execução — postado pelo robô em execução (autenticado por machineKey)
app.post('/api/robos/execucoes/:id/logs', async (req, res) => {
  try {
    const { machineKey, message, status } = req.body;
    if (!machineKey) return res.status(400).json({ erro: 'machineKey obrigatória' });
    const maquina = await Maquina.findOne({ machineKey, ativo: true });
    if (!maquina) return res.status(401).json({ erro: 'Chave inválida' });
    const exec = await ExecucaoRobo.findById(req.params.id);
    const updates = { $push: { logs: { message: message || '', status: status || 'info', time: new Date() } } };
    if (status === 'success') {
      const dur = exec?.iniciadoEm ? Math.round((Date.now() - new Date(exec.iniciadoEm).getTime()) / 1000) : 0;
      Object.assign(updates, { $set: { status: 'concluido', finalizadoEm: new Date(), duracao: dur } });
    }
    // Só muda status para 'erro' se não estiver já 'interrompido' (evita sobrescrever)
    if (status === 'error' && exec?.status !== 'interrompido') {
      Object.assign(updates, { $set: { status: 'erro', finalizadoEm: new Date() } });
    }
    await ExecucaoRobo.findByIdAndUpdate(req.params.id, updates);
    if (status === 'success') await Robot.findByIdAndUpdate(exec?.roboId, { $inc: { totalExecucoes: 1 } });
    if (status === 'success' || (status === 'error' && exec?.status !== 'interrompido')) {
      await Maquina.findByIdAndUpdate(maquina._id, { $inc: { robosAtivos: -1 } });
    }
    // Robô Git/ZIP na máquina da Nuvem: libera a vaga dele ao terminar (inclusive interrompido).
    // A marca vagaNuvemLiberada (update atômico) evita liberar duas vezes se o fim chegar repetido.
    if (maquina.efemera && (status === 'success' || status === 'error')) {
      const primeira = await ExecucaoRobo.findOneAndUpdate({ _id: req.params.id, vagaNuvemLiberada: { $ne: true } }, { $set: { vagaNuvemLiberada: true } });
      if (primeira) await automationEngine.liberarMaquinaEfemera(maquina._id);
    }
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

// Status de interrupção — consultado pelo agent.py para saber se deve parar
app.get('/api/robos/execucoes/:id/status', async (req, res) => {
  try {
    const machineKey = req.headers['x-machine-key'];
    if (!machineKey) return res.status(400).json({ erro: 'x-machine-key header obrigatório' });
    const maquina = await Maquina.findOne({ machineKey, ativo: true });
    if (!maquina) return res.status(401).json({ erro: 'Chave inválida' });
    const exec = await ExecucaoRobo.findById(req.params.id).select('status motivoInterrupcao');
    if (!exec) return res.status(404).json({ erro: 'Não encontrada' });
    res.json({ status: exec.status, motivo: exec.motivoInterrupcao });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Logs externos — postados por scripts com x-robot-key (sem agente em execução)
app.post('/api/robos/execucoes/:id/logs/externo', async (req, res) => {
  try {
    const apiKey = req.headers['x-robot-key'];
    if (!apiKey) return res.status(400).json({ erro: 'x-robot-key header obrigatório' });
    const robo = await Robot.findOne({ apiKey }).lean();
    if (!robo) return res.status(401).json({ erro: 'Chave inválida' });
    const exec = await ExecucaoRobo.findById(req.params.id);
    if (!exec) return res.status(404).json({ erro: 'Execução não encontrada' });
    if (exec.empresa?.toString() !== robo.empresa?.toString()) return res.status(403).json({ erro: 'Acesso negado' });
    const logEntry = {
      time: req.body.time || new Date(),
      status: req.body.status || req.body.nivel || 'info',
      message: req.body.message || req.body.mensagem || '',
    };
    await ExecucaoRobo.findByIdAndUpdate(req.params.id, { $push: { logs: logEntry } });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

// Credencial por nome — consumida pelo agente (x-machine-key) ou por scripts externos (x-robot-key)
app.get('/api/credenciais/:nome/valor', async (req, res) => {
  try {
    let empresaId;
    const machineKey = req.headers['x-machine-key'];
    const apiKey     = req.headers['x-robot-key'];
    if (machineKey) {
      const maquina = await Maquina.findOne({ machineKey, ativo: true });
      if (!maquina) return res.status(401).json({ erro: 'Chave inválida' });
      empresaId = maquina.empresa;
    } else if (apiKey) {
      const robo = await Robot.findOne({ apiKey }).lean();
      if (!robo) return res.status(401).json({ erro: 'Chave inválida' });
      empresaId = robo.empresa;
    } else {
      return res.status(400).json({ erro: 'x-machine-key ou x-robot-key obrigatório' });
    }
    const cred = await Credencial.findOne({ nome: req.params.nome, empresa: empresaId });
    if (!cred) return res.status(404).json({ erro: 'Credencial não encontrada' });
    res.json({ nome: cred.nome, campos: cred.campos || { valor: cred.valor } });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Job: marcar offline máquinas sem heartbeat há mais de 90s (roda a cada 30s)
setInterval(async () => {
  try {
    const cutoff = new Date(Date.now() - 90000);
    await Maquina.updateMany(
      { ultimoHeartbeat: { $lt: cutoff }, status: { $nin: ['offline', 'maintenance'] }, ativo: true },
      { status: 'offline', robosAtivos: 0, robosAtivosList: [] }
    );
  } catch (e) { /* silent */ }
}, 30000);

// Job: faxina de runners efêmeros órfãos (roda a cada 60s). Cobre o runner que
// nunca subiu (fila/erro no GitHub, workflow inexistente) ou que morreu no meio
// sem chamar /api/maquinas/efemera/encerrar (servidor reiniciou, timeout do job).
// Sem isso a Maquina temporária e a execução ficariam "em andamento" pra sempre.
setInterval(async () => {
  try {
    const nuncaSubiu = new Date(Date.now() - 10 * 60 * 1000);
    const sumiu = new Date(Date.now() - 3 * 60 * 1000);
    const orfas = await Maquina.find({
      efemera: true,
      $or: [
        { ultimoHeartbeat: null, criadoEm: { $lt: nuncaSubiu } },
        { ultimoHeartbeat: { $lt: sumiu } },
      ],
    });
    for (const m of orfas) {
      await ExecucaoRobo.updateMany(
        { maquinaId: m._id, status: 'em_execucao' },
        { status: 'erro', finalizadoEm: new Date(), motivoInterrupcao: m.ultimoHeartbeat ? 'Runner do GitHub Actions parou de responder' : 'Runner do GitHub Actions não iniciou a tempo' }
      );
      await Maquina.findByIdAndDelete(m._id);
    }
    // Máquina da Nuvem sem uso segurada por uma fila que ninguém mais atende (ex.: servidor reiniciou).
    const ociosas = await Maquina.find({ efemera: true, encerrando: false, usos: { $lte: 0 }, ociosaDesde: { $ne: null } }).select('_id').lean();
    for (const m of ociosas) await automationEngine.encerrarMaquinaEfemeraSeOciosa(m._id, { abandonadas: true });
  } catch (e) { /* silent */ }
}, 60000);

function calcularProximaExec(schedule) {
  const { frequencia, horario, diasSemana, diaMes, intervaloValor, intervaloUnidade, inicio, dataUnica } = schedule || {};
  const now = new Date();

  if (frequencia === 'unico') return null;

  if (frequencia === 'intervalo') {
    const val = parseInt(intervaloValor) || 1;
    const ms  = intervaloUnidade === 'minutos' ? val * 60000 : intervaloUnidade === 'horas' ? val * 3600000 : val * 86400000;
    let prox  = inicio ? new Date(inicio) : new Date();
    while (prox <= now) prox = new Date(prox.getTime() + ms);
    return prox;
  }

  const [hh, mm] = (horario || '08:00').split(':').map(Number);
  let next;

  if (frequencia === 'semanal') {
    const dias = (diasSemana || []).length ? diasSemana : [1];
    for (let i = 0; i <= 7; i++) {
      const c = new Date(now); c.setDate(now.getDate() + i); c.setHours(hh, mm, 0, 0);
      if (dias.includes(c.getDay()) && c > now) { next = c; break; }
    }
    if (!next) { next = new Date(now); next.setDate(next.getDate() + 7); next.setHours(hh, mm, 0, 0); }
  } else if (frequencia === 'mensal') {
    next = new Date(now.getFullYear(), now.getMonth(), diaMes || 1, hh, mm, 0);
    if (next <= now) next = new Date(now.getFullYear(), now.getMonth() + 1, diaMes || 1, hh, mm, 0);
  } else {
    next = new Date(now); next.setHours(hh, mm, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
  }
  return next;
}

// Job: scheduler de robôs agendados (roda a cada 60s)
setInterval(async () => {
  try {
    const now = new Date();
    const agendados = await Robot.find({ 'schedule.ativo': true, 'schedule.proximaExec': { $lte: now }, ativo: true });
    for (const robo of agendados) {
      await dispararExecucaoRobo(robo, { empresa: robo.empresa, gatilho: 'schedule' });
      const proxima = calcularProximaExec(robo.schedule);
      if (proxima) await Robot.findByIdAndUpdate(robo._id, { 'schedule.proximaExec': proxima });
      else await Robot.findByIdAndUpdate(robo._id, { 'schedule.ativo': false }); // unico: desativa após disparar
    }
  } catch (e) { /* silent */ }
}, 60000);

// ==================== ROBÔ ZIP PACKAGE ====================

const robotPackagesDir = path.join(__dirname, 'public', 'robot-packages');
if (!fs.existsSync(robotPackagesDir)) fs.mkdirSync(robotPackagesDir, { recursive: true });

const uploadRobotZip = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, robotPackagesDir),
    filename: (req, file, cb) => cb(null, `${req.params.id}.zip`)
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.originalname.endsWith('.zip') || file.mimetype === 'application/zip') cb(null, true);
    else cb(new Error('Apenas arquivos .zip são aceitos'));
  }
});

// Upload do ZIP do robô (autenticado pelo usuário SaaS)
app.post('/api/robos/:id/package', authMiddleware, verificarAssinatura, permOperacoes('acessar'), uploadRobotZip.single('zip'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado' });
    await Robot.findOneAndUpdate(
      { _id: req.params.id, empresa: req.usuario.empresa },
      {
        zipNome: req.file.originalname,
        vinculoTipo: 'zip',
        atualizadoEm: new Date(),
        $push: { zipHistorico: { nome: req.file.originalname, aplicadoEm: new Date() } }
      }
    );
    res.json({ ok: true, zipNome: req.file.originalname });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Download do ZIP pelo Agent (autenticado por machineKey no header)
app.get('/api/robos/:id/package', async (req, res) => {
  try {
    const machineKey = req.headers['x-machine-key'];
    if (!machineKey) return res.status(401).json({ erro: 'x-machine-key obrigatório' });
    const maquina = await Maquina.findOne({ machineKey, ativo: true });
    if (!maquina) return res.status(401).json({ erro: 'Chave inválida' });

    const zipPath = path.join(robotPackagesDir, `${req.params.id}.zip`);
    if (!fs.existsSync(zipPath)) return res.status(404).json({ erro: 'Pacote não encontrado' });

    res.download(zipPath, `robot-${req.params.id}.zip`);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== CREDENCIAIS ====================

app.get('/api/credenciais', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try { const creds = await Credencial.find({ empresa: req.usuario.empresa }).sort({ criadoEm: -1 }); res.json(creds); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/credenciais', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try { const { nome, proprietario, validade, campos } = req.body; const cred = await Credencial.create({ nome, proprietario, validade, campos: campos || {}, empresa: req.usuario.empresa }); res.status(201).json(cred); }
  catch (err) { res.status(400).json({ erro: err.message }); }
});
app.put('/api/credenciais/:id', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    const { nome, proprietario, validade, campos: novosCampos } = req.body;
    const cred = await Credencial.findOne({ _id: req.params.id, empresa: req.usuario.empresa });
    if (!cred) return res.status(404).json({ erro: 'Credencial não encontrada' });
    // merge campos: keep old value when new value is empty string (campo mantido mas sem alteração)
    let campos = {};
    if (novosCampos) {
      const antigos = cred.campos || {};
      for (const [k, v] of Object.entries(novosCampos)) {
        campos[k] = v !== '' ? v : (antigos[k] || '');
      }
    }
    const updated = await Credencial.findOneAndUpdate(
      { _id: req.params.id, empresa: req.usuario.empresa },
      { nome, proprietario, validade, campos, atualizadoEm: new Date() },
      { new: true }
    );
    res.json(updated);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.delete('/api/credenciais/:id', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try { await Credencial.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa }); res.json({ mensagem: 'Credencial deletada!' }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

// ---- OAuth do Google (Drive/Sheets) — cada empresa usa o PRÓPRIO app OAuth
// do Google Cloud dela (ver lib/googleOAuth.js): o client_id/client_secret e o
// refresh_token ficam juntos numa credencial do cofre da empresa, com o nome
// que ela escolher. Os steps do builder usam essa credencial inteira.
const googleOAuth = require('./lib/googleOAuth');
googleOAuth.init({ fetch });
const GOOGLE_OAUTH_REDIRECT_URI = `${PUBLIC_URL}/api/integracoes/google/callback`;

app.get('/api/integracoes/google/info', authMiddleware, verificarAssinatura, permOperacoes('acessar'), (req, res) => {
  res.json({ redirectUri: GOOGLE_OAUTH_REDIRECT_URI });
});

// Grava (ou atualiza) client_id/client_secret na credencial escolhida e devolve
// a URL de login do Google — o navegador segue pra ela por navegação de página
// inteira. client_secret vazio = mantém o que já estava salvo (reconectar).
app.post('/api/integracoes/google/iniciar', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    const nome = String(req.body.nome || '').trim();
    const clientId = String(req.body.client_id || '').trim();
    const clientSecret = String(req.body.client_secret || '').trim();
    if (!nome) return res.status(400).json({ erro: 'Informe o nome da credencial.' });
    let cred = await Credencial.findOne({ nome, empresa: req.usuario.empresa });
    const campos = { ...((cred && cred.campos) || {}) };
    if (clientId) campos.client_id = clientId;
    if (clientSecret) campos.client_secret = clientSecret;
    if (!campos.client_id || !campos.client_secret) return res.status(400).json({ erro: 'Informe o Client ID e o Client secret do app OAuth do Google da sua empresa.' });
    if (cred) { cred.campos = campos; cred.atualizadoEm = new Date(); await cred.save(); }
    else cred = await Credencial.create({ nome, proprietario: 'Google', empresa: req.usuario.empresa, campos });
    const state = jwt.sign({ empresa: String(req.usuario.empresa), credId: String(cred._id) }, process.env.JWT_SECRET || 'segredo123', { expiresIn: '10m' });
    res.json({ url: googleOAuth.buildAuthUrl({ clientId: campos.client_id, redirectUri: GOOGLE_OAUTH_REDIRECT_URI, state }) });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/integracoes/google/callback', async (req, res) => {
  const voltar = (qs) => res.redirect(`${PUBLIC_URL}/operacoes?robosTab=credenciais&${qs}`);
  if (req.query.error) return voltar(`google=erro&msg=${encodeURIComponent(req.query.error)}`);
  let state;
  try { state = jwt.verify(String(req.query.state || ''), process.env.JWT_SECRET || 'segredo123'); }
  catch { return voltar('google=erro&msg=' + encodeURIComponent('Link expirado, tente conectar de novo.')); }
  try {
    const cred = await Credencial.findOne({ _id: state.credId, empresa: state.empresa });
    if (!cred || !cred.campos?.client_id || !cred.campos?.client_secret) throw new Error('Credencial do Google não encontrada — cadastre de novo.');
    const tokens = await googleOAuth.exchangeCode({
      code: String(req.query.code || ''), clientId: cred.campos.client_id, clientSecret: cred.campos.client_secret, redirectUri: GOOGLE_OAUTH_REDIRECT_URI,
    });
    if (!tokens.refresh_token) throw new Error('O Google não devolveu um refresh_token (tente desconectar o app em myaccount.google.com/permissions e conectar de novo).');
    cred.campos = { ...cred.campos, refresh_token: tokens.refresh_token };
    cred.atualizadoEm = new Date();
    await cred.save();
    voltar('google=ok&cred=' + encodeURIComponent(cred.nome));
  } catch (err) {
    voltar('google=erro&msg=' + encodeURIComponent(err.message));
  }
});

// ==================== AUTOMAÇÃO (builder visual de Robôs) ====================
// Ver C:\Users\novai\.claude\plans\enchanted-gathering-pearl.md — porte
// reduzido (MVP) do "HAC Studio" pro conceito de Robô do HOC.

const githubActions = require('./lib/githubActions');
githubActions.init({
  fetch,
  token: process.env.GITHUB_TOKEN || '',
  owner: process.env.GITHUB_OWNER || 'kalimacomplex-prog',
  repo: process.env.GITHUB_REPO || 'HOC',
  workflowFile: process.env.GITHUB_WORKFLOW_FILE || 'rpa-ephemeral-runner.yml',
  ref: process.env.GITHUB_REF || 'main',
});

const automationEngine = require('./lib/automationEngine');
automationEngine.init({
  Automacao, AutomacaoRun, AutomacaoStepDispatch, Robot, ExecucaoRobo, Maquina, ConfigIA, Credencial,
  enviarEmail, resolverEChamarIA, fetch, githubActions,
  hocApiUrl: PUBLIC_URL,
});

const AUTOMACAO_STATUS_PARA_EXECUCAO = { success: 'concluido', failed: 'erro', cancelled: 'interrompido' };

// Poll simples (não é chamado com alta frequência — 1 por execução de robô
// origem='builder') até o AutomacaoRun sair de "running", e espelha o
// resultado no ExecucaoRobo público (aba Execuções já existente).
// Texto do log de um step no histórico de Execuções: cabeçalho ("nome (tipo): status")
// + a saída do step numa segunda linha — é onde fica, por exemplo, o texto que a IA escreveu.
// Saída comprida é cortada (respostas de IA têm limite maior) e conteúdo que parece
// base64 (imagem/áudio gerado, arquivo lido) vira só o tamanho, pra não poluir o log.
const LOG_SAIDA_MAX = 500;
const LOG_SAIDA_IA_MAX = 4000;
function _formatarLogDoStep(s) {
  let msg = `${s.stepName} (${s.stepType}): ${s.status}${s.error ? ' — ' + s.error : ''}`;
  const saida = typeof s.output === 'string' ? s.output.trim() : '';
  if (saida && s.status === 'success') {
    let texto;
    if (saida.length > 200 && /^[A-Za-z0-9+/=_-]+$/.test(saida)) {
      texto = `(conteúdo de ${saida.length} caracteres)`;
    } else {
      const max = (s.stepType === 'ai_chat' || s.stepType === 'call_ai_agent') ? LOG_SAIDA_IA_MAX : LOG_SAIDA_MAX;
      texto = saida.length > max ? `${saida.slice(0, max)}… (+${saida.length - max} caracteres)` : saida;
    }
    msg += `\n→ ${texto}`;
  }
  return msg;
}

async function _espelharRunNaExecucao(runId, execId) {
  const deadline = Date.now() + 60 * 60 * 1000; // 1h de teto de segurança
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const run = await AutomacaoRun.findById(runId).lean();
    if (!run || run.status === 'running') continue;
    const statusExec = AUTOMACAO_STATUS_PARA_EXECUCAO[run.status] || 'erro';
    const resumo = (run.stepsResult || []).map((s) => ({
      message: _formatarLogDoStep(s),
      status: s.status === 'failed' ? 'error' : s.status === 'success' ? 'success' : 'info',
      time: new Date(),
    }));
    await ExecucaoRobo.findByIdAndUpdate(execId, {
      status: statusExec,
      finalizadoEm: run.finalizadoEm || new Date(),
      duracao: Math.round((run.duracaoMs || 0) / 1000),
      $push: { logs: { $each: resumo } },
      ...(run.status !== 'cancelled' ? {} : { motivoInterrupcao: 'Interrompido pelo usuário' }),
    });
    return;
  }
}

app.post('/api/automacoes', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    const { nome, descricao, gatilho, steps, ativo } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome obrigatório' });
    const doc = { nome, descricao: descricao || '', steps: steps || [], ativo: ativo !== false, empresa: req.usuario.empresa, criadoPor: req.usuario.id };
    doc.gatilho = { tipo: gatilho?.tipo || 'manual', cron: gatilho?.cron || '', webhookToken: '' };
    if (doc.gatilho.tipo === 'webhook') doc.gatilho.webhookToken = crypto.randomBytes(20).toString('base64url');
    const automacao = await Automacao.create(doc);
    res.status(201).json(automacao);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.get('/api/automacoes', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try { res.json(await Automacao.find({ empresa: req.usuario.empresa }).sort({ criadoEm: -1 })); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/automacoes/:id', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    const automacao = await Automacao.findOne({ _id: req.params.id, empresa: req.usuario.empresa });
    if (!automacao) return res.status(404).json({ erro: 'Automação não encontrada' });
    res.json(automacao);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.patch('/api/automacoes/:id', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    const atual = await Automacao.findOne({ _id: req.params.id, empresa: req.usuario.empresa });
    if (!atual) return res.status(404).json({ erro: 'Automação não encontrada' });
    const { nome, descricao, gatilho, steps, ativo, roboId } = req.body;
    const updates = { atualizadoEm: new Date() };
    if (nome !== undefined) updates.nome = nome;
    if (descricao !== undefined) updates.descricao = descricao;
    if (steps !== undefined) updates.steps = steps;
    if (ativo !== undefined) updates.ativo = ativo;
    if (roboId !== undefined) updates.roboId = roboId;
    if (gatilho !== undefined) {
      // Preserva o webhookToken existente se o gatilho continuar sendo webhook
      // (senão cada save trocaria a URL do webhook debaixo do usuário).
      const manterToken = gatilho.tipo === 'webhook' && atual.gatilho?.tipo === 'webhook';
      updates.gatilho = {
        tipo: gatilho.tipo || 'manual', cron: gatilho.cron || '',
        webhookToken: manterToken ? atual.gatilho.webhookToken : (gatilho.tipo === 'webhook' ? crypto.randomBytes(20).toString('base64url') : ''),
      };
    }
    const automacao = await Automacao.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, updates, { new: true });
    res.json(automacao);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.delete('/api/automacoes/:id', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    await Automacao.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa });
    res.json({ mensagem: 'Automação deletada!' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Roda em background e responde 202 na hora — cliente acompanha via polling em
// GET /api/automacoes/:id/runs/:runId (mesmo padrão do HAC Studio).
app.post('/api/automacoes/:id/run', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    const run = await automationEngine.iniciarRunEmBackground({
      automacaoId: req.params.id, input: req.body?.input || '', gatilhoTipo: 'manual',
      empresa: req.usuario.empresa,
    });
    res.status(202).json(run);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.get('/api/automacoes/:id/runs', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    const runs = await AutomacaoRun.find({ automacaoId: req.params.id, empresa: req.usuario.empresa }).sort({ iniciadoEm: -1 }).limit(20);
    res.json(runs);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/automacoes/:id/runs/:runId', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    const run = await AutomacaoRun.findOne({ _id: req.params.runId, automacaoId: req.params.id, empresa: req.usuario.empresa });
    if (!run) return res.status(404).json({ erro: 'Execução não encontrada' });
    res.json(run);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/automacoes/:id/runs/:runId/cancel', authMiddleware, verificarAssinatura, permOperacoes('acessar'), async (req, res) => {
  try {
    const run = await AutomacaoRun.findOneAndUpdate(
      { _id: req.params.runId, automacaoId: req.params.id, empresa: req.usuario.empresa, status: 'running' },
      { cancelRequested: true }, { new: true }
    );
    if (!run) return res.status(404).json({ erro: 'Execução não encontrada ou já finalizada' });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

// Webhook — sem auth de usuário, o token na URL é a credencial (mesmo modelo
// do HAC Studio). Executa síncrono: a chamada só responde quando terminar.
app.post('/api/automacoes/webhook/:token', async (req, res) => {
  try {
    const automacao = await Automacao.findOne({ 'gatilho.webhookToken': req.params.token, ativo: true });
    if (!automacao) return res.status(404).json({ erro: 'Automação não encontrada ou inativa' });
    const input = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
    const run = await automationEngine.executarESperar({
      automacaoId: automacao._id, input, gatilhoTipo: 'webhook', empresa: automacao.empresa,
    });
    res.json({ runId: run._id, status: run.status, output: run.output });
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

// Resultado de um step dispatchado pra máquina — reporta pelo agent.py,
// autenticado por machineKey (mesmo padrão de /api/robos/execucoes/:id/logs).
app.post('/api/automacoes/step-dispatch/:id/resultado', async (req, res) => {
  try {
    const { machineKey, status, output, error } = req.body;
    if (!machineKey) return res.status(400).json({ erro: 'machineKey obrigatória' });
    const maquina = await Maquina.findOne({ machineKey, ativo: true });
    if (!maquina) return res.status(401).json({ erro: 'Chave inválida' });
    const dispatch = await AutomacaoStepDispatch.findOneAndUpdate(
      { _id: req.params.id, maquinaId: maquina._id },
      { status: status === 'erro' ? 'erro' : 'concluido', resultado: { output: output || '', error: error || '' } },
      { new: true }
    );
    if (!dispatch) return res.status(404).json({ erro: 'Dispatch não encontrado' });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

// ==================== SERVIDOR ====================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
