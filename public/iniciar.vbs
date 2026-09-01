' HOC Agent - Instalador silencioso
' Duplo clique: sem janela, sem CMD, instala tudo e sobe o agent
Option Explicit

Dim fso, sh, scriptDir, q
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
q = Chr(34)

' ── Verifica config.json ──────────────────────────────────────────
If Not fso.FileExists(scriptDir & "\config.json") Then
    MsgBox "config.json nao encontrado em:" & vbCrLf & scriptDir & vbCrLf & vbCrLf & _
           "Baixe o pacote em Operacoes > Agentes > Baixar Agent.", _
           vbCritical, "HOC Agent"
    WScript.Quit 1
End If

' ── Encontra python.exe ───────────────────────────────────────────
Dim pythonExe
pythonExe = EncontrarPython()

If pythonExe = "" Then
    MsgBox "Python nao encontrado. Instalando automaticamente..." & vbCrLf & _
           "Pode demorar alguns minutos. Clique OK para continuar.", _
           vbInformation, "HOC Agent"
    sh.Run "winget install -e --id Python.Python.3.11 --silent --accept-package-agreements --accept-source-agreements", 0, True
    pythonExe = EncontrarPython()
End If

If pythonExe = "" Then
    MsgBox "Nao foi possivel instalar Python." & vbCrLf & vbCrLf & _
           "Instale manualmente:" & vbCrLf & _
           "1. Acesse https://python.org/downloads" & vbCrLf & _
           "2. Baixe e instale" & vbCrLf & _
           "3. Marque 'Add Python to PATH'" & vbCrLf & _
           "4. Execute este arquivo novamente.", _
           vbCritical, "HOC Agent"
    WScript.Quit 1
End If

' ── Encerra instancias antigas do Agent (evita processos duplicados) ────────
' Rodar iniciar.vbs varias vezes (de pastas diferentes, por exemplo) nunca
' matava a instancia anterior — elas ficavam disputando os comandos pendentes,
' causando falhas aleatorias. Agora sempre garante só UMA rodando.
sh.Run "wmic process where " & q & "CommandLine like '%agent.py%' and not CommandLine like '%wmic%'" & q & " call terminate", 0, True
WScript.Sleep 1000

' ── Instala dependencias ──────────────────────────────────────────
Dim pipExit
pipExit = sh.Run(q & pythonExe & q & " -m pip install requests psutil pystray pillow -q", 0, True)

' Confere especificamente se o icone da bandeja (pystray/pillow) ficou disponivel —
' isso pode falhar mesmo com pipExit=0 (ex: erro so num dos pacotes) e falhava
' silenciosamente antes, sem nenhum aviso pro usuario.
Dim trayExit
trayExit = sh.Run(q & pythonExe & q & " -c " & q & "import pystray, PIL" & q, 0, True)

If trayExit <> 0 Then
    MsgBox "Nao foi possivel instalar o icone da bandeja (pystray/pillow)." & vbCrLf & vbCrLf & _
           "O Agent vai continuar funcionando normalmente (sem o icone verde/vermelho perto do relogio)." & vbCrLf & vbCrLf & _
           "Para tentar de novo manualmente, abra um Prompt de Comando nesta pasta e rode:" & vbCrLf & _
           q & pythonExe & q & " -m pip install pystray pillow", _
           vbExclamation, "HOC Agent — icone da bandeja"
End If

' ── Cria launcher permanente com caminho absoluto ────────────────
Dim vbsPath, f
vbsPath = scriptDir & "\_agent_bg.vbs"
Set f = fso.CreateTextFile(vbsPath, True)
f.WriteLine "Set sh = CreateObject(" & q & "WScript.Shell" & q & ")"
f.WriteLine "sh.Run " & q & q & q & pythonExe & q & q & " " & q & q & scriptDir & "\agent.py" & q & q & q & ", 0, False"
f.Close

' ── Registra auto-inicio no boot ─────────────────────────────────
sh.Run "schtasks /delete /tn " & q & "HOC_Agent" & q & " /f", 0, True
sh.Run "schtasks /create /tn " & q & "HOC_Agent" & q & _
       " /tr " & q & "wscript.exe " & q & q & vbsPath & q & q & q & _
       " /sc ONLOGON /f", 0, True

' ── Sobe o agent agora ───────────────────────────────────────────
sh.Run "wscript.exe " & q & vbsPath & q, 0, False

MsgBox "HOC Agent iniciado!" & vbCrLf & _
       "A maquina aparecera Online em ate 20 segundos." & vbCrLf & vbCrLf & _
       "O Agent iniciara automaticamente nos proximos logins.", _
       vbInformation, "HOC Agent"

' ── Encontra python.exe no sistema ───────────────────────────────
Function EncontrarPython()
    Dim exec, linha
    On Error Resume Next
    Set exec = sh.Exec("cmd /c where python 2>nul")
    If Err.Number = 0 Then
        Do While Not exec.StdOut.AtEndOfStream
            linha = Trim(exec.StdOut.ReadLine())
            If linha <> "" And InStr(LCase(linha), "python.exe") > 0 Then
                EncontrarPython = linha
                Exit Function
            End If
        Loop
    End If
    On Error GoTo 0

    Dim appdata, progFiles, caminhos, i
    appdata   = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%")
    progFiles = sh.ExpandEnvironmentStrings("%ProgramFiles%")

    caminhos = Array( _
        appdata   & "\Programs\Python\Python313\python.exe", _
        appdata   & "\Programs\Python\Python312\python.exe", _
        appdata   & "\Programs\Python\Python311\python.exe", _
        appdata   & "\Programs\Python\Python310\python.exe", _
        appdata   & "\Programs\Python\Python39\python.exe",  _
        progFiles & "\Python313\python.exe", _
        progFiles & "\Python312\python.exe", _
        progFiles & "\Python311\python.exe", _
        progFiles & "\Python310\python.exe"  _
    )

    For i = 0 To UBound(caminhos)
        If fso.FileExists(caminhos(i)) Then
            EncontrarPython = caminhos(i)
            Exit Function
        End If
    Next

    EncontrarPython = ""
End Function
