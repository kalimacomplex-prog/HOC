@echo off
chcp 65001 >nul
title HOC Agent

echo.
echo  ╔══════════════════════════════════════╗
echo  ║         HOC Agent - Instalador       ║
echo  ╚══════════════════════════════════════╝
echo.

:: Verifica se config.json existe
if not exist "%~dp0config.json" (
    echo  [ERRO] config.json nao encontrado!
    echo  Coloque este arquivo na mesma pasta que o agent.py
    echo  e o config.json baixados do HOC.
    pause
    exit /b 1
)

:: Verifica se Python esta instalado
python --version >nul 2>&1
if errorlevel 1 (
    echo  [!] Python nao encontrado. Instalando automaticamente...
    echo.

    :: Tenta instalar via winget (Windows 10/11)
    winget install -e --id Python.Python.3.11 --silent --accept-package-agreements --accept-source-agreements >nul 2>&1

    :: Aguarda instalacao
    timeout /t 5 /nobreak >nul

    :: Atualiza PATH para a sessao atual
    for /f "delims=" %%i in ('where python 2^>nul') do set PYTHON_PATH=%%i
    if not defined PYTHON_PATH (
        echo  Python nao encontrado mesmo apos instalacao.
        echo  Instale manualmente em: https://python.org/downloads
        echo  Marque "Add Python to PATH" na instalacao.
        pause
        exit /b 1
    )
    echo  [OK] Python instalado com sucesso!
    echo.
)

:: Instala dependencias silenciosamente
echo  [1/2] Instalando dependencias (requests, psutil)...
python -m pip install requests psutil --quiet --disable-pip-version-check >nul 2>&1
echo  [OK] Dependencias prontas.
echo.

:: Inicia o Agent
echo  [2/2] Iniciando HOC Agent...
echo  ─────────────────────────────────────────
echo.
cd /d "%~dp0"
python agent.py

echo.
echo  HOC Agent encerrado.
pause
