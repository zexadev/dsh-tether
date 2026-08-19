# Windows 上从零装 Tauri 2 Android 构建环境:JDK 已装好(winget Temurin 21)前提下,
# 装 Android cmdline-tools → platform-tools/platform/build-tools/NDK,并持久化用户级环境变量。
# 幂等:已存在的组件 sdkmanager 自动跳过。
$ErrorActionPreference = 'Stop'

$sdkRoot = 'D:\Android\sdk'
$ndkVersion = '27.0.12077973'

$jdk = Get-ChildItem 'C:\Program Files\Eclipse Adoptium' -Filter 'jdk-21*' -Directory | Select-Object -First 1
if (-not $jdk) { throw '未找到 Temurin JDK 21(先 winget install EclipseAdoptium.Temurin.21.JDK)' }
$env:JAVA_HOME = $jdk.FullName
Write-Host "JAVA_HOME = $env:JAVA_HOME"

New-Item -ItemType Directory -Force $sdkRoot | Out-Null
$cmdlineDir = Join-Path $sdkRoot 'cmdline-tools\latest'
if (-not (Test-Path (Join-Path $cmdlineDir 'bin\sdkmanager.bat'))) {
    $zip = Join-Path $env:TEMP 'android-cmdline-tools.zip'
    Write-Host '下载 Android cmdline-tools…'
    Invoke-WebRequest 'https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip' -OutFile $zip
    $extract = Join-Path $env:TEMP 'android-cmdline-tools-extract'
    Remove-Item -Recurse -Force $extract -ErrorAction SilentlyContinue
    Expand-Archive $zip -DestinationPath $extract
    New-Item -ItemType Directory -Force (Split-Path $cmdlineDir) | Out-Null
    Move-Item (Join-Path $extract 'cmdline-tools') $cmdlineDir
    Remove-Item $zip
}

$sdkmanager = Join-Path $cmdlineDir 'bin\sdkmanager.bat'
Write-Host '接受许可…'
# sdkmanager 交互式逐条要 y;喂足行数一次过
('y' * 1) * 1 | Out-Null
$yes = ("y`n" * 30)
$yes | & $sdkmanager --licenses --sdk_root=$sdkRoot | Out-Null

Write-Host '安装 platform-tools / android-34 / build-tools / NDK…'
& $sdkmanager --sdk_root=$sdkRoot 'platform-tools' 'platforms;android-34' 'build-tools;34.0.0' "ndk;$ndkVersion"

# sdkmanager 会静默半途而废(实测 NDK 解压中断只留 .installer 残留);装完必须验货
$required = @(
    (Join-Path $sdkRoot 'platform-tools\adb.exe'),
    (Join-Path $sdkRoot 'platforms\android-34\android.jar'),
    (Join-Path $sdkRoot "ndk\$ndkVersion\source.properties")
)
$missing = $required | Where-Object { -not (Test-Path $_) }
if ($missing) { throw "组件未装齐,重跑本脚本:`n$($missing -join "`n")" }

Write-Host '持久化用户环境变量…'
[Environment]::SetEnvironmentVariable('JAVA_HOME', $env:JAVA_HOME, 'User')
[Environment]::SetEnvironmentVariable('ANDROID_HOME', $sdkRoot, 'User')
[Environment]::SetEnvironmentVariable('NDK_HOME', (Join-Path $sdkRoot "ndk\$ndkVersion"), 'User')
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$platformTools = Join-Path $sdkRoot 'platform-tools'
if ($userPath -notlike "*$platformTools*") {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$platformTools", 'User')
}

Write-Host '完成。组件清单:'
& $sdkmanager --sdk_root=$sdkRoot --list_installed
