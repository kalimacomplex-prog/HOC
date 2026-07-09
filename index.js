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

const app = express();

// Webhook Asaas precisa do body RAW — deve vir ANTES do express.json()
app.use('/api/webhook/asaas', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));
app.use(express.static('public'));

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
  return nodemailer.createTransport({
    host: cfg.servidor, port: parseInt(cfg.porta)||587,
    secure: parseInt(cfg.porta)===465,
    auth: { user: cfg.usuario, pass: cfg.senha },
    tls: { rejectUnauthorized: false }
  });
}

async function enviarEmailTarefa(tarefaId, empresa) {
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
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
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
  const buildCorpo = (contato) => {
    const primeiroNome = (contato.nome||'').split(' ')[0];
    return (template.corpo||'')
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
      .replace(/\{data\}/g, new Date().toLocaleDateString('pt-BR'));
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
  permissoes: {
    overview:       { acessar: { type: Boolean, default: true },  editar: { type: Boolean, default: false }, aprovar: { type: Boolean, default: false } },
    ideiasLivres:   { acessar: { type: Boolean, default: true },  criar:     { type: Boolean, default: true },  aprovar:   { type: Boolean, default: false } },
    gestaoMetas:    { acessar: { type: Boolean, default: true },  editar:    { type: Boolean, default: false } },
    gestaoProjetos: { acessar: { type: Boolean, default: true },  criar:     { type: Boolean, default: false }, editar:    { type: Boolean, default: false } },
    gestaoLicencas: { acessar: { type: Boolean, default: true },  criar:     { type: Boolean, default: false }, editar:    { type: Boolean, default: false } },
    operacoes:      { acessar: { type: Boolean, default: true },  criar:     { type: Boolean, default: false }, editar:    { type: Boolean, default: false } },
    planoUsuarios:  { acessar: { type: Boolean, default: false }, gerenciar: { type: Boolean, default: false } },
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
  qtdGeradas: { type: Number, default: 12 },
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
  tags: { type: Array, default: [] },
  versao: { type: String, default: 'v1.0' }, ativo: { type: Boolean, default: true },
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
  criadoEm: { type: Date, default: Date.now }, atualizadoEm: { type: Date, default: Date.now }
}, { strict: false });
const ProExec = mongoose.model('ProExec', proExecSchema);

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
  criadoEm: { type: Date, default: Date.now }, atualizadoEm: { type: Date, default: Date.now }
}, { strict: false });
const Robot = mongoose.model('Robot', robotSchema);

