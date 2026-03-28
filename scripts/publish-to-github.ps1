[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$GitHubToken,

  [Parameter(Mandatory = $true)]
  [string]$RepoName,

  [string]$Owner = "",
  [string]$RepoDescription = "Turn-based sales souffleur assistant",
  [switch]$Private,
  [string]$SourcePath = ""
)

$ErrorActionPreference = "Stop"

if (-not $SourcePath) {
  if ($PSScriptRoot) {
    $SourcePath = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
  } else {
    throw "SourcePath is not set and PSScriptRoot is empty. Pass -SourcePath explicitly."
  }
}

$Headers = @{
  Accept                 = "application/vnd.github+json"
  Authorization          = "Bearer $GitHubToken"
  "X-GitHub-Api-Version" = "2026-03-10"
  "User-Agent"           = "sales-souffleur-publisher"
}

function Invoke-GitHubApi {
  param(
    [string]$Method,
    [string]$Uri,
    [object]$Body = $null
  )

  $params = @{
    Method  = $Method
    Uri     = $Uri
    Headers = $Headers
  }

  if ($null -ne $Body) {
    $params.ContentType = "application/json"
    $params.Body = ($Body | ConvertTo-Json -Depth 10 -Compress)
  }

  Invoke-RestMethod @params
}

function Resolve-Owner {
  if ($Owner) {
    return $Owner
  }

  $me = Invoke-GitHubApi -Method "GET" -Uri "https://api.github.com/user"
  return $me.login
}

function Test-RepositoryExists {
  param(
    [string]$RepoOwner,
    [string]$Name
  )

  try {
    Invoke-GitHubApi -Method "GET" -Uri "https://api.github.com/repos/$RepoOwner/$Name" | Out-Null
    return $true
  } catch {
    if ($_.Exception.Response.StatusCode.value__ -eq 404) {
      return $false
    }
    throw
  }
}

function New-RepositoryIfNeeded {
  param(
    [string]$RepoOwner,
    [string]$Name
  )

  if (Test-RepositoryExists -RepoOwner $RepoOwner -Name $Name) {
    Write-Host "Repository already exists: https://github.com/$RepoOwner/$Name"
    return
  }

  Write-Host "Creating repository $RepoOwner/$Name ..."

  Invoke-GitHubApi -Method "POST" -Uri "https://api.github.com/user/repos" -Body @{
    name         = $Name
    description  = $RepoDescription
    private      = [bool]$Private
    auto_init    = $false
    has_issues   = $true
    has_projects = $false
    has_wiki     = $false
  } | Out-Null
}

function Get-RelativeGitHubPath {
  param([string]$FullName)
  $basePath = [System.IO.Path]::GetFullPath($SourcePath)
  if (-not $basePath.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
    $basePath += [System.IO.Path]::DirectorySeparatorChar
  }
  $baseUri = [System.Uri]::new($basePath)
  $fileUri = [System.Uri]::new([System.IO.Path]::GetFullPath($FullName))
  [System.Uri]::UnescapeDataString($baseUri.MakeRelativeUri($fileUri).ToString())
}

function Escape-GitHubPath {
  param([string]$RelativePath)
  (($RelativePath -split "/") | ForEach-Object { [System.Uri]::EscapeDataString($_) }) -join "/"
}

function Get-UploadFiles {
  Get-ChildItem -Path $SourcePath -Recurse -File | Where-Object {
    $_.FullName -notmatch "\\\.git\\" -and
    $_.FullName -notmatch "\\node_modules\\" -and
    $_.Name -ne ".DS_Store"
  } | Sort-Object FullName
}

function Upload-File {
  param(
    [string]$RepoOwner,
    [string]$Name,
    [System.IO.FileInfo]$File
  )

  $relativePath = Get-RelativeGitHubPath -FullName $File.FullName
  $apiPath = Escape-GitHubPath -RelativePath $relativePath
  $content = [System.Convert]::ToBase64String([System.IO.File]::ReadAllBytes($File.FullName))

  Write-Host "Uploading $relativePath"

  Invoke-GitHubApi -Method "PUT" -Uri "https://api.github.com/repos/$RepoOwner/$Name/contents/$apiPath" -Body @{
    message = "Add $relativePath"
    content = $content
  } | Out-Null
}

$RepoOwner = Resolve-Owner
New-RepositoryIfNeeded -RepoOwner $RepoOwner -Name $RepoName

$files = Get-UploadFiles
if (-not $files.Count) {
  throw "No files found in $SourcePath"
}

foreach ($file in $files) {
  Upload-File -RepoOwner $RepoOwner -Name $RepoName -File $file
}

Write-Host ""
Write-Host "Repository published:"
Write-Host "https://github.com/$RepoOwner/$RepoName"
