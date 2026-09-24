"""
hoc_step_executor.py — implementa os steps do builder de automação de Robôs
que precisam rodar na máquina do tenant, shipado junto no pacote do Agent e
chamado por agent.py quando o heartbeat retorna algo em `automacaoSteps`.

Dois modelos de browser coexistem:
- `browser_flow`: lista de ações compiladas e rodadas de uma vez num único
  browser (abre, faz tudo, fecha) — mais simples, sem estado entre steps.
- `browser_open`/`browser_click`/.../`browser_close`: sessão persistente
  entre steps separados do builder. Mais simples de implementar aqui do que
  no HAC porque o agent.py do HOC já é um processo de longa duração (não um
  script novo por job) — não precisamos do truque do HAC de subprocesso
  destacado + reconexão via porta CDP a cada ação só pra sobreviver entre
  processos; aqui um dicionário no nível do módulo já é suficiente, porque
  as threads que tratam cada step do heartbeat rodam todas dentro do MESMO
  processo do agente. O que ainda reconecta via CDP a cada ação (em vez de
  guardar o objeto Python do Playwright) é só porque a API síncrona do
  Playwright não é thread-safe entre chamadas — cada ação abre sua própria
  instância curta do driver, conecta no Chrome já rodando via CDP, faz UMA
  coisa, e desconecta (sem matar o processo real do Chrome).
"""
import base64
import json
import os
import queue
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request


def _sub(text, ctx):
    """Substituição de {variavel}/{input}/{output} — versão mínima (sem
    indexação [n]/["chave"], que já é resolvida no servidor antes de mandar
    o ctxSnapshot, quando o valor referenciado não depende de algo só
    conhecido na máquina)."""
    if not isinstance(text, str):
        return text

    def repl(m):
        name = m.group(1).strip()
        if name == 'input':
            return str(ctx.get('input', ''))
        if name == 'output':
            return str(ctx.get('output', ''))
        vars_ = ctx.get('vars') or {}
        return str(vars_.get(name, m.group(0)))

    return re.sub(r'\{([^{}]+)\}', repl, text)


def executar_step(step, ctx):
    """Recebe {id, type, config} + ctx {input, output, vars}. Retorna a
    string de saída do step, ou levanta exceção (agent.py captura e reporta
    como erro pro servidor)."""
    tipo = step.get('type')
    cfg = step.get('config') or {}

    if tipo == 'read_file':
        caminho = _sub(cfg.get('file_path', ''), ctx)
        with open(caminho, 'r', encoding=cfg.get('encoding') or 'utf-8') as f:
            return f.read()

    if tipo == 'write_file':
        caminho = _sub(cfg.get('file_path', ''), ctx)
        conteudo = _sub(cfg.get('content', ''), ctx)
        modo = 'a' if cfg.get('append') else 'w'
        pasta = os.path.dirname(caminho)
        if pasta:
            os.makedirs(pasta, exist_ok=True)
        with open(caminho, modo, encoding=cfg.get('encoding') or 'utf-8') as f:
            f.write(conteudo)
        return f'Gravado: {caminho}'

    if tipo == 'run_command':
        comando = _sub(cfg.get('command', ''), ctx)
        timeout = float(cfg.get('timeout_seconds') or 60)
        resultado = subprocess.run(comando, shell=True, capture_output=True, text=True, timeout=timeout)
        if resultado.returncode != 0:
            raise RuntimeError(resultado.stderr.strip() or f'Comando falhou (exit code {resultado.returncode})')
        return resultado.stdout

    if tipo == 'browser_flow':
        return _executar_browser_flow(cfg, ctx)

    if tipo in _FILE_STEPS:
        return _FILE_STEPS[tipo](cfg, ctx)

    if tipo in ('system_stats', 'list_processes'):
        return _executar_sistema(tipo, cfg, ctx)

    if tipo in ('transcode_media', 'extract_audio', 'trim_media', 'extract_video_frame'):
        return _executar_midia(tipo, cfg, ctx)

    if tipo in _BROWSER_SESSION_STEPS:
        return _BROWSER_SESSION_STEPS[tipo](cfg, ctx)

    raise ValueError(f'Tipo de step não suportado no agente: {tipo}')


