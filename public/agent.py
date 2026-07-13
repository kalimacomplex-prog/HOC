#!/usr/bin/env python3
"""
HOC Agent v1.1 - Robot Orchestrator Client
Docs: veja /operacoes -> Agentes para instruções de instalação

Requisitos: pip install requests psutil
Uso: python agent.py
"""

import json
import os
import queue
import sys
import subprocess
import threading
import time
import zipfile
import requests

# ── Carrega config ──────────────────────────────────────────────────────────
CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'config.json')

if not os.path.exists(CONFIG_FILE):
    print(f"[ERRO] config.json não encontrado em: {CONFIG_FILE}")
    print("       Baixe o pacote do Agent em Operações → Agentes → Baixar Agent")
    sys.exit(1)

with open(CONFIG_FILE, encoding='utf-8') as f:
    config = json.load(f)

SERVER      = config.get('server', 'http://localhost:3000').rstrip('/')
MACHINE_KEY = config.get('machineKey', '')
MACHINE_ID  = config.get('machineId', '')

if not MACHINE_KEY:
    print("[ERRO] machineKey ausente no config.json")
    sys.exit(1)

# ── psutil opcional ──────────────────────────────────────────────────────────
try:
    import psutil
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False
    print("[AVISO] psutil não instalado — CPU/RAM não serão reportados")
    print("        Execute: pip install psutil")

# ── Estado ───────────────────────────────────────────────────────────────────
running_procs = {}  # execId (str) -> subprocess.Popen
_lock = threading.Lock()

HEADERS = {
    'Content-Type': 'application/json',
    'x-machine-key': MACHINE_KEY
}

# ── Utilitários ──────────────────────────────────────────────────────────────

def log(level, msg):
    ts = time.strftime('%H:%M:%S')
    print(f"[{ts}] [{level}] {msg}")


def post_log(exec_id, message, status='info'):
    """Envia log de execução ao SaaS."""
    try:
        requests.post(
            f"{SERVER}/api/robos/execucoes/{exec_id}/logs",
            json={'machineKey': MACHINE_KEY, 'message': message, 'status': status},
            timeout=10
        )
    except Exception as e:
        log('WARN', f"Erro ao postar log: {e}")


def check_interrupt(exec_id):
    """Retorna True se a execução foi interrompida no SaaS."""
    try:
        r = requests.get(
            f"{SERVER}/api/robos/execucoes/{exec_id}/status",
            headers=HEADERS,
            timeout=5
        )
        return r.json().get('status') == 'interrompido'
    except Exception:
        return False


def kill_proc(proc):
    """Mata o processo e todos os filhos; fecha stdout para desbloquear o reader."""
    # 1. psutil: mata toda a árvore recursivamente
    try:
        import psutil
        parent = psutil.Process(proc.pid)
        for child in parent.children(recursive=True):
            try: child.kill()
            except Exception: pass
        try: parent.kill()
        except Exception: pass
    except Exception:
        pass
    # 2. CTRL_BREAK_EVENT para o grupo de processos (Windows, funciona com CREATE_NEW_PROCESS_GROUP)
    if sys.platform == 'win32':
        try:
            import signal as _sig
            os.kill(proc.pid, _sig.CTRL_BREAK_EVENT)
        except Exception:
            pass
    # 3. Fallback direto
    try: proc.terminate()
    except Exception: pass
    try: proc.kill()
    except Exception: pass
    # 4. Fecha o pipe para desbloquear readline
    try: proc.stdout.close()
    except Exception: pass


