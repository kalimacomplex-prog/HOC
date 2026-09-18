// ==================== Builder de automação de Robô — MVP ====================
// Porte reduzido da UX do HAC Studio (lista vertical aninhada) pro HOC. Ver
// plano: C:\Users\novai\.claude\plans\enchanted-gathering-pearl.md

const rbToken = localStorage.getItem('token');
if (!rbToken) location.href = '/';
const RB_HEADERS = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + rbToken };

async function rbApi(method, url, body) {
  const resp = await fetch(url, { method, headers: RB_HEADERS, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await resp.json(); } catch {}
  if (!resp.ok) throw new Error(data?.erro || `Erro ${resp.status}`);
  return data;
}

function rbToast(msg, tipo) {
  if (window.hocToast) { hocToast(msg, tipo === 'error' ? 'erro' : tipo === 'success' ? 'ok' : 'info'); return; }
  console.log(`[${tipo || 'info'}] ${msg}`);
}

// ==================== Estado ====================

let rbSteps = [];
let rbAutomacaoId = null;
let rbRoboId = null;
let rbEmpresaSteps = false; // marca se algo mudou desde o último save
let rbSelectedId = null;
let rbDraggedId = null;
let rbBusca = '';
let rbPollTimer = null;

const RB_ACOES = [
  { tipo: 'comment', label: 'Comentário', icone: '💬', cor: '#a0aec0', cat: 'Anotação' },
  { tipo: 'set_variable', label: 'Definir variável', icone: '{x}', cor: '#3b5bdb', cat: 'Variáveis' },
  { tipo: 'condition', label: 'Condição (Se/Senão)', icone: '?', cor: '#dd6b20', cat: 'Controle de fluxo', container: true },
  { tipo: 'loop_count', label: 'Repetir N vezes', icone: '↻', cor: '#dd6b20', cat: 'Controle de fluxo', container: true },
  { tipo: 'foreach', label: 'Para cada item', icone: '∀', cor: '#dd6b20', cat: 'Controle de fluxo', container: true },
  { tipo: 'try_catch', label: 'Tentar / Capturar', icone: '!', cor: '#dd6b20', cat: 'Controle de fluxo', container: true },
  { tipo: 'wait', label: 'Aguardar', icone: '⏱', cor: '#718096', cat: 'Controle de fluxo' },
  { tipo: 'http_request', label: 'Requisição HTTP', icone: '⇄', cor: '#2b6cb0', cat: 'HTTP' },
  { tipo: 'http_request_retry', label: 'HTTP com retry', icone: '⇄+', cor: '#2b6cb0', cat: 'HTTP' },
  { tipo: 'send_email', label: 'Enviar e-mail', icone: '✉', cor: '#2b6cb0', cat: 'Comunicação' },
  { tipo: 'call_ai_agent', label: 'Chamar IA', icone: '✨', cor: '#6b46c1', cat: 'Inteligência Artificial' },
  { tipo: 'read_file', label: 'Ler arquivo', icone: '📄', cor: '#276749', cat: 'Arquivos (na máquina)' },
  { tipo: 'write_file', label: 'Escrever arquivo', icone: '📝', cor: '#276749', cat: 'Arquivos (na máquina)' },
  { tipo: 'run_command', label: 'Rodar comando', icone: '>_', cor: '#1a202c', cat: 'Sistema (na máquina)' },
  { tipo: 'browser_flow', label: 'Fluxo de navegador', icone: '🌐', cor: '#c53030', cat: 'Browser (na máquina)' },
];
const RB_ACOES_MAP = Object.fromEntries(RB_ACOES.map((a) => [a.tipo, a]));

function rbNovoId() {
  return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())).replace(/-/g, '').slice(0, 12);
}

function rbMarcarSujo() { rbEmpresaSteps = true; }

// ==================== Árvore de steps — helpers recursivos ====================

// [ [chave, array, label, classe], ... ] das branches que este step tem.
function rbBranches(step) {
  if (step.type === 'condition') return [['children_true', step.children_true ||= [], 'Verdadeiro', 'verdadeiro'], ['children_false', step.children_false ||= [], 'Falso', 'falso']];
  if (step.type === 'try_catch') return [['children_true', step.children_true ||= [], 'Tentar', 'tentar'], ['children_false', step.children_false ||= [], 'Capturar', 'capturar']];
  if (['loop_count', 'foreach', 'while_condition', 'parallel'].includes(step.type)) return [['children', step.children ||= [], 'Corpo', 'corpo']];
  return [];
}

