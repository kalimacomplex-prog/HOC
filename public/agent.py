#!/usr/bin/env python3
"""
HOC Agent v1.0 - Robot Orchestrator Client
Docs: veja /operacoes -> Agentes para instruções de instalação

Requisitos: pip install requests psutil
Uso: python agent.py
"""

import json
import os
import sys
import subprocess
import threading
import time
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


# ── Execução de robôs ────────────────────────────────────────────────────────

def run_robot(exec_id, command, timeout_min=30, git_url=None, git_branch='main'):
    """Executa um robô como subprocess e faz streaming de logs ao SaaS."""
    exec_id = str(exec_id)
    workdir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'runtime', exec_id)
    os.makedirs(workdir, exist_ok=True)

    try:
        # ── Clonar/atualizar via Git ─────────────────────────────────────
        if git_url:
            repo_dir = os.path.join(workdir, 'repo')
            if os.path.isdir(os.path.join(repo_dir, '.git')):
                log('INFO', f"[{exec_id}] git pull {git_url}")
                post_log(exec_id, f"Atualizando repositório: {git_url}")
                subprocess.run(['git', 'pull'], cwd=repo_dir, capture_output=True)
            else:
                log('INFO', f"[{exec_id}] git clone {git_url} branch={git_branch}")
                post_log(exec_id, f"Clonando repositório: {git_url} ({git_branch})")
                subprocess.run(['git', 'clone', '--depth=1', '-b', git_branch, git_url, repo_dir], capture_output=True)
            workdir = repo_dir

        # ── Instalar dependências ────────────────────────────────────────
        req_file = os.path.join(workdir, 'requirements.txt')
        if os.path.exists(req_file):
            log('INFO', f"[{exec_id}] instalando requirements.txt")
            post_log(exec_id, "Instalando dependências (requirements.txt)...")
            subprocess.run(
                [sys.executable, '-m', 'pip', 'install', '-r', req_file, '-q'],
                cwd=workdir, capture_output=True
            )

        # ── Executar ─────────────────────────────────────────────────────
        log('INFO', f"[{exec_id}] executando: {command}")
        post_log(exec_id, f"Iniciando: {command}")

        proc = subprocess.Popen(
            command, shell=True,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding='utf-8', errors='replace',
            cwd=workdir
        )
        with _lock:
            running_procs[exec_id] = proc

        deadline = time.time() + timeout_min * 60

        for line in iter(proc.stdout.readline, ''):
            line = line.rstrip()
            if line:
                log('BOT', f"[{exec_id}] {line}")
                post_log(exec_id, line, 'info')
            if check_interrupt(exec_id):
                proc.kill()
                log('INFO', f"[{exec_id}] interrompido pelo SaaS")
                post_log(exec_id, 'Execução interrompida pelo orquestrador.', 'error')
                return
            if time.time() > deadline:
                proc.kill()
                log('WARN', f"[{exec_id}] timeout após {timeout_min}min")
                post_log(exec_id, f'Timeout após {timeout_min} minutos.', 'error')
                return

        proc.wait()
        if proc.returncode == 0:
            log('INFO', f"[{exec_id}] concluído ✓")
            post_log(exec_id, 'Execução concluída com sucesso.', 'success')
        else:
            log('WARN', f"[{exec_id}] erro (código {proc.returncode})")
            post_log(exec_id, f'Erro na execução (exit code {proc.returncode}).', 'error')

    except Exception as e:
        log('ERR', f"[{exec_id}] exceção: {e}")
        post_log(exec_id, f'Erro inesperado: {e}', 'error')
    finally:
        with _lock:
            running_procs.pop(exec_id, None)


def run_webhook(exec_id, webhook_url, payload):
    """Dispara robô de nuvem via POST no webhook configurado."""
    exec_id = str(exec_id)
    try:
        post_log(exec_id, f"Disparando webhook: {webhook_url}")
        r = requests.post(webhook_url, json=payload, timeout=30)
        post_log(exec_id, f"Webhook respondeu: {r.status_code}", 'success' if r.ok else 'error')
    except Exception as e:
        log('ERR', f"[{exec_id}] webhook falhou: {e}")
        post_log(exec_id, f'Webhook falhou: {e}', 'error')
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

                tipo    = cmd.get('tipo', 'local')
                command = cmd.get('command', '')
                timeout = cmd.get('timeout', 30)

                if tipo in ('nuvem', 'cloud') and cmd.get('webhookUrl'):
                    t = threading.Thread(
                        target=run_webhook,
                        args=(exec_id, cmd['webhookUrl'], cmd.get('webhookPayload', {})),
                        daemon=True
                    )
                else:
                    if not command:
                        log('WARN', f"Comando vazio para exec {exec_id}")
                        continue
                    t = threading.Thread(
                        target=run_robot,
                        args=(exec_id, command, timeout),
                        kwargs={'git_url': cmd.get('gitUrl'), 'git_branch': cmd.get('gitBranch', 'main')},
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
    log('INFO', 'HOC Agent v1.0 iniciando...')
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
