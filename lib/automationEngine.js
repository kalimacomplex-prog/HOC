/**
 * Motor de execução do builder de automação de Robôs — porte reduzido do
 * "HAC Studio" (ver plano em C:\Users\novai\.claude\plans\enchanted-gathering-pearl.md).
 *
 * Não importa os models do Mongoose diretamente (evita require circular com
 * index.js, que é quem define os schemas) — index.js chama `init(deps)` uma
 * vez na subida com os models/helpers já prontos.
 *
 * Modelo de execução: um `ctx` mutável (`{ input, output, vars }`) atravessa
 * a árvore de steps. Cada step-folha lê/escreve `ctx.output` e opcionalmente
 * uma variável nomeada em `ctx.vars`. Templating via `{nome}`/`{nome[indice]}`
 * é resolvido antes de qualquer campo de config ser usado.
 */

const crypto = require('crypto');

let M = null; // { Automacao, AutomacaoRun, AutomacaoStepDispatch, Robot, ExecucaoRobo, Maquina, enviarEmail, resolverEChamarIA, fetch, githubActions, hocApiUrl }

function init(deps) {
  M = deps;
}

// Catálogo grande de steps além do núcleo abaixo (ver lib/stepLibrary.js) —
// o próprio `require` é adiado pro primeiro uso de propósito: esse módulo
// sozinho puxa ~30 dependências pesadas (tesseract.js, pdf-lib, exceljs,
// docx, pptxgenjs...) que juntas custam ~170MB de RSS e quase 3s só pra
// carregar, medido localmente — carregar isso sempre na subida do servidor
// penalizaria toda automação (mesmo as que só usam os steps do núcleo) e é
// arriscado num plano free com RAM curta. Só paga esse custo quem realmente
// usa um step da expansão, e só na primeira vez.
let STEP_LIBRARY = null;
function getStepLibrary() {
  if (!STEP_LIBRARY) STEP_LIBRARY = require('./stepLibrary')({ sub, fetch: M.fetch });
  return STEP_LIBRARY;
}

// ==================== Templating / variáveis ====================

// Resolve um token tipo `nome`, `nome[0]`, `nome["chave"]`, `nome[outraVar]`
// contra ctx.vars — encadeável (`var[0][chave]` não é suportado de propósito,
// um nível de indexação já cobre o essencial do MVP).
function resolveVarExpr(expr, ctx) {
  const m = expr.match(/^([a-zA-Z_][\w]*)(?:\[(.+)\])?$/);
  if (!m) return undefined;
  const [, name, idxRaw] = m;
  let val = ctx.vars[name];
  if (val === undefined) return undefined;
  if (idxRaw === undefined) return val;

  let parsed;
  try { parsed = JSON.parse(val); } catch { parsed = val; }

  let idx = idxRaw.trim();
  if (/^\d+$/.test(idx)) {
    return Array.isArray(parsed) ? parsed[parseInt(idx, 10)] : undefined;
  }
  if (/^".*"$/.test(idx) || /^'.*'$/.test(idx)) {
    const key = idx.slice(1, -1);
    return parsed && typeof parsed === 'object' ? parsed[key] : undefined;
  }
  // índice é o nome de outra variável — usa o valor dela como chave/índice
  const keyFromVar = ctx.vars[idx];
  if (keyFromVar === undefined) return undefined;
  return parsed && typeof parsed === 'object' ? parsed[keyFromVar] : undefined;
}

// Substitui todo token `{...}` numa string. Tokens não reconhecidos (ex: JSON
// literal solto no meio do texto) ficam como estão — mesmo comportamento do
// HAC, pra não estragar corpo de requisição/JSON que por acaso tenha chaves.
function sub(str, ctx) {
  if (typeof str !== 'string') return str;
  return str.replace(/\{([^{}]+)\}/g, (whole, inner) => {
    const trimmed = inner.trim();
    if (trimmed === 'input') return ctx.input ?? '';
    if (trimmed === 'output') return ctx.output ?? '';
    const resolved = resolveVarExpr(trimmed, ctx);
    if (resolved === undefined) return whole;
    return typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
  });
}

function store(result, varName, ctx) {
  ctx.output = result;
  if (varName) {
    ctx.vars[varName] = typeof result === 'string' ? result : JSON.stringify(result);
  }
}

