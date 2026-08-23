# FlowMate Android 用户端

仅包含**工作台用户功能**（首页、任务、团队、语音、拍照、复盘等），**不含** `/admin` 管理后台。管理员请在电脑浏览器打开 `https://usertool.aidigitcloud.cn/admin`。

## 构建

```bash
# 在项目根目录
npm install
npm run android:sync   # 构建用户端前端 + 同步到本目录
npm run android:open   # 用 Android Studio 打开
```

在 Android Studio 中 Run 安装到真机或模拟器。

## 首次使用

1. 安装 App 后直接注册/登录（已内置服务器 `https://usertool.aidigitcloud.cn`）
2. 模型、积分等请在电脑浏览器打开 `https://usertool.aidigitcloud.cn/admin` 配置

## 发布 APK

Android Studio → **Build → Generate Signed Bundle / APK**，选择 APK 并按向导签名。

或使用 CI / `npm run android:apk` 生成 debug 包。
