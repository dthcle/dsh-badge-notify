# dsh-badge-notify - taskbar overlay.
#
# Paints two things around the DSH taskbar icon (located through UI Automation,
# so no elevation and no cross-process memory games):
#
#   * top-right corner of the icon : ChatGPT-style badge - black rounded square,
#                                    white number of completed sessions. The
#                                    badge CENTRE sits exactly on the corner, so
#                                    it straddles the icon's outline.
#   * left edge of the icon        : attention dots, stacked top -> bottom. Each
#                                    dot CENTRE sits on the icon's left edge.
#                                    black  = a question is waiting for an answer
#                                    yellow = a permission (approval) request
#
# Because the badge/dots straddle the outline, the layered window is larger than
# the icon: the canvas is the icon rect inflated by `pad`, and everything is
# painted in canvas coordinates.
#
# The icon's box inside the button is measured from the button's own pixels
# (the button is wider than the icon glyph); a geometric fallback is used when
# that measurement is not trustworthy. The measurement always runs with the
# overlay hidden, otherwise the badge becomes part of the "ink" it measures and
# the anchor slowly drifts across the icon.
#
# The window is a per-pixel-alpha layered window and is click-through by
# default, so the DSH taskbar button underneath keeps working normally.
#
# Payload: copied to %LOCALAPPDATA%\DshBadgeNotify by the host half.
param(
  [switch]$NoWelcome,
  [switch]$SelfTest,
  [switch]$Calibrate,
  [switch]$Once,
  [switch]$Demo
)

$script:Version = '0.6.0'
$ErrorActionPreference = 'Stop'

if ($PSScriptRoot) { $script:Dir = $PSScriptRoot } else { $script:Dir = (Get-Location).Path }
$script:LogPath = Join-Path $script:Dir 'logs\badge-notify.log'
$script:Mutex = $null
$script:HaveMutex = $false

$script:Cfg = $null
$script:Form = $null
$script:Hidden = $true
$script:LastPresent = $null
$script:ButtonCache = $null
$script:ButtonRect = $null
$script:ButtonRectAt = -100000
$script:ButtonFoundAt = -100000
$script:ButtonRetryAt = 0
$script:TrayRoot = $null
$script:TrayRootAt = -100000
$script:LastTickAt = 0
$script:LastTickWarnAt = -100000
$script:StateCache = $null
$script:StateStamp = 0
$script:StateSize = -1
$script:StateReadAt = -100000
$script:StateMaxAgeMs = 2500
$script:CfgStamp = 0
$script:CfgCheckedAt = 0
$script:LastOccludedLogAt = -100000
$script:FrameBmp = $null
$script:FrameX = 0
$script:FrameY = 0
$script:PreviewCache = $null
$script:PreviewStamp = -1
$script:PreviewLogged = $false
$script:LastRectLog = ''
$script:LastIconLog = ''
$script:LastUiaErrAt = -100000
$script:LastMissLogAt = -100000
$script:IconBox = $null
$script:IconBoxFor = ''
$script:IconBoxAt = -100000
# The icon layout is stable; re-measuring costs a hide/show blink, so keep the
# measured box for a long time (the cache is also keyed by the button rect, so
# a taskbar move/resize still forces a fresh measurement).
$script:IconBoxTtlMs = 600000
$script:TraceOn = [bool]($SelfTest -or $Once -or $Demo -or $Calibrate)

function Write-Log {
  param([string]$Message)
  try {
    $logDir = Split-Path -Parent $script:LogPath
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    if (Test-Path $script:LogPath) {
      $fi = Get-Item $script:LogPath
      if ($fi.Length -gt 262144) { Remove-Item $script:LogPath -Force -ErrorAction SilentlyContinue }
    }
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $PID, $Message
    Add-Content -Path $script:LogPath -Value $line -Encoding UTF8 -ErrorAction SilentlyContinue
  } catch { }
}

function Trace {
  param([string]$Message)
  if ($script:TraceOn) { Write-Log ("trace: " + $Message) }
}

# ---- bootstrap -------------------------------------------------------------
Trace 'loading assemblies'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type -ReferencedAssemblies 'System.Windows.Forms', 'System.Drawing' -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class BadgeStyle {
  public int BadgeSize = 18;
  public double BadgeRadius = 0.34;
  public Color BadgeBg = Color.FromArgb(13, 13, 13);
  public Color BadgeFg = Color.White;
  public Color BadgeRing = Color.White;
  public double BadgeRingWidth = 1.2;
  public bool BadgeEnabled = true;
  public bool HideWhenZero = true;
  public string FontFamily = "Segoe UI";
  public int FontSize = 11;
  public double FontSizeRatio = 0.62;
  public bool FontBold = true;
  public int TextOffsetX = 0;   // optical nudge of the digit, from its ink centre
  public int TextOffsetY = 0;
  public int BadgeInsetX = 0;   // centre nudge left from the icon's right edge
  public int BadgeInsetY = 0;   // centre nudge down from its lifted position
  // How far the badge centre sits ABOVE the icon's top edge, in badge-size
  // units: 0 = centre on the corner, 0.5 = the badge rests on top of the icon.
  public double BadgeLift = 0.5;

  public int DotSize = 8;
  public int DotGap = 3;
  public int DotInsetX = 0;     // dot centre nudge right from the icon's left edge
  public int DotInsetY = 0;     // extra offset of the first dot centre
  // true: the first dot shares the badge's centre line (so the two marks form a
  // pair above the icon's top edge); false: first dot on the icon's top corner.
  public bool DotStartAtBadge = true;
  // true: keep 点径+gap spacing exactly and let the column run past the icon's
  // bottom edge; false (default): squeeze spacing/size so the column fits the
  // icon's height.
  public bool DotFixedStep = false;
  public Color DotQuestion = Color.FromArgb(17, 17, 17);
  public Color DotApproval = Color.FromArgb(255, 196, 0);
  public Color DotRing = Color.White;
  public double DotRingWidth = 1.2;
  public int DotMax = 6;

  public BadgeStyle Clone() { return (BadgeStyle)this.MemberwiseClone(); }
}

public class BadgeForm : System.Windows.Forms.Form {
  public bool ClickThrough = true;
  public BadgeForm() {
    FormBorderStyle = FormBorderStyle.None;
    ShowInTaskbar = false;
    TopMost = true;
    StartPosition = FormStartPosition.Manual;
    Size = new Size(1, 1);
    SetStyle(ControlStyles.Opaque, true);
  }
  protected override CreateParams CreateParams {
    get {
      CreateParams cp = base.CreateParams;
      cp.ExStyle |= 0x00080000; // WS_EX_LAYERED
      cp.ExStyle |= 0x08000000; // WS_EX_NOACTIVATE
      cp.ExStyle |= 0x00000080; // WS_EX_TOOLWINDOW  (keep out of Alt+Tab)
      if (ClickThrough) { cp.ExStyle |= 0x00000020; } // WS_EX_TRANSPARENT
      return cp;
    }
  }
  protected override void OnPaintBackground(PaintEventArgs e) { }
}