function evalCondition(value, operator, compareValue) {
  const v = value ?? '';
  const c = compareValue ?? '';
  switch (operator) {
    case 'contains': return v.includes(c);
    case 'not_contains': return !v.includes(c);
    case 'equals': return v === c;
    case 'not_equals': return v !== c;
    case 'starts_with': return v.startsWith(c);
    case 'ends_with': return v.endsWith(c);
    case 'is_empty': return !v || v.length === 0;
    case 'not_empty': return !!v && v.length > 0;
    case 'greater_than': return parseFloat(v) > parseFloat(c);
    case 'less_than': return parseFloat(v) < parseFloat(c);
    default: return false;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ==================== Cancelamento ====================

async function isCancelled(runId) {
  const run = await M.AutomacaoRun.findById(runId).select('cancelRequested').lean();
  return !!run?.cancelRequested;
}

// ==================== Dispatch pra agente (Maquina) ====================

const AGENT_STEP_TYPES = new Set([
  'read_file', 'write_file', 'run_command', 'browser_flow',
  // Filesystem por caminho — só faz sentido na máquina do tenant, não no servidor.
  'list_files', 'delete_file', 'copy_file', 'move_file', 'file_hash', 'file_info',
  'search_in_files', 'convert_encoding', 'delete_folder', 'ensure_dir', 'backup_folder',
  // Stats/processos são da máquina do tenant, não do servidor.
  'system_stats', 'list_processes',
  // Precisam de ffmpeg (binário nativo) — sem equivalente puro-JS viável.
  'transcode_media', 'extract_audio', 'trim_media', 'extract_video_frame',
  // Sessão de browser persistente entre steps (ver hoc_step_executor.py) —
  // o Chrome real só existe na máquina do tenant.
  'browser_open', 'browser_click', 'browser_type', 'browser_extract', 'browser_wait',
  'browser_screenshot', 'browser_close', 'browser_captcha_detect', 'browser_captcha_wait',
  'browser_captcha_solve_image',
]);
// 15min (não 5) porque browser_captcha_wait espera um humano resolver o
// captcha manualmente na janela do navegador — pode legitimamente demorar.
const STEP_DISPATCH_TIMEOUT_MS = 15 * 60 * 1000;
const STEP_DISPATCH_POLL_MS = 700;

async function escolherMaquina(empresa, roboId) {
  let maquina = null;
  if (roboId) {
    const robo = await M.Robot.findById(roboId).lean();
    if (robo?.maquinaId) {
      maquina = await M.Maquina.findOne({ _id: robo.maquinaId, empresa, status: { $in: ['online', 'busy'] }, ativo: true });
    }
  }
  if (!maquina) {
    maquina = await M.Maquina.findOne({
      empresa, status: 'online', ativo: true,
      $expr: { $lt: ['$robosAtivos', '$capacidadeMaxima'] },
    }).sort({ robosAtivos: 1 });
  }
  // Nenhuma máquina física do tenant disponível — sobe um runner efêmero no
  // GitHub Actions no lugar, mesma arquitetura já usada no HAC. Ele se
  // registra como uma Maquina temporária (machineKey só dele) fazendo
  // heartbeat normalmente — reaproveita 100% do protocolo de dispatch de
  // step já existente, só quem está do outro lado que é descartável.
  if (!maquina) {
    maquina = await criarMaquinaEfemera(empresa);
  }
  return maquina;
}

async function criarMaquinaEfemera(empresa) {
  const machineKey = crypto.randomBytes(24).toString('hex');
  const maquina = await M.Maquina.create({
    nome: 'Runner efêmero (GitHub Actions)',
    machineId: `ephemeral-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
    machineKey,
    capacidadeMaxima: 1,
    status: 'offline', // vira 'online' sozinho no primeiro heartbeat do runner
    ativo: true,
    efemera: true,
    empresa,
  });
  try {
    await M.githubActions.dispatchEphemeralRunner({ machineKey, hocApiUrl: M.hocApiUrl });
  } catch (e) {
    // Não deixa a Maquina órfã se o disparo falhar (ex: GitHub não
    // configurado) — sem isso ela ficaria pra sempre 'offline' na lista.
    await M.Maquina.findByIdAndDelete(maquina._id);
    throw e;
  }
  return maquina;
}

async function dispatchStepToAgent(step, ctx, maquinaId) {
  const dispatch = await M.AutomacaoStepDispatch.create({
    runId: ctx._runId,
    maquinaId,
    step: { id: step.id, type: step.type, config: step.config || {} },
    ctxSnapshot: { input: ctx.input, output: ctx.output, vars: ctx.vars },
  });

  const deadline = Date.now() + STEP_DISPATCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(STEP_DISPATCH_POLL_MS);
    const atual = await M.AutomacaoStepDispatch.findById(dispatch._id).lean();
    if (!atual) throw new Error('Dispatch do step sumiu (máquina/servidor reiniciou?)');
    if (atual.status === 'concluido') return atual.resultado?.output ?? '';
    if (atual.status === 'erro') throw new Error(atual.resultado?.error || 'Erro na máquina do agente');
    if (await isCancelled(ctx._runId)) throw new Error('__CANCELLED__');
  }
  throw new Error(`Timeout aguardando a máquina executar o step (${Math.round(STEP_DISPATCH_TIMEOUT_MS / 1000)}s)`);
}

// ==================== Steps-folha (servidor) ====================

async function execStepServer(step, ctx, empresa) {
  const cfg = step.config || {};
  const t = step.type;

  if (t === 'comment') {
    return '';
  }

  if (t === 'set_variable') {
    const value = sub(cfg.value ?? '', ctx);
    store(value, cfg.variable_name, ctx);
    return value;
  }

  if (t === 'http_request' || t === 'http_request_retry') {
    const method = (cfg.method || 'GET').toUpperCase();
    const url = sub(cfg.url || '', ctx);
    let headers = {};
    if (cfg.headers) {
      for (const line of String(cfg.headers).split('\n')) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        headers[line.slice(0, idx).trim()] = sub(line.slice(idx + 1).trim(), ctx);
      }
    }
    const body = cfg.body ? sub(cfg.body, ctx) : undefined;

    const maxTries = t === 'http_request_retry' ? Math.max(1, parseInt(cfg.max_iterations, 10) || 3) : 1;
    let lastErr;
    for (let attempt = 1; attempt <= maxTries; attempt++) {
      try {
        const resp = await M.fetch(url, { method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : body });
        const text = await resp.text();
        if (!resp.ok && t === 'http_request_retry' && resp.status >= 500 && attempt < maxTries) {
          lastErr = new Error(`HTTP ${resp.status}`);
          await sleep(Math.min(30000, 500 * 2 ** attempt));
          continue;
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text.slice(0, 300)}`);
        store(text, cfg.variable_name, ctx);
        return text;
      } catch (e) {
        lastErr = e;
        if (attempt >= maxTries) throw lastErr;
        await sleep(Math.min(30000, 500 * 2 ** attempt));
      }
    }
    throw lastErr;
  }

  if (t === 'send_email') {
    const to = sub(cfg.to || '', ctx);
    const subject = sub(cfg.subject || '', ctx);
    const body = sub(cfg.email_body || '', ctx);
    await M.enviarEmail(empresa, to, subject, cfg.is_html ? body : `<pre>${body}</pre>`);
    return 'Email enviado.';
  }

  if (t === 'call_ai_agent') {
    const inputTemplate = cfg.input_template || '{output}';
    const userMessage = sub(inputTemplate, ctx);
    const { resposta } = await M.resolverEChamarIA(empresa, {
      userMessage,
      systemMessage: cfg.system_message ? sub(cfg.system_message, ctx) : undefined,
      provedor: cfg.provedor,
      credencialNome: cfg.credencial_nome,
      campoCred: cfg.campo_cred,
    });
    store(resposta, cfg.variable_name, ctx);
    return resposta;
  }

  const lib = getStepLibrary();
  if (lib[t]) {
    const resultado = await lib[t](cfg, ctx);
    store(resultado, cfg.variable_name, ctx);
    return resultado;
  }

  throw new Error(`Tipo de step desconhecido: ${t}`);
}

