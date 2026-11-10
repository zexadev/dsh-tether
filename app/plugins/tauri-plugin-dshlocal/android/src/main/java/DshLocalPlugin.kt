package cc.zexa.dshtether.dshlocal

import android.app.Activity
import android.content.Intent
import android.view.View
import android.webkit.WebView
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
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
  override fun load(webView: WebView) {
    super.load(webView)
    // MainActivity 在所有版本上都调了 enableEdgeToEdge():窗口不再适配系统栏,
    // windowSoftInputMode=adjustResize 随之不再压缩窗口(API 30+ 明确如此,
    // Android 15 targetSdk≥35 更是强制边到边),键盘直接盖在 WebView 上,
    // dsh 的输入框待在键盘底下(0.1.28 真机报告)。改为把 IME inset 变成内容区
    // 底部 padding:WebView 随之变矮,页面 innerHeight 变小,输入框跟着键盘上移,
    // 等同 adjustResize 旧行为。不分版本:病根 enableEdgeToEdge 也不分版本,
    // WindowInsetsCompat 的 ime() 在低版本由 androidx 兼容实现。
    val content = activity.window.decorView.findViewById<View>(android.R.id.content)
    val target = content ?: activity.window.decorView
    ViewCompat.setOnApplyWindowInsetsListener(target) { v, insets ->
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      v.setPadding(v.paddingLeft, v.paddingTop, v.paddingRight, ime.bottom)
      insets
    }
    ViewCompat.requestApplyInsets(target)
  }

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
