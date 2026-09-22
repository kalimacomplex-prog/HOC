/**
 * Catálogo de steps "servidor" do builder de automação — expansão além do
 * núcleo (control-flow + 15 essenciais) já em automationEngine.js.
 *
 * Cada handler é `async (cfg, ctx) => saída (string)`. `cfg` já não precisa
 * ser re-substituído pelos campos comuns — automationEngine.js chama `sub()`
 * nos campos de texto mais usados antes de despachar aqui, mas handlers que
 * usam campos próprios chamam `sub()` de novo (passado via closure).
 *
 * Convenção pra conteúdo binário (planilha, PDF, imagem, docx, zip, áudio):
 * sempre base64 numa string, nunca caminho de arquivo — isso permite rodar
 * no servidor sem depender de máquina do tenant. Steps que precisam
 * genuinamente do disco do tenant (ler/escrever arquivo por caminho,
 * ffmpeg, stats do SO) continuam no agente (ver hoc_step_executor.py).
 */

const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const tls = require('tls');

const ExcelJS = require('exceljs');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const { PDFParse } = require('pdf-parse');
const yaml = require('js-yaml');
const xml2js = require('xml2js');
const Ajv = require('ajv');
const cheerio = require('cheerio');
const QRCode = require('qrcode');
const jsQR = require('jsqr');
const Jimp = require('jimp');
const speakeasy = require('speakeasy');
const RSSParser = require('rss-parser');
const IORedis = require('ioredis');
const { Pool: PgPool } = require('pg');
const { Document, Packer, Paragraph, TextRun } = require('docx');
const PptxGenJS = require('pptxgenjs');
const { parsePhoneNumberFromString } = require('libphonenumber-js');
const twilioLib = require('twilio');
const { ImapFlow } = require('imapflow');
const Handlebars = require('handlebars');
const { faker } = require('@faker-js/faker');
const alasql = require('alasql');
const JSZip = require('jszip');
const { encode: gptEncode } = require('gpt-tokenizer');
const { createWorker } = require('tesseract.js');
const FormData = require('form-data');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Client: SSHClient } = require('ssh2');

