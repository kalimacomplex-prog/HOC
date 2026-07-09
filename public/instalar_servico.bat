@echo off
title HOC Agent - Instalar como Servico

:: Garante que o diretorio de trabalho e a pasta do proprio bat
cd /d "%~dp0"

echo.
echo  ====================================================
echo   HOC Agent - Instalador de Servico (Task Scheduler)
echo  ====================================================
echo.
echo  Pasta: %CD%
echo.

:: Verificar arquivos necessarios
if not exist "config.json" (
    echo  ERRO: config.json nao encontrado!
    echo  Pasta atual: %CD%
    echo  Certifique-se de que config.json esta na mesma pasta.
    echo.
    pause
    exit /b 1
)

if not exist "iniciar_bg.vbs" (
    echo  ERRO: iniciar_bg.vbs nao encontrado!
    echo  Baixe o pacote completo em Operacoes ^> Agentes ^> Baixar Agent.
    echo.
    pause
    exit /b 1
)

:: Verificar Python
python --version >nul 2>&1
if errorlevel 1 (
    echo  ERRO: Python nao encontrado.
    echo  Execute primeiro iniciar.bat para instalar o Python.
    echo.
    pause
    exit /b 1
)

:: Nome da tarefa e caminho do VBS launcher
set TASK_NAME=HOC_Agent
set VBS_PATH=%CD%\iniciar_bg.vbs

:: Remover tarefa antiga se existir
schtasks /delete /tn "%TASK_NAME%" /f >nul 2>&1

:: Criar tarefa — usa wscript para rodar o VBS sem janela ao fazer login
schtasks /create /tn "%TASK_NAME%" /tr "wscript.exe \"%VBS_PATH%\"" /sc ONLOGON /ru "%USERNAME%" /rl HIGHEST /f

if errorlevel 1 (
    echo.
    echo  ERRO ao criar a tarefa agendada.
    echo  Tente executar este script como Administrador (botao direito ^> Executar como administrador).
    echo.
    pause
    exit /b 1
)

echo.
echo  ====================================================
echo   Servico instalado com sucesso!
echo  ====================================================
echo.
echo   Tarefa  : %TASK_NAME%
echo   Launcher: %VBS_PATH%
echo   Disparo : Ao fazer login no Windows (sem janela)
echo.
echo   Para iniciar AGORA sem reiniciar, escolha S abaixo.
echo   Para remover: schtasks /delete /tn "%TASK_NAME%" /f
echo.

choice /c SN /m "Deseja iniciar o Agent agora em background?"
if errorlevel 2 goto FIM

wscript.exe "%VBS_PATH%"

:FIM
echo.
pause
