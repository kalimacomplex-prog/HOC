"""
hoc_ephemeral_runner.py — roda dentro de um runner efêmero do GitHub Actions
(workflow_dispatch), fazendo o papel da "Maquina" da Nuvem de UMA empresa —
uma execução por vez; as seguintes da fila reaproveitam o mesmo runner, e o
servidor o apaga assim que não há execução nem fila (ver
lib/automationEngine.js::obterMaquinaEfemera).

Diferente do agent.py normal (que fica de pé indefinidamente numa máquina
real do tenant, com ícone de bandeja etc.), esse processo é deliberadamente
mínimo. Sabe processar dois tipos de trabalho do heartbeat:
  - `automacaoSteps` (robô do builder) — reaproveita o mesmo
    hoc_step_executor.py que o agente normal usa;
  - `commands` (robô Git/ZIP configurado como "Nuvem (GitHub Actions)") —
    reaproveita agent.run_robot (clone/ZIP, pip, subprocess, logs).
Sai sozinho em três casos:
  - fica um tempo sem receber nenhum trabalho novo (sinal de que o run já
    terminou e não tem mais nada pra fazer);
  - o heartbeat volta 401 — a Maquina efêmera foi apagada no servidor
    (fim do run do builder, ver lib/automationEngine.js::_rodarLoop, ou
    o aviso /api/maquinas/efemera/encerrar abaixo);
  - terminou o(s) comando(s) de robô: avisa o servidor, que apaga a
    Maquina, e o próximo heartbeat (401) encerra o processo.
Tudo isso evita consumir minutos do GitHub Actions à toa depois que o
trabalho de verdade já acabou.
"""
import json
import os
import sys
import threading
import time

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import hoc_step_executor  # noqa: E402

SERVER = os.environ['HOC_API_URL'].rstrip('/')
MACHINE_KEY = os.environ['HOC_MACHINE_KEY']
# Rede de segurança: o normal é o servidor apagar a Maquina quando a última
# execução da empresa sai dela e a fila está vazia (401 no heartbeat). Não é
# "tempo ocioso": uma execução pode passar minutos só em passos do servidor
# (IA, HTTP…) sem mandar nada para a máquina — por isso a folga de 300 s.
IDLE_TIMEOUT_SECONDS = float(os.environ.get('IDLE_TIMEOUT_SECONDS', 300))
POLL_INTERVAL = 1.5

# agent.py lê config.json no import (é assim que o agente instalado numa
# máquina real descobre servidor/chave) — aqui a "instalação" é só esse arquivo.
with open(os.path.join(HERE, 'config.json'), 'w', encoding='utf-8') as _f:
    json.dump({'server': SERVER, 'machineKey': MACHINE_KEY, 'machineId': 'ephemeral'}, _f)
import agent  # noqa: E402

_ultimo_trabalho = time.time()
_lock = threading.Lock()
_ativos = set()          # dispatchIds de steps do builder em andamento
_cmds_ativos = set()     # execIds de robôs Git/ZIP em andamento


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


def _avisar_encerramento():
    try:
        requests.post(f"{SERVER}/api/maquinas/efemera/encerrar", json={'machineKey': MACHINE_KEY}, timeout=15)
    except Exception as e:
        log(f"WARN: erro ao avisar encerramento: {e}")


def _rodar_comando(cmd):
    exec_id = str(cmd.get('execId', ''))
    try:
        agent.run_robot(
            exec_id, cmd.get('command', ''), cmd.get('timeout', 30),
            git_url=cmd.get('gitUrl'), git_branch=cmd.get('gitBranch', 'main'),
            robo_id=cmd.get('roboId'), robo_nome=cmd.get('roboNome', 'Robô'),
            pacotes_pip=cmd.get('pacotesPip', ''), pre_comando=cmd.get('preComando', ''),
            api_key=cmd.get('apiKey', ''),
        )
    except Exception as e:
        log(f"WARN: comando {exec_id} erro: {e}")
        agent.post_log(exec_id, f'Erro inesperado no runner: {e}', 'error')
    finally:
        with _lock:
            _cmds_ativos.discard(exec_id)
            terminou_tudo = not _cmds_ativos and not _ativos
        log(f"comando {exec_id} finalizado")
        if terminou_tudo:
            _avisar_encerramento()


def main():
    global _ultimo_trabalho
    log(f"Runner efêmero iniciado. Servidor: {SERVER}")

    while True:
        try:
            with _lock:
                cmds = list(_cmds_ativos)
            r = requests.post(
                f"{SERVER}/api/maquinas/heartbeat",
                json={'machineKey': MACHINE_KEY, 'cpu': 0, 'ram': 0, 'robosAtivos': len(cmds), 'robosAtivosList': cmds},
                timeout=15,
            )
            if r.status_code == 401:
                log("Máquina efêmera não existe mais no servidor (run já terminou) — encerrando.")
                return
            r.raise_for_status()
            data = r.json()

            for cmd in data.get('commands', []):
                exec_id = str(cmd.get('execId', ''))
                if not exec_id:
                    continue
                if not cmd.get('command'):
                    log(f"WARN: exec {exec_id} sem comando (defina Arquivo principal/Comando no robô)")
                    agent.post_log(exec_id, 'Robô sem comando de execução — defina o Arquivo principal ou o Comando.', 'error')
                    continue
                with _lock:
                    if exec_id in _cmds_ativos:
                        continue
                    _cmds_ativos.add(exec_id)
                _ultimo_trabalho = time.time()
                log(f"Iniciando robô {cmd.get('roboNome')} (exec {exec_id}): {cmd.get('command')}")
                threading.Thread(target=_rodar_comando, args=(cmd,), daemon=True).start()

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
            sem_trabalho_pendente = not _ativos and not _cmds_ativos
        if sem_trabalho_pendente and (time.time() - _ultimo_trabalho) > IDLE_TIMEOUT_SECONDS:
            log(f"Sem step novo há mais de {IDLE_TIMEOUT_SECONDS:.0f}s — encerrando.")
            return

        time.sleep(POLL_INTERVAL)


if __name__ == '__main__':
    main()