def notify(title, message):
    """Exibe notificação balloon no Windows via PowerShell (silencioso se falhar)."""
    if sys.platform != 'win32':
        return
    script = (
        "Add-Type -AssemblyName System.Windows.Forms;"
        "$n=New-Object System.Windows.Forms.NotifyIcon;"
        "$n.Icon=[System.Drawing.SystemIcons]::Information;"
        f"$n.BalloonTipTitle='{title}';"
        f"$n.BalloonTipText='{message}';"
        "$n.Visible=$true;"
        "$n.ShowBalloonTip(4000);"
        "Start-Sleep -Milliseconds 4500;"
        "$n.Dispose()"
    )
    try:
        subprocess.Popen(
            ['powershell', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
    except Exception:
        pass


# ── Download de ZIP do SaaS ──────────────────────────────────────────────────

def download_robot_zip(robo_id, workdir):
    """
    Baixa o ZIP do robô do SaaS e extrai em workdir.
    Retorna True se baixou com sucesso, False se não havia ZIP.
    """
    url = f"{SERVER}/api/robos/{robo_id}/package"
    try:
        r = requests.get(url, headers=HEADERS, timeout=60, stream=True)
        if r.status_code == 404:
            return False
        r.raise_for_status()
        zip_path = os.path.join(workdir, '_robot.zip')
        with open(zip_path, 'wb') as f:
            for chunk in r.iter_content(chunk_size=8192):
                f.write(chunk)
        with zipfile.ZipFile(zip_path, 'r') as zf:
            zf.extractall(workdir)
        os.remove(zip_path)
        log('INFO', f"ZIP extraído em {workdir}")
        return True
    except Exception as e:
        log('WARN', f"Falha ao baixar ZIP: {e}")
        return False


# ── Execução de robôs ────────────────────────────────────────────────────────

def run_robot(exec_id, command, timeout_min=30, git_url=None, git_branch='main',
              robo_id=None, robo_nome='Robô', pacotes_pip='', pre_comando=''):
    """Executa um robô como subprocess e faz streaming de logs ao SaaS."""
    exec_id = str(exec_id)
    base    = os.path.dirname(os.path.abspath(__file__))
    workdir = os.path.join(base, 'runtime', exec_id)
    os.makedirs(workdir, exist_ok=True)

    notify(f"HOC — {robo_nome}", "Execução iniciada...")

    try:
        # ── 1. Tentar baixar ZIP do SaaS ─────────────────────────────────
        if robo_id and not git_url:
            got_zip = download_robot_zip(robo_id, workdir)
            if got_zip:
                post_log(exec_id, "Pacote ZIP baixado e extraído.")

        # ── 2. Clonar/atualizar via Git ──────────────────────────────────
        if git_url:
            repo_dir = os.path.join(workdir, 'repo')
            if os.path.isdir(os.path.join(repo_dir, '.git')):
                log('INFO', f"[{exec_id}] git pull {git_url}")
                post_log(exec_id, f"Atualizando repositório: {git_url}")
                subprocess.run(['git', 'pull'], cwd=repo_dir, capture_output=True)
            else:
                log('INFO', f"[{exec_id}] git clone {git_url} branch={git_branch}")
                post_log(exec_id, f"Clonando repositório: {git_url} ({git_branch})")
                subprocess.run(
                    ['git', 'clone', '--depth=1', '-b', git_branch, git_url, repo_dir],
                    capture_output=True
                )
            workdir = repo_dir

        # ── 3. Instalar requirements.txt ─────────────────────────────────
        req_file = os.path.join(workdir, 'requirements.txt')
        if os.path.exists(req_file):
            log('INFO', f"[{exec_id}] instalando requirements.txt")
            post_log(exec_id, "Instalando dependências (requirements.txt)...")
            subprocess.run(
                [sys.executable, '-m', 'pip', 'install', '-r', req_file, '-q'],
                cwd=workdir, capture_output=True
            )

        # ── 4. Instalar pacotes pip adicionais ───────────────────────────
        if pacotes_pip:
            pkgs = [p.strip() for p in pacotes_pip.splitlines() if p.strip()]
            if pkgs:
                log('INFO', f"[{exec_id}] instalando pacotes: {pkgs}")
                post_log(exec_id, f"Instalando pacotes: {', '.join(pkgs)}")
                subprocess.run(
                    [sys.executable, '-m', 'pip', 'install', '-q'] + pkgs,
                    cwd=workdir, capture_output=True
                )

        # ── 5. Pré-comando ───────────────────────────────────────────────
        if pre_comando:
            log('INFO', f"[{exec_id}] pré-comando: {pre_comando}")
            post_log(exec_id, f"Pré-comando: {pre_comando}")
            subprocess.run(pre_comando, shell=True, cwd=workdir, capture_output=True)

        # ── 6. Executar ──────────────────────────────────────────────────
        log('INFO', f"[{exec_id}] executando: {command}")
        post_log(exec_id, f"Iniciando: {command}")

        extra = {'creationflags': subprocess.CREATE_NEW_PROCESS_GROUP} if sys.platform == 'win32' else {'start_new_session': True}
        proc = subprocess.Popen(
            command, shell=True,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding='utf-8', errors='replace',
            cwd=workdir, **extra
        )
        with _lock:
            running_procs[exec_id] = proc

        # Thread separada que mata o processo ao detectar interrupt ou timeout
        _stop_checker = threading.Event()
        _killed_by    = [None]
        deadline      = time.time() + timeout_min * 60

        def _checker():
            while not _stop_checker.is_set():
                if check_interrupt(exec_id):
                    _killed_by[0] = 'interrupt'
                    kill_proc(proc)
                    return
                if time.time() > deadline:
                    _killed_by[0] = 'timeout'
                    kill_proc(proc)
                    return
                _stop_checker.wait(5)

        checker_thread = threading.Thread(target=_checker, daemon=True)
        checker_thread.start()

        # Lê stdout em thread separada para não bloquear quando o processo é morto
        stdout_q = queue.Queue()

        def _reader():
            try:
                for line in iter(proc.stdout.readline, ''):
                    stdout_q.put(line)
            except Exception:
                pass
            stdout_q.put(None)  # sentinel: fim do stream

        reader_thread = threading.Thread(target=_reader, daemon=True)
        reader_thread.start()

        while True:
            try:
                line = stdout_q.get(timeout=0.5)
                if line is None:
                    break
                line = line.rstrip()
                if line:
                    log('BOT', f"[{exec_id}] {line}")
                    post_log(exec_id, line, 'info')
            except queue.Empty:
                if proc.poll() is not None:
                    break  # processo terminou

        proc.wait()
        _stop_checker.set()
        checker_thread.join(timeout=2)
        reader_thread.join(timeout=2)

        if _killed_by[0] == 'interrupt':
            log('INFO', f"[{exec_id}] interrompido pelo SaaS")
            post_log(exec_id, 'Execução interrompida pelo orquestrador.', 'info')
            notify(f"HOC — {robo_nome}", "Execução interrompida.")
        elif _killed_by[0] == 'timeout':
            log('WARN', f"[{exec_id}] timeout após {timeout_min}min")
            post_log(exec_id, f'Timeout após {timeout_min} minutos.', 'error')
            notify(f"HOC — {robo_nome}", f"Timeout após {timeout_min} min.")
        elif proc.returncode == 0:
            log('INFO', f"[{exec_id}] concluído ✓")
            post_log(exec_id, 'Execução concluída com sucesso.', 'success')
            notify(f"HOC — {robo_nome}", "Concluído com sucesso ✓")
        else:
            log('WARN', f"[{exec_id}] erro (código {proc.returncode})")
            post_log(exec_id, f'Erro na execução (exit code {proc.returncode}).', 'error')
            notify(f"HOC — {robo_nome}", f"Erro (exit {proc.returncode})")

    except Exception as e:
        log('ERR', f"[{exec_id}] exceção: {e}")
        post_log(exec_id, f'Erro inesperado: {e}', 'error')
        notify(f"HOC — {robo_nome}", "Erro inesperado na execução.")
    finally:
        with _lock:
            running_procs.pop(exec_id, None)


def run_webhook(exec_id, webhook_url, payload, robo_nome='Robô'):
    """Dispara robô de nuvem via POST no webhook configurado."""
    exec_id = str(exec_id)
    notify(f"HOC — {robo_nome}", "Disparando webhook...")
    try:
        post_log(exec_id, f"Disparando webhook: {webhook_url}")
        r = requests.post(webhook_url, json=payload, timeout=30)
        status = 'success' if r.ok else 'error'
        post_log(exec_id, f"Webhook respondeu: {r.status_code}", status)
        notify(f"HOC — {robo_nome}", f"Webhook: {r.status_code} {'OK' if r.ok else 'ERRO'}")
    except Exception as e:
        log('ERR', f"[{exec_id}] webhook falhou: {e}")
        post_log(exec_id, f'Webhook falhou: {e}', 'error')
        notify(f"HOC — {robo_nome}", "Webhook falhou.")
    finally:
        with _lock:
            running_procs.pop(exec_id, None)


# ── Heartbeat loop ────────────────────────────────────────────────────────────

def heartbeat_loop():
    """Envia heartbeat a cada 20s e processa comandos de execução pendentes."""
    while True:
        try:
            cpu = round(psutil.cpu_percent(interval=1), 1) if HAS_PSUTIL else 0
            ram = round(psutil.virtual_memory().percent, 1) if HAS_PSUTIL else 0

            with _lock:
                ativos = list(running_procs.keys())

            payload = {
                'machineKey':      MACHINE_KEY,
                'cpu':             cpu,
                'ram':             ram,
                'robosAtivos':     len(ativos),
                'robosAtivosList': ativos
            }

            r = requests.post(f"{SERVER}/api/maquinas/heartbeat", json=payload, timeout=15)
            data = r.json()

            log('HB', f"cpu={cpu}% ram={ram}% ativos={len(ativos)} status={data.get('status','?')}")

            # Processar comandos pendentes
            for cmd in data.get('commands', []):
                exec_id = str(cmd.get('execId', ''))
                if not exec_id:
                    continue
                with _lock:
                    if exec_id in running_procs:
                        continue  # já rodando

                tipo       = cmd.get('tipo', 'local')
                command    = cmd.get('command', '')
                timeout    = cmd.get('timeout', 30)
                robo_nome  = cmd.get('roboNome', 'Robô')
                robo_id    = cmd.get('roboId', None)

                if tipo in ('nuvem', 'cloud') and cmd.get('webhookUrl'):
                    t = threading.Thread(
                        target=run_webhook,
                        args=(exec_id, cmd['webhookUrl'], cmd.get('webhookPayload', {}), robo_nome),
                        daemon=True
                    )
                else:
                    if not command:
                        log('WARN', f"Comando vazio para exec {exec_id}")
                        continue
                    t = threading.Thread(
                        target=run_robot,
                        args=(exec_id, command, timeout),
                        kwargs={
                            'git_url':    cmd.get('gitUrl'),
                            'git_branch': cmd.get('gitBranch', 'main'),
                            'robo_id':    robo_id,
                            'robo_nome':  robo_nome,
                            'pacotes_pip':cmd.get('pacotesPip', ''),
                            'pre_comando':cmd.get('preComando', ''),
                        },
                        daemon=True
                    )
                t.start()
                log('INFO', f"Iniciando execução {exec_id} ({tipo}): {command or cmd.get('webhookUrl')}")

        except requests.exceptions.ConnectionError:
            log('WARN', f"Sem conexão com {SERVER} — tentando em 20s...")
        except Exception as e:
            log('ERR', f"Heartbeat falhou: {e}")

        time.sleep(20)


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == '__main__':
    log('INFO', '=' * 50)
    log('INFO', 'HOC Agent v1.1 iniciando...')
    log('INFO', f"Servidor : {SERVER}")
    log('INFO', f"Machine  : {MACHINE_ID}")
    log('INFO', 'Pressione Ctrl+C para parar')
    log('INFO', '=' * 50)

    hb_thread = threading.Thread(target=heartbeat_loop, daemon=True)
    hb_thread.start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        log('INFO', 'Parando HOC Agent...')
        sys.exit(0)
