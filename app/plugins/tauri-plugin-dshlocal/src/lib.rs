//! 本地模式的 Android 前台服务:手机上跑着 dsh 时挂一条常驻通知,系统就不会在
//! App 退到后台时把进程(连同 node 子进程)收掉。只有 Android 有实现;其余平台
//! 的调用是空操作,调用方不用分平台。
#[cfg(target_os = "android")]
use serde::Serialize;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

#[cfg(target_os = "android")]
use tauri::{plugin::PluginHandle, Manager};

#[cfg(target_os = "android")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceArgs<'a> {
    title: &'a str,
    text: &'a str,
}

#[cfg(target_os = "android")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeepAliveArgs<'a> {
    title: &'a str,
    text: &'a str,
    wake_lock: bool,
}

#[cfg(target_os = "android")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveDownloadArgs<'a> {
    path: &'a str,
    name: &'a str,
    mime: &'a str,
}

#[cfg(target_os = "android")]
#[derive(serde::Deserialize)]
struct SavedDownload {
    name: String,
}

#[cfg(target_os = "android")]
pub struct DshLocal<R: Runtime>(PluginHandle<R>);

#[cfg(target_os = "android")]
impl<R: Runtime> DshLocal<R> {
    pub fn start_service(&self, title: &str, text: &str) -> tauri::Result<()> {
        self.0
            .run_mobile_plugin::<()>("startService", ServiceArgs { title, text })
            .map_err(Into::into)
    }

    pub fn stop_service(&self) -> tauri::Result<()> {
        self.0.run_mobile_plugin::<()>("stopService", ()).map_err(Into::into)
    }

    pub fn start_keep_alive(&self, title: &str, text: &str, wake_lock: bool) -> tauri::Result<()> {
        self.0
            .run_mobile_plugin::<()>("startKeepAlive", KeepAliveArgs { title, text, wake_lock })
            .map_err(Into::into)
    }

    pub fn stop_keep_alive(&self) -> tauri::Result<()> {
        self.0.run_mobile_plugin::<()>("stopKeepAlive", ()).map_err(Into::into)
    }

    pub fn save_download(&self, path: &str, name: &str, mime: &str) -> tauri::Result<String> {
        self.0
            .run_mobile_plugin::<SavedDownload>("saveDownload", SaveDownloadArgs { path, name, mime })
            .map(|saved| saved.name)
            .map_err(Into::into)
    }
}

/// 起前台服务(带通知)。非 Android 平台无事发生。
pub fn start_service<R: Runtime>(app: &tauri::AppHandle<R>, title: &str, text: &str) -> tauri::Result<()> {
    #[cfg(target_os = "android")]
    {
        return app.state::<DshLocal<R>>().start_service(title, text);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, title, text);
        Ok(())
    }
}

pub fn stop_service<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    #[cfg(target_os = "android")]
    {
        return app.state::<DshLocal<R>>().stop_service();
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(())
    }
}

/// 起远程连接的后台保活前台服务(带静默常驻通知)。`wake_lock` 为真时服务期间
/// 另持 CPU 唤醒锁,熄屏深度休眠也不停。非 Android 平台无事发生。
pub fn start_keep_alive<R: Runtime>(
    app: &tauri::AppHandle<R>,
    title: &str,
    text: &str,
    wake_lock: bool,
) -> tauri::Result<()> {
    #[cfg(target_os = "android")]
    {
        return app.state::<DshLocal<R>>().start_keep_alive(title, text, wake_lock);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, title, text, wake_lock);
        Ok(())
    }
}

pub fn stop_keep_alive<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    #[cfg(target_os = "android")]
    {
        return app.state::<DshLocal<R>>().stop_keep_alive();
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(())
    }
}

/// 把 `path` 处的文件拷进系统公共「下载」目录(显示名 `name`,类型 `mime`)并发
/// 完成通知,返回最终文件名(重名时系统会改名)。`path` 本身不动,调用方自己删。
/// 非 Android 平台报不支持。
pub fn save_download<R: Runtime>(app: &tauri::AppHandle<R>, path: &str, name: &str, mime: &str) -> tauri::Result<String> {
    #[cfg(target_os = "android")]
    {
        return app.state::<DshLocal<R>>().save_download(path, name, mime);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, path, name, mime);
        Err(tauri::Error::Io(std::io::Error::new(std::io::ErrorKind::Unsupported, "save_download is Android-only")))
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("dshlocal")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin("cc.zexa.dshtether.dshlocal", "DshLocalPlugin")?;
                app.manage(DshLocal(handle));
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = (app, api);
            }
            Ok(())
        })
        .build()
}
