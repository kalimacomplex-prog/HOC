"""
hoc_ephemeral_runner.py — roda dentro de um runner efêmero do GitHub Actions
(workflow_dispatch), fazendo o papel de "Maquina" pra UM run de automação
do builder por vez.

Diferente do agent.py normal (que fica de pé indefinidamente numa máquina
real do tenant, com ícone de bandeja, comandos de robô local/nuvem
tradicionais etc.), esse processo é deliberadamente mínimo: só sabe
processar `automacaoSteps` do heartbeat, reaproveitando o mesmo
hoc_step_executor.py que o agente normal usa. Sai sozinho em dois casos:
  - fica um tempo sem receber nenhum step novo (sinal de que o run já
    terminou e não tem mais nada pra fazer);
  - o heartbeat volta 401 — a Maquina efêmera foi apagada no servidor
    assim que o run terminou (ver lib/automationEngine.js::_rodarLoop),
    então não existe mais razão pra esse runner continuar de pé.
Os dois casos evitam consumir minutos do GitHub Actions à toa depois que
o trabalho de verdade já acabou.
"""
import os
import sys
import threading
import time

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hoc_step_executor  # noqa: E402

SERVER = os.environ['HOC_API_URL'].rstrip('/')
MACHINE_KEY = os.environ['HOC_MACHINE_KEY']
IDLE_TIMEOUT_SECONDS = float(os.environ.get('IDLE_TIMEOUT_SECONDS', 90))
POLL_INTERVAL = 1.5

_ultimo_trabalho = time.time()
_lock = threading.Lock()
_ativos = set()


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def _post_resultado(dispatch_id, status, output, error):
    try:
        requests.post(
            f"{SERVER}/api/automacoes/step-dispatch/{dispatch_id}/resultado",
            json={'machineKey': MACHINE_KEY, 'status': status, 'output': output or '', 'error': error or ''},
            timeout=15,
        )
    except Exception as e:
        log(f"WARN: erro ao postar resultado do step {dispatch_id}: {e}")


def _rodar_step(dispatch_id, step, ctx):
    dispatch_id = str(dispatch_id)
    try:
        saida = hoc_step_executor.executar_step(step, ctx)
        _post_resultado(dispatch_id, 'concluido', saida, '')
        log(f"step {dispatch_id} ({step.get('type')}) concluído")
    except Exception as e:
        _post_resultado(dispatch_id, 'erro', '', str(e))
        log(f"WARN: step {dispatch_id} ({step.get('type')}) erro: {e}")
    finally:
        with _lock:
            _ativos.discard(dispatch_id)


def main():
    global _ultimo_trabalho
    log(f"Runner efêmero iniciado. Servidor: {SERVER}")

    while True:
        try:
            r = requests.post(
                f"{SERVER}/api/maquinas/heartbeat",
                json={'machineKey': MACHINE_KEY, 'cpu': 0, 'ram': 0, 'robosAtivos': 0, 'robosAtivosList': []},
                timeout=15,
            )
            if r.status_code == 401:
                log("Máquina efêmera não existe mais no servidor (run já terminou) — encerrando.")
                return
            r.raise_for_status()
            data = r.json()

            for item in data.get('automacaoSteps', []):
                dispatch_id = str(item.get('dispatchId', ''))
                if not dispatch_id:
                    continue
                with _lock:
                    if dispatch_id in _ativos:
                        continue
                    _ativos.add(dispatch_id)
                _ultimo_trabalho = time.time()
                t = threading.Thread(
                    target=_rodar_step,
                    args=(dispatch_id, item.get('step', {}), item.get('ctx', {})),
                    daemon=True,
                )
                t.start()

        except Exception as e:
            log(f"WARN: heartbeat falhou: {e}")

        with _lock:
            sem_trabalho_pendente = not _ativos
        if sem_trabalho_pendente and (time.time() - _ultimo_trabalho) > IDLE_TIMEOUT_SECONDS:
            log(f"Sem step novo há mais de {IDLE_TIMEOUT_SECONDS:.0f}s — encerrando.")
            return

        time.sleep(POLL_INTERVAL)


if __name__ == '__main__':
    main()
