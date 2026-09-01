@echo off
title HOC Agent

echo.
echo  ====================================
echo   HOC Agent - Instalador
echo  ====================================
echo.

:: Verifica se config.json existe
if not exist "%~dp0config.json" (
    echo  ERRO: config.json nao encontrado!
    echo  Coloque este arquivo na mesma pasta que agent.py e config.json.
    echo.
    pause
    exit /b 1
)

:: Verifica Python
python --version >nul 2>&1
if errorlevel 1 (
    echo  Python nao encontrado. Tentando instalar via winget...
    echo.
    winget install -e --id Python.Python.3.11 --silent --accept-package-agreements --accept-source-agreements
    timeout /t 10 /nobreak >nul
    python --version >nul 2>&1
    if errorlevel 1 (
        echo.
        echo  ERRO: Python nao instalado automaticamente.
        echo  Instale manualmente em: https://python.org/downloads
        echo  Marque "Add Python to PATH" na instalacao.
        echo.
        pause
        exit /b 1
    )
    echo  Python instalado com sucesso!
    echo.
)

:: Instala dependencias
echo  Instalando dependencias...
python -m pip install requests psutil pystray pillow
if errorlevel 1 (
    echo.
    echo  ERRO ao instalar dependencias. Verifique sua conexao com a internet.
    echo.
    pause
    exit /b 1
)

:: Encerra instancias antigas do Agent (evita processos duplicados disputando comandos)
wmic process where "CommandLine like '%%agent.py%%' and not CommandLine like '%%wmic%%'" call terminate >nul 2>&1

echo.
echo  Iniciando HOC Agent...
echo  ------------------------------------
echo.

cd /d "%~dp0"
python agent.py

echo.
echo  HOC Agent encerrado.
pause
