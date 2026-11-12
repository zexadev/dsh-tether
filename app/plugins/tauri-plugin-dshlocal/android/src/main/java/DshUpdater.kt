package cc.zexa.dshtether.dshlocal

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * App 内更新(仅 Android):查最新版本 → 下载与本机同 ABI 的 APK → 校验 → 交给系统安装器。
 *
 * 全部在 Kotlin 这侧做,Rust 只转发命令。与 jdnotes(Rust 用 reqwest 下载、MainActivity
 * 的 JS 桥装包)是同一流程的另一种写法,这里多了一步 [verify]:用 PackageManager 读出
 * 下载到的 APK 里的包名与版本号,对不上就不交给安装器。签名不另验,安卓只允许与已装
 * 应用同签名的包覆盖安装,换过的包装不上。
 *
 * 来源都先走官网、不通再直连 GitHub:国内直连 github.com 慢且不稳,官网的 Cloudflare
 * Functions 反代同一份 Release(国内用户在 arm64 上还能走镜像)。地址都写死在这里,
 * 不接受调用方传 URL。
 */
object DshUpdater {
  private const val SITE = "https://dsh-tether.zexa.cc"
  private const val REPO = "https://github.com/zexadev/dsh-tether"
  private const val UA = "dsh-tether-app"

  /** 下载进度;JS 轮询 [progress] 读,下载线程写 */
  @Volatile var downloaded: Long = 0
  @Volatile var total: Long = 0

  class Check(val current: String, val latest: String, val available: Boolean)

  /** 查最新版本。顺手清掉上次下好没装的包:装完系统直接杀进程,没有机会事后删 */
  fun check(context: Context): Check {
    updatesDir(context).listFiles()?.forEach { it.delete() }
    val current = currentVersion(context)
    val latest = latestVersion()
    return Check(current, latest, isNewer(latest, current))
  }

  private fun latestVersion(): String {
    val errors = mutableListOf<String>()
    // 官网 /api/stats 带 15 分钟缓存,不占 GitHub API 额度
    try {
      val body = get("$SITE/api/stats").use { it.inputStream.bufferedReader().readText() }
      val v = JSONObject(body).optString("version").removePrefix("v")
      if (v.isNotEmpty()) return v
      errors += "site: no version"
    } catch (e: Exception) {
      errors += "site: ${e.message}"
    }
    // releases/latest 会 302 到 /releases/tag/vX.Y.Z,读 Location 就够,不走 API
    try {
      val conn = open("$REPO/releases/latest")
      conn.instanceFollowRedirects = false
      try {
        val tag = conn.getHeaderField("Location")?.substringAfterLast('/')?.removePrefix("v")
        if (!tag.isNullOrEmpty()) return tag
        errors += "github: HTTP ${conn.responseCode}, no redirect"
      } finally {
        conn.disconnect()
      }
    } catch (e: Exception) {
      errors += "github: ${e.message}"
    }
    throw IllegalStateException(errors.joinToString("; "))
  }

  /**
   * 下载 [version] 的安装包,返回落盘路径。先官网后 GitHub;任一来源下完且通过校验即返回。
   * 官网给的是「最新版」,和 [version] 对不上(刚好又发了一版)会被 [verify] 拦下,转去
   * GitHub 按版本号精确下载。
   */
  fun download(context: Context, version: String): String {
    val abi = abi(context)
    val dir = updatesDir(context)
    dir.listFiles()?.forEach { it.delete() }
    val part = File(dir, "dsh-tether-$version-$abi.apk.part")
    val apk = File(dir, "dsh-tether-$version-$abi.apk")
    val sources = listOf(
      "$SITE/download/android?abi=$abi",
      "$REPO/releases/download/v$version/dsh-tether-$version-$abi.apk",
    )
    val errors = mutableListOf<String>()
    for (url in sources) {
      try {
        downloadTo(url, part)
        verify(context, part, version)
        if (!part.renameTo(apk)) throw IllegalStateException("cannot rename ${part.name}")
        return apk.absolutePath
      } catch (e: Exception) {
        errors += "${URL(url).host}: ${e.message}"
        part.delete()
      }
    }
    throw IllegalStateException(errors.joinToString("; "))
  }

