param(
  [string]$Source = (Join-Path $PSScriptRoot '..\assets\owl-app-icon-source.jpg')
)

$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourcePath = [System.IO.Path]::GetFullPath($Source)

if (-not (Test-Path -LiteralPath $sourcePath)) {
  throw "Icon source not found: $sourcePath"
}

Add-Type -AssemblyName System.Drawing

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class InwiseIconBuilder
{
    private static bool IsConnectedBackground(int pixel)
    {
        int alpha = (pixel >> 24) & 0xff;
        int red = (pixel >> 16) & 0xff;
        int green = (pixel >> 8) & 0xff;
        int blue = pixel & 0xff;
        int min = Math.Min(red, Math.Min(green, blue));
        int max = Math.Max(red, Math.Max(green, blue));
        return alpha < 8 || (min >= 236 && max - min <= 24);
    }

    public static Bitmap ExtractSubject(string sourcePath)
    {
        using (var loaded = new Bitmap(sourcePath))
        {
            var bitmap = new Bitmap(loaded.Width, loaded.Height, PixelFormat.Format32bppArgb);
            using (var graphics = Graphics.FromImage(bitmap))
            {
                graphics.DrawImageUnscaled(loaded, 0, 0);
            }

            int width = bitmap.Width;
            int height = bitmap.Height;
            var rect = new Rectangle(0, 0, width, height);
            var data = bitmap.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
            int stride = data.Stride / 4;
            var pixels = new int[stride * height];
            Marshal.Copy(data.Scan0, pixels, 0, pixels.Length);

            var background = new bool[width * height];
            var queue = new Queue<int>();
            Action<int, int> enqueue = (x, y) =>
            {
                int logical = y * width + x;
                if (background[logical]) return;
                if (!IsConnectedBackground(pixels[y * stride + x])) return;
                background[logical] = true;
                queue.Enqueue(logical);
            };

            for (int x = 0; x < width; x++)
            {
                enqueue(x, 0);
                enqueue(x, height - 1);
            }
            for (int y = 1; y < height - 1; y++)
            {
                enqueue(0, y);
                enqueue(width - 1, y);
            }

            while (queue.Count > 0)
            {
                int logical = queue.Dequeue();
                int x = logical % width;
                int y = logical / width;
                if (x > 0) enqueue(x - 1, y);
                if (x + 1 < width) enqueue(x + 1, y);
                if (y > 0) enqueue(x, y - 1);
                if (y + 1 < height) enqueue(x, y + 1);
            }

            for (int y = 0; y < height; y++)
            {
                for (int x = 0; x < width; x++)
                {
                    int logical = y * width + x;
                    int storage = y * stride + x;
                    if (background[logical])
                    {
                        pixels[storage] &= 0x00ffffff;
                        continue;
                    }

                    // Soften only the pale JPEG fringe touching the removed
                    // background. Enclosed whites (eyes/glasses) stay opaque.
                    bool touchesBackground =
                        (x > 0 && background[logical - 1]) ||
                        (x + 1 < width && background[logical + 1]) ||
                        (y > 0 && background[logical - width]) ||
                        (y + 1 < height && background[logical + width]);
                    if (!touchesBackground) continue;
                    int pixel = pixels[storage];
                    int red = (pixel >> 16) & 0xff;
                    int green = (pixel >> 8) & 0xff;
                    int blue = pixel & 0xff;
                    int lightness = Math.Min(red, Math.Min(green, blue));
                    if (lightness <= 208) continue;
                    int alpha = Math.Max(0, Math.Min(255, (255 - lightness) * 255 / 47));
                    pixels[storage] = (pixel & 0x00ffffff) | (alpha << 24);
                }
            }

            Marshal.Copy(pixels, 0, data.Scan0, pixels.Length);
            bitmap.UnlockBits(data);
            return bitmap;
        }
    }

    private static Rectangle AlphaBounds(Bitmap bitmap)
    {
        int minX = bitmap.Width;
        int minY = bitmap.Height;
        int maxX = -1;
        int maxY = -1;
        var rect = new Rectangle(0, 0, bitmap.Width, bitmap.Height);
        var data = bitmap.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        int stride = data.Stride / 4;
        var pixels = new int[stride * bitmap.Height];
        Marshal.Copy(data.Scan0, pixels, 0, pixels.Length);
        bitmap.UnlockBits(data);

        for (int y = 0; y < bitmap.Height; y++)
        {
            for (int x = 0; x < bitmap.Width; x++)
            {
                int alpha = (pixels[y * stride + x] >> 24) & 0xff;
                if (alpha <= 8) continue;
                minX = Math.Min(minX, x);
                minY = Math.Min(minY, y);
                maxX = Math.Max(maxX, x);
                maxY = Math.Max(maxY, y);
            }
        }
        if (maxX < minX || maxY < minY) throw new InvalidOperationException("No opaque icon subject found");
        return Rectangle.FromLTRB(minX, minY, maxX + 1, maxY + 1);
    }

    private static GraphicsPath RoundedRectangle(RectangleF rect, float radius)
    {
        float diameter = radius * 2f;
        var path = new GraphicsPath();
        path.AddArc(rect.Left, rect.Top, diameter, diameter, 180, 90);
        path.AddArc(rect.Right - diameter, rect.Top, diameter, diameter, 270, 90);
        path.AddArc(rect.Right - diameter, rect.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(rect.Left, rect.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }

    public static Bitmap Build(Bitmap subject, int size, bool appTile, bool recording)
    {
        var canvas = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using (var graphics = Graphics.FromImage(canvas))
        {
            graphics.Clear(Color.Transparent);
            graphics.CompositingMode = CompositingMode.SourceOver;
            graphics.CompositingQuality = CompositingQuality.HighQuality;
            graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
            graphics.PixelOffsetMode = PixelOffsetMode.HighQuality;
            graphics.SmoothingMode = SmoothingMode.AntiAlias;

            if (appTile)
            {
                float margin = size * 0.035f;
                var tile = new RectangleF(margin, margin, size - margin * 2f, size - margin * 2f);
                using (var tilePath = RoundedRectangle(tile, size * 0.215f))
                using (var fill = new SolidBrush(Color.FromArgb(255, 252, 252, 251)))
                using (var outline = new Pen(Color.FromArgb(18, 15, 23, 42), Math.Max(1f, size * 0.002f)))
                {
                    graphics.FillPath(fill, tilePath);
                    graphics.DrawPath(outline, tilePath);
                }
            }

            Rectangle sourceBounds = AlphaBounds(subject);
            float maxWidth = size * (appTile ? 0.78f : 0.93f);
            float maxHeight = size * (appTile ? 0.82f : 0.94f);
            float scale = Math.Min(maxWidth / sourceBounds.Width, maxHeight / sourceBounds.Height);
            float drawWidth = sourceBounds.Width * scale;
            float drawHeight = sourceBounds.Height * scale;
            float drawX = (size - drawWidth) / 2f;
            float drawY = (size - drawHeight) / 2f + (appTile ? size * 0.012f : 0f);
            graphics.DrawImage(subject, new RectangleF(drawX, drawY, drawWidth, drawHeight), sourceBounds, GraphicsUnit.Pixel);

            if (recording)
            {
                float outer = size * 0.36f;
                float inner = size * 0.25f;
                float cx = size * 0.78f;
                float cy = size * 0.78f;
                using (var white = new SolidBrush(Color.White))
                using (var red = new SolidBrush(Color.FromArgb(255, 220, 38, 38)))
                {
                    graphics.FillEllipse(white, cx - outer / 2f, cy - outer / 2f, outer, outer);
                    graphics.FillEllipse(red, cx - inner / 2f, cy - inner / 2f, inner, inner);
                }
            }
        }
        return canvas;
    }

    public static void SavePng(Bitmap subject, int size, bool appTile, bool recording, string path)
    {
        using (var image = Build(subject, size, appTile, recording))
        {
            image.Save(path, ImageFormat.Png);
        }
    }

    public static void SaveIco(Bitmap subject, bool appTile, string path)
    {
        int[] sizes = new[] { 16, 20, 24, 32, 40, 48, 64, 128, 256 };
        var frames = new List<byte[]>();
        foreach (int size in sizes)
        {
            using (var image = Build(subject, size, appTile, false))
            using (var stream = new MemoryStream())
            {
                image.Save(stream, ImageFormat.Png);
                frames.Add(stream.ToArray());
            }
        }

        using (var file = File.Create(path))
        using (var writer = new BinaryWriter(file))
        {
            writer.Write((ushort)0);
            writer.Write((ushort)1);
            writer.Write((ushort)sizes.Length);
            int offset = 6 + sizes.Length * 16;
            for (int i = 0; i < sizes.Length; i++)
            {
                writer.Write((byte)(sizes[i] == 256 ? 0 : sizes[i]));
                writer.Write((byte)(sizes[i] == 256 ? 0 : sizes[i]));
                writer.Write((byte)0);
                writer.Write((byte)0);
                writer.Write((ushort)1);
                writer.Write((ushort)32);
                writer.Write((uint)frames[i].Length);
                writer.Write((uint)offset);
                offset += frames[i].Length;
            }
            foreach (byte[] frame in frames) writer.Write(frame);
        }
    }
}
'@

$assets = Join-Path $repoRoot 'assets'
$build = Join-Path $repoRoot 'build'

$subject = [InwiseIconBuilder]::ExtractSubject($sourcePath)
try {
  [InwiseIconBuilder]::SavePng($subject, 1024, $true, $false, (Join-Path $assets 'icon.png'))
  [InwiseIconBuilder]::SavePng($subject, 1024, $true, $false, (Join-Path $build 'icon-mac.png'))
  [InwiseIconBuilder]::SavePng($subject, 256, $false, $false, (Join-Path $assets 'icon-256.png'))
  [InwiseIconBuilder]::SavePng($subject, 64, $false, $false, (Join-Path $assets 'favicon.png'))
  [InwiseIconBuilder]::SavePng($subject, 64, $false, $true, (Join-Path $assets 'favicon-recording.png'))
  [InwiseIconBuilder]::SaveIco($subject, $true, (Join-Path $assets 'icon.ico'))
  [InwiseIconBuilder]::SaveIco($subject, $true, (Join-Path $assets 'favicon.ico'))
} finally {
  $subject.Dispose()
}

Write-Host 'Generated Windows, macOS, tray, and recording icons from:' $sourcePath
