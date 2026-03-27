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
  // Plano solicitado aguardando confirmação de pagamento
  planoSolicitado: { type: String, default: null },
  solicitadoEm: { type: Date, default: null },
  solicitadoPor: { type: String, default: null }, // nome do usuário que solicitou
  coraCobrancaId: { type: String, default: null },
  coraBoletoUrl: { type: String, default: null },
  coraPixQrCode: { type: String, default: null },
  coraPixCopiaECola: { type: String, default: null },
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
    overview:       { acessar: { type: Boolean, default: true },  editar:    { type: Boolean, default: false } },
    ideiasLivres:   { acessar: { type: Boolean, default: true },  criar:     { type: Boolean, default: true },  aprovar:   { type: Boolean, default: false } },
    gestaoMetas:    { acessar: { type: Boolean, default: true },  editar:    { type: Boolean, default: false } },
    gestaoProjetos: { acessar: { type: Boolean, default: true },  criar:     { type: Boolean, default: false }, editar:    { type: Boolean, default: false } },
    gestaoLicencas: { acessar: { type: Boolean, default: true },  criar:     { type: Boolean, default: false }, editar:    { type: Boolean, default: false } },
    operacoes:      { acessar: { type: Boolean, default: true },  criar:     { type: Boolean, default: false }, editar:    { type: Boolean, default: false } },
    planoUsuarios:  { acessar: { type: Boolean, default: false }, gerenciar: { type: Boolean, default: false } },
  },
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
  nome: { type: String, required: true }, categoria: { type: String, default: '' }, fornecedor: { type: String, default: '' },
  unidade: { type: String, default: '' }, responsavel: { type: String, default: '' }, responsavelEmail: { type: String, default: '' },
  dataEmissao: { type: String, default: '' }, validade: { type: String, default: '' }, quantidade: { type: String, default: '' },
  custo: { type: Number, default: 0 }, status: { type: String, default: 'Ativa', enum: ['Ativa', 'Vencendo', 'Vencida', 'Em Renovação'] },
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
  empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  criadoEm: { type: Date, default: Date.now }
});
const Contato = mongoose.model('Contato', contatoSchema);

const emailTemplateSchema = new mongoose.Schema({
  nome: { type: String, required: true }, assunto: { type: String, default: '' },
  corpo: { type: String, default: '' }, variaveis: { type: Array, default: [] },
  categoria: { type: String, default: '' },
  empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  criadoEm: { type: Date, default: Date.now }, atualizadoEm: { type: Date, default: Date.now }
});
const EmailTemplate = mongoose.model('EmailTemplate', emailTemplateSchema);

const tarefaSchema = new mongoose.Schema({
  titulo: { type: String, required: true }, descricao: { type: String, default: '' },
  responsaveis: { type: Array, default: [] }, areas: { type: Array, default: [] },
  prazo: { type: String, default: '' }, competencia: { type: String, default: '' },
  tags: { type: Array, default: [] }, status: { type: String, default: 'Pendente', enum: ['Pendente', 'Em Progresso', 'Concluída', 'Dispensada'] },
  prioridade: { type: String, default: 'Media', enum: ['Baixa', 'Media', 'Alta', 'Urgente'] },
  progresso: { type: Number, default: 0 }, grupo: { type: String, default: '' },
  recorrente: { type: Boolean, default: false }, frequencia: { type: String, default: '' },
  contatoId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contato' },
  emailTemplateId: { type: mongoose.Schema.Types.ObjectId, ref: 'EmailTemplate' },
  lembretes: { type: Array, default: [] },
  anexos: [{ nome: String, tipo: String, tamanho: Number, base64: String, prazoVencimento: String }],
  tarefaVinculadaId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tarefa' },
  emailEnviado: { type: Boolean, default: false }, emailAberto: { type: Boolean, default: false },
  empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  criadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  criadoEm: { type: Date, default: Date.now }, atualizadoEm: { type: Date, default: Date.now }
});
const Tarefa = mongoose.model('Tarefa', tarefaSchema);

const processoSchema = new mongoose.Schema({
  nome: { type: String, required: true }, descricao: { type: String, default: '' },
  categoria: { type: String, default: '' }, responsavel: { type: String, default: '' },
  versao: { type: String, default: 'v1.0' }, status: { type: String, default: 'Ativo', enum: ['Ativo', 'Em Revisão', 'Inativo'] },
  execucoes: { type: Number, default: 0 }, taxaSucesso: { type: Number, default: 100 },
  passos: { type: Array, default: [] }, versoes: { type: Array, default: [] },
  empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  criadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  criadoEm: { type: Date, default: Date.now }, atualizadoEm: { type: Date, default: Date.now }
});
const Processo = mongoose.model('Processo', processoSchema);

const robotSchema = new mongoose.Schema({
  nome: { type: String, required: true }, descricao: { type: String, default: '' },
  tipo: { type: String, default: 'Background', enum: ['Background', 'Desktop'] },
  categoria: { type: String, default: '' }, departamento: { type: String, default: '' },
  versao: { type: String, default: 'v1.0' }, comandoExecucao: { type: String, default: '' },
  status: { type: String, default: 'Pausado', enum: ['Executando', 'Pausado', 'Erro', 'Concluído'] },
  prioridade: { type: String, default: 'Media', enum: ['Baixa', 'Media', 'Alta'] },
  maquina: { type: String, default: '' }, timeout: { type: Number, default: 30 },
  fila: { type: Array, default: [] }, logs: { type: Array, default: [] },
  schedules: { type: Array, default: [] }, versoes: { type: Array, default: [] },
  tempoMedioExecucao: { type: Number, default: 0 }, totalExecucoes: { type: Number, default: 0 },
  totalErros: { type: Number, default: 0 }, tempoHumanoMinutos: { type: Number, default: 0 },
  empresa: { type: mongoose.Schema.Types.ObjectId, ref: 'Empresa', required: true },
  criadoPor: { type: mongoose.Schema.Types.ObjectId, ref: 'Usuario' },
  criadoEm: { type: Date, default: Date.now }, atualizadoEm: { type: Date, default: Date.now }
});
const Robot = mongoose.model('Robot', robotSchema);

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
  titulo: { type: String, required: true },
  mensagem: { type: String, default: '' },
  tipo: { type: String, default: 'info', enum: ['info', 'sucesso', 'aviso', 'erro', 'licenca_vencendo', 'licenca_vencida'] },
  icone: { type: String, default: '🔔' },
  link: { type: String, default: '' },
  lida: { type: Boolean, default: false },
  criadoEm: { type: Date, default: Date.now }
});
const Notificacao = mongoose.model('Notificacao', notificacaoSchema);