const execucaoRoboSchema = new mongoose.Schema({
  roboId: { type: mongoose.Schema.Types.ObjectId, ref: 'Robot', required: true },
  roboNome: { type: String, default: '' },
  status: { type: String, default: 'em_execucao', enum: ['em_execucao','interrompido','erro','concluido','nao_disparado'] },
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
  criadoEm: { type: Date, default: Date.now }
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
  empresa:         { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  criadoPor:       { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  criadoEm:        { type: Date, default: Date.now },
  atualizadoEm:    { type: Date, default: Date.now }
}, { strict: false });
const Maquina = mongoose.model('Maquina', maquinaSchema);

const credencialSchema = new mongoose.Schema({
  nome: { type: String, required: true }, tipo: { type: String, default: 'API Key' },
  proprietario: { type: String, default: '' }, valor: { type: String, default: '' },
  validade: { type: String, default: '' }, status: { type: String, default: 'Válida', enum: ['Válida', 'Expirando', 'Expirada'] },
  empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  criadoEm: { type: Date, default: Date.now }, atualizadoEm: { type: Date, default: Date.now }
});
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

async function criarNotificacao(empresaId, titulo, mensagem, tipo, icone, link) {
  try { await Notificacao.create({ empresa: empresaId, titulo, mensagem, tipo, icone, link }); }
  catch (err) { console.error('Erro ao criar notificação:', err); }
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
        await criarNotificacao(empresaId, `Licença Vencida: ${lic.nome}`, `A licença "${lic.nome}" venceu há ${Math.abs(diffDias)} dia(s).`, 'licenca_vencida', '🔴', '/gestao-licencas');
        if (emailAdmin) await enviarEmail(emailAdmin, `🔴 Licença Vencida — ${lic.nome}`, gerarHtmlAlertaLicenca(lic, diffDias));
        if (lic.responsavelEmail && lic.responsavelEmail !== emailAdmin) await enviarEmail(lic.responsavelEmail, `🔴 Licença Vencida — ${lic.nome}`, gerarHtmlAlertaLicenca(lic, diffDias));
      } else if (diffDias >= 0 && diffDias <= (lic.alertaDias || 30) && lic.status !== 'Vencendo') {
        await Licenca.findByIdAndUpdate(lic._id, { status: 'Vencendo' });
        await criarNotificacao(empresaId, `Licença Vencendo: ${lic.nome}`, `A licença "${lic.nome}" vence em ${diffDias} dia(s).`, 'licenca_vencendo', '⚠️', '/gestao-licencas');
        if (emailAdmin) await enviarEmail(emailAdmin, `⚠️ Licença vencendo em ${diffDias} dias — ${lic.nome}`, gerarHtmlAlertaLicenca(lic, diffDias));
        if (lic.responsavelEmail && lic.responsavelEmail !== emailAdmin) await enviarEmail(lic.responsavelEmail, `⚠️ Licença vencendo em ${diffDias} dias — ${lic.nome}`, gerarHtmlAlertaLicenca(lic, diffDias));
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
      if (req.usuario.perfil === 'Admin') return next();
      const usuario = await Usuario.findById(req.usuario.id).select('permissoes usuarioMestre perfil');
      if (!usuario) return res.status(401).json({ erro: 'Usuário não encontrado' });
      if (usuario.usuarioMestre) return next();
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

app.get('/permissionamentos', (req, res) => res.sendFile(path.join(__dirname, 'public', 'permissionamentos.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/cadastro', (req, res) => res.sendFile(path.join(__dirname, 'public', 'cadastro.html')));
app.get('/confirmar-email', (req, res) => res.sendFile(path.join(__dirname, 'public', 'confirmar-email.html')));
app.get('/recuperar-senha', (req, res) => res.sendFile(path.join(__dirname, 'public', 'recuperar-senha.html')));
app.get('/redefinir-senha', (req, res) => res.sendFile(path.join(__dirname, 'public', 'redefinir-senha.html')));
app.get('/dashboard', (req, res) => res.redirect('/overview'));
app.get('/overview', (req, res) => res.sendFile(path.join(__dirname, 'public', 'overview.html')));
app.get('/gestao-metas', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gestao-metas.html')));
app.get('/ideias-livres', (req, res) => res.sendFile(path.join(__dirname, 'public', 'ideias-livres.html')));
app.get('/gestao-projetos', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gestao-projetos.html')));
app.get('/projeto-tradicional', (req, res) => res.sendFile(path.join(__dirname, 'public', 'projeto-tradicional.html')));
app.get('/projeto-agil', (req, res) => res.sendFile(path.join(__dirname, 'public', 'projeto-agil.html')));
app.get('/repositorio-templates', (req, res) => res.sendFile(path.join(__dirname, 'public', 'repositorio-templates.html')));
app.get('/gestao-licencas', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gestao-licencas.html')));
app.get('/operacoes', (req, res) => res.sendFile(path.join(__dirname, 'public', 'operacoes.html')));
app.get('/robos', (req, res) => res.sendFile(path.join(__dirname, 'public', 'robos.html')));
app.get('/aceitar-convite', (req, res) => res.sendFile(path.join(__dirname, 'public', 'aceitar-convite.html')));
app.get('/plano-usuarios', (req, res) => res.sendFile(path.join(__dirname, 'public', 'plano-usuarios.html')));

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
      permissoes: { overview:{acessar:true,editar:true}, ideiasLivres:{acessar:true,criar:true,aprovar:true}, gestaoMetas:{acessar:true,editar:true}, gestaoProjetos:{acessar:true,criar:true,editar:true}, gestaoLicencas:{acessar:true,criar:true,editar:true}, operacoes:{acessar:true,criar:true,editar:true}, planoUsuarios:{acessar:true,gerenciar:true} }
    });
    const linkConfirmacao = `${process.env.APP_URL}/confirmar-email?token=${tokenConfirmacao}`;
    await enviarEmail(email, 'Confirme seu email — HOC System', `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px"><h2 style="color:#2d1b69">Confirme seu email 📧</h2><p>Olá <strong>${nome}</strong>! Sua conta foi criada.</p><p style="margin-bottom:24px">Você tem <strong>30 dias gratuitos</strong> para explorar o HOC System.</p><a href="${linkConfirmacao}" style="display:inline-block;padding:14px 28px;background:#2d1b69;color:white;border-radius:8px;text-decoration:none;font-weight:600">Confirmar meu email</a></div>`);
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
    await criarNotificacao(usuario.empresa, 'Bem-vindo ao HOC System! 🎉', `Você tem ${diasTrial} dias gratuitos para explorar.`, 'sucesso', '🎉', '/dashboard');
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
    await enviarEmail(email, 'Redefinição de senha — HOC System', `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px"><h2 style="color:#2d1b69">Redefinir senha 🔐</h2><p>Olá <strong>${usuario.nome}</strong>!</p><p style="margin-bottom:24px">Clique abaixo para criar uma nova senha. Este link expira em <strong>1 hora</strong>.</p><a href="${linkRedefinicao}" style="display:inline-block;padding:14px 28px;background:#2d1b69;color:white;border-radius:8px;text-decoration:none;font-weight:600">Redefinir minha senha</a></div>`);
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

    await criarNotificacao(req.usuario.empresa, `💳 Cobrança gerada — Plano ${NOME_PLANO[plano]}`, `Cobrança gerada via ${formaPagamento}. Aguardando pagamento.`, 'aviso', '💳', '/plano-usuarios');

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
        await criarNotificacao(assinatura.empresa, `✅ Pagamento confirmado — Plano ${NOME_PLANO[plano] || plano}`, 'Seu pagamento foi confirmado automaticamente. Acesso liberado!', 'sucesso', '✅', '/plano-usuarios');
        console.log('Assinatura ativada via webhook:', assinatura.empresa);
      }
    }
    else if (event === 'PAYMENT_OVERDUE') {
      const assinatura = await Assinatura.findOne({ $or: [{ asaasCobrancaId: payment?.id }, { asaasAssinaturaId: payment?.subscription }] });
      if (assinatura && assinatura.status === 'ativa') {
        await Assinatura.findByIdAndUpdate(assinatura._id, { status: 'inadimplente', vencimento: payment?.dueDate ? new Date(payment.dueDate) : new Date(), atualizadoEm: new Date() });
        await criarNotificacao(assinatura.empresa, '⚠️ Pagamento em atraso', 'Identificamos um atraso no pagamento. Regularize para continuar usando o HOC System.', 'aviso', '⚠️', '/plano-usuarios');
        console.log('Inadimplente via webhook:', assinatura.empresa);
      }
    }
    else if (event === 'SUBSCRIPTION_DELETED') {
      const assinatura = await Assinatura.findOne({ asaasAssinaturaId: subscription?.id });
      if (assinatura) {
        await Assinatura.findByIdAndUpdate(assinatura._id, { status: 'cancelada', atualizadoEm: new Date() });
        await criarNotificacao(assinatura.empresa, '❌ Assinatura cancelada', 'Sua assinatura foi cancelada. Entre em contato para reativá-la.', 'erro', '❌', '/plano-usuarios');
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
      await criarNotificacao(req.usuario.empresa, `✅ Plano ${NOME_PLANO[plano]} ativado!`, 'Pagamento via cartão aprovado. Acesso liberado!', 'sucesso', '✅', '/plano-usuarios');
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
    await criarNotificacao(req.usuario.empresa, `💳 Pagamento aguardando confirmação`, `${usuarioReq.nome} solicitou o Plano ${NOME_PLANO[plano]}. Confirme o pagamento para liberar o acesso.`, 'aviso', '💳', '/plano-usuarios');
    try {
      const admin = await Usuario.findOne({ empresa: req.usuario.empresa, perfil: 'Admin' }).select('email nome');
      if (admin) await enviarEmail(admin.email, `💳 HOC System — Pagamento aguardando confirmação`, `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px"><h2 style="color:#2d1b69">Pagamento aguardando confirmação</h2><p>${usuarioReq.nome} realizou o pagamento e solicitou a ativação do <strong>Plano ${NOME_PLANO[plano]}</strong>.</p><a href="${process.env.APP_URL}/plano-usuarios" style="display:inline-block;margin-top:20px;padding:12px 24px;background:#2d1b69;color:white;border-radius:8px;text-decoration:none;font-weight:600">Confirmar Pagamento</a></div>`);
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
    await criarNotificacao(empresaId, `✅ Plano ${NOME_PLANO[plano]} ativado!`, 'Seu pagamento foi confirmado. O acesso completo está liberado.', 'sucesso', '✅', '/plano-usuarios');
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
    await criarNotificacao(empresaId, `❌ Pagamento não confirmado`, motivo || 'Não foi possível confirmar o pagamento. Entre em contato.', 'erro', '❌', '/plano-usuarios');
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
    await criarNotificacao(empresaId, '❌ Assinatura cancelada', motivo||'Sua assinatura foi cancelada.', 'erro', '❌', '/plano-usuarios');
    res.json({ mensagem: 'Conta cancelada.' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/admin/marcar-inadimplente', adminSecretMiddleware, async (req, res) => {
  try {
    const { empresaId } = req.body;
    if (!empresaId) return res.status(400).json({ erro: 'empresaId obrigatório.' });
    await Assinatura.findOneAndUpdate({ empresa: empresaId }, { status: 'inadimplente', vencimento: new Date(), atualizadoEm: new Date() });
    await criarNotificacao(empresaId, '⚠️ Pagamento em atraso', 'Identificamos um atraso no pagamento. Regularize para continuar usando o HOC System.', 'aviso', '⚠️', '/plano-usuarios');
    res.json({ mensagem: 'Conta marcada como inadimplente.' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/admin/reativar-conta', adminSecretMiddleware, async (req, res) => {
  try {
    const { empresaId } = req.body;
    if (!empresaId) return res.status(400).json({ erro: 'empresaId obrigatório.' });
    const vencimento = new Date(); vencimento.setDate(vencimento.getDate() + 30);
    await Assinatura.findOneAndUpdate({ empresa: empresaId }, { status: 'ativa', vencimento, atualizadoEm: new Date() });
    await criarNotificacao(empresaId, '✅ Assinatura reativada!', 'Sua assinatura foi reativada. O acesso completo está liberado.', 'sucesso', '✅', '/plano-usuarios');
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
    await criarNotificacao(empresaId, `📦 Plano alterado para ${NOME_PLANO[plano]}`, `Seu plano foi atualizado para ${NOME_PLANO[plano]}.`, 'sucesso', '📦', '/plano-usuarios');
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

app.get('/api/usuarios/minhas-permissoes', authMiddleware, async (req, res) => {
  try {
    const usuario = await Usuario.findById(req.usuario.id).select('permissoes usuarioMestre perfil');
    if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado' });
    if (usuario.perfil === 'Admin' || usuario.usuarioMestre) {
      return res.json({ isAdmin: true, permissoes: { overview:{acessar:true,editar:true}, ideiasLivres:{acessar:true,criar:true,aprovar:true}, gestaoMetas:{acessar:true,editar:true}, gestaoProjetos:{acessar:true,criar:true,editar:true}, gestaoLicencas:{acessar:true,criar:true,editar:true}, operacoes:{acessar:true,criar:true,editar:true}, planoUsuarios:{acessar:true,gerenciar:true} } });
    }
    res.json({ isAdmin: false, permissoes: usuario.permissoes });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.put('/api/usuarios/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    const { nome, perfil, status, permissoes } = req.body;
    const update = { nome, perfil, status };
    if (permissoes !== undefined) update.permissoes = permissoes;
    const usuario = await Usuario.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, update, { new: true }).select('-senha');
    if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado' });
    res.json(usuario);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.delete('/api/usuarios/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    if (req.params.id === req.usuario.id) return res.status(400).json({ erro: 'Você não pode deletar sua própria conta' });
    const usuario = await Usuario.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa });
    if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado' });
    res.json({ mensagem: 'Usuário deletado!' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== CONVITES ====================

app.post('/api/convites', authMiddleware, verificarAssinatura, permPlanoUsuarios('gerenciar'), async (req, res) => {
  try {
    const { email, usuarioMestre, permissoes } = req.body;
    if (!email) return res.status(400).json({ erro: 'Email obrigatório' });
    if (!validarEmail(email)) return res.status(400).json({ erro: 'Email inválido' });
    const usuarioExiste = await Usuario.findOne({ email });
    if (usuarioExiste) return res.status(400).json({ erro: 'Este email já possui uma conta' });
    const token = crypto.randomBytes(32).toString('hex');
    await Convite.create({ email, empresa: req.usuario.empresa, token, usuarioMestre: usuarioMestre||false, permissoes: permissoes||{} });
    const linkConvite = `${process.env.APP_URL}/aceitar-convite?token=${token}`;
    await enviarEmail(email, 'Você foi convidado para o HOC System', `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px"><h2 style="color:#2d1b69">Você recebeu um convite!</h2><p>Você foi convidado para colaborar no <strong>HOC System</strong>.</p><a href="${linkConvite}" style="display:inline-block;margin:24px 0;padding:14px 28px;background:#2d1b69;color:white;border-radius:8px;text-decoration:none;font-weight:600">Aceitar Convite</a><p style="color:#a0aec0;font-size:13px">Este link expira em 48 horas.</p></div>`);
    await criarNotificacao(req.usuario.empresa, `Convite enviado para ${email}`, `Um convite foi enviado para ${email}.`, 'info', '👤', '/plano-usuarios');
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
    await Usuario.create({ nome, email: convite.email, senha: hash, empresa: convite.empresa._id, usuarioMestre: convite.usuarioMestre, perfil: convite.usuarioMestre?'Admin':'Usuário', permissoes: convite.permissoes, status: 'Ativo', emailConfirmado: true });
    convite.usado = true; await convite.save();
    await criarNotificacao(convite.empresa._id, `Novo usuário: ${nome}`, `${nome} aceitou o convite.`, 'sucesso', '👤', '/plano-usuarios');
    res.json({ mensagem: 'Conta criada com sucesso!' });
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

// ==================== PROJETOS ====================

app.get('/api/projetos', authMiddleware, verificarAssinatura, async (req, res) => {
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
app.post('/api/projetos', authMiddleware, verificarAssinatura, permGestaoProjetos('criar'), async (req, res) => {
  try {
    const projeto = await Projeto.create({ ...req.body, empresa: req.usuario.empresa, criadoPor: req.usuario.id });
    await criarNotificacao(req.usuario.empresa, `Novo projeto: ${projeto.nome}`, `O projeto "${projeto.nome}" foi criado.`, 'info', '📁', '/gestao-projetos');
    res.status(201).json(projeto);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.put('/api/projetos/:id', authMiddleware, verificarAssinatura, permGestaoProjetos('editar'), async (req, res) => {
  try {
    const projeto = await Projeto.findOneAndUpdate(
      { _id: req.params.id, empresa: req.usuario.empresa },
      { $set: { ...req.body, atualizadoEm: new Date() } },
      { new: true, strict: false }
    );
    if (!projeto) return res.status(404).json({ erro: 'Projeto não encontrado' });
    res.json(projeto);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.delete('/api/projetos/:id', authMiddleware, verificarAssinatura, permGestaoProjetos('editar'), async (req, res) => {
  try {
    const projeto = await Projeto.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa });
    if (!projeto) return res.status(404).json({ erro: 'Projeto não encontrado' });
    res.json({ mensagem: 'Projeto deletado!' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== TEMPLATES ====================

app.get('/api/templates', authMiddleware, verificarAssinatura, async (req, res) => {
  try { const templates = await Template.find({ empresa: req.usuario.empresa }).sort({ criadoEm: -1 }); res.json(templates); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/templates', authMiddleware, verificarAssinatura, async (req, res) => {
  try { const template = await Template.create({ ...req.body, empresa: req.usuario.empresa, criadoPor: req.usuario.id }); res.status(201).json(template); }
  catch (err) { res.status(400).json({ erro: err.message }); }
});
app.put('/api/templates/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    const template = await Template.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, req.body, { new: true });
    if (!template) return res.status(404).json({ erro: 'Template não encontrado' });
    res.json(template);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.delete('/api/templates/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try { await Template.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa }); res.json({ mensagem: 'Template deletado!' }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== IDEIAS ====================

app.get('/api/ideias', authMiddleware, verificarAssinatura, async (req, res) => {
  try { const ideias = await Ideia.find({ empresa: req.usuario.empresa }).sort({ criadoEm: -1 }); res.json(ideias); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/ideias', authMiddleware, verificarAssinatura, permIdeiasLivres('criar'), async (req, res) => {
  try {
    const ideia = await Ideia.create({ ...req.body, empresa: req.usuario.empresa, criadoPor: req.usuario.id });
    if (ideia.aprovacao === 'pendente') await criarNotificacao(req.usuario.empresa, `Nova ideia: ${ideia.titulo}`, `${req.usuario.nome} submeteu uma nova ideia.`, 'info', '💡', '/ideias-livres');
    res.status(201).json(ideia);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.put('/api/ideias/:id', authMiddleware, verificarAssinatura, permIdeiasLivres('editar'), async (req, res) => {
  try {
    const anterior = await Ideia.findById(req.params.id);
    const ideia = await Ideia.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, { ...req.body, atualizadoEm: new Date() }, { new: true });
    if (!ideia) return res.status(404).json({ erro: 'Ideia não encontrada' });
    if (anterior && anterior.aprovacao !== ideia.aprovacao) {
      if (ideia.aprovacao === 'aprovada') await criarNotificacao(req.usuario.empresa, `Ideia aprovada: ${ideia.titulo}`, `A ideia foi aprovada.`, 'sucesso', '✅', '/ideias-livres');
      if (ideia.aprovacao === 'dispensada') await criarNotificacao(req.usuario.empresa, `Ideia dispensada: ${ideia.titulo}`, `A ideia foi dispensada.`, 'erro', '❌', '/ideias-livres');
    }
    res.json(ideia);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.delete('/api/ideias/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try { await Ideia.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa }); res.json({ mensagem: 'Ideia deletada!' }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== BOWLER ====================

app.get('/api/bowler/:ano', authMiddleware, verificarAssinatura, async (req, res) => {
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

app.get('/api/pastas', authMiddleware, async (req, res) => {
  try {
    const overview = await Overview.findOne({ empresa: req.usuario.empresa }).select('pastas');
    res.json(overview?.pastas || []);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/pastas', authMiddleware, async (req, res) => {
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

app.put('/api/pastas/:id', authMiddleware, async (req, res) => {
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

app.delete('/api/pastas/:id', authMiddleware, async (req, res) => {
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

app.get('/api/wikis', authMiddleware, verificarAssinatura, async (req, res) => {
  try { const wikis = await Wiki.find({ empresa: req.usuario.empresa }).sort({ criadoEm: -1 }); res.json(wikis); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/wikis', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    const id = new mongoose.Types.ObjectId();
    const grupoId = req.body.grupoId ? new mongoose.Types.ObjectId(req.body.grupoId) : id;
    const isFirst = !req.body.grupoId;
    const wiki = await Wiki.create({ _id: id, ...req.body, grupoId, ativo: isFirst, empresa: req.usuario.empresa, criadoPor: req.usuario.id });
    await criarNotificacao(req.usuario.empresa, `Novo Wiki: ${wiki.titulo}`, `O wiki foi criado.`, 'info', '📄', '/overview');
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
    const wiki = await Wiki.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, { ...req.body, atualizadoEm: new Date() }, { new: true });
    if (!wiki) return res.status(404).json({ erro: 'Wiki não encontrado' });
    if (req.body.status === 'Aprovado') await criarNotificacao(req.usuario.empresa, `Wiki aprovado: ${wiki.titulo}`, `O wiki foi aprovado.`, 'sucesso', '✅', '/overview');
    res.json(wiki);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.delete('/api/wikis/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try { await Wiki.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa }); res.json({ mensagem: 'Wiki deletado!' }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== LICENÇAS ====================

app.get('/api/licencas', authMiddleware, verificarAssinatura, async (req, res) => {
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
app.post('/api/licencas', authMiddleware, verificarAssinatura, permGestaoLicencas('criar'), async (req, res) => {
  try {
    const licenca = await Licenca.create({ ...req.body, empresa: req.usuario.empresa, criadoPor: req.usuario.id });
    await criarNotificacao(req.usuario.empresa, `Nova licença: ${licenca.nome}`, `A licença foi cadastrada.`, 'info', '📋', '/gestao-licencas');
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
app.delete('/api/licencas/:id', authMiddleware, verificarAssinatura, permGestaoLicencas('editar'), async (req, res) => {
  try { await Licenca.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa }); res.json({ mensagem: 'Licença deletada!' }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== FLUXO DE VALOR ====================

app.get('/api/fluxo-valor', authMiddleware, verificarAssinatura, async (req, res) => {
  try { const fv = await FluxoValor.findOne({ empresa: req.usuario.empresa }); res.json(fv || { blocos: [], conexoes: [], textos: [] }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.put('/api/fluxo-valor', authMiddleware, verificarAssinatura, async (req, res) => {
  try { const fv = await FluxoValor.findOneAndUpdate({ empresa: req.usuario.empresa }, { ...req.body, atualizadoEm: new Date() }, { new: true, upsert: true }); res.json(fv); }
  catch (err) { res.status(400).json({ erro: err.message }); }
});

// ==================== CONTATOS ====================

app.get('/api/contatos', authMiddleware, verificarAssinatura, async (req, res) => {
  try { const contatos = await Contato.find({ empresa: req.usuario.empresa }).sort({ criadoEm: -1 }); res.json(contatos); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/contatos', authMiddleware, verificarAssinatura, permOperacoes('criar'), async (req, res) => {
  try { const contato = await Contato.create({ ...req.body, empresa: req.usuario.empresa }); await criarNotificacao(req.usuario.empresa, `Novo contato: ${contato.nome}`, `O contato foi adicionado.`, 'info', '👤', '/operacoes'); res.status(201).json(contato); }
  catch (err) { res.status(400).json({ erro: err.message }); }
});
app.put('/api/contatos/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try { const contato = await Contato.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, req.body, { new: true }); if (!contato) return res.status(404).json({ erro: 'Contato não encontrado' }); res.json(contato); }
  catch (err) { res.status(400).json({ erro: err.message }); }
});
app.delete('/api/contatos/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try { await Contato.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa }); res.json({ mensagem: 'Contato deletado!' }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== EMAIL TEMPLATES ====================

app.get('/api/email-templates', authMiddleware, verificarAssinatura, async (req, res) => {
  try { const templates = await EmailTemplate.find({ empresa: req.usuario.empresa }).sort({ criadoEm: -1 }); res.json(templates); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/email-templates', authMiddleware, verificarAssinatura, async (req, res) => {
  try { const template = await EmailTemplate.create({ ...req.body, empresa: req.usuario.empresa }); res.status(201).json(template); }
  catch (err) { res.status(400).json({ erro: err.message }); }
});
app.put('/api/email-templates/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try { const template = await EmailTemplate.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, { ...req.body, atualizadoEm: new Date() }, { new: true }); if (!template) return res.status(404).json({ erro: 'Template não encontrado' }); res.json(template); }
  catch (err) { res.status(400).json({ erro: err.message }); }
});
app.delete('/api/email-templates/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try { await EmailTemplate.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa }); res.json({ mensagem: 'Template deletado!' }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== TAREFAS ====================

app.get('/api/tarefas', authMiddleware, verificarAssinatura, async (req, res) => {
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
app.post('/api/tarefas', authMiddleware, verificarAssinatura, permOperacoes('criar'), async (req, res) => {
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
    await criarNotificacao(req.usuario.empresa, `Nova tarefa: ${tarefa.titulo}`, `A tarefa foi criada.`, 'info', '📋', '/operacoes');
    res.status(201).json(tarefa);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.put('/api/tarefas/:id', authMiddleware, verificarAssinatura, permOperacoes('editar'), async (req, res) => {
  try {
    const anterior = await Tarefa.findById(req.params.id);
    const tarefa = await Tarefa.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, { ...req.body, atualizadoEm: new Date() }, { new: true, strict: false });
    if (!tarefa) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    if (anterior && anterior.status !== 'Concluída' && tarefa.status === 'Concluída') await criarNotificacao(req.usuario.empresa, `Tarefa concluída: ${tarefa.titulo}`, `A tarefa foi concluída.`, 'sucesso', '✅', '/operacoes');
    res.json(tarefa);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.delete('/api/tarefas/:id', authMiddleware, verificarAssinatura, permOperacoes('editar'), async (req, res) => {
  try { await Tarefa.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa }); res.json({ mensagem: 'Tarefa deletada!' }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/tarefas/:id/enviar-email', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    await enviarEmailTarefa(req.params.id, req.usuario.empresa);
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
app.get('/api/smtp-config', authMiddleware, async (req, res) => {
  try {
    const cfg = await SmtpConfig.findOne({ empresa: req.usuario.empresa }).lean();
    if (!cfg) return res.json({});
    const { senha, ...safe } = cfg;
    res.json({ ...safe, temSenha: !!senha });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});
app.put('/api/smtp-config', authMiddleware, async (req, res) => {
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
app.post('/api/smtp-config/testar', authMiddleware, async (req, res) => {
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

// ==================== PROCESSOS ====================

app.get('/api/processos', authMiddleware, verificarAssinatura, async (req, res) => {
  try { const processos = await Processo.find({ empresa: req.usuario.empresa }).sort({ criadoEm: -1 }); res.json(processos); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/processos', authMiddleware, verificarAssinatura, permOperacoes('criar'), async (req, res) => {
  try { const processo = await Processo.create({ ...req.body, empresa: req.usuario.empresa, criadoPor: req.usuario.id }); await criarNotificacao(req.usuario.empresa, `Novo processo: ${processo.nome}`, `O processo foi criado.`, 'info', '⚙️', '/operacoes'); res.status(201).json(processo); }
  catch (err) { res.status(400).json({ erro: err.message }); }
});
app.put('/api/processos/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    const prev = await Processo.findById(req.params.id).lean();
    const body = { ...req.body, atualizadoEm: new Date() };
    // versioning: if caller passes versionar:true, snapshot current before saving
    if (req.body.versionar && prev) {
      body.versoes = [...(prev.versoes||[]), { versao: prev.versao, elementos: prev.elementos, conexoes: prev.conexoes, data: new Date(), autor: req.usuario.nome||req.usuario.email||'—' }];
    }
    const processo = await Processo.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, body, { new: true, strict: false });
    if (!processo) return res.status(404).json({ erro: 'Processo não encontrado' });
    res.json(processo);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.delete('/api/processos/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try { await Processo.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa }); res.json({ mensagem: 'Processo deletado!' }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

// Execuções de processo
app.get('/api/pro-execucoes', authMiddleware, verificarAssinatura, async (req, res) => {
  try { const execs = await ProExec.find({ empresa: req.usuario.empresa }).sort({ criadoEm: -1 }).lean(); res.json(execs); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/pro-execucoes', authMiddleware, verificarAssinatura, async (req, res) => {
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
    res.status(201).json(exec);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.put('/api/pro-execucoes/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    const exec = await ProExec.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, { ...req.body, atualizadoEm: new Date() }, { new: true, strict: false });
    if (!exec) return res.status(404).json({ erro: 'Execução não encontrada' });
    // auto-complete: if all non-structural etapas done, mark process status
    if (!req.body.status) {
      const etapas = exec.etapas || [];
      const allDone = etapas.length && etapas.every(e => ['Concluído','Dispensado'].includes(e.status));
      if (allDone) await ProExec.findByIdAndUpdate(exec._id, { status: 'Concluído com Sucesso' }, { strict: false });
    }
    res.json(exec);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.delete('/api/pro-execucoes/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try { await ProExec.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa }); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/pro-execucoes/:id/enviar-email', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    const { emailTemplateId, emailContatoId, emailGrupoId } = req.body;
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
    for (const contato of contatos) {
      if (!contato.email) continue;
      const primeiroNome = (contato.nome||'').split(' ')[0];
      const corpo = (template.corpo||'')
        .replace(/\{nomeCompleto\}/g, contato.nome||'')
        .replace(/\{primeiroNome\}/g, primeiroNome)
        .replace(/\{data\}/g, new Date().toLocaleDateString('pt-BR'));
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

app.get('/api/robos', authMiddleware, verificarAssinatura, async (req, res) => {
  try { const robos = await Robot.find({ empresa: req.usuario.empresa }).sort({ criadoEm: -1 }); res.json(robos); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/robos', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    const body = { ...req.body, empresa: req.usuario.empresa, criadoPor: req.usuario.id };
    if (body.schedule?.ativo) body.schedule.proximaExec = calcularProximaExec(body.schedule);
    const robo = await Robot.create(body);
    await criarNotificacao(req.usuario.empresa, `Novo robô: ${robo.nome}`, `O robô foi cadastrado.`, 'info', '🤖', '/robos');
    res.status(201).json(robo);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.put('/api/robos/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    const body = { ...req.body, atualizadoEm: new Date() };
    if (body.schedule?.ativo) body.schedule.proximaExec = calcularProximaExec(body.schedule);
    const robo = await Robot.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, body, { new: true, strict: false });
    if (!robo) return res.status(404).json({ erro: 'Robô não encontrado' });
    res.json(robo);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.delete('/api/robos/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    await Robot.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa });
    await ExecucaoRobo.deleteMany({ roboId: req.params.id, empresa: req.usuario.empresa });
    res.json({ mensagem: 'Robô deletado!' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Executar robô manualmente
app.post('/api/robos/:id/executar', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    const robo = await Robot.findOne({ _id: req.params.id, empresa: req.usuario.empresa });
    if (!robo) return res.status(404).json({ erro: 'Robô não encontrado' });

    // Busca máquina alvo: primeiro a vinculada ao robô, senão qualquer online com slot livre
    let maquina = null;
    if (robo.maquinaId) {
      maquina = await Maquina.findOne({ _id: robo.maquinaId, empresa: req.usuario.empresa, status: { $in: ['online','busy'] }, ativo: true });
    }
    if (!maquina) {
      maquina = await Maquina.findOne({
        empresa: req.usuario.empresa, status: 'online', ativo: true,
        $expr: { $lt: ['$robosAtivos', '$capacidadeMaxima'] }
      }).sort({ robosAtivos: 1 });
    }

    const exec = await ExecucaoRobo.create({
      roboId:    robo._id,
      roboNome:  robo.nome,
      status:    maquina ? 'em_execucao' : 'nao_disparado',
      motivoInterrupcao: maquina ? '' : 'Nenhuma máquina online disponível',
      maquina:   maquina ? maquina.machineId : '',
      maquinaId: maquina ? maquina._id : null,
      gatilho:   req.body.gatilho || 'manual',
      prioridade: robo.prioridade || 'Media',
      iniciadoEm: maquina ? new Date() : null,
      empresa:   req.usuario.empresa,
      criadoPor: req.usuario.id
    });

    if (maquina) {
      await Maquina.findByIdAndUpdate(maquina._id, { $inc: { robosAtivos: 1 } });
    }

    res.status(201).json({ ...exec.toObject(), status: exec.status });
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

// Interromper execução
app.post('/api/robos/execucoes/:id/interromper', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    const exec = await ExecucaoRobo.findOneAndUpdate(
      { _id: req.params.id, empresa: req.usuario.empresa, status: 'em_execucao' },
      { status: 'interrompido', motivoInterrupcao: req.body.motivo || 'Interrupção manual', finalizadoEm: new Date() },
      { new: true }
    );
    if (!exec) return res.status(404).json({ erro: 'Execução não encontrada ou já finalizada' });
    res.json(exec);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

// CRUD execuções
app.get('/api/robos/execucoes', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    const filter = { empresa: req.usuario.empresa };
    if (req.query.status) filter.status = req.query.status;
    if (req.query.roboId) filter.roboId = req.query.roboId;
    const execs = await ExecucaoRobo.find(filter).sort({ criadoEm: -1 }).limit(200);
    res.json(execs);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});
app.get('/api/robos/execucoes/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    const exec = await ExecucaoRobo.findOne({ _id: req.params.id, empresa: req.usuario.empresa });
    if (!exec) return res.status(404).json({ erro: 'Execução não encontrada' });
    res.json(exec);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});
app.put('/api/robos/execucoes/:id', authMiddleware, verificarAssinatura, async (req, res) => {
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
app.get('/api/robos/metricas', authMiddleware, verificarAssinatura, async (req, res) => {
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
app.get('/api/robos/agentes', authMiddleware, verificarAssinatura, async (req, res) => {
  try { const agentes = await AgenteRobo.find({ empresa: req.usuario.empresa }).sort({ criadoEm: -1 }); res.json(agentes); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/robos/agentes', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    const token = require('crypto').randomBytes(32).toString('hex');
    const agente = await AgenteRobo.create({ ...req.body, token, empresa: req.usuario.empresa });
    res.status(201).json(agente);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.put('/api/robos/agentes/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    const agente = await AgenteRobo.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, { ...req.body, atualizadoEm: new Date() }, { new: true, strict: false });
    if (!agente) return res.status(404).json({ erro: 'Agente não encontrado' });
    res.json(agente);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.delete('/api/robos/agentes/:id', authMiddleware, verificarAssinatura, async (req, res) => {
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

app.get('/api/maquinas', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    const lista = await Maquina.find({ empresa: req.usuario.empresa, ativo: true }).sort({ criadoEm: -1 }).select('-machineKey');
    res.json(lista);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/maquinas', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    const machineKey = crypto.randomUUID();
    const maquina = await Maquina.create({
      ...req.body, machineKey,
      empresa: req.usuario.empresa, criadoPor: req.usuario.id
    });
    res.status(201).json({ ...maquina.toObject() }); // key included only on creation
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.put('/api/maquinas/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    const { machineKey, ...updates } = req.body;
    const maquina = await Maquina.findOneAndUpdate(
      { _id: req.params.id, empresa: req.usuario.empresa },
      { ...updates, atualizadoEm: new Date() },
      { new: true }
    ).select('-machineKey');
    if (!maquina) return res.status(404).json({ erro: 'Máquina não encontrada' });
    res.json(maquina);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

app.delete('/api/maquinas/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    await Maquina.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, { ativo: false });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.post('/api/maquinas/:id/manutencao', authMiddleware, verificarAssinatura, async (req, res) => {
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
app.get('/api/maquinas/:id/agent-config', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    const maquina = await Maquina.findOne({ _id: req.params.id, empresa: req.usuario.empresa });
    if (!maquina) return res.status(404).json({ erro: 'Máquina não encontrada' });
    res.json({
      server: process.env.BASE_URL || 'http://localhost:3000',
      workspace: req.usuario.empresa.toString(),
      machineKey: maquina.machineKey,
      machineId: maquina.machineId
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
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
    // Retorna comandos pendentes (execuções criadas para esta máquina ainda não iniciadas)
    const pendentes = await ExecucaoRobo.find({
      maquina: maquina.machineId,
      status: 'em_execucao',
      comandoEnviado: { $ne: true }
    }).limit(3);
    const roboIds = [...new Set(pendentes.map(e => e.roboId?.toString()).filter(Boolean))];
    const robosEncontrados = roboIds.length ? await Robot.find({ _id: { $in: roboIds } }) : [];
    const roboMap = Object.fromEntries(robosEncontrados.map(r => [r._id.toString(), r]));
    // Marca como enviados só depois de ter os dados do robô
    if (pendentes.length) {
      await ExecucaoRobo.updateMany(
        { _id: { $in: pendentes.map(e => e._id) } },
        { comandoEnviado: true }
      );
    }
    const INTERP = { py:'python', js:'node', ts:'npx ts-node', rb:'ruby', sh:'bash', php:'php', r:'Rscript' };
    const commands = pendentes.map(e => {
      const robo = roboMap[e.roboId?.toString()] || {};
      let command = robo.comandoExecucao || '';
      if (!command && robo.arquivoPrincipal) {
        const arq = robo.arquivoPrincipal;
        const ext = (arq.split('.').pop()||'').toLowerCase();
        if (INTERP[ext]) command = `${INTERP[ext]} ${arq}`;
        else if (['exe','bat','cmd'].includes(ext)) command = arq;
        else command = `python ${arq}`;
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
        pacotesPip:       robo.pacotesPip || '',
        preComando:       robo.preComando || '',
        timeout:          robo.timeout || 30
      };
    });
    res.json({ ok: true, status, commands });
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
    if (status === 'error') Object.assign(updates, { $set: { status: 'erro', finalizadoEm: new Date() } });
    await ExecucaoRobo.findByIdAndUpdate(req.params.id, updates);
    if (status === 'success') await Robot.findByIdAndUpdate(exec?.roboId, { $inc: { totalExecucoes: 1 } });
    if (status === 'success' || status === 'error') {
      await Maquina.findByIdAndUpdate(maquina._id, { $inc: { robosAtivos: -1 } });
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

// Credencial por nome — consumida pelo robô em execução
app.get('/api/credenciais/:nome/valor', async (req, res) => {
  try {
    const machineKey = req.headers['x-machine-key'];
    if (!machineKey) return res.status(400).json({ erro: 'x-machine-key header obrigatório' });
    const maquina = await Maquina.findOne({ machineKey, ativo: true });
    if (!maquina) return res.status(401).json({ erro: 'Chave inválida' });
    const cred = await Credencial.findOne({ nome: req.params.nome, empresa: maquina.empresa });
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
      let maquina = null;
      if (robo.maquinaId) {
        maquina = await Maquina.findOne({ _id: robo.maquinaId, status: { $in: ['online','busy'] }, ativo: true });
      }
      if (!maquina) {
        maquina = await Maquina.findOne({
          empresa: robo.empresa, status: 'online', ativo: true,
          $expr: { $lt: ['$robosAtivos', '$capacidadeMaxima'] }
        }).sort({ robosAtivos: 1 });
      }
      await ExecucaoRobo.create({
        roboId: robo._id, roboNome: robo.nome,
        status: maquina ? 'em_execucao' : 'nao_disparado',
        motivoInterrupcao: maquina ? '' : 'Nenhuma máquina disponível',
        maquina: maquina ? maquina.machineId : '',
        maquinaId: maquina ? maquina._id : null,
        gatilho: 'schedule', prioridade: robo.prioridade || 'Media',
        iniciadoEm: maquina ? new Date() : null, empresa: robo.empresa
      });
      if (maquina) await Maquina.findByIdAndUpdate(maquina._id, { $inc: { robosAtivos: 1 } });
      const proxima = calcularProximaExec(robo.schedule);
      if (proxima) await Robot.findByIdAndUpdate(robo._id, { 'schedule.proximaExec': proxima });
      else await Robot.findByIdAndUpdate(robo._id, { 'schedule.ativo': false });
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
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (req, file, cb) => {
    if (file.originalname.endsWith('.zip') || file.mimetype === 'application/zip') cb(null, true);
    else cb(new Error('Apenas arquivos .zip são aceitos'));
  }
});

// Upload do ZIP do robô (autenticado pelo usuário SaaS)
app.post('/api/robos/:id/package', authMiddleware, verificarAssinatura, uploadRobotZip.single('zip'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado' });
    await Robot.findOneAndUpdate(
      { _id: req.params.id, empresa: req.usuario.empresa },
      { zipNome: req.file.originalname, vinculoTipo: 'zip', atualizadoEm: new Date() }
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

app.get('/api/credenciais', authMiddleware, verificarAssinatura, async (req, res) => {
  try { const creds = await Credencial.find({ empresa: req.usuario.empresa }).select('-valor').sort({ criadoEm: -1 }); res.json(creds); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/credenciais', authMiddleware, verificarAssinatura, async (req, res) => {
  try { const cred = await Credencial.create({ ...req.body, empresa: req.usuario.empresa }); res.status(201).json(cred); }
  catch (err) { res.status(400).json({ erro: err.message }); }
});
app.put('/api/credenciais/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try { const cred = await Credencial.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, { ...req.body, atualizadoEm: new Date() }, { new: true }); if (!cred) return res.status(404).json({ erro: 'Credencial não encontrada' }); res.json(cred); }
  catch (err) { res.status(400).json({ erro: err.message }); }
});
app.delete('/api/credenciais/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try { await Credencial.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa }); res.json({ mensagem: 'Credencial deletada!' }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== SERVIDOR ====================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