public static class BadgeNative {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst, ref SIZE psize,
      IntPtr hdcSrc, ref POINT pptSrc, int crKey, ref BLENDFUNCTION pblend, int dwFlags);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr h);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("user32.dll", SetLastError = true)] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint flags);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
  [DllImport("gdi32.dll")]
  public static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFO bmi, uint usage, out IntPtr bits, IntPtr sect, uint offset);

  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }
  [StructLayout(LayoutKind.Sequential)] public struct SIZE { public int cx, cy; }
  [StructLayout(LayoutKind.Sequential, Pack = 1)]
  public struct BLENDFUNCTION { public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat; }
  [StructLayout(LayoutKind.Sequential)]
  public struct BITMAPINFOHEADER {
    public uint biSize; public int biWidth, biHeight; public ushort biPlanes, biBitCount;
    public uint biCompression, biSizeImage; public int biXPelsPerMeter, biYPelsPerMeter;
    public uint biClrUsed, biClrImportant;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct BITMAPINFO {
    public BITMAPINFOHEADER bmiHeader;
    [MarshalAs(UnmanagedType.ByValArray, SizeConst = 256)] public uint[] bmiColors;
  }

  public const int ULW_ALPHA = 2;  public const byte AC_SRC_OVER = 0;
  public const byte AC_SRC_ALPHA = 1;
  static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  const uint SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOACTIVATE = 0x0010;
  const uint GW_HWNDPREV = 3;

  // UpdateLayeredWindow needs PREMULTIPLIED alpha; Bitmap.GetHbitmap does not
  // premultiply, so build the DIB ourselves (tiny bitmaps, negligible cost).
  static IntPtr ToPremultipliedDib(Bitmap bmp, IntPtr hdcRef, out IntPtr bits) {
    int w = bmp.Width, h = bmp.Height;
    BITMAPINFO bmi = new BITMAPINFO();
    bmi.bmiColors = new uint[256];
    bmi.bmiHeader.biSize = (uint)Marshal.SizeOf(typeof(BITMAPINFOHEADER));
    bmi.bmiHeader.biWidth = w;
    bmi.bmiHeader.biHeight = -h; // top-down
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = 0;
    IntPtr hbmp = CreateDIBSection(hdcRef, ref bmi, 0, out bits, IntPtr.Zero, 0);
    if (hbmp == IntPtr.Zero) { throw new Exception("CreateDIBSection failed"); }
    BitmapData data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
    try {
      int row = w * 4;
      byte[] buf = new byte[row];
      for (int y = 0; y < h; y++) {
        Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), buf, 0, row);
        for (int x = 0; x < row; x += 4) {
          byte a = buf[x + 3];
          if (a == 255) { continue; }
          if (a == 0) { buf[x] = 0; buf[x + 1] = 0; buf[x + 2] = 0; continue; }
          buf[x] = (byte)(buf[x] * a / 255);
          buf[x + 1] = (byte)(buf[x + 1] * a / 255);
          buf[x + 2] = (byte)(buf[x + 2] * a / 255);
        }
        Marshal.Copy(buf, 0, IntPtr.Add(bits, y * row), row);
      }
    } finally { bmp.UnlockBits(data); }
    return hbmp;
  }

  public static void Present(BadgeForm form, Bitmap bmp, int x, int y) {
    IntPtr screenDc = GetDC(IntPtr.Zero);
    IntPtr memDc = CreateCompatibleDC(screenDc);
    IntPtr bits;
    IntPtr hbmp = ToPremultipliedDib(bmp, screenDc, out bits);
    IntPtr old = SelectObject(memDc, hbmp);
    POINT dst = new POINT(); dst.x = x; dst.y = y;
    POINT src = new POINT(); src.x = 0; src.y = 0;
    SIZE size = new SIZE(); size.cx = bmp.Width; size.cy = bmp.Height;
    BLENDFUNCTION blend = new BLENDFUNCTION();
    blend.BlendOp = AC_SRC_OVER; blend.BlendFlags = 0; blend.SourceConstantAlpha = 255; blend.AlphaFormat = AC_SRC_ALPHA;
    UpdateLayeredWindow(form.Handle, screenDc, ref dst, ref size, memDc, ref src, 0, ref blend, ULW_ALPHA);
    SetWindowPos(form.Handle, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    SelectObject(memDc, old);
    DeleteObject(hbmp);
    DeleteDC(memDc);
    ReleaseDC(IntPtr.Zero, screenDc);
  }

  public static void KeepTopMost(BadgeForm form) {
    // The taskbar is topmost too, and among topmost windows the last one to be
    // activated wins. Clicking the taskbar button therefore puts the taskbar
    // above us: the marks are still painted, just covered, so nothing in the
    // state changes and no repaint is triggered -- the dot simply "disappears"
    // until something re-asserts the z-order. Hence: every tick.
    if (form == null || !form.IsHandleCreated) { return; }
    SetWindowPos(form.Handle, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
  }

  // Class name of the window directly ABOVE us in z-order, "" when we are on
  // top. Used to prove/report an occlusion instead of guessing at it.
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public static string TopNeighbour(BadgeForm form) {
    if (form == null || !form.IsHandleCreated) { return ""; }
    IntPtr prev = GetWindow(form.Handle, GW_HWNDPREV);
    if (prev == IntPtr.Zero) { return ""; }
    System.Text.StringBuilder sb = new System.Text.StringBuilder(256);
    GetClassName(prev, sb, 256);
    return sb.ToString();
  }

  // The class of the nearest VISIBLE window above us that actually overlaps our
  // rect, or "" when nothing covers us. Z-order alone is not enough: the desktop
  // permanently keeps invisible/tiny topmost windows (e.g. "IME") above us, and
  // reporting those made the diagnostic fire constantly and mean nothing.
  public static string CoveringWindow(BadgeForm form) {
    if (form == null || !form.IsHandleCreated) { return ""; }
    RECT me;
    if (!GetWindowRect(form.Handle, out me)) { return ""; }
    IntPtr h = GetWindow(form.Handle, GW_HWNDPREV);
    int guard = 0;
    while (h != IntPtr.Zero && guard++ < 16) {
      if (IsWindowVisible(h)) {
        RECT r;
        if (GetWindowRect(h, out r) && r.Right > r.Left && r.Bottom > r.Top) {
          bool overlaps = !(r.Right <= me.Left || r.Left >= me.Right || r.Bottom <= me.Top || r.Top >= me.Bottom);
          if (overlaps) {
            System.Text.StringBuilder sb = new System.Text.StringBuilder(256);
            GetClassName(h, sb, 256);
            return sb.ToString();
          }
        }
      }
      h = GetWindow(h, GW_HWNDPREV);
    }
    return "";
  }

  public static GraphicsPath RoundedRect(RectangleF r, float radius) {
    GraphicsPath p = new GraphicsPath();
    float d = radius * 2f;
    if (d <= 0.5f || d > Math.Min(r.Width, r.Height)) { p.AddRectangle(r); return p; }
    p.AddArc(r.X, r.Y, d, d, 180, 90);
    p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
    p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
    p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
    p.CloseFigure();
    return p;
  }
}

public static class BadgeRender {
  // Ink bounds (x, y, w, h) of `text` when drawn with the same StringFormat the
  // caller will use; null when nothing was rasterised.
  static float[] MeasureInk(string text, Font font, StringFormat sf, int sw, int sh) {
    float[] r = null;
    using (Bitmap b = new Bitmap(sw, sh, PixelFormat.Format32bppArgb)) {
      using (Graphics g = Graphics.FromImage(b)) {
        g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAlias;
        g.PixelOffsetMode = PixelOffsetMode.Half;   // same as the real draw
        g.Clear(Color.Transparent);
        g.DrawString(text, font, Brushes.White, new RectangleF(0, 0, sw, sh), sf);
      }
      int minX = sw, minY = sh, maxX = -1, maxY = -1;
      for (int y = 0; y < sh; y++) {
        for (int x = 0; x < sw; x++) {
          if (b.GetPixel(x, y).A <= 40) { continue; }
          if (x < minX) { minX = x; }
          if (x > maxX) { maxX = x; }
          if (y < minY) { minY = y; }
          if (y > maxY) { maxY = y; }
        }
      }
      if (maxX >= 0) { r = new float[] { minX, minY, maxX - minX + 1, maxY - minY + 1 }; }
    }
    return r;
  }
  // Paints into a canvas that is the icon rect inflated by `pad`; the icon rect
  // itself is (pad,pad,iconW,iconH). Anchors:
  //   badge centre : lifted above the icon's top-right corner
  //                  (BadgeLift * badgeSize up, so 0.5 rests it on the icon)
  //   dot centres  : icon left edge, first dot on the badge's centre line and
  //                  the rest stacked downwards with a gap
  public static Bitmap Render(int iconW, int iconH, int padLeft, int padTop, int padRight, int padBottom,
                              int count, string[] dotKinds, BadgeStyle s) {
    if (iconW < 1) { iconW = 1; }
    if (iconH < 1) { iconH = 1; }
    if (padLeft < 0) { padLeft = 0; }
    if (padTop < 0) { padTop = 0; }
    if (padRight < 0) { padRight = 0; }
    if (padBottom < 0) { padBottom = 0; }
    int w = iconW + padLeft + padRight;
    int h = iconH + padTop + padBottom;
    float left = padLeft;
    float top = padTop;
    float right = padLeft + iconW;
    float bottom = padTop + iconH;
    float lift = (float)(s.BadgeSize * s.BadgeLift);

    Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    Graphics g = Graphics.FromImage(bmp);
    try {
      g.SmoothingMode = SmoothingMode.AntiAlias;
      g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAlias;
      g.Clear(Color.Transparent);
      g.PixelOffsetMode = PixelOffsetMode.Half;

      float dotSize = s.DotSize;

      if (dotKinds != null) {
        int n = dotKinds.Length;
        if (n > s.DotMax) { n = s.DotMax; }
        if (n > 0) {
          float startCy = (s.DotStartAtBadge ? (top - lift) : top) + s.DotInsetY;
          float step = dotSize + s.DotGap;
          float span = bottom - startCy;
          // Keep the whole column on the edge: compress the step, then the dots
          // themselves, so the last one never runs past the icon's bottom-left
          // corner. dots.mode=fixed keeps the spacing and overflows instead.
          if (!s.DotFixedStep && n > 1 && (n - 1) * step > span && span > 0) {
            step = span / (n - 1);
            if (step < dotSize + 1) { dotSize = (float)Math.Max(4.0, step - 1.0); }
            if (step < 3) { step = 3; }
          }
          float cx = left + s.DotInsetX;
          for (int i = 0; i < n; i++) {
            float cy = startCy + i * step;
            RectangleF baseRect = new RectangleF(cx - (dotSize / 2f), cy - (dotSize / 2f), dotSize, dotSize);
            Color fill = string.Equals(dotKinds[i], "approval", StringComparison.OrdinalIgnoreCase)
                ? s.DotApproval : s.DotQuestion;
            using (GraphicsPath p = new GraphicsPath()) {
              p.AddEllipse(baseRect);
              using (SolidBrush b = new SolidBrush(fill)) { g.FillPath(b, p); }
              using (Pen pen = new Pen(s.DotRing, (float)s.DotRingWidth)) { g.DrawPath(pen, p); }
            }
          }
        }
      }

      bool showBadge = s.BadgeEnabled && (count > 0 || !s.HideWhenZero);
      if (showBadge) {
        float size = s.BadgeSize;
        float bcx = right - s.BadgeInsetX;
        float bcy = top - lift + s.BadgeInsetY;
        RectangleF badge = new RectangleF(bcx - (size / 2f), bcy - (size / 2f), size, size);
        float radius = (float)(size * s.BadgeRadius);
        using (GraphicsPath p = BadgeNative.RoundedRect(badge, radius)) {
          using (SolidBrush b = new SolidBrush(s.BadgeBg)) { g.FillPath(b, p); }
          if (s.BadgeRingWidth > 0) {
            using (Pen pen = new Pen(s.BadgeRing, (float)s.BadgeRingWidth)) { g.DrawPath(pen, p); }
          }
        }
        string text = count > 99 ? "99+" : count.ToString();
        float fontSize = s.FontSize;
        if (fontSize <= 0) { fontSize = (float)(size * s.FontSizeRatio); }
        if (text.Length > 2) { fontSize = fontSize * 0.62f; }
        else if (text.Length > 1) { fontSize = fontSize * 0.82f; }
        using (Font font = new Font(s.FontFamily, fontSize, s.FontBold ? FontStyle.Bold : FontStyle.Regular, GraphicsUnit.Pixel)) {
          using (SolidBrush b = new SolidBrush(s.BadgeFg)) {
            using (StringFormat sf = new StringFormat()) {
              sf.Alignment = StringAlignment.Center;
              sf.LineAlignment = StringAlignment.Center;
              // DrawString centres the LAYOUT box, and GDI+ then biases the ink
              // by half a pixel left / a whole pixel up (PixelOffsetMode.Half).
              // So measure the real ink once and place THAT dead centre; this
              // also keeps "1" and "12" optically centred at any size.
              int sw = (int)Math.Ceiling(size * 2f) + 4;
              int sh = (int)Math.Ceiling(size * 2f) + 4;
              float[] ink = MeasureInk(text, font, sf, sw, sh);
              float tx = badge.X + ((badge.Width - (ink == null ? 0f : ink[2])) / 2f) + s.TextOffsetX;
              float ty = badge.Y + ((badge.Height - (ink == null ? 0f : ink[3])) / 2f) + s.TextOffsetY;
              if (ink != null) { tx -= ink[0]; ty -= ink[1]; }
              RectangleF tr = new RectangleF(tx, ty, sw, sh);
              g.DrawString(text, font, b, tr, sf);
            }
          }
        }
      }
    } finally {
      g.Dispose();
    }
    return bmp;
  }
}
'@
Trace 'csharp compiled'

# ---- config ----------------------------------------------------------------
function Get-ConfigStamp {
  # Last-write ticks of the deployed config.json, or 0 when it is unreadable.
  try { return (Get-Item (Join-Path $script:Dir 'config.json') -ErrorAction Stop).LastWriteTimeUtc.Ticks }
  catch { return 0 }
}

function Get-ConfigValue {
  param($Object, [string]$Path, $Fallback)
  $cur = $Object
  foreach ($seg in $Path.Split('.')) {
    if ($null -eq $cur) { return $Fallback }
    $prop = $cur.PSObject.Properties[$seg]
    if ($null -eq $prop) { return $Fallback }
    if ($null -eq $prop.Value) { return $Fallback }
    $cur = $prop.Value
  }
  return $cur
}

function ConvertTo-Color {
  param($Value, [System.Drawing.Color]$Fallback)
  if ($null -eq $Value) { return $Fallback }
  try { return [System.Drawing.ColorTranslator]::FromHtml([string]$Value) } catch { return $Fallback }
}

function Read-Config {
  $path = Join-Path $script:Dir 'config.json'
  $raw = $null
  if (Test-Path $path) {
    try { $raw = Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { Write-Log "config.json unreadable: $($_.Exception.Message)" }
  }
  $style = New-Object BadgeStyle
  $style.BadgeEnabled   = [bool](Get-ConfigValue $raw 'badge.enabled' $true)
  $style.BadgeSize      = [int](Get-ConfigValue $raw 'badge.size' 0)
  # insetX nudge the badge CENTRE left from the icon's right edge; insetY is an
  # extra vertical nudge below the lifted position (badge.lift).
  $style.BadgeInsetX    = [int](Get-ConfigValue $raw 'badge.insetX' 0)
  $style.BadgeInsetY    = [int](Get-ConfigValue $raw 'badge.insetY' 0)
  $style.BadgeLift      = [double](Get-ConfigValue $raw 'badge.lift' 0.5)
  $style.BadgeRadius    = [double](Get-ConfigValue $raw 'badge.radius' 0.34)
  $style.BadgeBg        = ConvertTo-Color (Get-ConfigValue $raw 'badge.bg' $null) ([System.Drawing.Color]::FromArgb(13, 13, 13))
  $style.BadgeFg        = ConvertTo-Color (Get-ConfigValue $raw 'badge.fg' $null) ([System.Drawing.Color]::White)
  $style.BadgeRing      = ConvertTo-Color (Get-ConfigValue $raw 'badge.ring' $null) ([System.Drawing.Color]::White)
  $style.BadgeRingWidth = [double](Get-ConfigValue $raw 'badge.ringWidth' 1.2)
  $style.FontFamily     = [string](Get-ConfigValue $raw 'badge.fontFamily' 'Segoe UI')
  $style.FontSize       = [int](Get-ConfigValue $raw 'badge.fontSize' 0)
  $style.FontSizeRatio  = [double](Get-ConfigValue $raw 'badge.fontSizeRatio' 0.62)
  $style.TextOffsetX    = [int](Get-ConfigValue $raw 'badge.textOffsetX' 0)
  $style.TextOffsetY    = [int](Get-ConfigValue $raw 'badge.textOffsetY' 0)
  $style.FontBold       = [bool](Get-ConfigValue $raw 'badge.fontBold' $true)
  $style.HideWhenZero   = [bool](Get-ConfigValue $raw 'badge.hideWhenZero' $true)

  $style.DotSize        = [int](Get-ConfigValue $raw 'dots.size' 0)
  $style.DotGap         = [int](Get-ConfigValue $raw 'dots.gap' 3)
  # insetX nudges the dot CENTRES sideways off the icon's left edge; insetY is an
  # extra offset for the first dot below its start line (see dots.start).
  $style.DotInsetX      = [int](Get-ConfigValue $raw 'dots.insetX' 0)
  $style.DotInsetY      = [int](Get-ConfigValue $raw 'dots.insetY' 0)
  # 'badge' (default): the first dot shares the badge's centre line; 'corner':
  # the first dot sits on the icon's top-left corner.
  $style.DotStartAtBadge = -not (([string](Get-ConfigValue $raw 'dots.start' 'badge')).ToLower() -eq 'corner')
  # dots.mode: 'fit' (default) squeezes the column into the icon's height,
  # 'fixed' keeps 点径+gap spacing and lets the column overflow downwards.
  $style.DotFixedStep = (([string](Get-ConfigValue $raw 'dots.mode' 'fit')).ToLower() -eq 'fixed')
  $style.DotQuestion    = ConvertTo-Color (Get-ConfigValue $raw 'dots.question' $null) ([System.Drawing.Color]::FromArgb(17, 17, 17))
  $style.DotApproval    = ConvertTo-Color (Get-ConfigValue $raw 'dots.approval' $null) ([System.Drawing.Color]::FromArgb(255, 196, 0))
  $style.DotRing        = ConvertTo-Color (Get-ConfigValue $raw 'dots.ring' $null) ([System.Drawing.Color]::White)
  $style.DotRingWidth   = [double](Get-ConfigValue $raw 'dots.ringWidth' 1.2)
  $style.DotMax         = [int](Get-ConfigValue $raw 'dots.max' 6)

  return [pscustomobject]@{
    Style            = $style
    ClickThrough     = [bool](Get-ConfigValue $raw 'clickThrough' $true)
    PollMs           = [int](Get-ConfigValue $raw 'pollMs' 500)
    ButtonRefreshMs  = [int](Get-ConfigValue $raw 'buttonRefreshMs' 2500)
    ButtonSearchMs   = [int](Get-ConfigValue $raw 'buttonSearchMs' 30000)
    ButtonRetryMs    = [int](Get-ConfigValue $raw 'buttonRetryMs' 4000)
    AnchorMode       = [string](Get-ConfigValue $raw 'anchor.mode' 'taskbar-button')
    Target           = [string](Get-ConfigValue $raw 'anchor.target' 'icon')
    IconScale        = [double](Get-ConfigValue $raw 'anchor.iconScale' 0.5)
    IconOffsetX      = [int](Get-ConfigValue $raw 'anchor.iconOffsetX' 0)
    IconOffsetY      = [int](Get-ConfigValue $raw 'anchor.iconOffsetY' 0)
    Calibrate        = [bool](Get-ConfigValue $raw 'anchor.calibrate' $true)
    CalibrateMinPx   = [int](Get-ConfigValue $raw 'anchor.calibrateMinPx' 12)
    CalibrateMaxPx   = [int](Get-ConfigValue $raw 'anchor.calibrateMaxPx' 48)
    CalibrateMinRatio = [double](Get-ConfigValue $raw 'anchor.calibrateMinRatio' 0)
    CalibrateMaxRatio = [double](Get-ConfigValue $raw 'anchor.calibrateMaxRatio' 0)
    CalibrateThreshold = [int](Get-ConfigValue $raw 'anchor.calibrateThreshold' 60)
    IconPad          = [double](Get-ConfigValue $raw 'anchor.iconPad' 1.12)
    BadgeSizeRatio   = [double](Get-ConfigValue $raw 'badge.sizeRatio' 0.52)
    DotSizeRatio     = [double](Get-ConfigValue $raw 'dots.sizeRatio' 0.22)
    DotStart         = [string](Get-ConfigValue $raw 'dots.start' 'badge')
    OffsetX          = [int](Get-ConfigValue $raw 'anchor.offsetX' 0)
    OffsetY          = [int](Get-ConfigValue $raw 'anchor.offsetY' 0)
    ScreenCorner     = [string](Get-ConfigValue $raw 'anchor.screenCorner' 'bottom-right')
    CornerMarginX    = [int](Get-ConfigValue $raw 'anchor.cornerMarginX' 12)
    CornerMarginY    = [int](Get-ConfigValue $raw 'anchor.cornerMarginY' 12)
    DotOrder         = [string](Get-ConfigValue $raw 'dots.order' 'time')
    DotGroup         = [string](Get-ConfigValue $raw 'dots.group' 'kind')
    ReferencePx      = [int](Get-ConfigValue $raw 'anchor.referencePx' 0)
    AutomationIds    = @(Get-ConfigValue $raw 'buttonMatch.automationId' @('com.deepseek.dsh'))
    Names            = @(Get-ConfigValue $raw 'buttonMatch.name' @('DeepSeek Harness'))
  }
}

# ---- state -----------------------------------------------------------------
function Read-State {
  $path = Join-Path $script:Dir 'state.json'
  $now = [Environment]::TickCount
  if (-not (Test-Path $path)) { return $script:StateCache }
  try {
    $fi = Get-Item $path -ErrorAction Stop
    $stamp = $fi.LastWriteTimeUtc.Ticks
    $size = $fi.Length
    $unchanged = ($stamp -eq $script:StateStamp) -and ($size -eq $script:StateSize)
    # The timestamp alone is not trusted (a same-tick rewrite would be missed),
    # so an unchanged file is still re-parsed on a slow cycle.
    if ($unchanged -and (($now - $script:StateReadAt) -lt $script:StateMaxAgeMs)) { return $script:StateCache }
    $obj = Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json
    $script:StateStamp = $stamp
    $script:StateSize = $size
    $script:StateReadAt = $now
    $script:StateCache = $obj
  } catch {
    # A torn read (host mid-rewrite) keeps the previous frame; the next tick
    # retries because StateReadAt was not advanced.
    return $script:StateCache
  }
  return $script:StateCache
}

# ---- UI Automation: locate the DSH taskbar button ---------------------------
# Search ONLY inside the taskbar window. A desktop-rooted descendant search is
# both slow (seconds) and, once the shell's UIA tree goes bad, returns hundreds
# of duplicate/stale entries -- including ones whose property reads BLOCK. That
# blocked a poll tick forever and pinned a core (observed: 33% CPU, no log line,
# no repaint). Rooting the search at Shell_TrayWnd measured 9 ms vs ~3000 ms.
function Get-TaskbarRoot {
  $now = [Environment]::TickCount
  if ($null -ne $script:TrayRoot -and (($now - $script:TrayRootAt) -lt 60000)) { return $script:TrayRoot }
  $script:TrayRoot = $null
  $script:TrayRootAt = $now
  try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    foreach ($cls in @('Shell_TrayWnd', 'Shell_SecondaryTrayWnd')) {
      $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ClassNameProperty, $cls)
      $w = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
      if ($null -ne $w) { $script:TrayRoot = $w; break }
    }
  } catch {
    $script:TrayRoot = $null
  }
  if ($null -eq $script:TrayRoot) {
    # No taskbar window found: fall back to the desktop root (slow but correct).
    $script:TrayRoot = [System.Windows.Automation.AutomationElement]::RootElement
  }
  return $script:TrayRoot
}

