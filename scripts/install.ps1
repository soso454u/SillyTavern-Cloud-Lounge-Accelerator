[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$SillyTavernRoot = $env:SILLYTAVERN_ROOT,

    [switch]$LazyCharacters
)

$ErrorActionPreference = 'Stop'
$RepositoryUrl = if ($env:ACCELERATOR_REPOSITORY) { $env:ACCELERATOR_REPOSITORY } else { 'https://github.com/soso454u/SillyTavern-Cloud-Lounge-Accelerator.git' }
$RepositoryBranch = if ($env:ACCELERATOR_BRANCH) { $env:ACCELERATOR_BRANCH } else { 'main' }
$ProjectDirectory = 'cloud-lounge-accelerator'

function Write-Step([string]$Message) {
    Write-Host "[云酒馆加速器] $Message" -ForegroundColor Cyan
}

function Test-SillyTavernRoot([string]$Candidate) {
    if (-not (Test-Path -LiteralPath (Join-Path $Candidate 'server.js') -PathType Leaf)) { return $false }
    if (-not (Test-Path -LiteralPath (Join-Path $Candidate 'package.json') -PathType Leaf)) { return $false }
    if (-not (Test-Path -LiteralPath (Join-Path $Candidate 'config.yaml') -PathType Leaf)) { return $false }
    $PackageText = [System.IO.File]::ReadAllText((Join-Path $Candidate 'package.json'))
    return $PackageText -match '"name"\s*:\s*"sillytavern"'
}

function Resolve-SillyTavernRoot {
    if ($SillyTavernRoot) {
        $Resolved = (Resolve-Path -LiteralPath $SillyTavernRoot).Path
        if (-not (Test-SillyTavernRoot $Resolved)) {
            throw "这不是 SillyTavern 根目录：$Resolved`n根目录中应直接存在 server.js、package.json 和 config.yaml。"
        }
        return $Resolved
    }

    $Current = (Get-Location).Path
    if (Test-SillyTavernRoot $Current) { return $Current }

    $Candidates = @(
        'C:\SillyTavern',
        (Join-Path $env:USERPROFILE 'SillyTavern'),
        (Join-Path $env:USERPROFILE 'Desktop\SillyTavern')
    ) | Where-Object { $_ -and (Test-SillyTavernRoot $_) }

    if ($Candidates.Count -eq 1) { return (Resolve-Path -LiteralPath $Candidates[0]).Path }
    throw '无法唯一确定 SillyTavern 根目录。请先 cd 进入根目录，或使用 -SillyTavernRoot 传入路径。'
}

function Invoke-Git([string[]]$Arguments) {
    & git @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Git 命令执行失败：git $($Arguments -join ' ')"
    }
}

function Install-OrUpdateRepository([string]$Destination, [string]$Label) {
    if ((Test-Path -LiteralPath $Destination) -and -not (Test-Path -LiteralPath (Join-Path $Destination '.git') -PathType Container)) {
        throw "$Label 目录已存在，但不是 Git 仓库：$Destination`n为避免覆盖你的文件，安装器已停止。请手动备份或重命名该目录后重试。"
    }

    if (Test-Path -LiteralPath (Join-Path $Destination '.git') -PathType Container) {
        Write-Step "更新$Label：$Destination"
        Invoke-Git @('-C', $Destination, 'pull', '--ff-only', 'origin', $RepositoryBranch)
    }
    else {
        Write-Step "安装$Label：$Destination"
        $Parent = Split-Path -Parent $Destination
        New-Item -ItemType Directory -Path $Parent -Force | Out-Null
        Invoke-Git @('clone', '--depth', '1', '--branch', $RepositoryBranch, $RepositoryUrl, $Destination)
    }
}

function Set-Configuration([string]$ConfigPath) {
    $Timestamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
    $BackupPath = "$ConfigPath.backup-cloud-lounge-$Timestamp"
    Copy-Item -LiteralPath $ConfigPath -Destination $BackupPath
    Write-Step "已备份配置：$BackupPath"

    $Content = [System.IO.File]::ReadAllText($ConfigPath)
    if ($Content -match '(?m)^enableServerPlugins\s*:') {
        $Content = [regex]::Replace($Content, '(?m)^enableServerPlugins\s*:.*$', 'enableServerPlugins: true')
    }
    else {
        $Content = $Content.TrimEnd() + [Environment]::NewLine + [Environment]::NewLine + '# Enabled by Cloud Lounge Accelerator installer' + [Environment]::NewLine + 'enableServerPlugins: true' + [Environment]::NewLine
    }

    if ($LazyCharacters) {
        if ($Content -match '(?m)^\s+lazyLoadCharacters\s*:') {
            $Content = [regex]::Replace($Content, '(?m)^(\s*)lazyLoadCharacters\s*:.*$', '${1}lazyLoadCharacters: true')
            Write-Step '已开启 performance.lazyLoadCharacters'
        }
        else {
            Write-Step '未在 config.yaml 中找到 lazyLoadCharacters，已跳过该可选设置。'
        }
    }

    $Utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($ConfigPath, $Content, $Utf8WithoutBom)
    if ([System.IO.File]::ReadAllText($ConfigPath) -notmatch '(?m)^enableServerPlugins\s*:\s*true(?:\s|$)') {
        throw 'config.yaml 更新验证失败，请使用自动备份恢复。'
    }
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw '缺少 Git。请先安装 Git for Windows，然后重新打开 PowerShell。'
}

$Root = Resolve-SillyTavernRoot
$ServerPluginDirectory = Join-Path $Root "plugins\$ProjectDirectory"
$UiExtensionDirectory = Join-Path $Root "public\scripts\extensions\third-party\$ProjectDirectory"

Write-Step "SillyTavern 根目录：$Root"
Install-OrUpdateRepository $ServerPluginDirectory '服务端插件'
Install-OrUpdateRepository $UiExtensionDirectory '全局 UI 扩展'
Set-Configuration (Join-Path $Root 'config.yaml')

if (-not (Test-Path -LiteralPath (Join-Path $ServerPluginDirectory 'server\index.js') -PathType Leaf)) {
    throw '服务端插件验证失败'
}
if (-not (Test-Path -LiteralPath (Join-Path $UiExtensionDirectory 'manifest.json') -PathType Leaf)) {
    throw 'UI 扩展验证失败'
}

Write-Host ''
Write-Host '============================================================' -ForegroundColor Green
Write-Host '云酒馆加速器已安装/更新完成。' -ForegroundColor Green
Write-Host "`n已安装：`n  1. 服务端插件：$ServerPluginDirectory`n  2. 全局 UI 扩展：$UiExtensionDirectory"
Write-Host "`n请继续完成："
Write-Host '  1. 重启 SillyTavern。'
Write-Host '  2. 用 HTTPS 域名，或在同机上用 localhost/127.0.0.1 访问。'
Write-Host '  3. 打开“扩展设置 → 云酒馆加速器”，确认显示“已启用”。'
Write-Host '============================================================' -ForegroundColor Green
