' HOC Agent - Iniciador silencioso (sem janela)
' Use este arquivo para rodar o agent em background
' O processo continua mesmo fechando qualquer janela

Dim fso, shell, scriptDir, agentPath, configPath

Set fso   = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir  = fso.GetParentFolderName(WScript.ScriptFullName)
agentPath  = scriptDir & "\agent.py"
configPath = scriptDir & "\config.json"

' Verifica config.json
If Not fso.FileExists(configPath) Then
    MsgBox "config.json nao encontrado em:" & vbCrLf & scriptDir & vbCrLf & vbCrLf & _
           "Baixe o pacote completo em Operacoes > Agentes > Baixar Agent.", _
           vbCritical, "HOC Agent"
    WScript.Quit 1
End If

' Verifica agent.py
If Not fso.FileExists(agentPath) Then
    MsgBox "agent.py nao encontrado em:" & vbCrLf & scriptDir, vbCritical, "HOC Agent"
    WScript.Quit 1
End If

' Inicia python de forma oculta (0 = sem janela, False = nao aguarda)
shell.Run "python """ & agentPath & """", 0, False

' Confirma inicio (opcional - remova a linha abaixo se nao quiser popup)
MsgBox "HOC Agent iniciado em background." & vbCrLf & "A maquina aparecera Online em ate 20 segundos.", _
       vbInformation, "HOC Agent"