# ==================== Sessão de browser persistente entre steps ====================

# Chave = "{run_id}:{session_name}" — separa por run pra duas automações
# concorrentes na mesma máquina não colidirem usando o mesmo nome de sessão.
_sessions = {}
_sessions_lock = threading.Lock()
_SESSION_TTL_SECONDS = 30 * 60

# Rodando no ambiente "Nuvem (GitHub Actions)" (hoc_ephemeral_runner.py): não
# existe tela (então o navegador é sempre headless, sem perfil) e o Ubuntu
# 24.04 do runner bloqueia o sandbox do Chrome (user namespaces via AppArmor)
# — sem --no-sandbox o Chrome aberto na mão (Popen) morre calado. O Playwright
# já faz isso sozinho no browser_flow (chromium.launch); aqui é só pra sessão.
NUVEM = os.environ.get('HOC_NUVEM') == '1' or os.environ.get('GITHUB_ACTIONS') == 'true'
_CHROME_BOOT_TIMEOUT = 25

# Navegadores disponíveis no campo "Navegador" dos steps: nome -> (tipo do
# Playwright, channel). "chromium" é o padrão e o único que usa a sessão via
# CDP abaixo; os outros (Firefox/WebKit não falam CDP) usam _SessaoPlaywright.
NAVEGADORES = {
    'chromium': ('chromium', None),
    'chrome': ('chromium', 'chrome'),
    'msedge': ('chromium', 'msedge'),
    'firefox': ('firefox', None),
    'webkit': ('webkit', None),
}
_NOMES_NAVEGADOR = {'chromium': 'Chromium', 'chrome': 'Google Chrome', 'msedge': 'Microsoft Edge',
                    'firefox': 'Firefox', 'webkit': 'WebKit (Safari)'}
_instalacao_lock = threading.Lock()
_instalados = set()


def _navegador(cfg):
    nome = str(cfg.get('navegador') or 'chromium').strip().lower()
    if nome not in NAVEGADORES:
        raise RuntimeError(f'Navegador "{nome}" desconhecido. Use: {", ".join(NAVEGADORES)}.')
    return nome


def _garantir_navegador(nome):
    """Instala o navegador na primeira vez que ele é pedido nesta máquina (em
    vez de instalar todos sempre — deixaria cada execução na Nuvem mais lenta
    mesmo para quem só usa Chromium). Na Nuvem instala também as dependências
    do sistema (--with-deps; o runner do GitHub tem sudo sem senha)."""
    with _instalacao_lock:
        if nome in _instalados:
            return
        if nome in ('chrome', 'msedge') and not NUVEM:
            # No Windows instalar Chrome/Edge exige administrador: só avisa.
            raise RuntimeError(f'{_NOMES_NAVEGADOR[nome]} não está instalado nesta máquina. Instale o navegador ou escolha outro no passo.')
        cmd = [sys.executable, '-m', 'playwright', 'install'] + (['--with-deps'] if NUVEM else []) + [nome]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
        if r.returncode != 0:
            raise RuntimeError(f'Falha ao instalar o {_NOMES_NAVEGADOR[nome]}: {(r.stderr or r.stdout).strip()[-500:]}')
        _instalados.add(nome)


def _falta_executavel(erro):
    msg = str(erro)
    return "Executable doesn't exist" in msg or 'is not found at' in msg or 'Chromium distribution' in msg


def _abrir_contexto(p, nome, headless, perfil=''):
    """Abre o navegador `nome` e devolve (browser_ou_None, contexto), instalando
    o navegador e tentando de novo se o executável ainda não existir."""
    tipo, canal = NAVEGADORES[nome]
    bt = getattr(p, tipo)
    kw = {'headless': headless}
    if canal:
        kw['channel'] = canal
    for tentativa in (1, 2):
        try:
            if perfil:
                return None, bt.launch_persistent_context(perfil, **kw)
            browser = bt.launch(**kw)
            return browser, browser.new_context(viewport={'width': 1366, 'height': 768})
        except Exception as e:
            if tentativa == 1 and _falta_executavel(e):
                _garantir_navegador(nome)
                continue
            raise


