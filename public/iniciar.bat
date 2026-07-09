@echo off
cd /d "%~dp0"
title HOC Agent - Setup

echo.
echo  HOC Agent - Instalador
echo  =========================================
echo.

:: ── Verifica config.json ──────────────────
if not exist "config.json" (
    echo  ERRO: config.json nao encontrado em:
    echo  %CD%
    echo.
    echo  Baixe o pacote em Operacoes ^> Agentes ^> Baixar Agent.
    pause & exit /b 1
)

:: ── Verifica / instala Python ─────────────
python --version >nul 2>&1
if not errorlevel 1 goto :instalar_deps

echo  Python nao encontrado. Instalando...
winget install -e --id Python.Python.3.11 --silent --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
    echo.
    echo  Instalacao automatica falhou.
    echo  Instale manualmente: https://python.org/downloads
    echo  Marque "Add Python to PATH" na instalacao.
    pause & exit /b 1
)
:: Atualiza PATH da sessao atual
for /f "delims=" %%i in ('powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable(\"PATH\",\"Machine\")+\";\"+ [Environment]::GetEnvironmentVariable(\"PATH\",\"User\")"') do set "PATH=%%i"
python --version >nul 2>&1
if errorlevel 1 (
    echo  Python instalado mas nao encontrado no PATH.
    echo  Feche e abra este arquivo novamente.
    pause & exit /b 1
)
echo  Python instalado!

:instalar_deps
echo  Instalando dependencias...
python -m pip install requests psutil -q
if errorlevel 1 (
    echo  Falha ao instalar dependencias. Verifique a internet.
    pause & exit /b 1
)
echo  Dependencias OK.
echo.

:: ── Encontra caminho completo do python.exe ───
set "PYTHON_EXE="
for /f "tokens=*" %%i in ('where python 2^>nul') do (
    set "PYTHON_EXE=%%i"
    goto :py_encontrado
)
:py_encontrado
if not defined PYTHON_EXE (
    echo  Nao foi possivel localizar python.exe.
    pause & exit /b 1
)

:: ── Cria launcher VBS com caminho absoluto ────
:: Usa caminho completo para garantir que funciona fora do PATH
(
    echo Set sh = CreateObject^("WScript.Shell"^)
    echo sh.Run """%PYTHON_EXE%"" ""%~dp0agent.py""", 0, False
) > "%~dp0_agent_bg.vbs"

:: ── Registra auto-inicio no boot ─────────
schtasks /delete /tn "HOC_Agent" /f >nul 2>&1
schtasks /create /tn "HOC_Agent" /tr "wscript.exe \"%~dp0_agent_bg.vbs\"" /sc ONLOGON /f >nul 2>&1
if not errorlevel 1 echo  Auto-inicio configurado para o proximo login.

:: ── Inicia agora via wscript (processo independente) ──
wscript.exe "%~dp0_agent_bg.vbs"

echo.
echo  Agent iniciado em background!
echo  Pode fechar esta janela - o Agent continua rodando.
echo  A maquina aparecera Online em ate 20 segundos.
echo.
timeout /t 4 /nobreak >nul