async function execLeafStep(step, ctx, empresa, maquinaIdRef) {
  if (AGENT_STEP_TYPES.has(step.type)) {
    if (!maquinaIdRef.current) {
      const maquina = await escolherMaquina(empresa, ctx._roboId);
      if (!maquina) throw new Error('Nenhuma máquina online disponível pra rodar este step.');
      maquinaIdRef.current = maquina._id;
      // Ocupa 1 slot de capacidade da máquina pelo resto do run (não por step
      // — um run com vários steps de agente sequenciais conta como 1 execução
      // ocupada, mesmo padrão de granularidade do dispatch de Robô já existente).
      // Liberado em executarAutomacao quando o run termina.
      await M.Maquina.findByIdAndUpdate(maquinaIdRef.current, { $inc: { robosAtivos: 1 } });
    }
    const out = await dispatchStepToAgent(step, ctx, maquinaIdRef.current);
    ctx.output = out;
    if (step.config?.variable_name) ctx.vars[step.config.variable_name] = out;
    return out;
  }
  return execStepServer(step, ctx, empresa);
}

// ==================== Walker recursivo (controle de fluxo) ====================

const MAX_TREE_DEPTH = 40; // guarda contra árvore corrompida/cíclica (o builder já impede isso na UI, mas a API aceita steps direto)