class _SessaoPlaywright:
    """Sessão persistente para navegadores que não falam CDP (Firefox, WebKit) e
    para Chrome/Edge. A API síncrona do Playwright não pode ser usada de threads
    diferentes, então UMA thread é dona do navegador e executa, em ordem, as
    ações que os steps (cada um na sua thread) colocam na fila."""

    def __init__(self, nome, headless, perfil, url):
        self._fila = queue.Queue()
        self._pronto = threading.Event()
        self._erro = None
        self._thread = threading.Thread(target=self._rodar, args=(nome, headless, perfil, url), daemon=True)
        self._thread.start()
        # Folga para a instalação do navegador na primeira vez (pode levar minutos).
        if not self._pronto.wait(900):
            raise RuntimeError('O navegador não abriu a tempo.')
        if self._erro:
            raise self._erro

    def _rodar(self, nome, headless, perfil, url):
        try:
            from playwright.sync_api import sync_playwright
            with sync_playwright() as p:
                browser, contexto = _abrir_contexto(p, nome, headless, perfil)
                try:
                    pagina = contexto.pages[0] if contexto.pages else contexto.new_page()
                    if url and url != 'about:blank':
                        pagina.goto(url)
                    self._pronto.set()
                    while True:
                        item = self._fila.get()
                        if item is None:
                            break
                        fn, resposta = item
                        try:
                            resposta.put((True, fn(pagina)))
                        except Exception as e:  # erro da ação volta para o step que pediu
                            resposta.put((False, e))
                finally:
                    try:
                        contexto.close()
                        if browser:
                            browser.close()
                    except Exception:
                        pass
        except Exception as e:
            self._erro = RuntimeError(str(e).splitlines()[0] if str(e) else repr(e))
            self._pronto.set()

    def executar(self, fn, timeout=600):
        if not self._thread.is_alive():
            raise RuntimeError('A sessão de navegador foi encerrada.')
        resposta = queue.Queue()
        self._fila.put((fn, resposta))
        ok, valor = resposta.get(timeout=timeout)
        if not ok:
            raise valor
        return valor

    def fechar(self):
        self._fila.put(None)
        self._thread.join(20)


def _session_key(cfg, ctx):
    nome = cfg.get('session_name') or 'default'
    run_id = ctx.get('run_id') or ''
    return f'{run_id}:{nome}'


def _chromium_path():
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        return p.chromium.executable_path


def _iniciar_watchdog(session_key):
    def _watch():
        time.sleep(_SESSION_TTL_SECONDS)
        with _sessions_lock:
            sess = _sessions.pop(session_key, None)
        if sess:
            _encerrar_sessao(sess)
    threading.Thread(target=_watch, daemon=True).start()


def _encerrar_sessao(sess):
    if sess.get('pw'):
        sess['pw'].fechar()
        return
    _matar_processo(sess['pid'])
    _apagar_perfil_tmp(sess.get('perfil_tmp'))


def _matar_processo(pid):
    # Mata a árvore inteira (processo + filhos) — o Chrome sobe vários
    # processos filhos (renderer, GPU etc.) e matar só o PID principal pode
    # deixar órfãos, mesmo binding funcionando na maioria dos casos simples.
    try:
        import psutil
        pai = psutil.Process(pid)
        for filho in pai.children(recursive=True):
            try:
                filho.kill()
            except Exception:
                pass
        pai.kill()
    except Exception:
        try:
            os.kill(pid, 9)
        except Exception:
            pass


