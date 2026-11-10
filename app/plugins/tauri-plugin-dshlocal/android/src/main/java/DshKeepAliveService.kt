package cc.zexa.dshtether.dshlocal

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * 远程连接的后台保活前台服务:App 退到后台时起,回前台即停。它存在的意义与
 * DshLocalService 一样——让系统把 App 进程当作前台进程,不进 Doze、不被缓存
 * 冻结,iroh 连接和 QUIC keepalive 才活得下来。通知是低优先级的静默常驻通知,
 * 只是系统要求前台服务必须有这么一条;进程真被杀了不自动拉起(START_NOT_STICKY):
 * 连接已经没了,拉起服务也没用,回前台时 App 自己重连。
 */
class DshKeepAliveService : Service() {
  companion object {
    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"
    private const val CHANNEL_ID = "dsh-keepalive"
    private const val NOTIFICATION_ID = 0x0d5c
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "DSH Tether"
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: ""
    ensureChannel()
    val notification = buildNotification(title, text)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    stopForeground(STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return
    // 渠道名与说明出现在系统的通知设置里,由系统显示,所以按系统语言取
    val zh = java.util.Locale.getDefault().language == "zh"
    val channel = NotificationChannel(
      CHANNEL_ID,
      if (zh) "保持连接" else "Keeping the connection alive",
      // DEFAULT 而非 LOW:MIUI 等国产 ROM 会把 LOW 收进「不重要通知」折叠组,
      // 用户根本看不到这条保活状态;DEFAULT 仍静音(下面 setSound(null)),
      // 只是作为一条正常通知显示在通知栏与锁屏上
      NotificationManager.IMPORTANCE_DEFAULT,
    )
    channel.description = if (zh) {
      "退到后台时保持与电脑的连接;关掉它,系统可能会在后台断开连接"
    } else {
      "Keeps the connection to the computer alive while the app is in the background; turning it off may drop the connection"
    }
    channel.setShowBadge(false)
    channel.setSound(null, null)
    // 默认锁屏可见性是「隐藏」,退后台后用户在锁屏上看不到这条;这里放出来
    // (内容只是主机名与一句说明,不敏感)
    channel.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    manager.createNotificationChannel(channel)
  }

  private fun buildNotification(title: String, text: String): Notification {
    // 点通知回到 App;启动图标复用 App 自己的
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    val pending = launch?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }
    builder
      .setContentTitle(title)
      .setContentText(text)
      .setSmallIcon(applicationInfo.icon)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      // 灵动岛式的状态栏胶囊:系统读 when 自己走秒(「已运行/已连接 N 分钟」的来源),
      // 通知栏里展开也是计时的钟
      .setWhen(System.currentTimeMillis())
      .setShowWhen(true)
      .setUsesChronometer(true)
    // Android 16(API 36)起:ongoing + ProgressStyle 会在状态栏显示「Live Update」
    // 胶囊(Android 的灵动岛),锁屏与常显屏同样渲染。运行时长未知,用不定进度。
    if (Build.VERSION.SDK_INT >= 36) {
      builder.setStyle(
        Notification.ProgressStyle()
          .setProgressIndeterminate(true)
          .setStyledByProgress(true),
      )
    }
    // 静默靠渠道:LOW 级别的渠道本来就不出声,不用(也不存在)Builder.setSilent
    if (pending != null) builder.setContentIntent(pending)
    return builder.build()
  }
}
