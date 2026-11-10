package cc.zexa.dshtether.dshlocal

import android.app.DownloadManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import java.io.File

/**
 * 把 App 缓存里的临时文件存成用户看得见的下载。
 *
 * - Android 10+(API 29):写进 MediaStore.Downloads,即公共「下载」目录,不需要
 *   任何存储权限;重名由 MediaStore 自己改名。完成后发一条通知,点开即用系统
 *   默认应用打开。
 * - Android 7–9:公共目录要运行时申请 WRITE_EXTERNAL_STORAGE,不申请就写不进。
 *   改写到 App 专属外部目录(Android/data/<包名>/files/Download,免权限),再用
 *   DownloadManager.addCompletedDownload 登记:系统「下载」应用里能看到、带完成
 *   通知、点开可打开。代价是卸载 App 时这些文件随之删除。
 */
object DshDownloads {
  private const val CHANNEL_ID = "dsh-downloads"

  /** 返回最终文件名 */
  fun save(context: Context, source: File, name: String, mime: String): String {
    val type = resolveMime(name, mime)
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      saveToMediaStore(context, source, name, type)
    } else {
      saveLegacy(context, source, name, type)
    }
  }

  private fun saveToMediaStore(context: Context, source: File, name: String, type: String): String {
    val resolver = context.contentResolver
    val values = ContentValues().apply {
      put(MediaStore.Downloads.DISPLAY_NAME, name)
      put(MediaStore.Downloads.MIME_TYPE, type)
      put(MediaStore.Downloads.IS_PENDING, 1)
    }
    val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
      ?: throw IllegalStateException("MediaStore insert returned null")
    try {
      resolver.openOutputStream(uri)?.use { out -> source.inputStream().use { it.copyTo(out) } }
        ?: throw IllegalStateException("cannot open $uri")
      resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
    } catch (e: Exception) {
      resolver.delete(uri, null, null)
      throw e
    }
    // 重名时 MediaStore 会改名,把实际落盘名读回来
    val finalName = resolver.query(uri, arrayOf(MediaStore.Downloads.DISPLAY_NAME), null, null, null)?.use {
      if (it.moveToFirst()) it.getString(0) else null
    } ?: name
    notifySaved(context, uri, type, finalName)
    return finalName
  }

  @Suppress("DEPRECATION")
  private fun saveLegacy(context: Context, source: File, name: String, type: String): String {
    val dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
      ?: throw IllegalStateException("external storage unavailable")
    dir.mkdirs()
    val target = uniqueFile(dir, name)
    source.copyTo(target)
    val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
    dm.addCompletedDownload(target.name, target.name, true, type, target.absolutePath, target.length(), true)
    return target.name
  }

  private fun uniqueFile(dir: File, name: String): File {
    var file = File(dir, name)
    if (!file.exists()) return file
    val dot = name.lastIndexOf('.')
    val base = if (dot > 0) name.substring(0, dot) else name
    val ext = if (dot > 0) name.substring(dot) else ""
    var n = 1
    while (file.exists()) {
      file = File(dir, "$base ($n)$ext")
      n += 1
    }
    return file
  }

  private fun resolveMime(name: String, mime: String): String {
    if (mime.isNotBlank() && mime != "application/octet-stream") return mime
    val ext = name.substringAfterLast('.', "").lowercase()
    return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
  }

  private fun notifySaved(context: Context, uri: Uri, type: String, name: String) {
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val zh = java.util.Locale.getDefault().language == "zh"
    if (manager.getNotificationChannel(CHANNEL_ID) == null) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, if (zh) "下载" else "Downloads", NotificationManager.IMPORTANCE_DEFAULT).apply {
          setShowBadge(false)
          setSound(null, null)
        },
      )
    }
    val view = Intent(Intent.ACTION_VIEW)
      .setDataAndType(uri, type)
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    val open = PendingIntent.getActivity(
      context,
      uri.hashCode(),
      Intent.createChooser(view, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val notification = Notification.Builder(context, CHANNEL_ID)
      .setContentTitle(name)
      .setContentText(if (zh) "已保存到「下载」,点按打开" else "Saved to Downloads. Tap to open")
      .setSmallIcon(android.R.drawable.stat_sys_download_done)
      .setContentIntent(open)
      .setAutoCancel(true)
      .build()
    // 没有通知权限时系统静默丢弃;页面里另有一条提示,不影响用户知道结果
    manager.notify(uri.hashCode(), notification)
  }
}
