<#
    Mantem o azuos-audit no ar em http://localhost:3001.

    Rodado pela tarefa agendada "Azuos Audit" no logon do Windows e, depois,
    a cada 5 minutos. Cada execucao:
      1. Sai na hora se outra execucao ainda estiver em andamento.
      2. Espera o PostgreSQL (porta 5432) aceitar conexao.
      3. Se a porta 3001 responde a tela de login com 200, nao faz nada.
      4. Se a porta esta ocupada mas o servidor nao responde (travado), encerra
         o processo e sobe de novo.
      5. Sobe em modo dev: as alteracoes no codigo aparecem sem recompilar, e
         nunca se roda "next build" sobre um dev em execucao - foi o que ja
         corrompeu a pasta .next e derrubou o sistema.

    Logs em logs\ (fora do git): inicializacao.log (este script) e
    servidor.log (saida do Next).
#>

$ErrorActionPreference = 'Stop'
$projeto = 'C:\Users\Grupo Azuos\azuos-audit'
$porta   = 3001
$url     = "http://localhost:$porta/entrar"
$logDir  = Join-Path $projeto 'logs'
$log     = Join-Path $logDir 'inicializacao.log'
$logSrv  = Join-Path $logDir 'servidor.log'
$node    = 'C:\Program Files\nodejs'

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Registrar($msg) {
    $linha = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    try { Add-Content -Path $log -Value $linha -Encoding utf8 -ErrorAction Stop } catch { }
}

function Responde([int]$segundos) {
    try {
        $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec $segundos -MaximumRedirection 0
        return $r.StatusCode -eq 200
    } catch {
        return $false
    }
}

# 1. Uma execucao por vez (a verificacao a cada 5 min nao pode se sobrepor a uma subida lenta).
$trava = New-Object System.Threading.Mutex($false, 'Local\AzuosAuditServidor')
if (-not $trava.WaitOne(0)) { exit 0 }

try {
    # Logs nao crescem sem limite.
    foreach ($arquivo in @($log, $logSrv)) {
        if ((Test-Path $arquivo) -and (Get-Item $arquivo).Length -gt 20MB) {
            Move-Item -Path $arquivo -Destination "$arquivo.anterior" -Force
        }
    }

    # 2. Banco.
    $banco = $false
    foreach ($i in 1..45) {
        if (Get-NetTCPConnection -LocalPort 5432 -State Listen -ErrorAction SilentlyContinue) { $banco = $true; break }
        Start-Sleep -Seconds 2
    }
    if (-not $banco) { Registrar 'ERRO: PostgreSQL nao respondeu na porta 5432 apos 90s'; exit 1 }

    # 3. Ja esta no ar e respondendo? (primeira compilacao do dev pode levar ate 1 min)
    $ocupada = Get-NetTCPConnection -LocalPort $porta -State Listen -ErrorAction SilentlyContinue
    if ($ocupada) {
        if (Responde 60) { exit 0 }
        Start-Sleep -Seconds 20
        if (Responde 60) { exit 0 }

        # 4. Travado: encerra a arvore de processos dona da porta.
        Registrar "porta $porta ocupada mas sem resposta - reiniciando"
        foreach ($processo in ($ocupada | Select-Object -ExpandProperty OwningProcess -Unique)) {
            & taskkill.exe /PID $processo /T /F 2>&1 | Out-Null
        }
        Start-Sleep -Seconds 5
    } else {
        Registrar "porta $porta livre - subindo"
    }

    # 5. Subir sem janela.
    $env:Path = "$node;$env:Path"
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'cmd.exe'
    $psi.Arguments = "/c npm run dev >> `"$logSrv`" 2>&1"
    $psi.WorkingDirectory = $projeto
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    [System.Diagnostics.Process]::Start($psi) | Out-Null

    foreach ($i in 1..24) {
        Start-Sleep -Seconds 5
        if ((Get-NetTCPConnection -LocalPort $porta -State Listen -ErrorAction SilentlyContinue) -and (Responde 60)) {
            Registrar "no ar em http://localhost:$porta"
            exit 0
        }
    }
    Registrar "ERRO: nao respondeu em http://localhost:$porta dentro de 2 minutos (ver logs\servidor.log)"
    exit 1
}
finally {
    $trava.ReleaseMutex()
}
