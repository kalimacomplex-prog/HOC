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

    raise ValueError(f'Tipo de step não suportado no agente: {tipo}')


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
