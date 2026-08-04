param(
    [string]$ReferenceImage = 'C:\Users\V\Downloads\f579b7df-d60b-42db-9245-a5533c868e0d.png',
    [string]$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

Add-Type -AssemblyName System.Drawing

$brandDir = Join-Path $ProjectRoot 'public\brand'
$iconsDir = Join-Path $ProjectRoot 'public\icons'
New-Item -ItemType Directory -Force -Path $brandDir | Out-Null
New-Item -ItemType Directory -Force -Path $iconsDir | Out-Null

function New-Bitmap {
    param([int]$Width, [int]$Height)

    return [System.Drawing.Bitmap]::new($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
}

function Copy-Crop {
    param(
        [System.Drawing.Bitmap]$Source,
        [int]$X,
        [int]$Y,
        [int]$Width,
        [int]$Height
    )

    $bitmap = New-Bitmap -Width $Width -Height $Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.DrawImage(
        $Source,
        [System.Drawing.Rectangle]::new(0, 0, $Width, $Height),
        [System.Drawing.Rectangle]::new($X, $Y, $Width, $Height),
        [System.Drawing.GraphicsUnit]::Pixel
    )
    $graphics.Dispose()
    return $bitmap
}

function Resize-Bitmap {
    param(
        [System.Drawing.Bitmap]$Source,
        [int]$Width,
        [int]$Height,
        [switch]$KeepAspect
    )

    $bitmap = New-Bitmap -Width $Width -Height $Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.Clear([System.Drawing.Color]::Transparent)

    if ($KeepAspect) {
        $scale = [Math]::Min($Width / $Source.Width, $Height / $Source.Height)
        $drawWidth = [int][Math]::Round($Source.Width * $scale)
        $drawHeight = [int][Math]::Round($Source.Height * $scale)
        $drawX = [int][Math]::Round(($Width - $drawWidth) / 2)
        $drawY = [int][Math]::Round(($Height - $drawHeight) / 2)
        $graphics.DrawImage($Source, [System.Drawing.Rectangle]::new($drawX, $drawY, $drawWidth, $drawHeight))
    } else {
        $graphics.DrawImage($Source, [System.Drawing.Rectangle]::new(0, 0, $Width, $Height))
    }

    $graphics.Dispose()
    return $bitmap
}

function Add-TransparentPadding {
    param(
        [System.Drawing.Bitmap]$Source,
        [int]$Padding
    )

    $bitmap = New-Bitmap -Width $Source.Width -Height $Source.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.Clear([System.Drawing.Color]::Transparent)

    $drawWidth = [Math]::Max(1, $Source.Width - ($Padding * 2))
    $drawHeight = [Math]::Max(1, $Source.Height - ($Padding * 2))
    $graphics.DrawImage(
        $Source,
        [System.Drawing.Rectangle]::new($Padding, $Padding, $drawWidth, $drawHeight)
    )

    $graphics.Dispose()
    return $bitmap
}

function Convert-DarkToTransparent {
    param(
        [System.Drawing.Bitmap]$Source,
        [int]$Threshold = 22
    )

    $bitmap = New-Bitmap -Width $Source.Width -Height $Source.Height

    for ($y = 0; $y -lt $Source.Height; $y++) {
        for ($x = 0; $x -lt $Source.Width; $x++) {
            $pixel = $Source.GetPixel($x, $y)
            $max = [Math]::Max($pixel.R, [Math]::Max($pixel.G, $pixel.B))
            if ($max -le $Threshold) {
                $bitmap.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, $pixel.R, $pixel.G, $pixel.B))
            } else {
                $bitmap.SetPixel($x, $y, $pixel)
            }
        }
    }

    return $bitmap
}

function Save-Png {
    param(
        [System.Drawing.Bitmap]$Bitmap,
        [string]$Path
    )

    $Bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
}

