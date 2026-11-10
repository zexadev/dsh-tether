package cc.zexa.dshtether.dshlocal

import android.app.Activity
import android.content.Intent
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class ServiceArgs {
  var title: String = "DSH Tether"
  var text: String = ""
}

/** Rust 侧经 run_mobile_plugin 调 startService / stopService;不暴露给 JS。 */
@TauriPlugin
class DshLocalPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun startService(invoke: Invoke) {
    val args = invoke.parseArgs(ServiceArgs::class.java)
    val intent = Intent(activity, DshLocalService::class.java)
      .putExtra(DshLocalService.EXTRA_TITLE, args.title)
      .putExtra(DshLocalService.EXTRA_TEXT, args.text)
    ContextCompat.startForegroundService(activity, intent)
    invoke.resolve()
  }

  @Command
  fun stopService(invoke: Invoke) {
    activity.stopService(Intent(activity, DshLocalService::class.java))
    invoke.resolve()
  }

  @Command
  fun startKeepAlive(invoke: Invoke) {
    val args = invoke.parseArgs(ServiceArgs::class.java)
    val intent = Intent(activity, DshKeepAliveService::class.java)
      .putExtra(DshKeepAliveService.EXTRA_TITLE, args.title)
      .putExtra(DshKeepAliveService.EXTRA_TEXT, args.text)
    ContextCompat.startForegroundService(activity, intent)
    invoke.resolve()
  }

  @Command
  fun stopKeepAlive(invoke: Invoke) {
    activity.stopService(Intent(activity, DshKeepAliveService::class.java))
    invoke.resolve()
  }
}