module.exports = function buildStepLibrary({ sub, fetch, Credencial, googleOAuthClientId, googleOAuthClientSecret }) {
  const ajv = new Ajv({ allErrors: true, strict: false });

  // ---- helpers internos ----
  function asBuffer(b64OrText) {
    try { return Buffer.from(b64OrText, 'base64'); } catch { return Buffer.from(String(b64OrText)); }
  }
  function jparse(s, fallback) {
    try { return JSON.parse(s); } catch { return fallback; }
  }

  const lib = {};

  // ==================== Google Drive ====================
  // Duas formas de autenticar, resolvidas pelo mesmo campo (cofre ou digitado
  // no step) — o conteúdo decide qual é usada:
  //  1) Conta de serviço (JSON com client_email/private_key): sem login, mas
  //     SEM cota de armazenamento própria — só funciona pra ler/listar/mover/
  //     renomear/copiar/compartilhar/excluir. Enviar ou atualizar conteúdo de
  //     arquivo falha com HTTP 403 "Service Accounts do not have storage quota".
  //  2) OAuth do usuário (refresh_token, gerado ao clicar "Conectar Google
  //     Drive" em Operações → Credenciais): usa a cota do Google do próprio
  //     usuário — funciona pra tudo, inclusive enviar/atualizar conteúdo.
  async function gdriveResolveCredencialBruta(cfg, ctx, empresa) {
    const digitado = sub(String(cfg.api_key || ''), ctx).trim();
    if (digitado) return digitado;
    const credNome = String(cfg.credencial_nome || '').trim();
    if (!credNome) throw new Error('Informe a credencial do Google (JSON da conta de serviço ou conecte sua conta) ou escolha uma credencial do cofre.');
    if (!Credencial) throw new Error('Cofre de credenciais indisponível.');
    const campo = String(cfg.campo_cred || '').trim() || 'service_account_json';
    const cred = await Credencial.findOne({ nome: credNome, empresa }).lean();
    const valor = cred?.campos?.[campo] || '';
    if (!valor) throw new Error(`Credencial "${credNome}" não encontrada ou sem o campo "${campo}".`);
    return valor;
  }

  async function gdriveTokenViaServiceAccount(sa) {
    if (!sa.client_email || !sa.private_key) throw new Error('JSON da conta de serviço do Google incompleto (faltam client_email/private_key).');
    const agora = Math.floor(Date.now() / 1000);
    const assertion = jwt.sign({
      iss: sa.client_email,
      scope: 'https://www.googleapis.com/auth/drive',
      aud: 'https://oauth2.googleapis.com/token',
      iat: agora, exp: agora + 3600,
    }, sa.private_key, { algorithm: 'RS256' });
    return fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
  }

  async function gdriveTokenViaOAuthRefresh(refreshToken) {
    if (!googleOAuthClientId || !googleOAuthClientSecret) throw new Error('Login do Google não configurado no servidor (faltam as variáveis GOOGLE_OAUTH_CLIENT_ID/SECRET).');
    return fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: refreshToken,
        client_id: googleOAuthClientId, client_secret: googleOAuthClientSecret,
      }).toString(),
    });
  }

  async function gdriveToken(cfg, ctx, empresa) {
    ctx._gdriveTokens ||= {};
    const bruta = await gdriveResolveCredencialBruta(cfg, ctx, empresa);
    const cacheKey = crypto.createHash('sha1').update(bruta).digest('hex');
    const cached = ctx._gdriveTokens[cacheKey];
    if (cached && cached.expiresAt > Date.now() + 30000) return cached.token;

    let sa = null;
    try { sa = JSON.parse(bruta); } catch { /* não é JSON — trata como refresh_token do OAuth */ }
    const ehContaDeServico = sa && typeof sa === 'object' && sa.client_email;

    const r = ehContaDeServico ? await gdriveTokenViaServiceAccount(sa) : await gdriveTokenViaOAuthRefresh(bruta);
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.access_token) throw new Error('Falha ao autenticar no Google Drive: ' + (data.error_description || data.error || `HTTP ${r.status}`));
    ctx._gdriveTokens[cacheKey] = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 3600) * 1000 };
    return data.access_token;
  }

  async function gdriveFetch(cfg, ctx, empresa, path, opts = {}) {
    const token = await gdriveToken(cfg, ctx, empresa);
    const r = await fetch(`https://www.googleapis.com${path}`, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
    if (!r.ok) throw new Error(`Google Drive: HTTP ${r.status} — ${(await r.text()).slice(0, 400)}`);
    return r;
  }

  lib.gdrive_create_folder = async (cfg, ctx, empresa) => {
    const nome = sub(cfg.gdrive_file_name || cfg.value || 'Nova pasta', ctx);
    const pai = sub(cfg.gdrive_parent_id || '', ctx).trim();
    const body = { name: nome, mimeType: 'application/vnd.google-apps.folder' };
    if (pai) body.parents = [pai];
    const r = await gdriveFetch(cfg, ctx, empresa, '/drive/v3/files?fields=id,name,webViewLink', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return await r.text();
  };

  lib.gdrive_upload_file = async (cfg, ctx, empresa) => {
    const nome = sub(cfg.gdrive_file_name || 'arquivo', ctx);
    const pai = sub(cfg.gdrive_parent_id || '', ctx).trim();
    const mime = sub(cfg.gdrive_mime_type || '', ctx).trim() || 'application/octet-stream';
    const conteudo = asBuffer(sub(cfg.file_base64 || '{output}', ctx));
    const metadata = { name: nome };
    if (pai) metadata.parents = [pai];
    const boundary = 'hocdrive' + crypto.randomBytes(8).toString('hex');
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`),
      conteudo,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const r = await gdriveFetch(cfg, ctx, empresa, '/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
      method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
    });
    return await r.text();
  };

  lib.gdrive_update_file_content = async (cfg, ctx, empresa) => {
    const id = sub(cfg.gdrive_file_id || '', ctx).trim();
    if (!id) throw new Error('Informe o ID do arquivo no Google Drive.');
    const mime = sub(cfg.gdrive_mime_type || '', ctx).trim() || 'application/octet-stream';
    const conteudo = asBuffer(sub(cfg.file_base64 || '{output}', ctx));
    const r = await gdriveFetch(cfg, ctx, empresa, `/upload/drive/v3/files/${encodeURIComponent(id)}?uploadType=media&fields=id,name,modifiedTime`, {
      method: 'PATCH', headers: { 'Content-Type': mime }, body: conteudo,
    });
    return await r.text();
  };

  lib.gdrive_download_file = async (cfg, ctx, empresa) => {
    const id = sub(cfg.gdrive_file_id || '', ctx).trim();
    if (!id) throw new Error('Informe o ID do arquivo no Google Drive.');
    const r = await gdriveFetch(cfg, ctx, empresa, `/drive/v3/files/${encodeURIComponent(id)}?alt=media`);
    const buf = await r.buffer();
    return buf.toString('base64');
  };

  lib.gdrive_delete_file = async (cfg, ctx, empresa) => {
    const id = sub(cfg.gdrive_file_id || '', ctx).trim();
    if (!id) throw new Error('Informe o ID do arquivo/pasta no Google Drive.');
    await gdriveFetch(cfg, ctx, empresa, `/drive/v3/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return `Arquivo/pasta "${id}" excluído.`;
  };

  lib.gdrive_list_files = async (cfg, ctx, empresa) => {
    const pai = sub(cfg.gdrive_parent_id || '', ctx).trim();
    const extra = sub(cfg.gdrive_query || '', ctx).trim();
    const partes = ['trashed = false'];
    if (pai) partes.push(`'${pai.replace(/'/g, "\\'")}' in parents`);
    if (extra) partes.push(extra);
    const q = encodeURIComponent(partes.join(' and '));
    const r = await gdriveFetch(cfg, ctx, empresa, `/drive/v3/files?q=${q}&fields=files(id,name,mimeType,size,modifiedTime,parents)&pageSize=200`);
    return await r.text();
  };

  lib.gdrive_rename_file = async (cfg, ctx, empresa) => {
    const id = sub(cfg.gdrive_file_id || '', ctx).trim();
    const nome = sub(cfg.gdrive_file_name || '', ctx);
    if (!id || !nome) throw new Error('Informe o ID do arquivo e o novo nome.');
    const r = await gdriveFetch(cfg, ctx, empresa, `/drive/v3/files/${encodeURIComponent(id)}?fields=id,name`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nome }),
    });
    return await r.text();
  };

  lib.gdrive_move_file = async (cfg, ctx, empresa) => {
    const id = sub(cfg.gdrive_file_id || '', ctx).trim();
    const novoPai = sub(cfg.gdrive_new_parent_id || '', ctx).trim();
    if (!id || !novoPai) throw new Error('Informe o ID do arquivo e a pasta de destino.');
    const infoR = await gdriveFetch(cfg, ctx, empresa, `/drive/v3/files/${encodeURIComponent(id)}?fields=parents`);
    const info = await infoR.json();
    const antigos = (info.parents || []).join(',');
    const r = await gdriveFetch(cfg, ctx, empresa, `/drive/v3/files/${encodeURIComponent(id)}?addParents=${encodeURIComponent(novoPai)}${antigos ? `&removeParents=${encodeURIComponent(antigos)}` : ''}&fields=id,name,parents`, { method: 'PATCH' });
    return await r.text();
  };

  lib.gdrive_copy_file = async (cfg, ctx, empresa) => {
    const id = sub(cfg.gdrive_file_id || '', ctx).trim();
    if (!id) throw new Error('Informe o ID do arquivo a copiar.');
    const nome = sub(cfg.gdrive_file_name || '', ctx).trim();
    const pai = sub(cfg.gdrive_parent_id || '', ctx).trim();
    const body = {};
    if (nome) body.name = nome;
    if (pai) body.parents = [pai];
    const r = await gdriveFetch(cfg, ctx, empresa, `/drive/v3/files/${encodeURIComponent(id)}/copy?fields=id,name,parents`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return await r.text();
  };

  lib.gdrive_share_file = async (cfg, ctx, empresa) => {
    const id = sub(cfg.gdrive_file_id || '', ctx).trim();
    if (!id) throw new Error('Informe o ID do arquivo/pasta a compartilhar.');
    const email = sub(cfg.gdrive_share_email || '', ctx).trim();
    const role = cfg.gdrive_share_role || 'reader';
    const body = email ? { type: 'user', role, emailAddress: email } : { type: 'anyone', role };
    const r = await gdriveFetch(cfg, ctx, empresa, `/drive/v3/files/${encodeURIComponent(id)}/permissions?fields=id`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return await r.text();
  };

  lib.gdrive_file_info = async (cfg, ctx, empresa) => {
    const id = sub(cfg.gdrive_file_id || '', ctx).trim();
    if (!id) throw new Error('Informe o ID do arquivo/pasta.');
    const r = await gdriveFetch(cfg, ctx, empresa, `/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType,size,modifiedTime,parents,webViewLink,webContentLink`);
    return await r.text();
  };

  // ==================== Variáveis / cálculo ====================

  lib.calculate = async (cfg, ctx) => {
    const expr = sub(cfg.expression || '', ctx);
    const bloqueadas = ['require', 'process', 'import', '=>', 'function', '__proto__', 'constructor', '`'];
    if (bloqueadas.some((b) => expr.includes(b))) throw new Error('Expressão contém termos não permitidos');
    const fn = new Function('Math', `"use strict"; return (${expr});`);
    return String(fn(Math));
  };

  // ==================== Data/hora ====================

  lib.date_diff = async (cfg, ctx) => {
    const d1 = new Date(sub(cfg.date_from || cfg.date1 || '', ctx));
    const d2 = new Date(sub(cfg.date_to || cfg.date2 || '', ctx));
    const ms = d2 - d1;
    const unidade = cfg.unit || 'days';
    const div = { seconds: 1000, minutes: 60000, hours: 3600000, days: 86400000 }[unidade] || 86400000;
    return String(Math.round(ms / div));
  };

  lib.date_add = async (cfg, ctx) => {
    const base = new Date(sub(cfg.date || '', ctx) || Date.now());
    const amount = parseFloat(sub(String(cfg.date_amount ?? '0'), ctx)) || 0;
    const unidade = cfg.unit || 'days';
    const div = { seconds: 1000, minutes: 60000, hours: 3600000, days: 86400000 }[unidade] || 86400000;
    return new Date(base.getTime() + amount * div).toISOString();
  };

  lib.timezone_convert = async (cfg, ctx) => {
    const data = new Date(sub(cfg.date || '', ctx) || Date.now());
    const tz = sub(cfg.to_timezone || cfg.timezone || 'America/Sao_Paulo', ctx);
    return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'medium', timeZone: tz }).format(data);
  };

  lib.is_business_day = async (cfg, ctx) => {
    const data = new Date(sub(cfg.date || '', ctx) || Date.now());
    const dia = data.getDay();
    return String(dia !== 0 && dia !== 6);
  };

  lib.format_date = async (cfg, ctx) => {
    const data = new Date(sub(cfg.date || '', ctx) || Date.now());
    const fmt = cfg.format || 'DD/MM/YYYY HH:mm';
    const pad = (n) => String(n).padStart(2, '0');
    return fmt
      .replace('YYYY', data.getFullYear())
      .replace('MM', pad(data.getMonth() + 1))
      .replace('DD', pad(data.getDate()))
      .replace('HH', pad(data.getHours()))
      .replace('mm', pad(data.getMinutes()))
      .replace('ss', pad(data.getSeconds()));
  };

  // ==================== Planilhas / dados (base64 in/out) ====================

  lib.read_excel = async (cfg, ctx) => {
    const buf = asBuffer(sub(cfg.file_base64 || '{output}', ctx));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf);
    const sheet = cfg.sheet_name ? wb.getWorksheet(cfg.sheet_name) : wb.worksheets[0];
    if (!sheet) throw new Error('Planilha não encontrada');
    const rows = [];
    const headers = sheet.getRow(1).values.slice(1).map((v) => String(v ?? ''));
    sheet.eachRow((row, i) => {
      if (i === 1) return;
      const obj = {};
      row.values.slice(1).forEach((v, idx) => { obj[headers[idx] || `col${idx}`] = v; });
      rows.push(obj);
    });
    return JSON.stringify(rows);
  };

  lib.write_excel = async (cfg, ctx) => {
    const dados = jparse(sub(cfg.data_input || '{output}', ctx), []);
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet(cfg.sheet_name || 'Planilha1');
    if (dados.length) {
      sheet.columns = Object.keys(dados[0]).map((k) => ({ header: k, key: k }));
      dados.forEach((row) => sheet.addRow(row));
    }
    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf).toString('base64');
  };

  function parseCsv(text, delim) {
    const linhas = text.split(/\r?\n/).filter((l) => l.length);
    return linhas.map((l) => l.split(delim));
  }
  function stringifyCsv(rows, delim) {
    return rows.map((r) => r.map((c) => (String(c).includes(delim) ? `"${c}"` : c)).join(delim)).join('\n');
  }

  lib.read_csv = async (cfg, ctx) => {
    const texto = asBuffer(sub(cfg.file_base64 || '{output}', ctx)).toString('utf8');
    const delim = cfg.delimiter || ',';
    const linhas = parseCsv(texto, delim);
    const [cab, ...resto] = linhas;
    const rows = resto.map((cols) => Object.fromEntries(cab.map((h, i) => [h, cols[i]])));
    return JSON.stringify(rows);
  };

  lib.write_csv = async (cfg, ctx) => {
    const dados = jparse(sub(cfg.data_input || '{output}', ctx), []);
    const delim = cfg.delimiter || ',';
    if (!dados.length) return '';
    const cab = Object.keys(dados[0]);
    const linhas = [cab, ...dados.map((d) => cab.map((k) => d[k]))];
    return stringifyCsv(linhas, delim);
  };

  lib.write_row = async (cfg, ctx) => {
    const dados = jparse(sub(cfg.data_input || '{output}', ctx), []);
    const novaLinha = jparse(sub(cfg.value || '{}', ctx), {});
    dados.push(novaLinha);
    return JSON.stringify(dados);
  };

  lib.write_cell = async (cfg, ctx) => {
    const dados = jparse(sub(cfg.data_input || '{output}', ctx), []);
    const idx = parseInt(sub(String(cfg.row_index ?? '0'), ctx), 10);
    const chave = sub(cfg.cell_ref || '', ctx);
    if (!dados[idx]) dados[idx] = {};
    dados[idx][chave] = sub(cfg.value || '', ctx);
    return JSON.stringify(dados);
  };

  lib.remove_row = async (cfg, ctx) => {
    const dados = jparse(sub(cfg.data_input || '{output}', ctx), []);
    const idx = parseInt(sub(String(cfg.row_index ?? '0'), ctx), 10);
    dados.splice(idx, 1);
    return JSON.stringify(dados);
  };

  lib.remove_cell = async (cfg, ctx) => {
    const dados = jparse(sub(cfg.data_input || '{output}', ctx), []);
    const idx = parseInt(sub(String(cfg.row_index ?? '0'), ctx), 10);
    const chave = sub(cfg.cell_ref || '', ctx);
    if (dados[idx]) delete dados[idx][chave];
    return JSON.stringify(dados);
  };

  lib.filter_data = async (cfg, ctx) => {
    const dados = jparse(sub(cfg.data_input || '{output}', ctx), []);
    const chave = sub(cfg.cell_ref || cfg.sort_key || '', ctx);
    const valor = sub(cfg.value || cfg.condition_value || '', ctx);
    const op = cfg.operator || 'equals';
    const filtrado = dados.filter((row) => {
      const v = String(row[chave] ?? '');
      if (op === 'not_equals') return v !== valor;
      if (op === 'contains') return v.includes(valor);
      if (op === 'greater_than') return parseFloat(v) > parseFloat(valor);
      if (op === 'less_than') return parseFloat(v) < parseFloat(valor);
      return v === valor;
    });
    return JSON.stringify(filtrado);
  };

  lib.merge_data = async (cfg, ctx) => {
    const a = jparse(sub(cfg.data_input || '{output}', ctx), []);
    const b = jparse(sub(cfg.data_input2 || '[]', ctx), []);
    const chave = sub(cfg.merge_key || '', ctx);
    const mapB = new Map(b.map((r) => [String(r[chave]), r]));
    const resultado = a.map((r) => ({ ...r, ...(mapB.get(String(r[chave])) || {}) }));
    return JSON.stringify(resultado);
  };

  lib.dedupe_data = async (cfg, ctx) => {
    const dados = jparse(sub(cfg.data_input || '{output}', ctx), []);
    const chave = sub(cfg.merge_key || cfg.cell_ref || '', ctx);
    const vistos = new Set();
    const out = dados.filter((r) => {
      const k = chave ? String(r[chave]) : JSON.stringify(r);
      if (vistos.has(k)) return false;
      vistos.add(k);
      return true;
    });
    return JSON.stringify(out);
  };

  lib.sort_group_data = async (cfg, ctx) => {
    const dados = jparse(sub(cfg.data_input || '{output}', ctx), []);
    const chave = sub(cfg.sort_key || '', ctx);
    const ordenado = [...dados].sort((a, b) => (a[chave] > b[chave] ? 1 : a[chave] < b[chave] ? -1 : 0));
    return JSON.stringify(ordenado);
  };

  lib.sql_on_data = async (cfg, ctx) => {
    const dados = jparse(sub(cfg.data_input || '{output}', ctx), []);
    const query = sub(cfg.sql_query || 'SELECT * FROM ?', ctx);
    const resultado = alasql(query, [dados]);
    return JSON.stringify(resultado);
  };

  lib.generate_fake_data = async (cfg, ctx) => {
    const tipo = cfg.fake_type || 'name';
    const qtd = Math.max(1, parseInt(cfg.fake_count, 10) || 1);
    const geradores = {
      name: () => faker.person.fullName(),
      email: () => faker.internet.email(),
      phone: () => faker.phone.number(),
      address: () => faker.location.streetAddress(),
      company: () => faker.company.name(),
      cpf: () => faker.string.numeric(11),
      uuid: () => faker.string.uuid(),
      number: () => faker.number.int({ min: 1, max: 10000 }),
      date: () => faker.date.recent().toISOString(),
    };
    const gerar = geradores[tipo] || geradores.name;
    const out = Array.from({ length: qtd }, gerar);
    return qtd === 1 ? String(out[0]) : JSON.stringify(out);
  };

  // ==================== PDF (base64 in/out) ====================

  lib.pdf_extract_text = async (cfg, ctx) => {
    const buf = asBuffer(sub(cfg.file_base64 || '{output}', ctx));
    const parser = new PDFParse({ data: buf });
    try { return (await parser.getText()).text; }
    finally { await parser.destroy(); }
  };

  lib.pdf_extract_tables = async (cfg, ctx) => {
    const buf = asBuffer(sub(cfg.file_base64 || '{output}', ctx));
    const parser = new PDFParse({ data: buf });
    try {
      const resultado = await parser.getTable();
      const tabelas = resultado.pages.flatMap((p) => p.tables || []);
      return JSON.stringify(tabelas.length === 1 ? tabelas[0] : tabelas);
    } finally { await parser.destroy(); }
  };

  lib.pdf_merge = async (cfg, ctx) => {
    const arquivos = jparse(sub(cfg.data_input || '[]', ctx), []);
    const out = await PDFDocument.create();
    for (const b64 of arquivos) {
      const src = await PDFDocument.load(asBuffer(b64));
      const paginas = await out.copyPages(src, src.getPageIndices());
      paginas.forEach((p) => out.addPage(p));
    }
    return Buffer.from(await out.save()).toString('base64');
  };

  lib.pdf_split = async (cfg, ctx) => {
    const buf = asBuffer(sub(cfg.file_base64 || '{output}', ctx));
    const src = await PDFDocument.load(buf);
    const paginas = [];
    for (let i = 0; i < src.getPageCount(); i++) {
      const novo = await PDFDocument.create();
      const [p] = await novo.copyPages(src, [i]);
      novo.addPage(p);
      paginas.push(Buffer.from(await novo.save()).toString('base64'));
    }
    return JSON.stringify(paginas);
  };

  lib.pdf_generate = async (cfg, ctx) => {
    const texto = sub(cfg.content || '', ctx);
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    let page = doc.addPage();
    const { height } = page.getSize();
    let y = height - 50;
    for (const linha of texto.split('\n')) {
      if (y < 50) { page = doc.addPage(); y = height - 50; }
      page.drawText(linha.slice(0, 100), { x: 50, y, size: 11, font });
      y -= 16;
    }
    return Buffer.from(await doc.save()).toString('base64');
  };

  lib.pdf_fill_form = async (cfg, ctx) => {
    const buf = asBuffer(sub(cfg.file_base64 || '{output}', ctx));
    const campos = jparse(sub(cfg.data_input || '{}', ctx), {});
    const doc = await PDFDocument.load(buf);
    const form = doc.getForm();
    for (const [k, v] of Object.entries(campos)) {
      try { form.getTextField(k).setText(String(v)); } catch { /* campo não existe, ignora */ }
    }
    form.flatten();
    return Buffer.from(await doc.save()).toString('base64');
  };

  // ==================== ETL / formatos ====================

  lib.validate_json_schema = async (cfg, ctx) => {
    const dados = jparse(sub(cfg.data_input || '{output}', ctx), null);
    const schema = jparse(sub(cfg.schema_input || '{}', ctx), {});
    const validate = ajv.compile(schema);
    const ok = validate(dados);
    return JSON.stringify({ valido: ok, erros: validate.errors || [] });
  };

  lib.convert_data_format = async (cfg, ctx) => {
    const de = cfg.format_from || 'json';
    const para = cfg.format_to || 'yaml';
    const entrada = sub(cfg.data_input || '{output}', ctx);
    let obj;
    if (de === 'json') obj = jparse(entrada, {});
    else if (de === 'yaml') obj = yaml.load(entrada);
    else if (de === 'xml') obj = await xml2js.parseStringPromise(entrada);
    else if (de === 'csv') { const [cab, ...r] = parseCsv(entrada, ','); obj = r.map((c) => Object.fromEntries(cab.map((h, i) => [h, c[i]]))); }
    else obj = entrada;

    if (para === 'json') return JSON.stringify(obj, null, 2);
    if (para === 'yaml') return yaml.dump(obj);
    if (para === 'xml') return new xml2js.Builder().buildObject(obj);
    if (para === 'csv') return stringifyCsv([Object.keys(obj[0] || {}), ...(obj || []).map((r) => Object.values(r))], ',');
    return String(obj);
  };

  lib.html_extract = async (cfg, ctx) => {
    const html = sub(cfg.data_input || cfg.body || '{output}', ctx);
    const $ = cheerio.load(html);
    const seletor = sub(cfg.css_selector || 'body', ctx);
    const els = $(seletor).map((_, el) => $(el).text().trim()).get();
    return els.length === 1 ? els[0] : JSON.stringify(els);
  };

  // ==================== Validação BR ====================

  function validarCPF(cpf) {
    cpf = cpf.replace(/\D/g, '');
    if (cpf.length !== 11 || /^(\d)\1+$/.test(cpf)) return false;
    let soma = 0;
    for (let i = 0; i < 9; i++) soma += parseInt(cpf[i]) * (10 - i);
    let dv1 = (soma * 10) % 11; if (dv1 === 10) dv1 = 0;
    if (dv1 !== parseInt(cpf[9])) return false;
    soma = 0;
    for (let i = 0; i < 10; i++) soma += parseInt(cpf[i]) * (11 - i);
    let dv2 = (soma * 10) % 11; if (dv2 === 10) dv2 = 0;
    return dv2 === parseInt(cpf[10]);
  }
  function validarCNPJ(cnpj) {
    cnpj = cnpj.replace(/\D/g, '');
    if (cnpj.length !== 14 || /^(\d)\1+$/.test(cnpj)) return false;
    const calc = (base) => {
      const pesos = base.length === 12 ? [5,4,3,2,9,8,7,6,5,4,3,2] : [6,5,4,3,2,9,8,7,6,5,4,3,2];
      const soma = base.split('').reduce((s, d, i) => s + parseInt(d) * pesos[i], 0);
      const r = soma % 11;
      return r < 2 ? 0 : 11 - r;
    };
    const dv1 = calc(cnpj.slice(0, 12));
    const dv2 = calc(cnpj.slice(0, 12) + dv1);
    return cnpj.slice(12) === `${dv1}${dv2}`;
  }

  lib.validate_cpf_cnpj = async (cfg, ctx) => {
    const valor = sub(cfg.value || '{output}', ctx).replace(/\D/g, '');
    const valido = valor.length === 11 ? validarCPF(valor) : valor.length === 14 ? validarCNPJ(valor) : false;
    return String(valido);
  };

  lib.validate_email = async (cfg, ctx) => {
    const valor = sub(cfg.value || '{output}', ctx);
    return String(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(valor));
  };

  lib.validate_phone = async (cfg, ctx) => {
    const valor = sub(cfg.value || '{output}', ctx);
    const pn = parsePhoneNumberFromString(valor, 'BR');
    return String(!!pn && pn.isValid());
  };

  lib.lookup_cep = async (cfg, ctx) => {
    const cep = sub(cfg.value || '{output}', ctx).replace(/\D/g, '');
    const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
    return JSON.stringify(await r.json());
  };

  lib.format_currency = async (cfg, ctx) => {
    const valor = parseFloat(sub(String(cfg.value ?? '{output}'), ctx)) || 0;
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: cfg.currency || 'BRL' }).format(valor);
  };

  // ==================== Segurança / cripto ====================

  function chaveDe(segredo) { return crypto.createHash('sha256').update(String(segredo)).digest(); }

  lib.encrypt_text = async (cfg, ctx) => {
    const texto = sub(cfg.value || '{output}', ctx);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', chaveDe(cfg.secret_key || ''), iv);
    const enc = Buffer.concat([cipher.update(texto, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, enc]).toString('base64');
  };

  lib.decrypt_text = async (cfg, ctx) => {
    const buf = Buffer.from(sub(cfg.value || '{output}', ctx), 'base64');
    const iv = buf.subarray(0, 16);
    const dados = buf.subarray(16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', chaveDe(cfg.secret_key || ''), iv);
    return Buffer.concat([decipher.update(dados), decipher.final()]).toString('utf8');
  };

  lib.generate_jwt = async (cfg, ctx) => {
    const payload = jparse(sub(cfg.data_input || '{}', ctx), {});
    return jwt.sign(payload, cfg.secret_key || '', { expiresIn: cfg.expires_in || '1h' });
  };

  lib.verify_jwt = async (cfg, ctx) => {
    const token = sub(cfg.value || '{output}', ctx);
    try { return JSON.stringify(jwt.verify(token, cfg.secret_key || '')); }
    catch (e) { return JSON.stringify({ valido: false, erro: e.message }); }
  };

  lib.hash_password = async (cfg, ctx) => {
    return bcrypt.hash(sub(cfg.value || '{output}', ctx), 10);
  };

  lib.verify_password = async (cfg, ctx) => {
    const senha = sub(cfg.value || '', ctx);
    const hash = sub(cfg.password_hash || cfg.hash || '{output}', ctx);
    return String(await bcrypt.compare(senha, hash));
  };

  lib.generate_otp = async (cfg, ctx) => {
    return speakeasy.totp({ secret: cfg.secret_key || '', encoding: 'base32' });
  };

  lib.verify_otp = async (cfg, ctx) => {
    const token = sub(cfg.value || '{output}', ctx);
    return String(speakeasy.totp.verify({ secret: cfg.secret_key || '', encoding: 'base32', token, window: 1 }));
  };

  lib.generate_secure_password = async (cfg) => {
    const tam = Math.max(8, parseInt(cfg.password_length, 10) || 16);
    return crypto.randomBytes(tam).toString('base64').slice(0, tam);
  };

  lib.check_ssl_cert = async (cfg, ctx) => {
    const host = sub(cfg.url || cfg.target || '', ctx).replace(/^https?:\/\//, '').split('/')[0];
    return new Promise((resolve, reject) => {
      const socket = tls.connect(443, host, { servername: host, timeout: 8000 }, () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        resolve(JSON.stringify({ subject: cert.subject, issuer: cert.issuer, validTo: cert.valid_to }));
      });
      socket.on('error', reject);
      socket.on('timeout', () => { socket.destroy(); reject(new Error('Timeout na conexão TLS')); });
    });
  };

  lib.hmac_sign = async (cfg, ctx) => {
    const texto = sub(cfg.value || '{output}', ctx);
    return crypto.createHmac('sha256', cfg.secret_key || '').update(texto).digest('hex');
  };

  // ==================== Comunicação ====================

  lib.send_telegram = async (cfg, ctx) => {
    const token = cfg.api_key || '';
    const chatId = sub(cfg.to || '', ctx);
    const texto = sub(cfg.email_body || cfg.value || '{output}', ctx);
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: texto }),
    });
    if (!r.ok) throw new Error('Falha ao enviar Telegram: ' + (await r.text()));
    return 'Telegram enviado.';
  };

  lib.send_slack = async (cfg, ctx) => {
    const texto = sub(cfg.email_body || cfg.value || '{output}', ctx);
    const r = await fetch(sub(cfg.url || cfg.webhook_url || '', ctx), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: texto }),
    });
    if (!r.ok) throw new Error('Falha ao enviar Slack: ' + (await r.text()));
    return 'Slack enviado.';
  };

  lib.send_discord = async (cfg, ctx) => {
    const texto = sub(cfg.email_body || cfg.value || '{output}', ctx);
    const r = await fetch(sub(cfg.url || cfg.webhook_url || '', ctx), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: texto }),
    });
    if (!r.ok) throw new Error('Falha ao enviar Discord: ' + (await r.text()));
    return 'Discord enviado.';
  };

  function twilioClient(cfg) { return twilioLib(cfg.api_key || '', cfg.api_secret || ''); }

  lib.send_sms = async (cfg, ctx) => {
    const client = twilioClient(cfg);
    const msg = await client.messages.create({
      from: cfg.from_number || '', to: sub(cfg.to || '', ctx), body: sub(cfg.email_body || cfg.value || '{output}', ctx),
    });
    return msg.sid;
  };

  lib.send_whatsapp = async (cfg, ctx) => {
    const client = twilioClient(cfg);
    const msg = await client.messages.create({
      from: `whatsapp:${cfg.from_number || ''}`, to: `whatsapp:${sub(cfg.to || '', ctx)}`,
      body: sub(cfg.email_body || cfg.value || '{output}', ctx),
    });
    return msg.sid;
  };

  lib.read_email_imap = async (cfg, ctx) => {
    const client = new ImapFlow({
      host: cfg.host || '', port: parseInt(cfg.port, 10) || 993, secure: true,
      auth: { user: cfg.api_key || '', pass: cfg.secret_key || '' }, logger: false,
    });
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    const mensagens = [];
    try {
      for await (const msg of client.fetch({ seen: false }, { envelope: true }, { uid: true })) {
        mensagens.push({ subject: msg.envelope?.subject, from: msg.envelope?.from?.[0]?.address, date: msg.envelope?.date });
        if (mensagens.length >= (parseInt(cfg.max_iterations, 10) || 10)) break;
      }
    } finally { lock.release(); await client.logout(); }
    return JSON.stringify(mensagens);
  };

  lib.send_push_notification = async (cfg, ctx) => {
    const r = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${cfg.api_key || ''}` },
      body: JSON.stringify({ app_id: cfg.api_secret || '', contents: { en: sub(cfg.email_body || '{output}', ctx) }, include_external_user_ids: [sub(cfg.to || '', ctx)] }),
    });
    if (!r.ok) throw new Error('Falha no push: ' + (await r.text()));
    return 'Push enviado.';
  };

  lib.create_incident = async (cfg, ctx) => {
    const r = await fetch('https://events.pagerduty.com/v2/enqueue', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ routing_key: cfg.api_key || '', event_action: 'trigger', payload: { summary: sub(cfg.email_body || cfg.subject || '{output}', ctx), source: 'HOC', severity: 'error' } }),
    });
    if (!r.ok) throw new Error('Falha ao criar incidente: ' + (await r.text()));
    return 'Incidente criado.';
  };

  // ==================== Pagamentos / financeiro ====================

  lib.asaas_create_charge = async (cfg, ctx) => {
    const r = await fetch('https://api.asaas.com/v3/payments', {
      method: 'POST', headers: { 'Content-Type': 'application/json', access_token: cfg.api_key || '' },
      body: sub(cfg.data_input || '{}', ctx),
    });
    return await r.text();
  };

  lib.asaas_check_payment = async (cfg, ctx) => {
    const id = sub(cfg.value || '{output}', ctx);
    const r = await fetch(`https://api.asaas.com/v3/payments/${id}`, { headers: { access_token: cfg.api_key || '' } });
    return await r.text();
  };

  // EMV QR "Pix Copia e Cola" — mesmo formato hand-rolled do HAC (TLV + CRC16).
  function pixTlv(id, valor) { const len = String(valor.length).padStart(2, '0'); return `${id}${len}${valor}`; }
  function pixCrc16(payload) {
    let crc = 0xFFFF;
    for (const c of payload) {
      crc ^= c.charCodeAt(0) << 8;
      for (let i = 0; i < 8; i++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
  }

  lib.generate_pix_qr = async (cfg, ctx) => {
    const chave = sub(cfg.value || cfg.pix_key || '', ctx);
    const nome = (cfg.merchant_name || 'HOC').slice(0, 25);
    const cidade = (cfg.merchant_city || 'SAO PAULO').slice(0, 15);
    const valor = sub(String(cfg.amount ?? ''), ctx);
    const gui = pixTlv('00', 'br.gov.bcb.pix');
    const chaveTlv = pixTlv('01', chave);
    const merchantAccount = pixTlv('26', gui + chaveTlv);
    let payload = pixTlv('00', '01') + merchantAccount + pixTlv('52', '0000') + pixTlv('53', '986');
    if (valor) payload += pixTlv('54', parseFloat(valor).toFixed(2));
    payload += pixTlv('58', 'BR') + pixTlv('59', nome) + pixTlv('60', cidade) + pixTlv('62', pixTlv('05', '***'));
    payload += '6304';
    const crc = pixCrc16(payload);
    const copiaECola = payload + crc;
    const qrBase64 = (await QRCode.toDataURL(copiaECola)).split(',')[1];
    return JSON.stringify({ copiaECola, qrBase64 });
  };

  lib.get_currency_rate = async (cfg, ctx) => {
    const par = sub(cfg.value || 'USD-BRL', ctx);
    const r = await fetch(`https://economia.awesomeapi.com.br/json/last/${par}`);
    return await r.text();
  };

  lib.get_crypto_price = async (cfg, ctx) => {
    const moeda = sub(cfg.value || 'bitcoin', ctx);
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${moeda}&vs_currencies=usd,brl`);
    return await r.text();
  };

  // ==================== APIs externas ====================

  lib.get_weather = async (cfg, ctx) => {
    const cidade = sub(cfg.value || '', ctx);
    const r = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(cidade)}&appid=${cfg.api_key || ''}&units=metric&lang=pt_br`);
    return await r.text();
  };

  lib.geocode_address = async (cfg, ctx) => {
    const endereco = sub(cfg.value || '', ctx);
    const r = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(endereco)}&format=json&limit=1`, { headers: { 'User-Agent': 'HOC-Automation' } });
    return await r.text();
  };

  lib.calculate_distance = async (cfg, ctx) => {
    const [lat1, lon1] = String(sub(cfg.coord_from || '', ctx)).split(',').map(Number);
    const [lat2, lon2] = String(sub(cfg.coord_to || '', ctx)).split(',').map(Number);
    const R = 6371;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return String(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
  };

  lib.shorten_url = async (cfg, ctx) => {
    const url = sub(cfg.url || cfg.value || '{output}', ctx);
    const r = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`);
    return await r.text();
  };

  lib.lookup_cnpj = async (cfg, ctx) => {
    const cnpj = sub(cfg.value || '{output}', ctx).replace(/\D/g, '');
    const r = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${cnpj}`);
    return await r.text();
  };

  lib.get_holidays = async (cfg, ctx) => {
    const ano = sub(cfg.value || String(new Date().getFullYear()), ctx);
    const r = await fetch(`https://brasilapi.com.br/api/feriados/v1/${ano}`);
    return await r.text();
  };

  lib.translate_text = async (cfg, ctx) => {
    const texto = sub(cfg.value || '{output}', ctx);
    const r = await fetch('https://api-free.deepl.com/v2/translate', {
      method: 'POST', headers: { Authorization: `DeepL-Auth-Key ${cfg.api_key || ''}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `text=${encodeURIComponent(texto)}&target_lang=${cfg.target_lang || 'EN'}`,
    });
    const d = await r.json();
    return d.translations?.[0]?.text || '';
  };

  // ==================== Web / scraping ====================

  lib.download_file = async (cfg, ctx) => {
    const url = sub(cfg.url || '{output}', ctx);
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Falha ao baixar (HTTP ${r.status})`);
    const buf = await r.buffer();
    return buf.toString('base64');
  };

  lib.upload_file = async (cfg, ctx) => {
    const url = sub(cfg.url || '', ctx);
    const conteudo = asBuffer(sub(cfg.file_base64 || cfg.data_input || '{output}', ctx));
    const r = await fetch(url, { method: 'POST', body: conteudo });
    return await r.text();
  };

  lib.scrape_html_table = async (cfg, ctx) => {
    const html = sub(cfg.data_input || cfg.body || '{output}', ctx);
    const $ = cheerio.load(html);
    const tabelas = [];
    $(sub(cfg.css_selector || 'table', ctx)).each((_, table) => {
      const linhas = [];
      $(table).find('tr').each((_, tr) => {
        linhas.push($(tr).find('td,th').map((_, td) => $(td).text().trim()).get());
      });
      tabelas.push(linhas);
    });
    return JSON.stringify(tabelas.length === 1 ? tabelas[0] : tabelas);
  };

  lib.read_rss_feed = async (cfg, ctx) => {
    const parser = new RSSParser();
    const feed = await parser.parseURL(sub(cfg.url || '', ctx));
    return JSON.stringify(feed.items.slice(0, parseInt(cfg.max_iterations, 10) || 20).map((i) => ({ title: i.title, link: i.link, date: i.pubDate })));
  };

  // ==================== Texto / NLP ====================

  lib.detect_language = async (cfg, ctx) => {
    const texto = sub(cfg.value || '{output}', ctx).toLowerCase();
    const marcadores = {
      pt: [' de ', ' que ', ' não ', ' com ', ' para ', 'ção'],
      en: [' the ', ' and ', ' is ', ' of ', ' to ', ' you '],
      es: [' que ', ' de ', ' el ', ' la ', ' no ', ' con '],
    };
    let melhor = 'pt', pontos = -1;
    for (const [lang, termos] of Object.entries(marcadores)) {
      const score = termos.reduce((s, t) => s + (texto.includes(t) ? 1 : 0), 0);
      if (score > pontos) { pontos = score; melhor = lang; }
    }
    return melhor;
  };

  lib.count_tokens = async (cfg, ctx) => {
    const texto = sub(cfg.value || '{output}', ctx);
    return String(gptEncode(texto).length);
  };

  lib.compare_texts = async (cfg, ctx) => {
    const a = sub(cfg.data_input || '', ctx);
    const b = sub(cfg.data_input2 || '{output}', ctx);
    const maior = Math.max(a.length, b.length) || 1;
    let iguais = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] === b[i]) iguais++;
    return String(iguais / maior);
  };

  // ==================== IA extra (OpenAI direto) ====================

  lib.generate_embedding = async (cfg, ctx) => {
    const texto = sub(cfg.value || '{output}', ctx);
    const r = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST', headers: { Authorization: `Bearer ${cfg.api_key || ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: texto }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || 'Erro OpenAI embeddings');
    return JSON.stringify(d.data?.[0]?.embedding || []);
  };

  lib.semantic_search = async (cfg, ctx) => {
    const query = jparse(sub(cfg.value || '[]', ctx), []);
    const candidatos = jparse(sub(cfg.data_input || '[]', ctx), []);
    const cos = (a, b) => {
      const dot = a.reduce((s, v, i) => s + v * (b[i] || 0), 0);
      const na = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
      const nb = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
      return dot / (na * nb || 1);
    };
    const ranked = candidatos.map((c, i) => ({ i, score: cos(query, c.embedding || c) })).sort((a, b) => b.score - a.score);
    return JSON.stringify(ranked);
  };

  lib.moderate_content = async (cfg, ctx) => {
    const texto = sub(cfg.value || '{output}', ctx);
    const r = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST', headers: { Authorization: `Bearer ${cfg.api_key || ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: texto }),
    });
    return await r.text();
  };

  lib.generate_ai_image = async (cfg, ctx) => {
    const prompt = sub(cfg.value || cfg.input_template || '{output}', ctx);
    const r = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST', headers: { Authorization: `Bearer ${cfg.api_key || ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'dall-e-3', prompt, n: 1, size: '1024x1024', response_format: 'b64_json' }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || 'Erro DALL-E');
    return d.data?.[0]?.b64_json || '';
  };

  lib.transcribe_audio = async (cfg, ctx) => {
    const audioBuf = asBuffer(sub(cfg.file_base64 || '{output}', ctx));
    const form = new FormData();
    form.append('file', audioBuf, 'audio.mp3');
    form.append('model', 'whisper-1');
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${cfg.api_key || ''}`, ...form.getHeaders() }, body: form,
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || 'Erro Whisper');
    return d.text || '';
  };

  lib.text_to_speech = async (cfg, ctx) => {
    const texto = sub(cfg.value || '{output}', ctx);
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST', headers: { Authorization: `Bearer ${cfg.api_key || ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'tts-1', voice: cfg.provedor || 'alloy', input: texto }),
    });
    if (!r.ok) throw new Error('Erro TTS: ' + (await r.text()));
    const buf = await r.buffer();
    return buf.toString('base64');
  };

  // ==================== Sistema / rede ====================

  lib.check_port_open = async (cfg, ctx) => {
    const host = sub(cfg.target || cfg.url || '', ctx);
    const porta = parseInt(sub(String(cfg.value ?? '80'), ctx), 10);
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(4000);
      socket.on('connect', () => { socket.destroy(); resolve('true'); });
      socket.on('error', () => resolve('false'));
      socket.on('timeout', () => { socket.destroy(); resolve('false'); });
      socket.connect(porta, host);
    });
  };

  lib.dns_lookup = async (cfg, ctx) => {
    const host = sub(cfg.target || cfg.url || cfg.value || '', ctx);
    const enderecos = await dns.resolve4(host).catch(() => []);
    return JSON.stringify(enderecos);
  };

  lib.whois_lookup = async (cfg, ctx) => {
    const dominio = sub(cfg.value || '', ctx);
    return new Promise((resolve, reject) => {
      const socket = net.connect(43, 'whois.iana.org', () => socket.write(dominio + '\r\n'));
      let dados = '';
      socket.on('data', (d) => { dados += d.toString(); });
      socket.on('end', () => resolve(dados));
      socket.on('error', reject);
      socket.setTimeout(8000, () => { socket.destroy(); reject(new Error('Timeout no whois')); });
    });
  };

  lib.ssh_execute = async (cfg, ctx) => {
    return new Promise((resolve, reject) => {
      const conn = new SSHClient();
      conn.on('ready', () => {
        conn.exec(sub(cfg.command || '', ctx), (err, stream) => {
          if (err) { conn.end(); return reject(err); }
          let out = '', errOut = '';
          stream.on('data', (d) => { out += d; });
          stream.stderr.on('data', (d) => { errOut += d; });
          stream.on('close', (code) => {
            conn.end();
            if (code !== 0) reject(new Error(errOut || `SSH exit ${code}`));
            else resolve(out);
          });
        });
      }).on('error', reject).connect({
        host: sub(cfg.target || cfg.url || '', ctx), port: parseInt(cfg.port, 10) || 22,
        username: cfg.api_key || '', password: cfg.secret_key || '', readyTimeout: 10000,
      });
    });
  };

  lib.read_env_var = async (cfg, ctx) => {
    const nome = sub(cfg.value || '', ctx);
    return process.env[nome] || '';
  };

  lib.check_url_uptime = async (cfg, ctx) => {
    const url = sub(cfg.url || cfg.value || '', ctx);
    const inicio = Date.now();
    try {
      const r = await fetch(url, { method: 'GET' });
      return JSON.stringify({ online: r.ok, status: r.status, ms: Date.now() - inicio });
    } catch (e) {
      return JSON.stringify({ online: false, erro: e.message, ms: Date.now() - inicio });
    }
  };

  // ==================== DB / fila ====================

  function redisClient(cfg) { return new IORedis(cfg.url || cfg.api_key || process.env.REDIS_URL || ''); }

  lib.redis_get = async (cfg, ctx) => {
    const r = redisClient(cfg);
    try { return (await r.get(sub(cfg.value || '', ctx))) || ''; } finally { r.disconnect(); }
  };
  lib.redis_set = async (cfg, ctx) => {
    const r = redisClient(cfg);
    try { await r.set(sub(cfg.cell_ref || cfg.value || '', ctx), sub(cfg.content || '{output}', ctx)); return 'ok'; } finally { r.disconnect(); }
  };
  lib.queue_push = async (cfg, ctx) => {
    const r = redisClient(cfg);
    try { await r.rpush(sub(cfg.value || 'fila', ctx), sub(cfg.content || '{output}', ctx)); return 'ok'; } finally { r.disconnect(); }
  };
  lib.queue_pop = async (cfg, ctx) => {
    const r = redisClient(cfg);
    try { return (await r.lpop(sub(cfg.value || 'fila', ctx))) || ''; } finally { r.disconnect(); }
  };

  lib.sql_query_external = async (cfg, ctx) => {
    const pool = new PgPool({ connectionString: cfg.api_key || cfg.secret_key || '' });
    try {
      const res = await pool.query(sub(cfg.sql_query || '', ctx));
      return JSON.stringify(res.rows);
    } finally { await pool.end(); }
  };

  // ==================== Templates / documentos ====================

  lib.render_template = async (cfg, ctx) => {
    const template = Handlebars.compile(cfg.content || '');
    return template({ ...ctx.vars, input: ctx.input, output: ctx.output });
  };

  lib.generate_word_doc = async (cfg, ctx) => {
    const texto = sub(cfg.content || '', ctx);
    const doc = new Document({ sections: [{ children: texto.split('\n').map((l) => new Paragraph({ children: [new TextRun(l)] })) }] });
    const buf = await Packer.toBuffer(doc);
    return buf.toString('base64');
  };

  lib.generate_pptx = async (cfg, ctx) => {
    const texto = sub(cfg.content || '', ctx);
    const pptx = new PptxGenJS();
    for (const bloco of texto.split('\n\n')) {
      const slide = pptx.addSlide();
      slide.addText(bloco, { x: 0.5, y: 0.5, w: '90%', h: '80%', fontSize: 18 });
    }
    const buf = await pptx.write({ outputType: 'nodebuffer' });
    return Buffer.from(buf).toString('base64');
  };

  // ==================== Imagens ====================

  async function loadImage(cfg, ctx) {
    const buf = asBuffer(sub(cfg.file_base64 || '{output}', ctx));
    return Jimp.read(buf);
  }

  lib.resize_image = async (cfg, ctx) => {
    const img = await loadImage(cfg, ctx);
    img.resize(parseInt(cfg.width, 10) || Jimp.AUTO, parseInt(cfg.height, 10) || Jimp.AUTO);
    return (await img.getBufferAsync(Jimp.MIME_PNG)).toString('base64');
  };

  lib.convert_image_format = async (cfg, ctx) => {
    const img = await loadImage(cfg, ctx);
    const mime = { jpg: Jimp.MIME_JPEG, jpeg: Jimp.MIME_JPEG, png: Jimp.MIME_PNG, bmp: Jimp.MIME_BMP }[(cfg.format_to || 'png').toLowerCase()] || Jimp.MIME_PNG;
    return (await img.getBufferAsync(mime)).toString('base64');
  };

  lib.add_watermark = async (cfg, ctx) => {
    const img = await loadImage(cfg, ctx);
    const font = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
    img.print(font, 10, img.getHeight() - 40, sub(cfg.value || 'HOC', ctx));
    return (await img.getBufferAsync(Jimp.MIME_PNG)).toString('base64');
  };

  lib.generate_thumbnail = async (cfg, ctx) => {
    const img = await loadImage(cfg, ctx);
    img.cover(parseInt(cfg.width, 10) || 150, parseInt(cfg.height, 10) || 150);
    return (await img.getBufferAsync(Jimp.MIME_PNG)).toString('base64');
  };

  lib.generate_qrcode = async (cfg, ctx) => {
    const texto = sub(cfg.value || '{output}', ctx);
    return (await QRCode.toDataURL(texto)).split(',')[1];
  };

  lib.read_qrcode = async (cfg, ctx) => {
    const img = await loadImage(cfg, ctx);
    const { data, width, height } = img.bitmap;
    const resultado = jsQR(new Uint8ClampedArray(data), width, height);
    if (!resultado) throw new Error('Nenhum QR code encontrado na imagem');
    return resultado.data;
  };

  lib.compare_images = async (cfg, ctx) => {
    const a = await Jimp.read(asBuffer(sub(cfg.data_input || '', ctx)));
    const b = await Jimp.read(asBuffer(sub(cfg.data_input2 || '{output}', ctx)));
    a.resize(16, 16).grayscale();
    b.resize(16, 16).grayscale();
    const distancia = Jimp.distance(a, b);
    return String(1 - distancia);
  };

  // ==================== OCR ====================

  lib.ocr_image = async (cfg, ctx) => {
    const buf = asBuffer(sub(cfg.file_base64 || '{output}', ctx));
    const worker = await createWorker(cfg.ocr_lang || 'por');
    try {
      const { data } = await worker.recognize(buf);
      return data.text.trim();
    } finally { await worker.terminate(); }
  };

  // ==================== Zip ====================

  lib.zip_files = async (cfg, ctx) => {
    const arquivos = jparse(sub(cfg.data_input || '[]', ctx), []); // [{nome, base64}]
    const zip = new JSZip();
    for (const f of arquivos) zip.file(f.nome, f.base64, { base64: true });
    return zip.generateAsync({ type: 'base64' });
  };

  lib.unzip_file = async (cfg, ctx) => {
    const buf = asBuffer(sub(cfg.file_base64 || '{output}', ctx));
    const zip = await JSZip.loadAsync(buf);
    const arquivos = [];
    for (const [nome, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      arquivos.push({ nome, base64: await entry.async('base64') });
    }
    return JSON.stringify(arquivos);
  };

  return lib;
};