def _browser_open(cfg, ctx):
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401 (só valida que está instalado)
    except ImportError:
        raise RuntimeError(
            'Playwright não instalado nesta máquina. Rode: '
            'pip install playwright && playwright install chromium'
        )

    key = _session_key(cfg, ctx)
    with _sessions_lock:
        if key in _sessions:
            return f'Sessão "{cfg.get("session_name") or "default"}" já estava aberta.'

    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        porta = s.getsockname()[1]

    # Perfil persistente (extensões pagas de captcha, sessão de login salva)
    # só faz sentido com janela visível — headless nesse caso é ignorado de
    # propósito, mesmo comportamento documentado no HAC. Na nuvem não há tela
    # nem perfil salvo: sempre headless, perfil ignorado.
    perfil = '' if NUVEM else _sub(cfg.get('browser_profile', ''), ctx)
    headless = NUVEM or (_cfg_bool(cfg.get('headless', True)) and not perfil)
    nav = _navegador(cfg)
    url = _sub(cfg.get('target') or cfg.get('url') or 'about:blank', ctx)
    sufixo = ', nuvem/headless' if NUVEM else ''

    if nav != 'chromium':
        sessao = _SessaoPlaywright(nav, headless, perfil, url)
        with _sessions_lock:
            _sessions[key] = {'pw': sessao, 'aberto_em': time.time()}
        _iniciar_watchdog(key)
        return f'Sessão aberta ({_NOMES_NAVEGADOR[nav]}{sufixo}).'

    caminho = _chromium_path()
    if not os.path.exists(caminho):
        _garantir_navegador('chromium')

    args = [
        caminho,
        f'--remote-debugging-port={porta}',
        '--no-first-run',
        '--no-default-browser-check',
    ]
    perfil_tmp = None
    if perfil:
        args.append(f'--user-data-dir={perfil}')
    else:
        # Sem perfil informado, cada sessão usa uma pasta própria e descartável:
        # com o perfil padrão, um Chromium já aberto "engole" o novo processo
        # (que sai na hora) e duas sessões ao mesmo tempo brigariam pelo perfil.
        perfil_tmp = tempfile.mkdtemp(prefix='hoc-browser-')
        args.append(f'--user-data-dir={perfil_tmp}')
    if headless:
        args.append('--headless=new')
    if NUVEM:
        args += ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1366,768']
    args.append(url)

    log_erro = tempfile.TemporaryFile()
    processo = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=log_erro)
    try:
        _esperar_chrome(processo, porta, log_erro)
    except Exception:
        _apagar_perfil_tmp(perfil_tmp)
        raise
    with _sessions_lock:
        _sessions[key] = {'porta': porta, 'pid': processo.pid, 'aberto_em': time.time(), 'perfil_tmp': perfil_tmp}
    _iniciar_watchdog(key)
    return f'Sessão aberta (Chromium, porta {porta}{sufixo}).'


def _apagar_perfil_tmp(pasta):
    # O Chrome recém-morto ainda segura arquivos do perfil por um instante
    # (no Windows o rmtree imediato falha) — tenta de novo em segundo plano.
    if not pasta:
        return

    def _apagar():
        for _ in range(20):
            shutil.rmtree(pasta, ignore_errors=True)
            if not os.path.exists(pasta):
                return
            time.sleep(0.5)
    threading.Thread(target=_apagar, daemon=True).start()


def _cfg_bool(v):
    if isinstance(v, str):
        return v.strip().lower() not in ('', '0', 'false', 'nao', 'não', 'off')
    return bool(v)


def _esperar_chrome(processo, porta, log_erro):
    """Espera o debug port do Chrome responder (em vez de um sleep fixo — numa
    máquina fria da nuvem ele demora mais). Se o Chrome morrer antes, devolve
    o fim do stderr dele no erro, em vez de um "connect_over_cdp" genérico."""
    prazo = time.time() + _CHROME_BOOT_TIMEOUT
    while time.time() < prazo:
        if processo.poll() is not None:
            log_erro.seek(0)
            detalhe = log_erro.read().decode('utf-8', 'replace').strip()[-800:]
            raise RuntimeError(f'O navegador fechou ao abrir (código {processo.returncode}). {detalhe}')
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{porta}/json/version', timeout=1) as r:
                if r.status == 200:
                    return
        except Exception:
            pass
        time.sleep(0.3)
    _matar_processo(processo.pid)
    raise RuntimeError(f'O navegador não respondeu em {_CHROME_BOOT_TIMEOUT}s.')