function Write-Ico {
    param(
        [string]$Path,
        [string[]]$PngPaths
    )

    $pngFiles = @($PngPaths | ForEach-Object {
        $name = [System.IO.Path]::GetFileNameWithoutExtension($_)
        $size = [int]([regex]::Match($name, '\d+').Value)
        [pscustomobject]@{
            Path = $_
            Bytes = [System.IO.File]::ReadAllBytes($_)
            Size = $size
        }
    })

    $stream = [System.IO.File]::Create($Path)
    $writer = [System.IO.BinaryWriter]::new($stream)

    $writer.Write([UInt16]0)
    $writer.Write([UInt16]1)
    $writer.Write([UInt16]$pngFiles.Count)

    $offset = 6 + (16 * $pngFiles.Count)
    foreach ($file in $pngFiles) {
        $dimensionByte = if ($file.Size -ge 256) { 0 } else { [byte]$file.Size }
        $writer.Write([byte]$dimensionByte)
        $writer.Write([byte]$dimensionByte)
        $writer.Write([byte]0)
        $writer.Write([byte]0)
        $writer.Write([UInt16]1)
        $writer.Write([UInt16]32)
        $writer.Write([UInt32]$file.Bytes.Length)
        $writer.Write([UInt32]$offset)
        $offset += $file.Bytes.Length
    }

    foreach ($file in $pngFiles) {
        $writer.Write($file.Bytes)
    }

    $writer.Dispose()
    $stream.Dispose()
}