function Find-DshButton {
  param($Config)
  try {
    $scope = Get-TaskbarRoot
    $cond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ClassNameProperty, 'Taskbar.TaskListButtonAutomationPeer')
    $found = $scope.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    $seen = @()
    $seenIds = @{}
    for ($i = 0; $i -lt $found.Count; $i++) {
      $el = $found.Item($i)
      $aid = [string]$el.Current.AutomationId
      $nm = [string]$el.Current.Name
      if ($seen.Count -lt 8) { $seen += "$aid|$nm" }
      # The tree can contain duplicate elements for the same button; the first
      # match wins, and its id is remembered so a stale duplicate is skipped.
      $hit = $false
      foreach ($pat in $Config.AutomationIds) {
        if ($aid -and $pat -and $aid.ToLower().Contains(([string]$pat).ToLower())) { $hit = $true; break }
      }
      if (-not $hit) {
        foreach ($pat in $Config.Names) {
          if ($nm -and $pat -and $nm.ToLower().Contains(([string]$pat).ToLower())) { $hit = $true; break }
        }
      }
      if (-not $hit) { continue }
      $key = "$aid|$nm"
      if ($seenIds.ContainsKey($key)) { continue }
      $seenIds[$key] = $true
      # Validate the element cheaply: a stale entry throws or reports an empty
      # rect, in which case the next candidate is tried.
      try {
        $r = $el.Current.BoundingRectangle
        if ([double]::IsNaN($r.Width) -or [double]::IsNaN($r.Height)) { continue }
        if ($r.Width -lt 4 -or $r.Height -lt 4) { continue }
      } catch { continue }
      return $el
    }
    # Nothing matched: say what the taskbar actually offers (throttled), so a
    # renamed AppUserModelId is a one-line fix in config.json.
    $t = [Environment]::TickCount
    if (($t - $script:LastMissLogAt) -gt 30000) {
      $script:LastMissLogAt = $t
      Write-Log ("UIA: no DSH button among $($found.Count) taskbar buttons: " + ($seen -join ' ; '))
    }
  } catch {
    # UIA can go sour transiently (provider restart, shell reload): throttle the
    # noise, drop the cached element, and let the next poll re-discover it.
    $now = [Environment]::TickCount
    if (($now - $script:LastUiaErrAt) -gt 30000) {
      Write-Log "UIA lookup failed: $($_.Exception.Message)"
      $script:LastUiaErrAt = $now
    }
    $script:ButtonCache = $null
    $script:ButtonFoundAt = -100000
    $script:TrayRoot = $null
    $script:TrayRootAt = -100000
  }
  return $null
}