def _com_pagina(cfg, ctx, fn):
    """Reconecta via CDP na sessão já aberta, roda `fn(page)`, desconecta
    (sem matar o processo real do Chrome — só solta a conexão CDP)."""
    key = _session_key(cfg, ctx)
    with _sessions_lock:
        sess = _sessions.get(key)
    if not sess:
        nome = cfg.get('session_name') or 'default'
        raise RuntimeError(f'Sessão de navegador "{nome}" não está aberta. Use "Abrir sessão de navegador" antes.')
    if sess.get('pw'):
        return sess['pw'].executar(fn)

    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(f'http://127.0.0.1:{sess["porta"]}')
        try:
            contexto = browser.contexts[0] if browser.contexts else browser.new_context()
            pagina = contexto.pages[0] if contexto.pages else contexto.new_page()
            return fn(pagina)
        finally:
            browser.close()


def _browser_click(cfg, ctx):
    alvo = _sub(cfg.get('target', ''), ctx)
    return _com_pagina(cfg, ctx, lambda p: (p.click(alvo), 'ok')[1])


def _browser_type(cfg, ctx):
    alvo = _sub(cfg.get('target', ''), ctx)
    valor = _sub(cfg.get('value', ''), ctx)
    return _com_pagina(cfg, ctx, lambda p: (p.fill(alvo, valor), 'ok')[1])


def _browser_extract(cfg, ctx):
    alvo = _sub(cfg.get('target', ''), ctx)
    return _com_pagina(cfg, ctx, lambda p: p.inner_text(alvo))


def _browser_wait(cfg, ctx):
    alvo = _sub(cfg.get('target', ''), ctx)
    if alvo:
        return _com_pagina(cfg, ctx, lambda p: (p.wait_for_selector(alvo, timeout=float(cfg.get('timeout_seconds') or 30) * 1000), 'ok')[1])
    time.sleep(float(cfg.get('seconds') or 1))
    return 'ok'


def _browser_screenshot(cfg, ctx):
    alvo = _sub(cfg.get('target', ''), ctx)

    def _fn(p):
        img_bytes = p.locator(alvo).screenshot() if alvo else p.screenshot()
        return base64.b64encode(img_bytes).decode('ascii')
    return _com_pagina(cfg, ctx, _fn)


def _browser_close(cfg, ctx):
    key = _session_key(cfg, ctx)
    with _sessions_lock:
        sess = _sessions.pop(key, None)
    if not sess:
        return 'Sessão já estava fechada.'
    _encerrar_sessao(sess)
    return 'Sessão fechada.'


_CAPTCHA_JS = """() => {
    const el = document.querySelector('textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"]');
    return !!(el && el.value);
}"""


def _browser_captcha_detect(cfg, ctx):
    resolvido = _com_pagina(cfg, ctx, lambda p: p.evaluate(_CAPTCHA_JS))
    return 'true' if resolvido else 'false'


def _browser_captcha_wait(cfg, ctx):
    if NUVEM:
        raise RuntimeError(
            'Na nuvem ninguém vê a janela do navegador para resolver o captcha à mão. '
            'Use "Capturar imagem do captcha" + "OCR de imagem", ou rode este robô num Agent (máquina física).'
        )
    prazo = time.time() + float(cfg.get('timeout_seconds') or 120)
    while time.time() < prazo:
        if _browser_captcha_detect(cfg, ctx) == 'true':
            return 'Captcha resolvido.'
        time.sleep(2)
    raise RuntimeError('Timeout esperando o captcha ser resolvido manualmente na janela do navegador.')


def _browser_captcha_solve_image(cfg, ctx):
    # Só captura o elemento do captcha como imagem (base64) — a leitura em
    # si reaproveita o step "OCR de imagem" (server-side, ver
    # lib/stepLibrary.js::ocr_image) encadeado logo depois no builder, em
    # vez de duplicar um motor de OCR aqui no agente.
    alvo = _sub(cfg.get('target', ''), ctx)

    def _fn(p):
        elemento = p.query_selector(alvo)
        if not elemento:
            raise RuntimeError(f'Elemento do captcha não encontrado: {alvo}')
        return base64.b64encode(elemento.screenshot()).decode('ascii')
    return _com_pagina(cfg, ctx, _fn)