function New-RoundRectPath {
    param(
        [float]$X,
        [float]$Y,
        [float]$Width,
        [float]$Height,
        [float]$Radius
    )

    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $diameter = $Radius * 2
    $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
    $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
    $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

function Fill-RoundRect {
    param(
        [System.Drawing.Graphics]$Graphics,
        [System.Drawing.Brush]$Brush,
        [float]$X,
        [float]$Y,
        [float]$Width,
        [float]$Height,
        [float]$Radius
    )

    $path = New-RoundRectPath -X $X -Y $Y -Width $Width -Height $Height -Radius $Radius
    $Graphics.FillPath($Brush, $path)
    $path.Dispose()
}

function Apply-AppIconAlphaMask {
    param([System.Drawing.Bitmap]$Source)

    $scale = 4
    $maskWidth = $Source.Width * $scale
    $maskHeight = $Source.Height * $scale
    $mask = New-Bitmap -Width $maskWidth -Height $maskHeight
    $graphics = [System.Drawing.Graphics]::FromImage($mask)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.Clear([System.Drawing.Color]::Transparent)

    $brush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
    $radius = $Source.Width * 0.23 * $scale
    $inset = 0.4 * $scale
    $path = New-RoundRectPath `
        -X $inset `
        -Y $inset `
        -Width ($maskWidth - ($inset * 2)) `
        -Height ($maskHeight - ($inset * 2)) `
        -Radius $radius
    $graphics.FillPath($brush, $path)
    $path.Dispose()
    $brush.Dispose()
    $graphics.Dispose()

    $maskSmall = Resize-Bitmap -Source $mask -Width $Source.Width -Height $Source.Height
    $mask.Dispose()

    $bitmap = New-Bitmap -Width $Source.Width -Height $Source.Height
    for ($y = 0; $y -lt $Source.Height; $y++) {
        for ($x = 0; $x -lt $Source.Width; $x++) {
            $pixel = $Source.GetPixel($x, $y)
            $maskPixel = $maskSmall.GetPixel($x, $y)
            $alpha = [int][Math]::Round($pixel.A * ($maskPixel.A / 255))
            if ($alpha -le 0) {
                $bitmap.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 0, 0, 0))
            } else {
                $bitmap.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($alpha, $pixel.R, $pixel.G, $pixel.B))
            }
        }
    }

    $maskSmall.Dispose()
    return $bitmap
}

function New-ComposedLogo {
    param(
        [System.Drawing.Bitmap]$Mark,
        [System.Drawing.Bitmap]$Tra,
        [int]$Width,
        [int]$Height,
        [int]$MarkHeight,
        [int]$WordHeight,
        [switch]$UseBackground
    )

    $bitmap = New-Bitmap -Width $Width -Height $Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.Clear([System.Drawing.Color]::Transparent)

    if ($UseBackground) {
        $background = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
            [System.Drawing.RectangleF]::new(0, 0, $Width, $Height),
            [System.Drawing.ColorTranslator]::FromHtml('#080b10'),
            [System.Drawing.ColorTranslator]::FromHtml('#03060b'),
            90
        )
        $graphics.FillRectangle($background, 0, 0, $Width, $Height)
        $background.Dispose()
    }

    $markWidth = [int][Math]::Round($Mark.Width * ($MarkHeight / $Mark.Height))
    $traHeight = $WordHeight
    $traWidth = [int][Math]::Round($Tra.Width * ($traHeight / $Tra.Height))
    $eWidth = [int][Math]::Round($WordHeight * (0.78 / 0.86))
    $eHeight = $WordHeight
    $xWidth = [int][Math]::Round($WordHeight * (1.1 / 0.86))
    $gap = [int][Math]::Round($WordHeight * (0.62 / 0.86))
    $wordGap = [int][Math]::Round($WordHeight * (0.16 / 0.86))
    $totalWidth = $markWidth + $gap + $eWidth + $wordGap + $xWidth + $wordGap + $traWidth
    $startX = [int][Math]::Round(($Width - $totalWidth) / 2)
    $markY = [int][Math]::Round(($Height - $MarkHeight) / 2)
    $wordY = [int][Math]::Round(($Height - $WordHeight) / 2)

    $graphics.DrawImage($Mark, [System.Drawing.Rectangle]::new($startX, $markY, $markWidth, $MarkHeight))

    $accent = [System.Drawing.ColorTranslator]::FromHtml('#8fa1bb')
    $light = [System.Drawing.ColorTranslator]::FromHtml('#f3f2ef')
    $accentBrush = [System.Drawing.SolidBrush]::new($accent)

    $eX = $startX + $markWidth + $gap
    $eY = $wordY
    $barHeight = [Math]::Max(3, [int][Math]::Round($WordHeight * (0.16 / 0.86)))
    $barRadius = $barHeight / 2
    $barGap = ($eHeight - ($barHeight * 3)) / 2

    for ($i = 0; $i -lt 3; $i++) {
        $barY = $eY + (($barHeight + $barGap) * $i)
        Fill-RoundRect -Graphics $graphics -Brush $accentBrush -X $eX -Y $barY -Width $eWidth -Height $barHeight -Radius $barRadius
    }

    # The x is an ordinary letter: two full crossing strokes in the same ink as
    # the rest of the word. Only the N carries the brand gradient.
    $xX = $eX + $eWidth + $wordGap
    $xStroke = [Math]::Max(4, [int][Math]::Round($WordHeight * (10 / 52)))
    $xPen = [System.Drawing.Pen]::new($light, $xStroke)
    $xPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $xPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $xPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

    $xLeft = $xX + ($xWidth * (8 / 56))
    $xRight = $xX + ($xWidth * (48 / 56))
    $xTop = $wordY + ($WordHeight * (7 / 52))
    $xBottom = $wordY + ($WordHeight * (45 / 52))

    $graphics.DrawLine($xPen, $xLeft, $xTop, $xRight, $xBottom)
    $graphics.DrawLine($xPen, $xRight, $xTop, $xLeft, $xBottom)

    $traX = $xX + $xWidth + $wordGap
    $graphics.DrawImage($Tra, [System.Drawing.Rectangle]::new($traX, $wordY, $traWidth, $traHeight))

    $xPen.Dispose()
    $accentBrush.Dispose()
    $graphics.Dispose()
    return $bitmap
}

$appIconPath = Join-Path $brandDir 'nextra-app-icon.png'
$faviconSourcePath = Join-Path $brandDir 'nextra-favicon-source.png'

if (Test-Path $ReferenceImage) {
    $sheet = [System.Drawing.Bitmap]::FromFile($ReferenceImage)

    $appIconCrop = Copy-Crop -Source $sheet -X 666 -Y 528 -Width 206 -Height 206
    $appIconPadded = Add-TransparentPadding -Source $appIconCrop -Padding 0
    $appIcon = Apply-AppIconAlphaMask -Source $appIconPadded
    Save-Png -Bitmap $appIcon -Path $appIconPath

    $faviconSource = Copy-Crop -Source $sheet -X 1084 -Y 552 -Width 176 -Height 176
    Save-Png -Bitmap $faviconSource -Path $faviconSourcePath

    $mark = Copy-Crop -Source $sheet -X 1076 -Y 918 -Width 166 -Height 142
    $markTransparent = Convert-DarkToTransparent -Source $mark
    Save-Png -Bitmap $markTransparent -Path (Join-Path $brandDir 'nextra-mark.png')

    $tra = Copy-Crop -Source $sheet -X 925 -Y 214 -Width 360 -Height 96
    $traTransparent = Convert-DarkToTransparent -Source $tra
    Save-Png -Bitmap $traTransparent -Path (Join-Path $brandDir 'nextra-tra.png')

    $oldXtraPath = Join-Path $brandDir 'nextra-xtra.png'
    if (Test-Path $oldXtraPath) {
        Remove-Item -LiteralPath $oldXtraPath -Force
    }

    $primaryLogo = New-ComposedLogo -Mark $markTransparent -Tra $traTransparent -Width 560 -Height 150 -MarkHeight 128 -WordHeight 58
    Save-Png -Bitmap $primaryLogo -Path (Join-Path $brandDir 'nextra-primary-logo.png')

    $heroLogo = New-ComposedLogo -Mark $markTransparent -Tra $traTransparent -Width 1165 -Height 250 -MarkHeight 230 -WordHeight 98
    Save-Png -Bitmap $heroLogo -Path (Join-Path $brandDir 'nextra-hero-logo.png')

    $heroSocial = New-ComposedLogo -Mark $markTransparent -Tra $traTransparent -Width 1200 -Height 630 -MarkHeight 230 -WordHeight 98 -UseBackground
    Save-Png -Bitmap $heroSocial -Path (Join-Path $brandDir 'nextra-social-card.png')

    foreach ($bitmap in @($appIconCrop, $appIconPadded, $appIcon, $faviconSource, $mark, $markTransparent, $tra, $traTransparent, $primaryLogo, $heroLogo, $heroSocial)) {
        $bitmap.Dispose()
    }

    $sheet.Dispose()
} elseif (-not (Test-Path $appIconPath)) {
    throw "Reference image was not found and no generated app icon exists: $ReferenceImage"
}

$appIconSource = [System.Drawing.Bitmap]::FromFile($appIconPath)
$iconSizes = @(16, 32, 48, 64, 128, 180, 192, 256, 512)
foreach ($size in $iconSizes) {
    $resized = Resize-Bitmap -Source $appIconSource -Width $size -Height $size
    Save-Png -Bitmap $resized -Path (Join-Path $iconsDir "icon-$size.png")
    $resized.Dispose()
}
$appIconSource.Dispose()

Copy-Item -Force (Join-Path $iconsDir 'icon-180.png') (Join-Path $iconsDir 'apple-touch-icon.png')
Copy-Item -Force (Join-Path $iconsDir 'icon-512.png') (Join-Path $iconsDir 'maskable-512.png')
$mstileSource = [System.Drawing.Bitmap]::FromFile($appIconPath)
$mstile = Resize-Bitmap -Source $mstileSource -Width 150 -Height 150
Save-Png -Bitmap $mstile -Path (Join-Path $iconsDir 'mstile-150x150.png')
$mstile.Dispose()
$mstileSource.Dispose()

if (Test-Path $faviconSourcePath) {
    $faviconSource = [System.Drawing.Bitmap]::FromFile($faviconSourcePath)
} else {
    $faviconSource = [System.Drawing.Bitmap]::FromFile((Join-Path $iconsDir 'icon-512.png'))
}

$faviconSizes = @(16, 32, 48, 64)
foreach ($size in $faviconSizes) {
    $resized = Resize-Bitmap -Source $faviconSource -Width $size -Height $size
    Save-Png -Bitmap $resized -Path (Join-Path $iconsDir "favicon-$size.png")
    $resized.Dispose()
}
$faviconSource.Dispose()

Write-Ico -Path (Join-Path $ProjectRoot 'public\favicon.ico') -PngPaths @(
    (Join-Path $iconsDir 'favicon-16.png'),
    (Join-Path $iconsDir 'favicon-32.png'),
    (Join-Path $iconsDir 'favicon-48.png'),
    (Join-Path $iconsDir 'favicon-64.png')
)

Write-Ico -Path (Join-Path $ProjectRoot 'public\app.ico') -PngPaths @(
    (Join-Path $iconsDir 'icon-16.png'),
    (Join-Path $iconsDir 'icon-32.png'),
    (Join-Path $iconsDir 'icon-48.png'),
    (Join-Path $iconsDir 'icon-64.png'),
    (Join-Path $iconsDir 'icon-128.png'),
    (Join-Path $iconsDir 'icon-256.png')
)

Write-Host "Generated Nextra brand assets in $brandDir and $iconsDir"