async function execStepList(steps, ctx, empresa, maquinaIdRef, results, depth = 0) {
  if (depth > MAX_TREE_DEPTH) throw new Error('Árvore de steps aninhada demais (possível ciclo)');
  for (const step of steps) {
    if (step.enabled === false) continue;
    if (await isCancelled(ctx._runId)) throw Object.assign(new Error('Execução cancelada'), { cancelled: true });

    const started = Date.now();
    const result = { stepId: step.id, stepName: step.name || step.type, stepType: step.type, status: 'success', output: null, error: null, durationMs: 0, conditionResult: null };

    try {
      if (step.type === 'condition') {
        const ok = evalCondition(ctx.output, step.config?.operator, sub(step.config?.condition_value ?? '', ctx));
        result.conditionResult = ok;
        result.output = `condição: ${ok}`;
        await execStepList(ok ? (step.children_true || []) : (step.children_false || []), ctx, empresa, maquinaIdRef, results, depth + 1);

      } else if (step.type === 'loop_count') {
        const count = Math.max(0, parseInt(sub(String(step.config?.count ?? '0'), ctx), 10) || 0);
        for (let i = 0; i < count; i++) {
          if (step.config?.index_variable) ctx.vars[step.config.index_variable] = String(i);
          try {
            await execStepList(step.children || [], ctx, empresa, maquinaIdRef, results, depth + 1);
          } catch (e) {
            if (e.breakLoop) break;
            throw e;
          }
        }
        result.output = `loop x${count}`;

      } else if (step.type === 'foreach') {
        let list;
        try { list = JSON.parse(sub(step.config?.list_source ?? '[]', ctx)); }
        catch { list = String(sub(step.config?.list_source ?? '', ctx)).split('\n').filter(Boolean); }
        if (!Array.isArray(list)) list = [];
        for (let i = 0; i < list.length; i++) {
          if (step.config?.item_variable) {
            ctx.vars[step.config.item_variable] = typeof list[i] === 'string' ? list[i] : JSON.stringify(list[i]);
            ctx.vars[`${step.config.item_variable}_index`] = String(i);
          }
          try {
            await execStepList(step.children || [], ctx, empresa, maquinaIdRef, results, depth + 1);
          } catch (e) {
            if (e.breakLoop) break;
            throw e;
          }
        }
        result.output = `foreach x${list.length}`;

      } else if (step.type === 'while_condition') {
        const maxIter = Math.max(1, parseInt(step.config?.max_iterations, 10) || 50);
        let i = 0;
        while (i < maxIter && evalCondition(ctx.output, step.config?.operator, sub(step.config?.condition_value ?? '', ctx))) {
          try {
            await execStepList(step.children || [], ctx, empresa, maquinaIdRef, results, depth + 1);
          } catch (e) {
            if (e.breakLoop) break;
            throw e;
          }
          i++;
        }
        result.output = `while x${i}`;

      } else if (step.type === 'try_catch') {
        try {
          await execStepList(step.children_true || [], ctx, empresa, maquinaIdRef, results, depth + 1);
          result.output = 'try ok';
        } catch (e) {
          if (e.cancelled || e.breakLoop) throw e; // não intercepta cancelamento nem break de loop externo
          ctx.vars.error = String(e.message || e);
          await execStepList(step.children_false || [], ctx, empresa, maquinaIdRef, results, depth + 1);
          result.output = `catch: ${ctx.vars.error}`;
        }

      } else if (step.type === 'break_loop') {
        result.output = 'break';
        results.push({ ...result, durationMs: Date.now() - started });
        throw Object.assign(new Error('break'), { breakLoop: true });

      } else if (step.type === 'wait' || step.type === 'random_wait') {
        let seconds = parseFloat(sub(String(step.config?.seconds ?? '1'), ctx)) || 0;
        if (step.type === 'random_wait') {
          const max = parseFloat(sub(String(step.config?.seconds_max ?? seconds), ctx)) || seconds;
          seconds = seconds + Math.random() * Math.max(0, max - seconds);
        }
        let remaining = seconds * 1000;
        while (remaining > 0) {
          const chunk = Math.min(500, remaining);
          await sleep(chunk);
          remaining -= chunk;
          if (await isCancelled(ctx._runId)) throw Object.assign(new Error('Execução cancelada'), { cancelled: true });
        }
        result.output = `aguardou ${seconds}s`;

      } else if (step.type === 'parallel') {
        const childList = step.children || [];
        // Cada item de topo do array `children` roda em paralelo, cada um com
        // sua própria cópia de vars (evita corrida escrevendo na mesma var) —
        // as saídas são mescladas de volta depois, na ordem declarada.
        const varsSnapshots = childList.map(() => ({ ...ctx.vars }));
        const subResults = childList.map(() => []);
        const subOutputs = new Array(childList.length);
        await Promise.all(childList.map(async (childStep, i) => {
          const subCtx = { ...ctx, vars: varsSnapshots[i] };
          await execStepList([childStep], subCtx, empresa, maquinaIdRef, subResults[i], depth + 1);
          Object.assign(ctx.vars, subCtx.vars);
          subOutputs[i] = subCtx.output;
        }));
        for (const sr of subResults) results.push(...sr);
        ctx.output = subOutputs.join('\n');
        result.output = `parallel x${childList.length}`;

      } else {
        result.output = String(await execLeafStep(step, ctx, empresa, maquinaIdRef) ?? '');
      }
    } catch (e) {
      if (e.cancelled) throw e;
      if (e.breakLoop) throw e;
      result.status = 'failed';
      result.error = String(e.message || e);
      results.push({ ...result, durationMs: Date.now() - started });
      throw Object.assign(new Error(result.error), { fromStep: true });
    }

    result.durationMs = Date.now() - started;
    results.push(result);
  }
}