_BROWSER_SESSION_STEPS = {
    'browser_open': _browser_open,
    'browser_click': _browser_click,
    'browser_type': _browser_type,
    'browser_extract': _browser_extract,
    'browser_wait': _browser_wait,
    'browser_screenshot': _browser_screenshot,
    'browser_close': _browser_close,
    'browser_captcha_detect': _browser_captcha_detect,
    'browser_captcha_wait': _browser_captcha_wait,
    'browser_captcha_solve_image': _browser_captcha_solve_image,
}


# ==================== Arquivos/pastas (por caminho na máquina) ====================

def _fs_list_files(cfg, ctx):
    pasta = _sub(cfg.get('directory', ''), ctx)
    padrao = cfg.get('pattern') or '*'
    import glob
    arquivos = glob.glob(os.path.join(pasta, padrao))
    return json.dumps(arquivos)


def _fs_delete_file(cfg, ctx):
    caminho = _sub(cfg.get('file_path', ''), ctx)
    os.remove(caminho)
    return f'Removido: {caminho}'


def _fs_copy_file(cfg, ctx):
    import shutil
    origem = _sub(cfg.get('source_path', ''), ctx)
    destino = _sub(cfg.get('dest_path', ''), ctx)
    shutil.copy2(origem, destino)
    return f'Copiado: {origem} -> {destino}'


def _fs_move_file(cfg, ctx):
    import shutil
    origem = _sub(cfg.get('source_path', ''), ctx)
    destino = _sub(cfg.get('dest_path', ''), ctx)
    shutil.move(origem, destino)
    return f'Movido: {origem} -> {destino}'


def _fs_file_hash(cfg, ctx):
    import hashlib
    caminho = _sub(cfg.get('file_path', ''), ctx)
    algo = cfg.get('hash_algo') or 'sha256'
    h = hashlib.new(algo)
    with open(caminho, 'rb') as f:
        for bloco in iter(lambda: f.read(65536), b''):
            h.update(bloco)
    return h.hexdigest()


def _fs_file_info(cfg, ctx):
    caminho = _sub(cfg.get('file_path', ''), ctx)
    st = os.stat(caminho)
    return json.dumps({
        'tamanho': st.st_size,
        'modificado': st.st_mtime,
        'existe': True,
        'e_diretorio': os.path.isdir(caminho),
    })


def _fs_search_in_files(cfg, ctx):
    pasta = _sub(cfg.get('directory', ''), ctx)
    padrao = cfg.get('pattern') or '*'
    termo = _sub(cfg.get('value', ''), ctx)
    import glob
    achados = []
    for caminho in glob.glob(os.path.join(pasta, '**', padrao), recursive=True):
        if not os.path.isfile(caminho):
            continue
        try:
            with open(caminho, 'r', encoding='utf-8', errors='ignore') as f:
                if termo in f.read():
                    achados.append(caminho)
        except Exception:
            continue
    return json.dumps(achados)


def _fs_convert_encoding(cfg, ctx):
    caminho = _sub(cfg.get('file_path', ''), ctx)
    de = cfg.get('encoding_from') or 'latin-1'
    para = cfg.get('encoding_to') or 'utf-8'
    with open(caminho, 'r', encoding=de) as f:
        conteudo = f.read()
    with open(caminho, 'w', encoding=para) as f:
        f.write(conteudo)
    return f'Convertido {de} -> {para}: {caminho}'


def _fs_delete_folder(cfg, ctx):
    import shutil
    pasta = _sub(cfg.get('directory', ''), ctx)
    shutil.rmtree(pasta, ignore_errors=True)
    return f'Pasta removida: {pasta}'


def _fs_ensure_dir(cfg, ctx):
    pasta = _sub(cfg.get('directory', ''), ctx)
    os.makedirs(pasta, exist_ok=True)
    return f'Pasta garantida: {pasta}'


def _fs_backup_folder(cfg, ctx):
    import shutil
    from datetime import datetime
    pasta = _sub(cfg.get('directory', ''), ctx)
    destino = f"{pasta}_backup_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    shutil.copytree(pasta, destino)
    return destino


