"""
hoc_step_executor.py — implementa os steps do builder de automação de Robôs
que precisam rodar na máquina do tenant (read_file, write_file, run_command,
browser_flow), shipado junto no pacote do Agent e chamado por agent.py
quando o heartbeat retorna algo em `automacaoSteps`.

Modelo de browser deliberadamente simples nesta fase (ver plano em
C:\\Users\\novai\\.claude\\plans\\enchanted-gathering-pearl.md): uma lista de
ações compiladas e rodadas de uma vez num único browser, sem sessão
persistente entre steps (isso fica pra uma fase posterior).
"""
import json
import os
import re
import subprocess


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

    raise ValueError(f'Tipo de step não suportado no agente: {tipo}')


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
    headless = cfg.get('headless', True)
    saida = {}

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        page = browser.new_page()
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
