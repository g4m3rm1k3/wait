$ErrorActionPreference = 'Stop'

# Build the portable planning library without a Mastercam SDK or NuGet packages.
# The same C# source can later be included in the matching Mastercam add-in project.
$plannerDirectory = $PSScriptRoot
$repositoryDirectory = Split-Path -Parent $plannerDirectory
$outputDirectory = Join-Path $plannerDirectory 'bin'
$compilerPath = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compilerPath)) {
    $compilerPath = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path -LiteralPath $compilerPath)) {
    throw 'The .NET Framework C# compiler was not found. Build these sources in Visual Studio instead.'
}
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$libraryPath = Join-Path $outputDirectory 'SpindleSync.Planner.dll'
$verifierPath = Join-Path $outputDirectory 'VerifyPlanner.exe'

$libraryArguments = @(
    '/nologo', '/langversion:5', '/target:library', '/reference:System.Core.dll',
    ('/out:' + $libraryPath), (Join-Path $plannerDirectory 'SyncPlanner.cs')
)
& $compilerPath @libraryArguments
if ($LASTEXITCODE -ne 0) { throw 'The planner library did not compile.' }

$verifierArguments = @(
    '/nologo', '/langversion:5', '/target:exe', '/reference:System.Core.dll',
    ('/reference:' + $libraryPath), ('/out:' + $verifierPath),
    (Join-Path $plannerDirectory 'VerifyPlanner.cs')
)
& $compilerPath @verifierArguments
if ($LASTEXITCODE -ne 0) { throw 'The planner verification program did not compile.' }

& $verifierPath $repositoryDirectory
if ($LASTEXITCODE -ne 0) { throw 'Planner verification failed.' }
Write-Host ('Built: ' + $libraryPath)