function rbFindStep(id, list = rbSteps) {
  for (const s of list) {
    if (s.id === id) return s;
    for (const [, arr] of rbBranches(s)) {
      const found = rbFindStep(id, arr);
      if (found) return found;
    }
  }
  return null;
}

// {arr, index} do array que CONTÉM o step (pra remover/mover) — null se não achar.
function rbFindLocation(id, list = rbSteps) {
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) return { arr: list, index: i };
    for (const [, arr] of rbBranches(list[i])) {
      const found = rbFindLocation(id, arr);
      if (found) return found;
    }
  }
  return null;
}

function rbRemoveStep(id) {
  const loc = rbFindLocation(id);
  if (loc) loc.arr.splice(loc.index, 1);
}

function rbComputeNumbers() {
  const map = {};
  let n = 0;
  (function walk(list) {
    for (const s of list) {
      n++;
      map[s.id] = n;
      for (const [, arr] of rbBranches(s)) walk(arr);
    }
  })(rbSteps);
  return map;
}

// ==================== Paleta ====================

function rbRenderPalette() {
  rbBusca = document.getElementById('rbBusca').value.trim().toLowerCase();
  const filtradas = RB_ACOES.filter((a) => !rbBusca || a.label.toLowerCase().includes(rbBusca));
  const porCategoria = {};
  for (const a of filtradas) (porCategoria[a.cat] ||= []).push(a);

  let html = '';
  for (const [cat, acoes] of Object.entries(porCategoria)) {
    html += `<div class="rb-cat-titulo">${escapeHtmlRb(cat)}</div>`;
    for (const a of acoes) {
      html += `
        <div class="rb-acao-item" draggable="true" ondragstart="rbPaletteDragStart(event,'${a.tipo}')" onclick="rbAddStep('${a.tipo}')">
          <span class="rb-acao-dot" style="background:${a.cor}"></span>
          <span>${escapeHtmlRb(a.label)}</span>
        </div>`;
    }
  }
  document.getElementById('rbPaletteLista').innerHTML = html || '<div style="padding:12px;color:#a0aec0;font-size:12px">Nada encontrado.</div>';
}