  private fun downloadTo(url: String, file: File) {
    downloaded = 0
    total = 0
    val conn = get(url)
    try {
      total = conn.contentLengthLong.coerceAtLeast(0)
      conn.inputStream.use { input ->
        file.outputStream().use { out ->
          val buf = ByteArray(64 * 1024)
          while (true) {
            val n = input.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
            downloaded += n
          }
        }
      }
    } finally {
      conn.disconnect()
    }
    if (total > 0 && downloaded != total) {
      throw IllegalStateException("incomplete: $downloaded / $total bytes")
    }
  }

  /** 下到的包必须是本应用、且正是要的那个版本 */
  private fun verify(context: Context, file: File, version: String) {
    val info = context.packageManager.getPackageArchiveInfo(file.absolutePath, 0)
      ?: throw IllegalStateException("not a valid APK")
    if (info.packageName != context.packageName) {
      throw IllegalStateException("package ${info.packageName}, expected ${context.packageName}")
    }
    if (info.versionName != version) {
      throw IllegalStateException("version ${info.versionName}, expected $version")
    }
  }

  /**
   * 交给系统安装器。Android 8+ 要用户先允许本应用「安装未知应用」:没允许就打开那一页
   * 设置并返回 "needs-permission",用户打开开关回来再点一次;否则返回 "started"。
   */
  fun install(activity: Activity, path: String): String {
    val file = File(path)
    if (!file.isFile) throw IllegalStateException("APK not found: $path")
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !activity.packageManager.canRequestPackageInstalls()) {
      activity.startActivity(
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}"))
      )
      return "needs-permission"
    }
    // 缓存目录在 App 清单的 file_paths.xml 里登记过(cache-path),FileProvider 才签得出 URI
    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
    activity.startActivity(
      Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, "application/vnd.android.package-archive")
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
    )
    return "started"
  }

  /**
   * 本机装的是哪个 ABI 的包。原生库目录名(/data/app/…/lib/arm64)正好就是 Release 里 APK
   * 的后缀;拆 ABI 打包时装的只有一个,用它比用 SUPPORTED_ABIS 准(64 位手机也可能装了 arm 包)。
   */
  private fun abi(context: Context): String {
    val dir = File(context.applicationInfo.nativeLibraryDir).name
    if (dir in setOf("arm64", "arm", "x86", "x86_64")) return dir
    return when (Build.SUPPORTED_ABIS.firstOrNull()) {
      "armeabi-v7a" -> "arm"
      "x86" -> "x86"
      "x86_64" -> "x86_64"
      else -> "arm64"
    }
  }

  private fun currentVersion(context: Context): String =
    context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "0.0.0"

  private fun updatesDir(context: Context): File = File(context.cacheDir, "updates").apply { mkdirs() }

  /** a 是否比 b 新;只比 主.次.修订,解析不了按不新 */
  private fun isNewer(a: String, b: String): Boolean {
    val pa = parse(a) ?: return false
    val pb = parse(b) ?: return false
    for (i in 0..2) if (pa[i] != pb[i]) return pa[i] > pb[i]
    return false
  }

  private fun parse(v: String): List<Int>? {
    val m = Regex("""^v?(\d+)\.(\d+)\.(\d+)""").find(v.trim()) ?: return null
    return m.groupValues.drop(1).map { it.toInt() }
  }

  private fun open(url: String): HttpURLConnection =
    (URL(url).openConnection() as HttpURLConnection).apply {
      connectTimeout = 15_000
      readTimeout = 30_000
      setRequestProperty("User-Agent", UA)
    }

  /** GET 并要求 2xx;HttpURLConnection 自己跟 https→https 的跳转(GitHub → 资产 CDN) */
  private fun get(url: String): HttpURLConnection {
    val conn = open(url)
    val code = conn.responseCode
    if (code !in 200..299) {
      conn.disconnect()
      throw IllegalStateException("HTTP $code")
    }
    return conn
  }

  private inline fun <T> HttpURLConnection.use(block: (HttpURLConnection) -> T): T =
    try { block(this) } finally { disconnect() }
}