// ==================== HELPERS ====================

async function criarNotificacao(empresaId, titulo, mensagem, tipo, icone, link) {
  try {
    await Notificacao.create({ empresa: empresaId, titulo, mensagem, tipo, icone, link });
  } catch (err) { console.error('Erro ao criar notificação:', err); }
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

// Middleware de verificação de assinatura
// Bloqueia acesso se inadimplente ou cancelado
// Permite acesso em trial e ativa
// Rotas de pagamento/assinatura são sempre liberadas
async function verificarAssinatura(req, res, next) {
  try {
    // Rotas liberadas mesmo com inadimplência
    const rotasLiberadas = [
      '/api/assinatura',
      '/api/assinatura/fatura',
      '/api/assinatura/webhook',
      '/api/notificacoes',
      '/api/notificacoes/resumo',
      '/api/usuarios'
    ];
    const rota = req.path;
    if (rotasLiberadas.some(r => rota.startsWith(r))) return next();

    const empresaId = req.usuario?.empresa;
    if (!empresaId) return next();

    const assinatura = await Assinatura.findOne({ empresa: empresaId });

    // Se não tem assinatura ainda, cria trial (compatibilidade com contas antigas)
    if (!assinatura) return next();

    const agora = new Date();

    // Trial ativo
    if (assinatura.status === 'trial') {
      if (agora <= assinatura.trialFim) return next();
      // Trial expirado — marcar como inadimplente e gerar cobrança
      await Assinatura.findByIdAndUpdate(assinatura._id, { status: 'inadimplente', atualizadoEm: new Date() });
      return res.status(402).json({
        bloqueado: true,
        motivo: 'trial_expirado',
        mensagem: 'Seu período de teste gratuito expirou. Regularize sua assinatura para continuar.'
      });
    }

    // Ativa
    if (assinatura.status === 'ativa') return next();

    // Inadimplente
    if (assinatura.status === 'inadimplente') {
      const diasAtraso = Math.floor((agora - assinatura.vencimento) / (1000 * 60 * 60 * 24));
      return res.status(402).json({
        bloqueado: true,
        motivo: 'fatura_atrasada',
        diasAtraso,
        mensagem: `Sua fatura está ${diasAtraso} dia(s) em atraso. Regularize para continuar usando o sistema.`,
        boletoUrl: assinatura.coraBoletoUrl,
        pixCopiaECola: assinatura.coraPixCopiaECola
      });
    }

    // Cancelada
    if (assinatura.status === 'cancelada') {
      return res.status(402).json({
        bloqueado: true,
        motivo: 'assinatura_cancelada',
        mensagem: 'Sua assinatura foi cancelada. Entre em contato para reativá-la.'
      });
    }

    next();
  } catch (err) {
    console.error('Erro ao verificar assinatura:', err);
    next(); // Em caso de erro, não bloqueia
  }
}


// ==================== MIDDLEWARE DE PERMISSÕES ====================

// Verifica se usuário tem permissão para acessar um módulo
// Admin e usuarioMestre sempre têm acesso total
function criarMiddlewarePermissao(modulo, acao) {
  return async function(req, res, next) {
    try {
      // Admin sempre passa
      if (req.usuario.perfil === 'Admin') return next();
      const usuario = await Usuario.findById(req.usuario.id).select('permissoes usuarioMestre perfil');
      if (!usuario) return res.status(401).json({ erro: 'Usuário não encontrado' });
      // Usuário mestre sempre passa
      if (usuario.usuarioMestre) return next();
      const permMod = usuario.permissoes?.[modulo];
      if (!permMod) return res.status(403).json({ erro: 'Sem permissão', modulo, acao });
      if (!permMod[acao]) return res.status(403).json({ erro: 'Sem permissão', modulo, acao });
      next();
    } catch (err) { res.status(500).json({ erro: err.message }); }
  };
}

// Atalhos por módulo
const permOverview       = (acao) => criarMiddlewarePermissao('overview', acao);
const permIdeiasLivres   = (acao) => criarMiddlewarePermissao('ideiasLivres', acao);
const permGestaoMetas    = (acao) => criarMiddlewarePermissao('gestaoMetas', acao);
const permGestaoProjetos = (acao) => criarMiddlewarePermissao('gestaoProjetos', acao);
const permGestaoLicencas = (acao) => criarMiddlewarePermissao('gestaoLicencas', acao);
const permOperacoes      = (acao) => criarMiddlewarePermissao('operacoes', acao);
const permPlanoUsuarios  = (acao) => criarMiddlewarePermissao('planoUsuarios', acao);

// ==================== PÁGINAS ====================
// Rota permissionamentos — acessível pela URL mas sem link no menu
app.get('/permissionamentos', (req, res) => res.sendFile(path.join(__dirname, 'public', 'permissionamentos.html')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/cadastro', (req, res) => res.sendFile(path.join(__dirname, 'public', 'cadastro.html')));
app.get('/confirmar-email', (req, res) => res.sendFile(path.join(__dirname, 'public', 'confirmar-email.html')));
app.get('/recuperar-senha', (req, res) => res.sendFile(path.join(__dirname, 'public', 'recuperar-senha.html')));
app.get('/redefinir-senha', (req, res) => res.sendFile(path.join(__dirname, 'public', 'redefinir-senha.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/overview', (req, res) => res.sendFile(path.join(__dirname, 'public', 'overview.html')));
app.get('/gestao-metas', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gestao-metas.html')));
app.get('/ideias-livres', (req, res) => res.sendFile(path.join(__dirname, 'public', 'ideias-livres.html')));
app.get('/gestao-projetos', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gestao-projetos.html')));
app.get('/projeto-tradicional', (req, res) => res.sendFile(path.join(__dirname, 'public', 'projeto-tradicional.html')));
app.get('/projeto-agil', (req, res) => res.sendFile(path.join(__dirname, 'public', 'projeto-agil.html')));
app.get('/repositorio-templates', (req, res) => res.sendFile(path.join(__dirname, 'public', 'repositorio-templates.html')));
app.get('/gestao-licencas', (req, res) => res.sendFile(path.join(__dirname, 'public', 'gestao-licencas.html')));
app.get('/operacoes', (req, res) => res.sendFile(path.join(__dirname, 'public', 'operacoes.html')));
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
    // CNPJ deve ser único — impede duplicidade independente do nome
    const cnpjExiste = await Empresa.findOne({ cnpj: cnpjLimpo });
    if (cnpjExiste) return res.status(400).json({ erro: 'CNPJ já cadastrado. Entre em contato com o administrador.' });
    // Nome igual + CNPJ igual = duplicata (já bloqueado acima)
    // Nome igual + CNPJ diferente = permitido (empresas com nome fantasia igual)

    const empresa = await Empresa.create({ nome: nomeEmpresa.trim(), cnpj: cnpjLimpo });

    // Criar assinatura com trial de 30 dias
    const trialFim = new Date();
    trialFim.setDate(trialFim.getDate() + 30);
    await Assinatura.create({ empresa: empresa._id, status: 'trial', trialFim, plano: 'basico' });

    const tokenConfirmacao = crypto.randomBytes(32).toString('hex');
    const hash = await bcrypt.hash(senha, 10);
    await Usuario.create({
      nome, email, senha: hash, perfil: 'Admin', usuarioMestre: true,
      status: 'Pendente', emailConfirmado: false, tokenConfirmacao,
      empresa: empresa._id,
      permissoes: {
        overview:       { acessar: true, editar: true },
        ideiasLivres:   { acessar: true, criar: true, aprovar: true },
        gestaoMetas:    { acessar: true, editar: true },
        gestaoProjetos: { acessar: true, criar: true, editar: true },
        gestaoLicencas: { acessar: true, criar: true, editar: true },
        operacoes:      { acessar: true, criar: true, editar: true },
        planoUsuarios:  { acessar: true, gerenciar: true },
      }
    });

    const linkConfirmacao = `${process.env.APP_URL}/confirmar-email?token=${tokenConfirmacao}`;
    await enviarEmail(email, 'Confirme seu email — HOC System', `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
        <h2 style="color:#2d1b69">Confirme seu email 📧</h2>
        <p style="color:#4a5568">Olá <strong>${nome}</strong>! Sua conta foi criada com sucesso.</p>
        <p style="color:#718096;margin-bottom:8px">Você tem <strong>30 dias gratuitos</strong> para explorar o HOC System.</p>
        <p style="color:#718096;margin-bottom:24px">Clique abaixo para confirmar seu email e ativar sua conta.</p>
        <a href="${linkConfirmacao}" style="display:inline-block;padding:14px 28px;background:#2d1b69;color:white;border-radius:8px;text-decoration:none;font-weight:600">Confirmar meu email</a>
      </div>`);

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
    await criarNotificacao(usuario.empresa, 'Bem-vindo ao HOC System! 🎉', `Você tem ${diasTrial} dias gratuitos para explorar. Aproveite!`, 'sucesso', '🎉', '/dashboard');
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
    if (usuario.status === 'Inativo') return res.status(400).json({ erro: 'Conta inativa. Entre em contato com o administrador.' });

    // Buscar status da assinatura para incluir no token
    const assinatura = await Assinatura.findOne({ empresa: usuario.empresa._id });
    const statusAssinatura = assinatura ? assinatura.status : 'trial';
    const trialFim = assinatura ? assinatura.trialFim : null;
    const diasTrialRestantes = (statusAssinatura === 'trial' && trialFim)
      ? Math.max(0, Math.ceil((new Date(trialFim) - new Date()) / (1000 * 60 * 60 * 24)))
      : null;

    const token = jwt.sign(
      { id: usuario._id, nome: usuario.nome, email: usuario.email, perfil: usuario.perfil, empresa: usuario.empresa._id, empresaNome: usuario.empresa.nome },
      process.env.JWT_SECRET || 'segredo123',
      { expiresIn: '8h' }
    );

    verificarAlertasLicencas(usuario.empresa._id, usuario.email).catch(console.error);

    res.json({
      token,
      usuario: { nome: usuario.nome, email: usuario.email, perfil: usuario.perfil, empresaNome: usuario.empresa.nome },
      assinatura: { status: statusAssinatura, diasTrialRestantes }
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== RECUPERAÇÃO DE SENHA ====================

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
    await enviarEmail(email, 'Redefinição de senha — HOC System', `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
        <h2 style="color:#2d1b69">Redefinir senha 🔐</h2>
        <p style="color:#4a5568">Olá <strong>${usuario.nome}</strong>!</p>
        <p style="color:#718096;margin-bottom:24px">Clique abaixo para criar uma nova senha. Este link expira em <strong>1 hora</strong>.</p>
        <a href="${linkRedefinicao}" style="display:inline-block;padding:14px 28px;background:#2d1b69;color:white;border-radius:8px;text-decoration:none;font-weight:600">Redefinir minha senha</a>
        <p style="color:#a0aec0;font-size:12px;margin-top:24px">Se não solicitou isso, ignore este email.</p>
      </div>`);
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
    tokenDoc.usado = true;
    await tokenDoc.save();
    res.json({ mensagem: 'Senha redefinida com sucesso!' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== ASSINATURA ====================

// Buscar assinatura da empresa
app.get('/api/assinatura', authMiddleware, async (req, res) => {
  try {
    let assinatura = await Assinatura.findOne({ empresa: req.usuario.empresa });
    if (!assinatura) {
      // Compatibilidade com contas antigas — criar trial
      const trialFim = new Date();
      trialFim.setDate(trialFim.getDate() + 30);
      assinatura = await Assinatura.create({ empresa: req.usuario.empresa, status: 'trial', trialFim, plano: 'basico' });
    }
    const agora = new Date();
    const diasTrialRestantes = (assinatura.status === 'trial' && assinatura.trialFim)
      ? Math.max(0, Math.ceil((new Date(assinatura.trialFim) - agora) / (1000 * 60 * 60 * 24)))
      : null;
    const diasAtraso = (assinatura.status === 'inadimplente' && assinatura.vencimento)
      ? Math.floor((agora - new Date(assinatura.vencimento)) / (1000 * 60 * 60 * 24))
      : null;
    res.json({
      ...assinatura.toObject(),
      diasTrialRestantes,
      diasAtraso,
      // Inclui dados de PIX configurados por variável de ambiente
      pixChave: process.env.PIX_CHAVE || null,
      pixNome: process.env.PIX_NOME || null,
      pixBanco: process.env.PIX_BANCO || null,
    });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Solicitar plano — registra pedido, aguarda confirmação manual do Admin
app.post('/api/assinatura/solicitar', authMiddleware, async (req, res) => {
  try {
    const { plano } = req.body;
    const planosValidos = ['basico', 'intermediario', 'avancado', 'enterprise'];
    if (!planosValidos.includes(plano)) return res.status(400).json({ erro: 'Plano inválido' });

    const usuarioReq = await Usuario.findById(req.usuario.id).select('nome email');
    if (!usuarioReq) return res.status(404).json({ erro: 'Usuário não encontrado' });

    let assinatura = await Assinatura.findOne({ empresa: req.usuario.empresa });
    const updateData = {
      planoSolicitado: plano,
      solicitadoEm: new Date(),
      solicitadoPor: usuarioReq.nome,
      status: 'aguardando_confirmacao',
      atualizadoEm: new Date()
    };

    if (assinatura) {
      assinatura = await Assinatura.findOneAndUpdate(
        { empresa: req.usuario.empresa }, updateData, { new: true }
      );
    } else {
      assinatura = await Assinatura.create({ empresa: req.usuario.empresa, ...updateData });
    }

    // Notificar o Admin da empresa
    const nomePlano = { basico:'Básico', intermediario:'Intermediário', avancado:'Avançado', enterprise:'Enterprise' };
    await criarNotificacao(
      req.usuario.empresa,
      `💳 Pagamento aguardando confirmação`,
      `${usuarioReq.nome} solicitou o Plano ${nomePlano[plano]}. Confirme o pagamento para liberar o acesso.`,
      'aviso', '💳', '/plano-usuarios'
    );

    // Enviar email para o admin da empresa
    try {
      const admin = await Usuario.findOne({ empresa: req.usuario.empresa, perfil: 'Admin' }).select('email nome');
      if (admin) {
        await enviarEmail(
          admin.email,
          `💳 HOC System — Pagamento aguardando confirmação`,
          `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px">
            <h2 style="color:#2d1b69">Pagamento aguardando confirmação</h2>
            <p>${usuarioReq.nome} realizou o pagamento e solicitou a ativação do <strong>Plano ${nomePlano[plano]}</strong>.</p>
            <p style="margin-top:16px">Acesse o HOC System e confirme o pagamento para liberar o acesso.</p>
            <a href="${process.env.APP_URL}/plano-usuarios" style="display:inline-block;margin-top:20px;padding:12px 24px;background:#2d1b69;color:white;border-radius:8px;text-decoration:none;font-weight:600">Confirmar Pagamento</a>
            <p style="margin-top:24px;font-size:12px;color:#a0aec0">Solicitado em: ${new Date().toLocaleString('pt-BR')}</p>
          </div>`
        );
      }
    } catch(emailErr) { console.error('Erro ao enviar email admin:', emailErr); }

    res.json({ mensagem: 'Solicitação registrada! Aguarde a confirmação do administrador.', assinatura });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== ADMIN — PAINEL DE PAGAMENTOS ====================

// Middleware para verificar ADMIN_SECRET
function adminSecretMiddleware(req, res, next) {
  const secret = (req.headers['x-admin-secret'] || '').trim();
  const adminSecret = (process.env.ADMIN_SECRET || '').trim();
  if (!secret || !adminSecret || secret !== adminSecret) {
    return res.status(403).json({ erro: 'Acesso negado. Senha administrativa incorreta.' });
  }
  next();
}

// Verificar senha do painel admin
app.post('/api/admin/verificar-senha', (req, res) => {
  const { senha } = req.body;
  const adminSecret = (process.env.ADMIN_SECRET || '').trim();
  if (!senha || !adminSecret || senha.trim() !== adminSecret) {
    return res.status(401).json({ erro: 'Senha incorreta.' });
  }
  res.json({ ok: true });
});

// Listar todos os pagamentos pendentes (todas as empresas)
app.get('/api/admin/pagamentos-pendentes', adminSecretMiddleware, async (req, res) => {
  try {
    const assinaturas = await Assinatura.find({ status: 'aguardando_confirmacao' })
      .populate('empresa', 'nome cnpj')
      .sort({ solicitadoEm: -1 });

    const nomePlano = { basico:'Básico', intermediario:'Intermediário', avancado:'Avançado', enterprise:'Enterprise' };
    const valorPlano = { basico: 'R$ 49,00', intermediario: 'R$ 149,00', avancado: 'R$ 349,00', enterprise: 'Sob consulta' };

    const resultado = assinaturas.map(a => ({
      _id: a._id,
      empresaId: a.empresa?._id,
      empresaNome: a.empresa?.nome || 'Empresa desconhecida',
      empresaCnpj: a.empresa?.cnpj || '—',
      planoSolicitado: a.planoSolicitado,
      planoNome: nomePlano[a.planoSolicitado] || a.planoSolicitado,
      planoValor: valorPlano[a.planoSolicitado] || '—',
      solicitadoPor: a.solicitadoPor,
      solicitadoEm: a.solicitadoEm,
      statusAnterior: a.plano && a.vencimento ? a.status : 'trial',
    }));

    res.json(resultado);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Confirmar pagamento de uma empresa
app.post('/api/admin/confirmar-pagamento', adminSecretMiddleware, async (req, res) => {
  try {
    const { empresaId } = req.body;
    if (!empresaId) return res.status(400).json({ erro: 'empresaId obrigatório.' });

    const assinatura = await Assinatura.findOne({ empresa: empresaId, status: 'aguardando_confirmacao' });
    if (!assinatura) return res.status(404).json({ erro: 'Nenhuma solicitação pendente para esta empresa.' });

    const plano = assinatura.planoSolicitado || assinatura.plano;
    const vencimento = new Date();
    vencimento.setDate(vencimento.getDate() + 30);

    const nomePlano = { basico:'Básico', intermediario:'Intermediário', avancado:'Avançado', enterprise:'Enterprise' };
    const valorPlano = { basico: 4900, intermediario: 14900, avancado: 34900, enterprise: 0 };
    const novaFatura = { plano, valor: valorPlano[plano], vencimento, pagoEm: new Date(), confirmadoPor: 'admin' };

    await Assinatura.findOneAndUpdate(
      { empresa: empresaId },
      {
        plano, status: 'ativa', vencimento,
        planoSolicitado: null, solicitadoEm: null, solicitadoPor: null,
        atualizadoEm: new Date(),
        $push: { historicoFaturas: novaFatura }
      }
    );

    // Notificar usuários da empresa
    await criarNotificacao(
      empresaId,
      `✅ Plano ${nomePlano[plano]} ativado!`,
      'Seu pagamento foi confirmado. O acesso completo ao HOC System está liberado.',
      'sucesso', '✅', '/plano-usuarios'
    );

    res.json({ mensagem: `Plano ${nomePlano[plano]} confirmado para empresa ${empresaId}.` });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Rejeitar pagamento de uma empresa
app.post('/api/admin/rejeitar-pagamento', adminSecretMiddleware, async (req, res) => {
  try {
    const { empresaId, motivo } = req.body;
    if (!empresaId) return res.status(400).json({ erro: 'empresaId obrigatório.' });

    const assinatura = await Assinatura.findOne({ empresa: empresaId, status: 'aguardando_confirmacao' });
    if (!assinatura) return res.status(404).json({ erro: 'Nenhuma solicitação pendente para esta empresa.' });

    // Volta ao status anterior
    const statusAnterior = assinatura.vencimento ? 'inadimplente' : 'trial';

    await Assinatura.findOneAndUpdate(
      { empresa: empresaId },
      { status: statusAnterior, planoSolicitado: null, solicitadoEm: null, solicitadoPor: null, atualizadoEm: new Date() }
    );

    // Notificar usuários da empresa
    await criarNotificacao(
      empresaId,
      `❌ Pagamento não confirmado`,
      motivo || 'Não foi possível confirmar o pagamento. Entre em contato com o suporte.',
      'erro', '❌', '/plano-usuarios'
    );

    res.json({ mensagem: `Pagamento rejeitado para empresa ${empresaId}.` });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Listar todas as empresas com assinatura ativa
app.get('/api/admin/contas-ativas', adminSecretMiddleware, async (req, res) => {
  try {
    const assinaturas = await Assinatura.find({ status: 'ativa' })
      .populate('empresa', 'nome cnpj criadoEm')
      .sort({ atualizadoEm: -1 });
    const nomePlano = { basico:'Básico', intermediario:'Intermediário', avancado:'Avançado', enterprise:'Enterprise' };
    const valorPlano = { basico:'R$ 49,00', intermediario:'R$ 149,00', avancado:'R$ 349,00', enterprise:'Sob consulta' };
    res.json(assinaturas.map(a => ({
      _id: a._id, empresaId: a.empresa?._id,
      empresaNome: a.empresa?.nome || '—', empresaCnpj: a.empresa?.cnpj || '—',
      plano: a.plano, planoNome: nomePlano[a.plano] || a.plano, planoValor: valorPlano[a.plano] || '—',
      vencimento: a.vencimento, atualizadoEm: a.atualizadoEm
    })));
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Listar contas bloqueadas/inadimplentes/canceladas
app.get('/api/admin/contas-bloqueadas', adminSecretMiddleware, async (req, res) => {
  try {
    const assinaturas = await Assinatura.find({ status: { $in: ['inadimplente', 'cancelada', 'trial'] } })
      .populate('empresa', 'nome cnpj criadoEm')
      .sort({ atualizadoEm: -1 });
    const nomePlano = { basico:'Básico', intermediario:'Intermediário', avancado:'Avançado', enterprise:'Enterprise' };
    const statusLabel = { inadimplente:'Inadimplente', cancelada:'Cancelada', trial:'Trial' };
    res.json(assinaturas.map(a => ({
      _id: a._id, empresaId: a.empresa?._id,
      empresaNome: a.empresa?.nome || '—', empresaCnpj: a.empresa?.cnpj || '—',
      plano: a.plano, planoNome: nomePlano[a.plano] || a.plano,
      status: a.status, statusLabel: statusLabel[a.status] || a.status,
      vencimento: a.vencimento, atualizadoEm: a.atualizadoEm,
      diasAtraso: a.status === 'inadimplente' && a.vencimento
        ? Math.floor((new Date() - new Date(a.vencimento)) / (1000*60*60*24)) : null
    })));
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Histórico de faturas pagas (todas as empresas)
app.get('/api/admin/historico-pagamentos', adminSecretMiddleware, async (req, res) => {
  try {
    const assinaturas = await Assinatura.find({ 'historicoFaturas.0': { $exists: true } })
      .populate('empresa', 'nome cnpj')
      .sort({ atualizadoEm: -1 });
    const nomePlano = { basico:'Básico', intermediario:'Intermediário', avancado:'Avançado', enterprise:'Enterprise' };
    const valorPlano = { basico: 4900, intermediario: 14900, avancado: 34900, enterprise: 0 };
    const historico = [];
    assinaturas.forEach(a => {
      (a.historicoFaturas || []).forEach(f => {
        historico.push({
          empresaId: a.empresa?._id,
          empresaNome: a.empresa?.nome || '—',
          empresaCnpj: a.empresa?.cnpj || '—',
          plano: f.plano, planoNome: nomePlano[f.plano] || f.plano,
          valor: f.valor || valorPlano[f.plano] || 0,
          vencimento: f.vencimento, pagoEm: f.pagoEm,
          confirmadoPor: f.confirmadoPor || 'admin'
        });
      });
    });
    historico.sort((a, b) => new Date(b.pagoEm) - new Date(a.pagoEm));
    res.json(historico);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Dashboard — contadores gerais
app.get('/api/admin/dashboard', adminSecretMiddleware, async (req, res) => {
  try {
    const [ativas, inadimplentes, canceladas, trial, pendentes, totalEmpresas] = await Promise.all([
      Assinatura.countDocuments({ status: 'ativa' }),
      Assinatura.countDocuments({ status: 'inadimplente' }),
      Assinatura.countDocuments({ status: 'cancelada' }),
      Assinatura.countDocuments({ status: 'trial' }),
      Assinatura.countDocuments({ status: 'aguardando_confirmacao' }),
      Empresa.countDocuments()
    ]);
    // Receita mensal estimada
    const assinaturasAtivas = await Assinatura.find({ status: 'ativa' }).select('plano');
    const valorPlano = { basico: 49, intermediario: 149, avancado: 349, enterprise: 0 };
    const receitaMensal = assinaturasAtivas.reduce((s, a) => s + (valorPlano[a.plano] || 0), 0);
    res.json({ ativas, inadimplentes, canceladas, trial, pendentes, totalEmpresas, receitaMensal });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Cancelar conta de uma empresa
app.post('/api/admin/cancelar-conta', adminSecretMiddleware, async (req, res) => {
  try {
    const { empresaId, motivo } = req.body;
    if (!empresaId) return res.status(400).json({ erro: 'empresaId obrigatório.' });
    await Assinatura.findOneAndUpdate(
      { empresa: empresaId },
      { status: 'cancelada', atualizadoEm: new Date() }
    );
    await criarNotificacao(
      empresaId,
      '❌ Assinatura cancelada',
      motivo || 'Sua assinatura foi cancelada. Entre em contato com o suporte.',
      'erro', '❌', '/plano-usuarios'
    );
    res.json({ mensagem: 'Conta cancelada com sucesso.' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Marcar conta como inadimplente
app.post('/api/admin/marcar-inadimplente', adminSecretMiddleware, async (req, res) => {
  try {
    const { empresaId } = req.body;
    if (!empresaId) return res.status(400).json({ erro: 'empresaId obrigatório.' });
    await Assinatura.findOneAndUpdate(
      { empresa: empresaId },
      { status: 'inadimplente', vencimento: new Date(), atualizadoEm: new Date() }
    );
    await criarNotificacao(
      empresaId,
      '⚠️ Pagamento em atraso',
      'Identificamos um atraso no pagamento da sua assinatura. Regularize para continuar usando o HOC System.',
      'aviso', '⚠️', '/plano-usuarios'
    );
    res.json({ mensagem: 'Conta marcada como inadimplente.' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Reativar conta (cancelada ou inadimplente → ativa)
app.post('/api/admin/reativar-conta', adminSecretMiddleware, async (req, res) => {
  try {
    const { empresaId } = req.body;
    if (!empresaId) return res.status(400).json({ erro: 'empresaId obrigatório.' });
    const vencimento = new Date();
    vencimento.setDate(vencimento.getDate() + 30);
    await Assinatura.findOneAndUpdate(
      { empresa: empresaId },
      { status: 'ativa', vencimento, atualizadoEm: new Date() }
    );
    await criarNotificacao(
      empresaId,
      '✅ Assinatura reativada!',
      'Sua assinatura foi reativada. O acesso completo ao HOC System está liberado.',
      'sucesso', '✅', '/plano-usuarios'
    );
    res.json({ mensagem: 'Conta reativada com sucesso.' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// Trocar plano de uma empresa manualmente
app.post('/api/admin/trocar-plano', adminSecretMiddleware, async (req, res) => {
  try {
    const { empresaId, plano } = req.body;
    const planosValidos = ['basico', 'intermediario', 'avancado', 'enterprise'];
    if (!empresaId) return res.status(400).json({ erro: 'empresaId obrigatório.' });
    if (!planosValidos.includes(plano)) return res.status(400).json({ erro: 'Plano inválido.' });

    const nomePlano = { basico:'Básico', intermediario:'Intermediário', avancado:'Avançado', enterprise:'Enterprise' };
    const vencimento = new Date();
    vencimento.setDate(vencimento.getDate() + 30);

    await Assinatura.findOneAndUpdate(
      { empresa: empresaId },
      { plano, status: 'ativa', vencimento, atualizadoEm: new Date() }
    );

    await criarNotificacao(
      empresaId,
      `📦 Plano alterado para ${nomePlano[plano]}`,
      `Seu plano foi atualizado para ${nomePlano[plano]} pelo administrador.`,
      'sucesso', '📦', '/plano-usuarios'
    );

    res.json({ mensagem: `Plano alterado para ${nomePlano[plano]} com sucesso.` });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== NOTIFICAÇÕES ====================

app.get('/api/notificacoes', authMiddleware, async (req, res) => {
  try {
    const notificacoes = await Notificacao.find({ empresa: req.usuario.empresa }).sort({ criadoEm: -1 }).limit(50);
    res.json(notificacoes);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.get('/api/notificacoes/resumo', authMiddleware, async (req, res) => {
  try {
    const naoLidas = await Notificacao.countDocuments({ empresa: req.usuario.empresa, lida: false });
    const temVencida = await Notificacao.countDocuments({ empresa: req.usuario.empresa, tipo: 'licenca_vencida', lida: false });
    const temVencendo = await Notificacao.countDocuments({ empresa: req.usuario.empresa, tipo: 'licenca_vencendo', lida: false });

    // Incluir status da assinatura no resumo
    const assinatura = await Assinatura.findOne({ empresa: req.usuario.empresa });
    const statusAssinatura = assinatura ? {
      status: assinatura.status,
      diasTrialRestantes: assinatura.status === 'trial'
        ? Math.max(0, Math.ceil((new Date(assinatura.trialFim) - new Date()) / (1000 * 60 * 60 * 24)))
        : null,
      diasAtraso: assinatura.status === 'inadimplente'
        ? Math.floor((new Date() - new Date(assinatura.vencimento)) / (1000 * 60 * 60 * 24))
        : null,
      boletoUrl: assinatura.coraBoletoUrl,
      pixCopiaECola: assinatura.coraPixCopiaECola
    } : null;

    res.json({ naoLidas, temVencida, temVencendo, assinatura: statusAssinatura });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.put('/api/notificacoes/:id/ler', authMiddleware, async (req, res) => {
  try {
    await Notificacao.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, { lida: true });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.put('/api/notificacoes/ler-todas', authMiddleware, async (req, res) => {
  try {
    await Notificacao.updateMany({ empresa: req.usuario.empresa, lida: false }, { lida: true });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

app.delete('/api/notificacoes/:id', authMiddleware, async (req, res) => {
  try {
    await Notificacao.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== USUÁRIOS ====================

app.get('/api/usuarios', authMiddleware, async (req, res) => {
  try { const usuarios = await Usuario.find({ empresa: req.usuario.empresa }).select('-senha'); res.json(usuarios); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

// Buscar permissões do usuário logado
app.get('/api/usuarios/minhas-permissoes', authMiddleware, async (req, res) => {
  try {
    const usuario = await Usuario.findById(req.usuario.id).select('permissoes usuarioMestre perfil');
    if (!usuario) return res.status(404).json({ erro: 'Usuário não encontrado' });
    // Admin e mestre têm tudo liberado
    if (usuario.perfil === 'Admin' || usuario.usuarioMestre) {
      const tudo = { acessar: true, editar: true, criar: true, aprovar: true, gerenciar: true };
      return res.json({
        isAdmin: true,
        permissoes: {
          overview: { acessar: true, editar: true },
          ideiasLivres: { acessar: true, criar: true, aprovar: true },
          gestaoMetas: { acessar: true, editar: true },
          gestaoProjetos: { acessar: true, criar: true, editar: true },
          gestaoLicencas: { acessar: true, criar: true, editar: true },
          operacoes: { acessar: true, criar: true, editar: true },
          planoUsuarios: { acessar: true, gerenciar: true },
        }
      });
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
    await Convite.create({ email, empresa: req.usuario.empresa, token, usuarioMestre: usuarioMestre || false, permissoes: permissoes || {} });
    const linkConvite = `${process.env.APP_URL}/aceitar-convite?token=${token}`;
    await enviarEmail(email, 'Você foi convidado para o HOC System', `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
        <h2 style="color:#2d1b69">Você recebeu um convite!</h2>
        <p style="color:#718096">Você foi convidado para colaborar no <strong>HOC System</strong>.</p>
        <a href="${linkConvite}" style="display:inline-block;margin:24px 0;padding:14px 28px;background:#2d1b69;color:white;border-radius:8px;text-decoration:none;font-weight:600">Aceitar Convite</a>
        <p style="color:#a0aec0;font-size:13px">Este link expira em 48 horas.</p>
      </div>`);
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
    await Usuario.create({
      nome, email: convite.email, senha: hash, empresa: convite.empresa._id,
      usuarioMestre: convite.usuarioMestre, perfil: convite.usuarioMestre ? 'Admin' : 'Usuário',
      permissoes: convite.permissoes, status: 'Ativo', emailConfirmado: true
    });
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
    const projeto = await Projeto.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, { ...req.body, atualizadoEm: new Date() }, { new: true });
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
  try {
    const bowler = await Bowler.findOne({ empresa: req.usuario.empresa, ano: req.params.ano });
    res.json(bowler || null);
  } catch (err) { res.status(500).json({ erro: err.message }); }
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
app.put('/api/overview', authMiddleware, verificarAssinatura, permOverview('editar'), async (req, res) => {
  try {
    const overview = await Overview.findOneAndUpdate({ empresa: req.usuario.empresa }, { ...req.body, atualizadoEm: new Date() }, { new: true, upsert: true });
    res.json(overview);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

// ==================== WIKIS ====================

app.get('/api/wikis', authMiddleware, verificarAssinatura, async (req, res) => {
  try { const wikis = await Wiki.find({ empresa: req.usuario.empresa }).sort({ criadoEm: -1 }); res.json(wikis); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/wikis', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    const wiki = await Wiki.create({ ...req.body, empresa: req.usuario.empresa, criadoPor: req.usuario.id });
    await criarNotificacao(req.usuario.empresa, `Novo Wiki: ${wiki.titulo}`, `O wiki foi criado.`, 'info', '📄', '/overview');
    res.status(201).json(wiki);
  } catch (err) { res.status(400).json({ erro: err.message }); }
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
  try {
    const licencas = await Licenca.find({ empresa: req.usuario.empresa }).select('-documentos.base64').sort({ criadoEm: -1 });
    res.json(licencas);
  } catch (err) { res.status(500).json({ erro: err.message }); }
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
  try {
    const fv = await FluxoValor.findOne({ empresa: req.usuario.empresa });
    res.json(fv || { blocos: [], conexoes: [], textos: [] });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});
app.put('/api/fluxo-valor', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    const fv = await FluxoValor.findOneAndUpdate({ empresa: req.usuario.empresa }, { ...req.body, atualizadoEm: new Date() }, { new: true, upsert: true });
    res.json(fv);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});

// ==================== CONTATOS ====================

app.get('/api/contatos', authMiddleware, verificarAssinatura, async (req, res) => {
  try { const contatos = await Contato.find({ empresa: req.usuario.empresa }).sort({ criadoEm: -1 }); res.json(contatos); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/contatos', authMiddleware, verificarAssinatura, permOperacoes('criar'), async (req, res) => {
  try {
    const contato = await Contato.create({ ...req.body, empresa: req.usuario.empresa });
    await criarNotificacao(req.usuario.empresa, `Novo contato: ${contato.nome}`, `O contato foi adicionado.`, 'info', '👤', '/operacoes');
    res.status(201).json(contato);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.put('/api/contatos/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    const contato = await Contato.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, req.body, { new: true });
    if (!contato) return res.status(404).json({ erro: 'Contato não encontrado' });
    res.json(contato);
  } catch (err) { res.status(400).json({ erro: err.message }); }
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
  try {
    const template = await EmailTemplate.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, { ...req.body, atualizadoEm: new Date() }, { new: true });
    if (!template) return res.status(404).json({ erro: 'Template não encontrado' });
    res.json(template);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.delete('/api/email-templates/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try { await EmailTemplate.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa }); res.json({ mensagem: 'Template deletado!' }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== TAREFAS ====================

app.get('/api/tarefas', authMiddleware, verificarAssinatura, async (req, res) => {
  try { const tarefas = await Tarefa.find({ empresa: req.usuario.empresa }).sort({ criadoEm: -1 }); res.json(tarefas); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.get('/api/tarefas/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    const tarefa = await Tarefa.findOne({ _id: req.params.id, empresa: req.usuario.empresa });
    if (!tarefa) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    res.json(tarefa);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/tarefas', authMiddleware, verificarAssinatura, permOperacoes('criar'), async (req, res) => {
  try {
    const tarefa = await Tarefa.create({ ...req.body, empresa: req.usuario.empresa, criadoPor: req.usuario.id });
    await criarNotificacao(req.usuario.empresa, `Nova tarefa: ${tarefa.titulo}`, `A tarefa foi criada.`, 'info', '📋', '/operacoes');
    res.status(201).json(tarefa);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.put('/api/tarefas/:id', authMiddleware, verificarAssinatura, permOperacoes('editar'), async (req, res) => {
  try {
    const anterior = await Tarefa.findById(req.params.id);
    const tarefa = await Tarefa.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, { ...req.body, atualizadoEm: new Date() }, { new: true });
    if (!tarefa) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    if (anterior && anterior.status !== 'Concluída' && tarefa.status === 'Concluída') {
      await criarNotificacao(req.usuario.empresa, `Tarefa concluída: ${tarefa.titulo}`, `A tarefa foi concluída.`, 'sucesso', '✅', '/operacoes');
    }
    res.json(tarefa);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.delete('/api/tarefas/:id', authMiddleware, verificarAssinatura, permOperacoes('editar'), async (req, res) => {
  try { await Tarefa.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa }); res.json({ mensagem: 'Tarefa deletada!' }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/tarefas/:id/enviar-email', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    const tarefa = await Tarefa.findOne({ _id: req.params.id, empresa: req.usuario.empresa });
    if (!tarefa) return res.status(404).json({ erro: 'Tarefa não encontrada' });
    const contato = tarefa.contatoId ? await Contato.findById(tarefa.contatoId) : null;
    const emailTemplate = tarefa.emailTemplateId ? await EmailTemplate.findById(tarefa.emailTemplateId) : null;
    if (!contato || !emailTemplate) return res.status(400).json({ erro: 'Contato ou template não configurado' });
    let corpo = emailTemplate.corpo;
    corpo = corpo.replace(/{cliente}/g, contato.nome).replace(/{empresa}/g, contato.empresa_contato || '').replace(/{data}/g, new Date().toLocaleDateString('pt-BR'));
    await enviarEmail(contato.email, emailTemplate.assunto, `<div style="font-family:sans-serif;padding:24px">${corpo}</div>`);
    await Tarefa.findByIdAndUpdate(tarefa._id, { emailEnviado: true });
    res.json({ mensagem: 'Email enviado!' });
  } catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== PROCESSOS ====================

app.get('/api/processos', authMiddleware, verificarAssinatura, async (req, res) => {
  try { const processos = await Processo.find({ empresa: req.usuario.empresa }).sort({ criadoEm: -1 }); res.json(processos); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/processos', authMiddleware, verificarAssinatura, permOperacoes('criar'), async (req, res) => {
  try {
    const processo = await Processo.create({ ...req.body, empresa: req.usuario.empresa, criadoPor: req.usuario.id });
    await criarNotificacao(req.usuario.empresa, `Novo processo: ${processo.nome}`, `O processo foi criado.`, 'info', '⚙️', '/operacoes');
    res.status(201).json(processo);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.put('/api/processos/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    const processo = await Processo.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, { ...req.body, atualizadoEm: new Date() }, { new: true });
    if (!processo) return res.status(404).json({ erro: 'Processo não encontrado' });
    res.json(processo);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.delete('/api/processos/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try { await Processo.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa }); res.json({ mensagem: 'Processo deletado!' }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== ROBÔS ====================

app.get('/api/robos', authMiddleware, verificarAssinatura, async (req, res) => {
  try { const robos = await Robot.find({ empresa: req.usuario.empresa }).sort({ criadoEm: -1 }); res.json(robos); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/robos', authMiddleware, verificarAssinatura, permOperacoes('criar'), async (req, res) => {
  try {
    const robo = await Robot.create({ ...req.body, empresa: req.usuario.empresa, criadoPor: req.usuario.id });
    await criarNotificacao(req.usuario.empresa, `Novo robô: ${robo.nome}`, `O robô foi cadastrado.`, 'info', '🤖', '/operacoes');
    res.status(201).json(robo);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.put('/api/robos/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    const anterior = await Robot.findById(req.params.id);
    const robo = await Robot.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, { ...req.body, atualizadoEm: new Date() }, { new: true });
    if (!robo) return res.status(404).json({ erro: 'Robô não encontrado' });
    if (anterior && anterior.status !== 'Erro' && robo.status === 'Erro') {
      await criarNotificacao(req.usuario.empresa, `Robô com erro: ${robo.nome}`, `O robô encontrou um erro.`, 'erro', '🔴', '/operacoes');
    }
    res.json(robo);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.delete('/api/robos/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try { await Robot.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa }); res.json({ mensagem: 'Robô deletado!' }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== CREDENCIAIS ====================

app.get('/api/credenciais', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    const creds = await Credencial.find({ empresa: req.usuario.empresa }).select('-valor').sort({ criadoEm: -1 });
    res.json(creds);
  } catch (err) { res.status(500).json({ erro: err.message }); }
});
app.post('/api/credenciais', authMiddleware, verificarAssinatura, async (req, res) => {
  try { const cred = await Credencial.create({ ...req.body, empresa: req.usuario.empresa }); res.status(201).json(cred); }
  catch (err) { res.status(400).json({ erro: err.message }); }
});
app.put('/api/credenciais/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try {
    const cred = await Credencial.findOneAndUpdate({ _id: req.params.id, empresa: req.usuario.empresa }, { ...req.body, atualizadoEm: new Date() }, { new: true });
    if (!cred) return res.status(404).json({ erro: 'Credencial não encontrada' });
    res.json(cred);
  } catch (err) { res.status(400).json({ erro: err.message }); }
});
app.delete('/api/credenciais/:id', authMiddleware, verificarAssinatura, async (req, res) => {
  try { await Credencial.findOneAndDelete({ _id: req.params.id, empresa: req.usuario.empresa }); res.json({ mensagem: 'Credencial deletada!' }); }
  catch (err) { res.status(500).json({ erro: err.message }); }
});

// ==================== SERVIDOR ====================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