function Get-ButtonRect {
  param($Element)
  $r = $Element.Current.BoundingRectangle
  if ([double]::IsNaN($r.Width) -or [double]::IsNaN($r.Height)) { return $null }
  if ($r.Width -lt 4 -or $r.Height -lt 4) { return $null }
  return [pscustomobject]@{
    X = [int][Math]::Round($r.X); Y = [int][Math]::Round($r.Y)
    Width = [int][Math]::Round($r.Width); Height = [int][Math]::Round($r.Height)
  }
}

# ---- icon box inside the button --------------------------------------------
# Screen capture only (no process access), so this works from any process.
#
# The raw ink bbox is useless: the button rect also covers the neighbouring
# buttons' edge bands and the running-app underline. So the ink is split into
# connected components and the one sitting nearest the button centre wins --
# that is the icon glyph.
function Measure-IconBox {
  param($Rect, $Config)
  $bmp = $null
  try {
    $w = $Rect.Width; $h = $Rect.Height
    # Bounds for a plausible glyph, as a fraction of the button's short side when
    # the ratios are set (so the measurement does not reject a valid glyph on a
    # bigger DPI / taskbar scale).
    $short = [Math]::Min($w, $h)
    $minPx = $Config.CalibrateMinPx
    $maxPx = $Config.CalibrateMaxPx
    if ($Config.CalibrateMinRatio -gt 0) { $minPx = [int][Math]::Max(6, [Math]::Round($short * $Config.CalibrateMinRatio)) }
    if ($Config.CalibrateMaxRatio -gt 0) { $maxPx = [int][Math]::Max($minPx + 4, [Math]::Round($short * $Config.CalibrateMaxRatio)) }
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($Rect.X, $Rect.Y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
    $g.Dispose()

    # The button is mostly padding: its dominant colour is the background.
    $freq = @{}
    for ($y = 0; $y -lt $h; $y++) {
      for ($x = 0; $x -lt $w; $x++) {
        $c = $bmp.GetPixel($x, $y)
    # Pack with multiplication, not -shl: PowerShell keeps the LEFT operand's
    # numeric type, so [byte]235 -shl 16 silently wraps back to 0.
    $k = ([int]$c.R * 65536) + ([int]$c.G * 256) + [int]$c.B
        if ($freq.ContainsKey($k)) { $freq[$k]++ } else { $freq[$k] = 1 }
      }
    }
    $bgKey = 0; $bgCount = -1
    foreach ($kv in $freq.GetEnumerator()) { if ($kv.Value -gt $bgCount) { $bgCount = $kv.Value; $bgKey = $kv.Key } }
    $bgR = ($bgKey -shr 16) -band 255; $bgG = ($bgKey -shr 8) -band 255; $bgB = $bgKey -band 255
    $bgLum = 0.299 * $bgR + 0.587 * $bgG + 0.114 * $bgB

    # ink mask over the interior. Ink must be DARKER than the background: Windows
    # 11 draws a light hover/active highlight behind the taskbar button, which
    # differs from the plain taskbar by more than the colour threshold. Counting
    # light-on-light differences made the measured "icon" flip between the glyph
    # and the 32x32 highlight box as the window gained/lost focus.
    $thr = $Config.CalibrateThreshold
    $lumSlack = 22
    $mask = [bool[]]::new($w * $h)
    $inkTotal = 0
    for ($y = 1; $y -lt $h - 1; $y++) {
      for ($x = 1; $x -lt $w - 1; $x++) {
        $c = $bmp.GetPixel($x, $y)
        $d = [Math]::Abs($c.R - $bgR) + [Math]::Abs($c.G - $bgG) + [Math]::Abs($c.B - $bgB)
        if ($d -le $thr) { continue }
        $lum = 0.299 * $c.R + 0.587 * $c.G + 0.114 * $c.B
        if ($lum -gt ($bgLum - $lumSlack)) { continue }
        $mask[($y * $w) + $x] = $true; $inkTotal++
      }
    }
    Trace "measure: bg=$bgR,$bgG,$bgB lum=$([int]$bgLum) thr=$thr ink=$inkTotal size=${w}x${h}"

    # connected components (4-neighbour flood fill over an explicit int stack)
    $seen = [bool[]]::new($w * $h)
    $best = $null
    $bestScore = -1.0
    [double]$cx0 = $w / 2.0
    [double]$cy0 = $h / 2.0
    $stack = [System.Collections.Generic.List[int]]::new()
    $found = 0
    for ([int]$sy = 1; $sy -lt ($h - 1); $sy++) {
      for ([int]$sx = 1; $sx -lt ($w - 1); $sx++) {
        [int]$startIdx = ($sy * $w) + $sx
        if (-not $mask[$startIdx]) { continue }
        if ($seen[$startIdx]) { continue }
        $stack.Clear()
        $stack.Add($startIdx)
        $seen[$startIdx] = $true
        [int]$area = 0
        [int]$minX = $w; [int]$maxX = -1; [int]$minY = $h; [int]$maxY = -1
        [int]$sumX = 0; [int]$sumY = 0
        while ($stack.Count -gt 0) {
          [int]$last = $stack.Count - 1
          [int]$idx = $stack[$last]
          $stack.RemoveAt($last)
          [int]$px = $idx % $w
          [int]$py = [int](($idx - $px) / $w)
          $area++
          $sumX += $px
          $sumY += $py
          if ($px -lt $minX) { $minX = $px }
          if ($px -gt $maxX) { $maxX = $px }
          if ($py -lt $minY) { $minY = $py }
          if ($py -gt $maxY) { $maxY = $py }
          if ($px -gt 0) { [int]$n = $idx - 1; if ($mask[$n] -and -not $seen[$n]) { $seen[$n] = $true; $stack.Add($n) } }
          if ($px -lt ($w - 1)) { [int]$n = $idx + 1; if ($mask[$n] -and -not $seen[$n]) { $seen[$n] = $true; $stack.Add($n) } }
          if ($py -gt 0) { [int]$n = $idx - $w; if ($mask[$n] -and -not $seen[$n]) { $seen[$n] = $true; $stack.Add($n) } }
          if ($py -lt ($h - 1)) { [int]$n = $idx + $w; if ($mask[$n] -and -not $seen[$n]) { $seen[$n] = $true; $stack.Add($n) } }
        }
        if ($area -lt 30) { continue }
        $found++
        [double]$ccx = $sumX / [double]$area
        [double]$ccy = $sumY / [double]$area
        [int]$bw = $maxX - $minX + 1
        [int]$bh = $maxY - $minY + 1
        Trace "measure: component area=$area bbox=${bw}x${bh} centre=$([int]$ccx),$([int]$ccy)"
        # must sit near the middle (rejects the edge bands and the underline)
        if ([Math]::Abs($ccx - $cx0) -gt ($w * 0.28)) { continue }
        if ([Math]::Abs($ccy - $cy0) -gt ($h * 0.28)) { continue }
        if ($bw -gt $maxPx -or $bh -gt $maxPx) { continue }
        if ($bw -lt $minPx -or $bh -lt $minPx) { continue }
        # prefer a big, dense, centred component
        [double]$score = $area - (([Math]::Abs($ccx - $cx0) + [Math]::Abs($ccy - $cy0)) * 4)
        if ($score -gt $bestScore) {
          $bestScore = $score
          $best = [pscustomobject]@{
            Cx = $ccx; Cy = $ccy; W = $bw; H = $bh; Area = $area
            Bx = $minX; By = $minY
          }
        }
      }
    }
    if ($null -eq $best) {
      Trace "measure: no acceptable component (ink=$inkTotal components=$found)"
      return $null
    }

    # Square the glyph box up around its own centre: an icon's layout box is
    # square even when the glyph inside it is not. This square is only the SIZE
    # BASIS for the badge/dot ratios.
    $side = [int][Math]::Round([Math]::Max($best.W, $best.H) * $Config.IconPad)
    if ($side -lt $minPx) { $side = $minPx }
    if ($side -gt $maxPx) { $side = $maxPx }
    $x = [int][Math]::Round($best.Cx - ($side / 2.0))
    $y = [int][Math]::Round($best.Cy - ($side / 2.0))

    # Anchor rect: the glyph's own bbox, inflated by iconPad around its centre
    # (iconPad = 1.0 -> exactly the ink outline, which is where the user wants
    # the badge centre and the dot centres to sit).
    $inkW = [int][Math]::Round($best.W * $Config.IconPad)
    $inkH = [int][Math]::Round($best.H * $Config.IconPad)
    if ($inkW -lt 6) { $inkW = 6 }
    if ($inkH -lt 6) { $inkH = 6 }
    $inkX = [int][Math]::Round($best.Bx + (($best.W - $inkW) / 2.0))
    $inkY = [int][Math]::Round($best.By + (($best.H - $inkH) / 2.0))
    return [pscustomobject]@{
      X = $Rect.X + $x; Y = $Rect.Y + $y; Width = $side; Height = $side
      InkX = $Rect.X + $inkX; InkY = $Rect.Y + $inkY; InkWidth = $inkW; InkHeight = $inkH
      Source = 'measured'; Ink = $best.Area
      Bg = "$bgR,$bgG,$bgB"
      Glyph = "$($best.W)x$($best.H)@$([int]$best.Cx),$([int]$best.Cy)"
    }
  } catch {
    Trace "measure failed: $($_.Exception.Message)"
    return $null
  } finally {
    if ($null -ne $bmp) { $bmp.Dispose() }
  }
}

function Get-FallbackIconBox {
  param($Rect, $Config)
  $side = [int][Math]::Round([Math]::Min($Rect.Width, $Rect.Height) * $Config.IconScale)
  if ($side -lt 8) { $side = 8 }
  $x = $Rect.X + [int](($Rect.Width - $side) / 2); $y = $Rect.Y + [int](($Rect.Height - $side) / 2)
  return [pscustomobject]@{
    X = $x; Y = $y; Width = $side; Height = $side
    InkX = $x; InkY = $y; InkWidth = $side; InkHeight = $side
    Source = 'geometry'; Ink = 0; Bg = ''
  }
}

function Get-IconBox {
  param($Rect, $Config)
  $key = '{0},{1},{2}x{3}' -f $Rect.X, $Rect.Y, $Rect.Width, $Rect.Height
  $now = [Environment]::TickCount
  if ($key -eq $script:IconBoxFor -and $null -ne $script:IconBox -and (($now - $script:IconBoxAt) -lt $script:IconBoxTtlMs)) {
    return $script:IconBox
  }
  # Measure with the overlay OFF screen. Otherwise our own badge is part of the
  # "ink" the measurement sees, the accepted component grows every re-measure
  # and both the badge and the dots creep away from the icon.
  $why = if ($key -eq $script:IconBoxFor) { 'icon-box ttl expired' } else { 'button rect changed' }
  if (-not $script:Hidden) {
    Hide-Overlay -Reason "re-measuring ($why)"
    Start-Sleep -Milliseconds 120
  }
  Write-Log "re-measuring icon box ($why)"
  $box = $null
  if ($Config.Calibrate) { $box = Measure-IconBox -Rect $Rect -Config $Config }
  if ($null -eq $box) { $box = Get-FallbackIconBox -Rect $Rect -Config $Config }
  $box.X = $box.X + $Config.IconOffsetX
  $box.Y = $box.Y + $Config.IconOffsetY
  $box.InkX = $box.InkX + $Config.IconOffsetX
  $box.InkY = $box.InkY + $Config.IconOffsetY
  $script:IconBox = $box
  $script:IconBoxFor = $key
  $script:IconBoxAt = [Environment]::TickCount
  return $box
}

function Get-CornerRect {
  param($Config, [int]$Width, [int]$Height)
  $wa = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $x = $wa.Right - $Width - $Config.CornerMarginX
  $y = $wa.Bottom - $Height - $Config.CornerMarginY
  if ($Config.ScreenCorner -eq 'top-right') { $y = $wa.Top + $Config.CornerMarginY }
  elseif ($Config.ScreenCorner -eq 'top-left') { $x = $wa.Left + $Config.CornerMarginX; $y = $wa.Top + $Config.CornerMarginY }
  elseif ($Config.ScreenCorner -eq 'bottom-left') { $x = $wa.Left + $Config.CornerMarginX }
  return [pscustomobject]@{ X = $x; Y = $y; Width = $Width; Height = $Height }
}

# ---- rendering -------------------------------------------------------------
function Hide-Overlay {
  param([string]$Reason = 'unspecified')
  if ($script:Hidden) { return }
  $bmp = New-Object System.Drawing.Bitmap(1, 1)
  [BadgeNative]::Present($script:Form, $bmp, -4, -4)
  $bmp.Dispose()
  $script:Hidden = $true
  $script:LastPresent = $null
  # Why the marks vanished matters: "button not found" vs "nothing to draw" vs a
  # blink for a re-measure are three very different bugs.
  Write-Log "overlay hidden ($Reason)"
}

function Show-Frame {
  param($Config, $Icon, [int]$Count, [string[]]$Kinds)
  # Resolve the style for THIS icon size. Every absolute (px) knob is scaled by
  # basis/referencePx, so a config tuned on one machine keeps its proportions on
  # another (different DPI / taskbar icon size). Ratio knobs need no scaling.
  $style = $Config.Style.Clone()
  $basis = [Math]::Min($Icon.Width, $Icon.Height)
  if ($basis -lt 1) { $basis = 1 }
  $scale = 1.0
  if ($Config.ReferencePx -gt 0) { $scale = $basis / [double]$Config.ReferencePx }
  $px = { param($v) [int][Math]::Round($v * $scale) }
  # Sizes may be ratio-driven so the badge keeps its proportion on any icon size.
  if ($style.BadgeSize -le 0) {
    $style.BadgeSize = [int][Math]::Max(10, [Math]::Round($basis * $Config.BadgeSizeRatio))
  } else {
    $style.BadgeSize = & $px $style.BadgeSize
  }
  if ($style.DotSize -le 0) {
    $style.DotSize = [int][Math]::Max(5, [Math]::Round($basis * $Config.DotSizeRatio))
  } else {
    $style.DotSize = & $px $style.DotSize
  }
  if ($style.FontSize -gt 0) { $style.FontSize = & $px $style.FontSize }
  $style.DotGap = & $px $style.DotGap
  $style.DotInsetX = & $px $style.DotInsetX
  $style.DotInsetY = & $px $style.DotInsetY
  $style.BadgeInsetX = & $px $style.BadgeInsetX
  $style.BadgeInsetY = & $px $style.BadgeInsetY
  $style.TextOffsetX = & $px $style.TextOffsetX
  $style.TextOffsetY = & $px $style.TextOffsetY
  $style.BadgeRingWidth = $style.BadgeRingWidth * $scale
  $style.DotRingWidth = $style.DotRingWidth * $scale
  # The badge is lifted above the icon's top edge and the dots ride on the badge
  # line plus down the left edge, so the canvas has to cover:
  #   top    : lift + half of the largest mark
  #   sides  : half of the badge (right) / half of a dot (left)
  #   bottom : half of a dot, plus whatever the column overflows in fixed mode
  $ring = [Math]::Max($style.BadgeRingWidth, $style.DotRingWidth)
  $lift = $style.BadgeSize * $style.BadgeLift
  $dotStart = 0.0
  if ($style.DotStartAtBadge) { $dotStart = $lift }
  $nDots = [Math]::Min($Kinds.Count, $style.DotMax)
  $topReach = [Math]::Max($lift + ($style.BadgeSize / 2.0), $dotStart + $style.DotInsetY + ($style.DotSize / 2.0))
  $sideReach = [Math]::Max($style.BadgeSize, $style.DotSize) / 2.0
  $dotsBottom = $style.DotSize / 2.0
  if ($nDots -gt 0) {
    $dotsBottom = $dotStart + $style.DotInsetY + ($style.DotSize / 2.0)
    if ($nDots -gt 1) {
      $dotsBottom += ($nDots - 1) * ($style.DotSize + $style.DotGap)
    }
  }
  $inkW = [int]$Icon.InkWidth; $inkH = [int]$Icon.InkHeight
  # fit mode squeezes the column into the icon, so only half a dot can stick out
  # below; fixed mode keeps the spacing and needs room for the overflow.
  $bottomReach = $style.DotSize / 2.0
  if ($style.DotFixedStep) { $bottomReach = [Math]::Max($bottomReach, $dotsBottom - $inkH) }
  $padTop = [int][Math]::Ceiling($topReach + $ring + 2)
  $padBottom = [int][Math]::Ceiling($bottomReach + $ring + 2)
  $padSide = [int][Math]::Ceiling($sideReach + $ring + 2)
  if ($padTop -lt 0) { $padTop = 0 }
  if ($padBottom -lt 0) { $padBottom = 0 }
  if ($padSide -lt 0) { $padSide = 0 }
  $cw = $inkW + ($padSide * 2); $ch = $inkH + $padTop + $padBottom
  $cx = [int]$Icon.InkX - $padSide + $Config.OffsetX
  $cy = [int]$Icon.InkY - $padTop + $Config.OffsetY
  $key = '{0},{1},{2},{3},{4},{5},{6},{7},{8}' -f $cx, $cy, $cw, $ch, $Count, ($Kinds -join ''), $padTop, $padBottom, $padSide
  if ($key -eq $script:LastPresent) { return }
  $bmp = [BadgeRender]::Render($inkW, $inkH, $padSide, $padTop, $padSide, $padBottom, $Count, $Kinds, $style)
  [BadgeNative]::Present($script:Form, $bmp, $cx, $cy)
  # Keep the pixels: a z-order restore can then re-present the exact frame
  # without paying for the render (which re-measures the digit's ink).
  if ($null -ne $script:FrameBmp) { $script:FrameBmp.Dispose() }
  $script:FrameBmp = $bmp
  $script:FrameX = $cx
  $script:FrameY = $cy
  $script:LastPresent = $key
  $script:Hidden = $false
  Write-Log ("frame count=$Count dots=$($Kinds.Count) canvas=${cw}x${ch}@$cx,$cy pad=$padSide/$padTop/$padBottom badge=$($style.BadgeSize) dot=$($style.DotSize) icon=${inkW}x${inkH}")
}

# Put the already-rendered frame back on screen. Cheap (no re-render) and safe
# to call every tick: UpdateLayeredWindow replaces the window content atomically.
function RePresent-Frame {
  if ($script:Hidden -or $null -eq $script:FrameBmp) { return }
  [BadgeNative]::Present($script:Form, $script:FrameBmp, $script:FrameX, $script:FrameY)
}

# Re-assert our place at the top of the topmost band, and report what was
# covering us. Clicking the DSH taskbar button makes the taskbar the foreground
# topmost window, which puts it above the overlay: the marks are still there,
# just hidden, and nothing in the state changes -- so without this the dot looked
# like it "briefly disappeared" until some unrelated repaint fixed the z-order.
function Maintain-ZOrder {
  # Only an actually-overlapping window counts as "covering us".
  $above = [BadgeNative]::CoveringWindow($script:Form)
  if ($above -ne '') {
    [BadgeNative]::KeepTopMost($script:Form)
    RePresent-Frame
    $now = [Environment]::TickCount
    if (($now - $script:LastOccludedLogAt) -gt 5000) {
      $script:LastOccludedLogAt = $now
      Write-Log "z-order: '$above' covered the overlay - re-asserted topmost"
    }
    return
  }
  # Nothing covering us: keep our place cheaply, but do not repaint.
  $now = [Environment]::TickCount
  if (($now - $script:LastTopMostAt) -gt 1500) {
    $script:LastTopMostAt = $now
    [BadgeNative]::KeepTopMost($script:Form)
  }
}

# ---- preview (manual tuning) ------------------------------------------------
# Optional %LOCALAPPDATA%\DshBadgeNotify\preview.json:
#   {"enabled": true, "count": 8, "dots": ["question", "approval", "question"]}
# While it is present the overlay ignores state.json and paints exactly these
# marks, so the geometry can be tuned by hand (config.json hot-reloads within
# ~2s). Delete the file to go back to the live state.
function Read-Preview {
  $path = Join-Path $script:Dir 'preview.json'
  $stamp = 0
  try { $stamp = (Get-Item $path -ErrorAction Stop).LastWriteTimeUtc.Ticks } catch { $stamp = 0 }
  if ($stamp -eq $script:PreviewStamp) { return $script:PreviewCache }
  $script:PreviewStamp = $stamp
  $script:PreviewCache = $null
  if ($stamp -eq 0) {
    if ($script:PreviewLogged) {
      Write-Log 'preview.json gone - back to the live state'
      $script:PreviewLogged = $false
    }
    return $null
  }
  try {
    $obj = Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([bool]$obj.enabled) {
      $kinds = @()
      foreach ($k in @($obj.dots)) { $kinds += [string]$k }
      $script:PreviewCache = [pscustomobject]@{ Count = [int]$obj.count; Kinds = $kinds }
      Write-Log "preview.json: $($kinds.Count) dot(s) [$($kinds -join ',')] count=$([int]$obj.count)"
      $script:PreviewLogged = $true
    } elseif ($script:PreviewLogged) {
      Write-Log 'preview.json disabled - back to the live state'
      $script:PreviewLogged = $false
    }
  } catch {
    Write-Log "preview.json unreadable: $($_.Exception.Message)"
  }
  return $script:PreviewCache
}

function Invoke-Step {
  # Latency watchdog: a UIA call that blocks forever used to leave the overlay
  # silently spinning (a core burnt, no log, no repaint). Reporting a slow tick
  # turns that invisible failure into a log line.
  $tickStart = [Environment]::TickCount
  if ($script:LastTickAt -gt 0) {
    $gap = $tickStart - $script:LastTickAt
    if ($gap -gt 15000 -and ($tickStart - $script:LastTickWarnAt) -gt 60000) {
      $script:LastTickWarnAt = $tickStart
      Write-Log "slow tick: previous poll took ${gap}ms (UIA may be blocking)"
    }
  }
  try {
    $cfg = $script:Cfg
    $now = [Environment]::TickCount
    $drawRect = $null

    # config.json is the tuning surface: pick edits up without a restart.
    if (($now - $script:CfgCheckedAt) -gt 2000) {
      $script:CfgCheckedAt = $now
      $stamp = Get-ConfigStamp
      if ($stamp -ne 0 -and $stamp -ne $script:CfgStamp) {
        $first = ($script:CfgStamp -eq 0)
        $script:CfgStamp = $stamp
        if (-not $first) {
          $cfg = Read-Config
          $script:Cfg = $cfg
          # sizes/anchor changed: drop the derived caches and repaint
          $script:IconBox = $null; $script:IconBoxFor = ''; $script:IconBoxAt = -100000
          $script:ButtonCache = $null; $script:ButtonRect = $null; $script:ButtonRetryAt = 0
          $script:LastPresent = $null; $script:LastIconLog = ''; $script:LastRectLog = ''
          Write-Log ("config.json reloaded: target=$($cfg.Target) iconPad=$($cfg.IconPad) " +
                     "badgeRatio=$($cfg.BadgeSizeRatio) dotRatio=$($cfg.DotSizeRatio)")
        }
      }
    }

    if ($cfg.AnchorMode -eq 'taskbar-button') {      # UIA lookup is expensive (the desktop tree is huge), so the element is
      # cached: the rect is re-read on a short cycle and a fresh search only
      # runs when the element is missing/dead or after buttonSearchMs. A FAILED
      # search backs off only briefly, otherwise one UIA hiccup would blank the
      # badge for the whole slow cycle.
      if ($null -ne $script:ButtonCache -and (($now - $script:ButtonFoundAt) -gt $cfg.ButtonSearchMs)) {
        $script:ButtonCache = $null
      }
      if ($null -eq $script:ButtonCache -and $now -ge $script:ButtonRetryAt) {
        $script:ButtonCache = Find-DshButton -Config $cfg
        $script:ButtonFoundAt = [Environment]::TickCount
        if ($null -eq $script:ButtonCache) {
          $script:ButtonRetryAt = [Environment]::TickCount + $cfg.ButtonRetryMs
        } else {
          $script:ButtonRect = $null
        }
      }
      if ($null -ne $script:ButtonCache -and
          (($null -eq $script:ButtonRect) -or (($now - $script:ButtonRectAt) -gt $cfg.ButtonRefreshMs))) {
        try {
          $script:ButtonRect = Get-ButtonRect -Element $script:ButtonCache
        } catch {
          # Dead element (shell restart, monitor change): drop it and let the
          # next tick re-search. The last known rect is KEPT so a slow search
          # does not blink the badge away.
          $script:ButtonCache = $null
          $script:ButtonFoundAt = -100000
          $script:ButtonRetryAt = 0
        }
        $script:ButtonRectAt = [Environment]::TickCount
      }
      $buttonRect = $script:ButtonRect
      if ($null -eq $buttonRect) {
        if ($script:LastRectLog -ne 'none') {
          Write-Log 'DSH taskbar button not found - overlay hidden'
          $script:LastRectLog = 'none'
        }
        Hide-Overlay -Reason 'button not found'
        return
      }
      $rectKey = '{0},{1},{2}x{3}' -f $buttonRect.X, $buttonRect.Y, $buttonRect.Width, $buttonRect.Height
      if ($rectKey -ne $script:LastRectLog) {
        Write-Log "button at $rectKey"
        $script:LastRectLog = $rectKey
      }
      if ($cfg.Target -eq 'icon') {
        $drawRect = Get-IconBox -Rect $buttonRect -Config $cfg
      } else {
        $drawRect = $buttonRect
        if ($null -eq $drawRect.InkWidth) {
          $drawRect = [pscustomobject]@{
            X = $buttonRect.X; Y = $buttonRect.Y; Width = $buttonRect.Width; Height = $buttonRect.Height
            InkX = $buttonRect.X; InkY = $buttonRect.Y; InkWidth = $buttonRect.Width; InkHeight = $buttonRect.Height
            Source = 'button'; Ink = 0; Bg = ''
          }
        }
      }
    } else {
      $drawRect = Get-CornerRect -Config $cfg -Width 220 -Height 140
      $drawRect = [pscustomobject]@{
        X = $drawRect.X; Y = $drawRect.Y; Width = $drawRect.Width; Height = $drawRect.Height
        InkX = $drawRect.X; InkY = $drawRect.Y; InkWidth = $drawRect.Width; InkHeight = $drawRect.Height
        Source = 'screen-corner'; Ink = 0; Bg = ''
      }
    }

    $iconKey = '{0},{1},{2}x{3}/{4}/ink {5},{6} {7}x{8}' -f $drawRect.X, $drawRect.Y, $drawRect.Width, $drawRect.Height,
      $drawRect.Source, $drawRect.InkX, $drawRect.InkY, $drawRect.InkWidth, $drawRect.InkHeight
    if ($iconKey -ne $script:LastIconLog) {
      $extra = ''
      if ($drawRect.Source -eq 'measured') { $extra = " ink=$($drawRect.Ink) glyph=$($drawRect.Glyph) bg=$($drawRect.Bg)" }
      Write-Log ("draw box $($drawRect.X),$($drawRect.Y) $($drawRect.Width)x$($drawRect.Height) source=$($drawRect.Source)$extra")
      Write-Log ("anchor ink $($drawRect.InkX),$($drawRect.InkY) $($drawRect.InkWidth)x$($drawRect.InkHeight)")
      $script:LastIconLog = $iconKey
    }

    $count = 0
    $kinds = @()
    $preview = Read-Preview
    if ($null -ne $preview) {
      # Tuning mode: preview.json pins a fixed set of marks on screen so the
      # position/size can be adjusted by hand without waiting for real events.
      $count = $preview.Count
      $kinds = @($preview.Kinds)
    } elseif ($Demo) {
      $count = 3
      $kinds = @('question', 'approval', 'question')
    } else {
      $st = Read-State
      if ($null -ne $st) {
        $count = [int](Get-ConfigValue $st 'completed.count' 0)
        $items = @(Get-ConfigValue $st 'pending.items' @())
        if ($items.Count -gt 0) {
          if ($cfg.DotGroup -eq 'kind') {
            # ONE dot per KIND (the default): black = something needs a human to
            # answer, yellow = a permission request. Three pending questions still
            # show a single black dot.
            $firstQ = $null; $firstA = $null
            foreach ($it in $items) {
              $at = [double](Get-ConfigValue $it 'at' 0)
              if ([string]$it.kind -eq 'approval') {
                if ($null -eq $firstA -or $at -lt $firstA) { $firstA = $at }
              } elseif ($null -eq $firstQ -or $at -lt $firstQ) { $firstQ = $at }
            }
            $pairs = @()
            if ($null -ne $firstQ) { $pairs += [pscustomobject]@{ Kind = 'question'; At = $firstQ } }
            if ($null -ne $firstA) { $pairs += [pscustomobject]@{ Kind = 'approval'; At = $firstA } }
            if ($cfg.DotOrder -eq 'time') { $pairs = @($pairs | Sort-Object -Property At) }
            foreach ($pp in $pairs) {
              if ($kinds.Count -ge $cfg.Style.DotMax) { break }
              $kinds += [string]$pp.Kind
            }
          } else {
            if ($cfg.DotOrder -eq 'kind') {
              $items = @($items | Sort-Object -Property @{ Expression = { if ($_.kind -eq 'question') { 0 } else { 1 } } }, at)
            } else {
              $items = @($items | Sort-Object -Property at)
            }
            foreach ($it in $items) {
              if ($kinds.Count -ge $cfg.Style.DotMax) { break }
              $kinds += [string]$it.kind
            }
          }
        }
      }
    }

    if (($count -le 0) -and ($kinds.Count -eq 0) -and $cfg.Style.HideWhenZero) { Hide-Overlay -Reason 'nothing to draw'; return }
    Show-Frame -Config $cfg -Icon $drawRect -Count $count -Kinds $kinds
    # Every tick, not every so often: the taskbar taking the foreground (a click
    # on its button) is enough to cover the overlay, and no state changes when
    # that happens, so there is no repaint to rescue it. This is what makes the
    # dot flicker away for as long as the nudge used to be throttled.
    Maintain-ZOrder
  } catch {
    Write-Log "step failed: $($_.Exception.Message)"
  } finally {
    $script:LastTickAt = [Environment]::TickCount
  }
}

# ---- main ------------------------------------------------------------------
function Invoke-BadgeMain {
  # Per-monitor-v2: every coordinate below (UIA rects included) is physical px.
  try { [void][BadgeNative]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { Write-Log 'DpiAwareness unsupported' }

  $created = $false
  try { $script:Mutex = [System.Threading.Mutex]::new($false, 'Local\DshBadgeNotify_SingleInstance', [ref]$created) }
  catch { $created = $true }
  if ($created) {
    try { $created = $script:Mutex.WaitOne(0) } catch { $created = $true }
  }
  if (-not $created) { Write-Log 'another instance is already running - exiting'; return 0 }
  $script:HaveMutex = $true
  Trace 'mutex acquired'

  $script:Cfg = Read-Config
  $script:CfgStamp = Get-ConfigStamp
  Write-Log "start v$($script:Version) anchor=$($script:Cfg.AnchorMode)/$($script:Cfg.Target) clickThrough=$($script:Cfg.ClickThrough) demo=$($Demo.IsPresent)"

  if ($SelfTest -or $Calibrate) {
    Trace 'locating button'
    $el = Find-DshButton -Config $script:Cfg
    if ($null -eq $el) { Write-Host 'SELFTEST: FAIL - DSH taskbar button not found'; return 2 }
    $rect = Get-ButtonRect -Element $el
    if ($null -eq $rect) { Write-Host 'SELFTEST: FAIL - button has no usable rect'; return 3 }
    Write-Host ("SELFTEST: OK aid='{0}' name='{1}' button={2},{3},{4}x{5}" -f `
      $el.Current.AutomationId, $el.Current.Name, $rect.X, $rect.Y, $rect.Width, $rect.Height)
    $measured = Measure-IconBox -Rect $rect -Config $script:Cfg
    if ($null -ne $measured) {
      Write-Host ("MEASURED icon: {0},{1} {2}x{3} ink={4} bg={5} buttonOffset=+{6},+{7}" -f `
        $measured.X, $measured.Y, $measured.Width, $measured.Height, $measured.Ink, $measured.Bg, ($measured.X - $rect.X), ($measured.Y - $rect.Y))
      Write-Host ("ANCHOR ink  : {0},{1} {2}x{3}  (badge centre = top-right corner, dot centres = left edge)" -f `
        $measured.InkX, $measured.InkY, $measured.InkWidth, $measured.InkHeight)
    } else {
      Write-Host 'MEASURED icon: none (fallback would apply)'
    }
    $fall = Get-FallbackIconBox -Rect $rect -Config $script:Cfg
    Write-Host ("FALLBACK icon: {0},{1} {2}x{3}" -f $fall.X, $fall.Y, $fall.Width, $fall.Height)
    # Calibrate is a diagnostic: report and leave. Only a normal run (or -Demo /
    # -Once) enters the message loop and paints.
    return 0
  }

  $script:Form = New-Object BadgeForm
  $script:Form.ClickThrough = $script:Cfg.ClickThrough
  $script:Form.Show()
  $script:Form.Visible = $true
  Trace 'form shown'

  if ($Once) {
    Invoke-Step
    Start-Sleep -Milliseconds 1500
    return 0
  }

  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = [Math]::Max(120, $script:Cfg.PollMs)
  $timer.add_Tick({ Invoke-Step })
  $timer.Start()

  Invoke-Step
  [System.Windows.Forms.Application]::Run($script:Form)
  $timer.Stop()
  $timer.Dispose()
  return 0
}

$exitCode = 0
try {
  $exitCode = Invoke-BadgeMain
} catch {
  Write-Log "fatal: $($_.Exception.Message)"
  $exitCode = 1
} finally {
  if ($script:HaveMutex -and $null -ne $script:Mutex) {
    try { $script:Mutex.ReleaseMutex() } catch { }
    try { $script:Mutex.Dispose() } catch { }
  }
}
if ($SelfTest -or $Once -or $Calibrate) { exit $exitCode }