function escapeHtmlRb(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ==================== Criar / mover / remover steps ====================

function rbCriarStep(tipo) {
  const step = { id: rbNovoId(), type: tipo, name: RB_ACOES_MAP[tipo]?.label || tipo, enabled: true, config: {} };
  if (tipo === 'condition') { step.children_true = []; step.children_false = []; }
  if (tipo === 'try_catch') { step.children_true = []; step.children_false = []; }
  if (['loop_count', 'foreach', 'while_condition', 'parallel'].includes(tipo)) step.children = [];
  return step;
}

function rbAddStep(tipo) {
  rbSteps.push(rbCriarStep(tipo));
  rbMarcarSujo();
  rbRenderCanvas();
}

function rbInserirEm(step, containerArr, index) {
  containerArr.splice(index, 0, step);
}

function rbMoveStep(id, dir) {
  const loc = rbFindLocation(id);
  if (!loc) return;
  const novoIndex = loc.index + dir;
  if (novoIndex < 0 || novoIndex >= loc.arr.length) return;
  const [item] = loc.arr.splice(loc.index, 1);
  loc.arr.splice(novoIndex, 0, item);
  rbMarcarSujo();
  rbRenderCanvas();
}

function rbDeleteStep(id) {
  rbRemoveStep(id);
  if (rbSelectedId === id) { rbSelectedId = null; rbRenderProps(); }
  rbMarcarSujo();
  rbRenderCanvas();
}

function rbToggleEnabled(id) {
  const step = rbFindStep(id);
  if (step) step.enabled = step.enabled === false ? true : false;
  rbMarcarSujo();
  rbRenderCanvas();
}

// ==================== Renderização do canvas ====================

function rbRenderCanvas() {
  const numeros = rbComputeNumbers();
  document.getElementById('rbCanvasSteps').innerHTML = rbRenderStepList(rbSteps, numeros, 'root', null);
}

function rbRenderStepList(steps, numeros, containerId, branchKey) {
  let html = rbZoneHtml(containerId, branchKey, 0);
  if (!steps.length) {
    html += `<div class="rb-empty-branch" ondragover="rbZoneDragOver(event)" ondrop="rbZoneDrop(event,'${containerId}','${branchKey}',0)">Arraste uma ação aqui</div>`;
    return html;
  }
  steps.forEach((step, i) => {
    html += rbRenderStepCard(step, numeros);
    html += rbZoneHtml(containerId, branchKey, i + 1);
  });
  return html;
}

function rbZoneHtml(containerId, branchKey, index) {
  return `<div class="rb-zone" ondragover="rbZoneDragOver(event)" ondragleave="rbZoneDragLeave(event)" ondrop="rbZoneDrop(event,'${containerId}','${branchKey}',${index})"><div class="rb-zone-line"></div></div>`;
}

function rbRenderStepCard(step, numeros) {
  const acao = RB_ACOES_MAP[step.type] || { label: step.type, icone: '•', cor: '#718096' };
  const num = numeros[step.id];
  const desativado = step.enabled === false;
  const branches = rbBranches(step);
  const isContainer = branches.length > 0;

  const cardHtml = `
    <div class="rb-step ${rbSelectedId === step.id ? 'selecionado' : ''}" style="${desativado ? 'opacity:.45' : ''}"
         draggable="true" ondragstart="rbStepDragStart(event,'${step.id}')"
         onclick="rbSelectStep('${step.id}', event)">
      <span class="rb-step-num">${num}</span>
      <span class="rb-step-icone" style="background:${acao.cor}22;color:${acao.cor}">${acao.icone}</span>
      <div class="rb-step-corpo">
        <div class="rb-step-nome">${escapeHtmlRb(step.name || acao.label)}</div>
        <div class="rb-step-resumo">${escapeHtmlRb(rbResumoStep(step))}</div>
      </div>
      <div class="rb-step-acoes">
        <button title="Mover pra cima" onclick="event.stopPropagation();rbMoveStep('${step.id}',-1)">▲</button>
        <button title="Mover pra baixo" onclick="event.stopPropagation();rbMoveStep('${step.id}',1)">▼</button>
        <button title="${desativado ? 'Ativar' : 'Desativar'}" onclick="event.stopPropagation();rbToggleEnabled('${step.id}')">${desativado ? '○' : '●'}</button>
        <button title="Remover" onclick="event.stopPropagation();rbDeleteStep('${step.id}')">✕</button>
      </div>
    </div>`;

  if (!isContainer) return cardHtml;

  const duasBranches = branches.length === 2;
  let branchesHtml = `<div class="rb-container-branches ${duasBranches ? 'duas' : ''}">`;
  for (const [key, arr, label, classe] of branches) {
    branchesHtml += `
      <div class="rb-branch ${classe}">
        <div class="rb-branch-label">${label}</div>
        ${rbRenderStepList(arr, numeros, step.id, key)}
      </div>`;
  }
  branchesHtml += '</div>';

  return `<div class="rb-container">${cardHtml}${branchesHtml}</div>`;
}

function rbResumoStep(step) {
  const c = step.config || {};
  switch (step.type) {
    case 'set_variable': return `${c.variable_name || '?'} = ${c.value || ''}`;
    case 'condition': return `se output ${c.operator || '?'} "${c.condition_value || ''}"`;
    case 'loop_count': return `${c.count || 0}x`;
    case 'foreach': return `sobre ${c.list_source || '?'}`;
    case 'wait': return `${c.seconds || 0}s`;
    case 'http_request': case 'http_request_retry': return `${(c.method || 'GET')} ${c.url || ''}`;
    case 'send_email': return `pra ${c.to || '?'}`;
    case 'call_ai_agent': return c.input_template || '{output}';
    case 'read_file': return c.file_path || '';
    case 'write_file': return c.file_path || '';
    case 'run_command': return c.command || '';
    case 'browser_flow': return `${(c.actions || []).length} ações`;
    default: return '';
  }
}

// ==================== Seleção + painel de propriedades ====================

function rbSelectStep(id, ev) {
  if (ev) ev.stopPropagation();
  rbSelectedId = id;
  rbRenderCanvas();
  rbRenderProps();
}

function rbUpdateConfig(stepId, key, value) {
  const step = rbFindStep(stepId);
  if (!step) return;
  step.config = step.config || {};
  step.config[key] = value;
  rbMarcarSujo();
  rbRenderCanvas();
}

function rbUpdateName(stepId, value) {
  const step = rbFindStep(stepId);
  if (!step) return;
  step.name = value;
  rbMarcarSujo();
  rbRenderCanvas();
}

function rbField(label, inputHtml, hint) {
  return `<div class="rb-field"><label>${escapeHtmlRb(label)}</label>${inputHtml}${hint ? `<div class="rb-hint">${hint}</div>` : ''}</div>`;
}

function rbRenderProps() {
  const el = document.getElementById('rbProps');
  if (!rbSelectedId) { el.innerHTML = '<div class="rb-props-placeholder">Selecione um step no canvas pra configurar, ou clique numa ação da paleta pra adicionar.</div>'; return; }
  const step = rbFindStep(rbSelectedId);
  if (!step) { el.innerHTML = ''; return; }
  const acao = RB_ACOES_MAP[step.type] || { label: step.type, icone: '•', cor: '#718096' };
  const c = step.config || {};
  const id = step.id;

  let form = `${rbField('Nome do step', `<input value="${escapeHtmlRb(step.name || '')}" oninput="rbUpdateName('${id}',this.value)">`)}`;

  const inp = (key, ph) => `<input value="${escapeHtmlRb(c[key] || '')}" placeholder="${ph || ''}" oninput="rbUpdateConfig('${id}','${key}',this.value)">`;
  const ta = (key, ph, rows) => `<textarea rows="${rows || 3}" placeholder="${ph || ''}" oninput="rbUpdateConfig('${id}','${key}',this.value)">${escapeHtmlRb(c[key] || '')}</textarea>`;
  const sel = (key, options) => `<select onchange="rbUpdateConfig('${id}','${key}',this.value)">${options.map((o) => `<option value="${o[0]}" ${c[key] === o[0] ? 'selected' : ''}>${o[1]}</option>`).join('')}</select>`;
  const chk = (key, label) => `<label class="rb-check"><input type="checkbox" ${c[key] ? 'checked' : ''} onchange="rbUpdateConfig('${id}','${key}',this.checked)"> ${label}</label>`;

  if (step.type === 'set_variable') {
    form += rbField('Nome da variável', inp('variable_name', 'minha_variavel'));
    form += rbField('Valor', ta('value', 'Pode usar {output}, {input} ou {outra_variavel}'));
  } else if (step.type === 'condition') {
    form += rbField('Operador', sel('operator', [['contains','contém'],['not_contains','não contém'],['equals','igual a'],['not_equals','diferente de'],['starts_with','começa com'],['ends_with','termina com'],['is_empty','está vazio'],['not_empty','não está vazio'],['greater_than','maior que'],['less_than','menor que']]));
    form += rbField('Valor de comparação', inp('condition_value'), 'Comparado contra o {output} do step anterior.');
  } else if (step.type === 'loop_count') {
    form += rbField('Quantas vezes', inp('count', '5'));
    form += rbField('Variável do índice (opcional)', inp('index_variable', 'i'));
  } else if (step.type === 'foreach') {
    form += rbField('Lista (JSON ou uma linha por item)', ta('list_source', '["a","b","c"]'));
    form += rbField('Variável do item', inp('item_variable', 'item'));
  } else if (step.type === 'try_catch') {
    form += `<div class="rb-hint">Roda "Tentar"; se algum step falhar, roda "Capturar" (com {error} preenchido) em vez de abortar a automação.</div>`;
  } else if (step.type === 'wait') {
    form += rbField('Segundos', inp('seconds', '5'));
  } else if (step.type === 'http_request' || step.type === 'http_request_retry') {
    form += rbField('Método', sel('method', [['GET','GET'],['POST','POST'],['PUT','PUT'],['PATCH','PATCH'],['DELETE','DELETE']]));
    form += rbField('URL', inp('url', 'https://...'));
    form += rbField('Headers', ta('headers', 'Chave: Valor (uma por linha)'));
    form += rbField('Corpo (body)', ta('body'));
    if (step.type === 'http_request_retry') form += rbField('Máx. tentativas', inp('max_iterations', '3'));
    form += rbField('Salvar resposta na variável', inp('variable_name'));
  } else if (step.type === 'send_email') {
    form += rbField('Para', inp('to', 'destino@email.com'));
    form += rbField('Assunto', inp('subject'));
    form += rbField('Corpo', ta('email_body', '', 5));
    form += chk('is_html', 'Corpo é HTML');
    form += `<div class="rb-hint">Usa o SMTP configurado em Configurações → SMTP.</div>`;
  } else if (step.type === 'call_ai_agent') {
    form += rbField('Mensagem (template)', ta('input_template', '{output}'));
    form += rbField('Mensagem de sistema (opcional)', ta('system_message', '', 2));
    form += rbField('Provedor (vazio = padrão da empresa)', sel('provedor', [['','Padrão da empresa'],['claude-sonnet','Claude Sonnet'],['claude-haiku','Claude Haiku'],['gpt-4o','GPT-4o'],['gpt-4','GPT-4'],['gemini','Gemini']]));
    form += rbField('Salvar resposta na variável', inp('variable_name'));
  } else if (step.type === 'read_file') {
    form += rbField('Caminho do arquivo', inp('file_path', 'C:\\pasta\\arquivo.txt'));
    form += rbField('Salvar conteúdo na variável', inp('variable_name'));
    form += `<div class="rb-hint">Roda na máquina do tenant (precisa de um agente online).</div>`;
  } else if (step.type === 'write_file') {
    form += rbField('Caminho do arquivo', inp('file_path'));
    form += rbField('Conteúdo', ta('content'));
    form += chk('append', 'Adicionar ao final (em vez de sobrescrever)');
    form += `<div class="rb-hint">Roda na máquina do tenant (precisa de um agente online).</div>`;
  } else if (step.type === 'run_command') {
    form += rbField('Comando', ta('command', 'python script.py'));
    form += rbField('Timeout (segundos)', inp('timeout_seconds', '60'));
    form += rbField('Salvar saída na variável', inp('variable_name'));
    form += `<div class="rb-hint">Roda na máquina do tenant (precisa de um agente online).</div>`;
  } else if (step.type === 'browser_flow') {
    form += chk('headless', 'Sem interface visível (headless)');
    form += rbRenderBrowserActions(step);
    form += `<div class="rb-hint">Roda na máquina do tenant, um browser por execução (sem sessão persistente entre steps nesta versão).</div>`;
  } else if (step.type === 'comment') {
    form += rbField('Anotação', ta('text'));
  }

  el.innerHTML = `<div class="rb-props-titulo"><span class="rb-step-icone" style="background:${acao.cor}22;color:${acao.cor}">${acao.icone}</span> ${escapeHtmlRb(acao.label)}</div>${form}`;
}

function rbRenderBrowserActions(step) {
  const acoes = step.config.actions || (step.config.actions = []);
  const tipos = [['open','Abrir URL'],['click','Clicar'],['type','Digitar'],['wait','Aguardar (s)'],['extract','Extrair texto'],['screenshot','Screenshot']];
  let html = '<div class="rb-field"><label>Ações do navegador</label>';
  acoes.forEach((a, i) => {
    html += `
      <div style="display:flex;gap:4px;margin-bottom:4px">
        <select style="width:auto" onchange="rbUpdateBrowserAction('${step.id}',${i},'type',this.value)">
          ${tipos.map((t) => `<option value="${t[0]}" ${a.type === t[0] ? 'selected' : ''}>${t[1]}</option>`).join('')}
        </select>
        <input placeholder="seletor/URL" value="${escapeHtmlRb(a.target || '')}" oninput="rbUpdateBrowserAction('${step.id}',${i},'target',this.value)">
        <input placeholder="valor" value="${escapeHtmlRb(a.value || '')}" oninput="rbUpdateBrowserAction('${step.id}',${i},'value',this.value)">
        <button onclick="rbRemoveBrowserAction('${step.id}',${i})" style="border:none;background:none;color:#c53030;cursor:pointer">✕</button>
      </div>`;
  });
  html += `<button class="btn-secondary" style="width:100%;margin-top:4px" onclick="rbAddBrowserAction('${step.id}')">+ Ação</button></div>`;
  return html;
}

function rbUpdateBrowserAction(stepId, i, key, value) {
  const step = rbFindStep(stepId);
  if (!step?.config?.actions?.[i]) return;
  step.config.actions[i][key] = value;
  rbMarcarSujo();
}

function rbAddBrowserAction(stepId) {
  const step = rbFindStep(stepId);
  if (!step) return;
  (step.config.actions ||= []).push({ type: 'open', target: '', value: '' });
  rbMarcarSujo();
  rbRenderProps();
  rbRenderCanvas();
}

function rbRemoveBrowserAction(stepId, i) {
  const step = rbFindStep(stepId);
  if (!step?.config?.actions) return;
  step.config.actions.splice(i, 1);
  rbMarcarSujo();
  rbRenderProps();
  rbRenderCanvas();
}

// ==================== Drag and drop ====================

let rbDraggedTipo = null; // quando arrasta da paleta (ação nova)

function rbPaletteDragStart(ev, tipo) {
  rbDraggedTipo = tipo;
  rbDraggedId = null;
  ev.dataTransfer.effectAllowed = 'copy';
}

function rbStepDragStart(ev, stepId) {
  ev.stopPropagation();
  rbDraggedId = stepId;
  rbDraggedTipo = null;
  ev.dataTransfer.effectAllowed = 'move';
}

function rbZoneDragOver(ev) {
  ev.preventDefault();
  ev.currentTarget.classList.add('rb-over');
}
function rbZoneDragLeave(ev) {
  ev.currentTarget.classList.remove('rb-over');
}

function rbContainerArr(containerId, branchKey) {
  if (containerId === 'root') return rbSteps;
  const container = rbFindStep(containerId);
  if (!container) return null;
  const found = rbBranches(container).find(([k]) => k === branchKey);
  return found ? found[1] : null;
}

// true se `targetId` está dentro da árvore de `ancestorId` (soltar um
// container dentro de um dos seus próprios branches criaria um ciclo).
function rbIsDescendant(ancestorId, targetId) {
  const ancestor = rbFindStep(ancestorId);
  if (!ancestor) return false;
  for (const [, arr] of rbBranches(ancestor)) {
    for (const s of arr) {
      if (s.id === targetId || rbIsDescendant(s.id, targetId)) return true;
    }
  }
  return false;
}

function rbZoneDrop(ev, containerId, branchKey, index) {
  ev.preventDefault();
  ev.currentTarget.classList.remove('rb-over');
  const destArr = rbContainerArr(containerId, branchKey);
  if (!destArr) return;

  if (rbDraggedTipo) {
    destArr.splice(index, 0, rbCriarStep(rbDraggedTipo));
    rbDraggedTipo = null;
  } else if (rbDraggedId) {
    if (containerId !== 'root' && (containerId === rbDraggedId || rbIsDescendant(rbDraggedId, containerId))) {
      rbDraggedId = null;
      return; // soltaria o step dentro de si mesmo — ignora
    }
    const loc = rbFindLocation(rbDraggedId);
    if (!loc) return;
    const [item] = loc.arr.splice(loc.index, 1);
    let destIndex = index;
    if (loc.arr === destArr && loc.index < destIndex) destIndex -= 1;
    destArr.splice(destIndex, 0, item);
    rbDraggedId = null;
  } else {
    return;
  }
  rbMarcarSujo();
  rbRenderCanvas();
}

// ==================== Carregar / salvar ====================

function rbParamsUrl() {
  return new URLSearchParams(location.search);
}

async function rbCarregar() {
  const params = rbParamsUrl();
  rbAutomacaoId = params.get('automacaoId');
  rbRoboId = params.get('roboId');
  if (!rbAutomacaoId) { rbRenderPalette(); rbRenderCanvas(); return; }
  try {
    const automacao = await rbApi('GET', `/api/automacoes/${rbAutomacaoId}`);
    document.getElementById('rbNome').value = automacao.nome || '';
    document.getElementById('rbDesc').value = automacao.descricao || '';
    rbSteps = JSON.parse(JSON.stringify(automacao.steps || []));
    rbRoboId = automacao.roboId || rbRoboId;
  } catch (e) {
    rbToast('Erro ao carregar automação: ' + e.message, 'error');
  }
  rbRenderPalette();
  rbRenderCanvas();
}

async function rbSalvar() {
  const nome = document.getElementById('rbNome').value.trim();
  if (!nome) { rbToast('Dê um nome pro robô antes de salvar.', 'error'); return; }
  const descricao = document.getElementById('rbDesc').value.trim();
  const btn = document.getElementById('rbBtnSalvar');
  btn.disabled = true;
  try {
    let automacao;
    if (rbAutomacaoId) {
      automacao = await rbApi('PATCH', `/api/automacoes/${rbAutomacaoId}`, { nome, descricao, steps: rbSteps });
    } else {
      automacao = await rbApi('POST', '/api/automacoes', { nome, descricao, steps: rbSteps, gatilho: { tipo: 'manual' } });
      rbAutomacaoId = automacao._id;
    }

    if (!rbRoboId) {
      const robo = await rbApi('POST', '/api/robos', {
        nome, descricao, origem: 'builder', automacaoId: automacao._id, ambiente: 'local',
      });
      rbRoboId = robo._id;
      await rbApi('PATCH', `/api/automacoes/${rbAutomacaoId}`, { roboId: rbRoboId }).catch(() => {});
      history.replaceState(null, '', `/robo-builder?automacaoId=${rbAutomacaoId}&roboId=${rbRoboId}`);
    }

    rbEmpresaSteps = false;
    document.getElementById('rbStatusTxt').textContent = 'Salvo ' + new Date().toLocaleTimeString('pt-BR');
    rbToast('Robô salvo!', 'success');
  } catch (e) {
    rbToast('Erro ao salvar: ' + e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function rbVoltar() {
  if (rbEmpresaSteps && !confirm('Existem alterações não salvas. Sair mesmo assim?')) return;
  location.href = '/operacoes';
}

// ==================== Rodar / acompanhar ====================

async function rbExecutarInline() {
  if (!rbAutomacaoId) { rbToast('Salve o robô antes de rodar.', 'error'); return; }
  if (rbEmpresaSteps) { rbToast('Salve as alterações antes de rodar.', 'error'); return; }
  const painel = document.getElementById('rbLogPanel');
  painel.classList.add('aberto');
  painel.innerHTML = '<div class="rb-log-linha">Disparando...</div>';
  try {
    const run = await rbApi('POST', `/api/automacoes/${rbAutomacaoId}/run`, {});
    rbPollRun(run._id, painel);
  } catch (e) {
    painel.innerHTML += `<div class="rb-log-linha failed">Erro: ${escapeHtmlRb(e.message)}</div>`;
  }
}

function rbPollRun(runId, painel) {
  if (rbPollTimer) clearTimeout(rbPollTimer);
  const mostrados = new Set();
  const tick = async () => {
    let run;
    try { run = await rbApi('GET', `/api/automacoes/${rbAutomacaoId}/runs/${runId}`); }
    catch (e) { painel.innerHTML += `<div class="rb-log-linha failed">${escapeHtmlRb(e.message)}</div>`; return; }

    for (const s of run.stepsResult || []) {
      const chave = s.stepId + ':' + s.status;
      if (mostrados.has(chave)) continue;
      mostrados.add(chave);
      const linha = document.createElement('div');
      linha.className = `rb-log-linha ${s.status}`;
      linha.textContent = `${s.stepName} (${s.stepType}) — ${s.status}${s.error ? ': ' + s.error : ''} [${s.durationMs}ms]`;
      painel.appendChild(linha);
      painel.scrollTop = painel.scrollHeight;
    }

    if (run.status === 'running') {
      rbPollTimer = setTimeout(tick, 500);
    } else {
      const linha = document.createElement('div');
      linha.className = `rb-log-linha ${run.status === 'success' ? 'success' : 'failed'}`;
      linha.textContent = `— ${run.status.toUpperCase()} — saída final: ${run.output || ''}`;
      painel.appendChild(linha);
    }
  };
  tick();
}

// ==================== Boot ====================

document.addEventListener('DOMContentLoaded', rbCarregar);