_FILE_STEPS = {
    'list_files': _fs_list_files,
    'delete_file': _fs_delete_file,
    'copy_file': _fs_copy_file,
    'move_file': _fs_move_file,
    'file_hash': _fs_file_hash,
    'file_info': _fs_file_info,
    'search_in_files': _fs_search_in_files,
    'convert_encoding': _fs_convert_encoding,
    'delete_folder': _fs_delete_folder,
    'ensure_dir': _fs_ensure_dir,
    'backup_folder': _fs_backup_folder,
}


# ==================== Sistema (da máquina do tenant) ====================

def _executar_sistema(tipo, cfg, ctx):
    try:
        import psutil
    except ImportError:
        raise RuntimeError('psutil não instalado nesta máquina. Rode: pip install psutil')

    if tipo == 'system_stats':
        return json.dumps({
            'cpu_percent': psutil.cpu_percent(interval=1),
            'ram_percent': psutil.virtual_memory().percent,
            'disco_percent': psutil.disk_usage('/').percent,
        })

    if tipo == 'list_processes':
        procs = [{'pid': p.pid, 'nome': p.info.get('name')} for p in psutil.process_iter(['name'])]
        return json.dumps(procs[:200])


# ==================== Mídia (precisa do binário ffmpeg instalado) ====================

def _executar_midia(tipo, cfg, ctx):
    try:
        import ffmpeg
    except ImportError:
        raise RuntimeError('ffmpeg-python não instalado nesta máquina. Rode: pip install ffmpeg-python (precisa também do binário ffmpeg no PATH)')

    origem = _sub(cfg.get('source_path') or cfg.get('file_path', ''), ctx)
    destino = _sub(cfg.get('dest_path', ''), ctx)

    if tipo == 'transcode_media':
        ffmpeg.input(origem).output(destino).overwrite_output().run(quiet=True)
        return destino

    if tipo == 'extract_audio':
        ffmpeg.input(origem).output(destino, vn=None, acodec='libmp3lame').overwrite_output().run(quiet=True)
        return destino

    if tipo == 'trim_media':
        inicio = _sub(str(cfg.get('value') or '0'), ctx)
        duracao = _sub(str(cfg.get('seconds') or '10'), ctx)
        ffmpeg.input(origem, ss=inicio, t=duracao).output(destino).overwrite_output().run(quiet=True)
        return destino

    if tipo == 'extract_video_frame':
        tempo = _sub(str(cfg.get('value') or '0'), ctx)
        ffmpeg.input(origem, ss=tempo).output(destino, vframes=1).overwrite_output().run(quiet=True)
        return destino


def _executar_browser_flow(cfg, ctx):
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        raise RuntimeError(
            'Playwright não instalado nesta máquina. Rode: '
            'pip install playwright && playwright install chromium'
        )

    acoes = cfg.get('actions') or []
    headless = NUVEM or _cfg_bool(cfg.get('headless', True))
    nav = _navegador(cfg)
    saida = {}

    with sync_playwright() as p:
        browser, contexto = _abrir_contexto(p, nav, headless)
        page = contexto.new_page()
        try:
            for acao in acoes:
                tipo_acao = acao.get('type')
                target = _sub(acao.get('target', ''), ctx)
                valor = _sub(acao.get('value', ''), ctx)
                if tipo_acao == 'open':
                    page.goto(target or valor)
                elif tipo_acao == 'click':
                    page.click(target)
                elif tipo_acao == 'type':
                    page.fill(target, valor)
                elif tipo_acao == 'wait':
                    page.wait_for_timeout(float(valor or 1) * 1000)
                elif tipo_acao == 'extract':
                    texto = page.inner_text(target)
                    if acao.get('variable'):
                        saida[acao['variable']] = texto
                    saida['_last'] = texto
                elif tipo_acao == 'screenshot':
                    page.screenshot(path=valor or 'screenshot.png')
                else:
                    raise ValueError(f'Ação de browser desconhecida: {tipo_acao}')
        finally:
            browser.close()

    return json.dumps(saida) if saida else 'ok'
