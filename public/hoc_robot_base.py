"""
hoc_robot_base.py — Framework orientado a objetos para robôs HOC
===================================================================
Classe base reutilizável para escrever robôs no padrão OOP. Encapsula tudo
que é "chapa" (boilerplate) de integração com o HOC:

  - Leitura das variáveis de ambiente injetadas automaticamente pelo Agent
    (HOC_SERVER, HOC_ROBOT_KEY, HOC_MACHINE_KEY, HOC_EXEC_ID, ...).
  - Logging: imprime no stdout (sempre capturado pelo Agent) e também posta
    via HTTP na execução do HOC, para aparecer na tela de acompanhamento.
  - Consumo de credenciais cadastradas no HOC (com cache simples).
  - Ciclo de vida da execução (preparar → executar → finalizar) com
    tratamento de erro e exit code corretos (0 = sucesso, 1 = erro), que é
    o que o Agent usa para marcar a execução como concluída ou com erro.
  - Encerramento gracioso: quando você interrompe a execução (ou ela dá
    timeout) pela tela do HOC, o Agent manda um sinal antes de forçar o
    encerramento — essa classe já escuta esse sinal e chama finalizar()
    mesmo nesse caso, dando uma janela (alguns segundos) pra fechar
    navegador/arquivo/conexão em vez de simplesmente morrer no meio.

Como usar: crie uma subclasse de HocRobot, implemente `executar()` (e
opcionalmente `preparar()`/`finalizar()`), e chame `main(SuaClasse)` no
bloco `if __name__ == '__main__':`. Veja robo_exemplo_oop.py.
"""

import os
import signal
import sys
import traceback
import requests


class InterrompidoPeloHOC(Exception):
    """Levantada quando o HOC pede pra interromper a execução (botão Interromper
    ou timeout) — permite tratar esse caso separado de um erro real, se quiser."""


def _handler_encerramento(signum, frame):
    raise InterrompidoPeloHOC()


class HocRobot:
    """Classe base para robôs HOC orientados a objetos."""

    def __init__(self, nome_credencial=None):
        self.server = os.environ.get('HOC_SERVER', 'http://localhost:3000').rstrip('/')
        self.robot_key = os.environ.get('HOC_ROBOT_KEY', '')
        self.machine_key = os.environ.get('HOC_MACHINE_KEY', '')
        self.exec_id = os.environ.get('HOC_EXEC_ID', '')
        self.robo_id = os.environ.get('HOC_ROBO_ID', '')
        self.robo_nome = os.environ.get('HOC_ROBO_NOME') or self.__class__.__name__
        self.nome_credencial = nome_credencial
        self._credenciais_cache = {}

        # No Windows, o Agent manda CTRL_BREAK_EVENT antes de forçar o encerramento
        # (interrupção manual ou timeout) — isso chega aqui como SIGBREAK. Só dá pra
        # registrar na thread principal; se falhar (ex: chamado de outra thread),
        # degrada normalmente e o Agent força o encerramento na hora de qualquer jeito.
        if sys.platform == 'win32' and hasattr(signal, 'SIGBREAK'):
            try:
                signal.signal(signal.SIGBREAK, _handler_encerramento)
            except Exception:
                pass

    @property
    def _headers_auth(self):
        if self.robot_key:
            return {'x-robot-key': self.robot_key}
        if self.machine_key:
            return {'x-machine-key': self.machine_key}
        return {}

    def log(self, mensagem, nivel='info'):
        """Loga no stdout (sempre visível pelo Agent/terminal) e via HTTP no HOC."""
        print(f"[{nivel.upper()}] {mensagem}", flush=True)
        if not self.exec_id or not self._headers_auth:
            return
        try:
            requests.post(
                f"{self.server}/api/robos/execucoes/{self.exec_id}/logs/externo",
                headers=self._headers_auth,
                json={'message': mensagem, 'status': nivel},
                timeout=5,
            )
        except Exception:
            pass  # o stdout já garante que o log não se perde

    def credencial(self, nome):
        """Busca (com cache em memória) os campos de uma credencial cadastrada no HOC."""
        if nome in self._credenciais_cache:
            return self._credenciais_cache[nome]
        r = requests.get(f"{self.server}/api/credenciais/{nome}/valor", headers=self._headers_auth, timeout=10)
        if r.status_code == 404:
            raise RuntimeError(f"Credencial '{nome}' não encontrada no HOC.")
        r.raise_for_status()
        campos = r.json().get('campos', {})
        self._credenciais_cache[nome] = campos
        return campos

    def preparar(self):
        """Hook opcional, chamado antes de executar() — sobrescreva se precisar."""

    def executar(self):
        """Obrigatório: implemente a lógica de negócio do robô aqui."""
        raise NotImplementedError('Implemente o método executar() na subclasse.')

    def finalizar(self):
        """Hook opcional, chamado sempre ao final — sucesso, erro OU interrupção
        pelo HOC — sobrescreva pra fechar navegador/arquivo/conexão."""

    def rodar(self):
        """Ponto de entrada: orquestra o ciclo de vida e devolve o exit code."""
        self.log(f'{self.robo_nome} iniciado.')
        try:
            self.preparar()
            self.executar()
            self.log('Concluído com sucesso.', nivel='success')
            return 0
        except InterrompidoPeloHOC:
            self.log('Interrompido pelo HOC — encerrando com segurança...', nivel='aviso')
            return 130
        except Exception as e:
            self.log(f'Erro: {e}', nivel='error')
            traceback.print_exc()
            return 1
        finally:
            self.finalizar()


def main(robot_cls):
    """Helper para o entry point: `if __name__ == '__main__': main(MeuRobo)`."""
    sys.exit(robot_cls().rodar())