// ==================== Entry point ====================

// Cria o registro do run e devolve na hora — quem chama decide se espera o
// resultado (`_rodarLoop` awaited) ou deixa rodando em background.
async function _criarRun({ automacaoId, input, gatilhoTipo, empresa, execucaoRoboId }) {
  const automacao = await M.Automacao.findOne({ _id: automacaoId, empresa }).lean();
  if (!automacao) throw new Error('Automação não encontrada');
  const run = await M.AutomacaoRun.create({
    automacaoId, automacaoNome: automacao.nome, empresa,
    execucaoRoboId: execucaoRoboId || null,
    gatilhoTipo: gatilhoTipo || 'manual',
    input: input || '',
    status: 'running',
  });
  return { automacao, run };
}

async function _rodarLoop(automacao, run, empresa, roboId) {
  const ctx = { input: run.input || '', output: run.input || '', vars: {}, _runId: run._id, _roboId: roboId || automacao.roboId };
  const results = [];
  const maquinaIdRef = { current: null };
  const startedAt = Date.now();

  try {
    await execStepList(automacao.steps || [], ctx, empresa, maquinaIdRef, results);
    await M.AutomacaoRun.findByIdAndUpdate(run._id, {
      status: 'success', output: ctx.output, stepsResult: results,
      finalizadoEm: new Date(), duracaoMs: Date.now() - startedAt,
    });
  } catch (e) {
    const status = e.cancelled ? 'cancelled' : 'failed';
    await M.AutomacaoRun.findByIdAndUpdate(run._id, {
      status, output: ctx.output, stepsResult: results, error: e.message,
      finalizadoEm: new Date(), duracaoMs: Date.now() - startedAt,
    });
  }

  if (maquinaIdRef.current) {
    const maq = await M.Maquina.findById(maquinaIdRef.current).lean();
    if (maq?.efemera) {
      // Apaga (não só decrementa) — sem isso o runner efêmero ficaria
      // "listado" pra sempre; além disso, o próprio processo do runner usa
      // o 401 do próximo heartbeat (Maquina não existe mais) como sinal
      // pra encerrar sozinho (ver public/hoc_ephemeral_runner.py).
      await M.Maquina.findByIdAndDelete(maquinaIdRef.current);
    } else {
      await M.Maquina.findByIdAndUpdate(maquinaIdRef.current, { $inc: { robosAtivos: -1 } });
    }
  }

  return M.AutomacaoRun.findById(run._id);
}

// Dispara em background — devolve o run recém-criado na hora (status
// "running"), sem esperar os steps terminarem. Usado por runs manuais.
async function iniciarRunEmBackground(opts) {
  const { automacao, run } = await _criarRun(opts);
  _rodarLoop(automacao, run, opts.empresa, opts.roboId).catch((err) => {
    console.error(`Erro no run ${run._id} da automação ${automacao._id}:`, err);
  });
  return run;
}

// Espera terminar antes de devolver — usado pelo webhook (mesma limitação do
// HAC Studio: a automação inteira roda dentro da requisição do webhook).
async function executarESperar(opts) {
  const { automacao, run } = await _criarRun(opts);
  return _rodarLoop(automacao, run, opts.empresa, opts.roboId);
}

module.exports = { init, iniciarRunEmBackground, executarESperar };
