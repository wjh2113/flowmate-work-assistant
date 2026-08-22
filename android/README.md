# FlowMate Android 用户端

仅包含**工作台用户功能**（首页、任务、团队、语音、拍照、复盘等），**不含** `/admin` 管理后台。管理员请在电脑浏览器打开 `http://服务器:8787/admin`。

## 构建

```bash
# 在项目根目录
npm install
npm run android:sync   # 构建用户端前端 + 同步到本目录
npm run android:open   # 用 Android Studio 打开
```

在 Android Studio 中 Run 安装到真机或模拟器。

## 首次使用

1. 确保电脑已运行 `npm start`（FlowMate 服务端）
2. 手机与电脑同一 WiFi
3. App 首次启动填写服务器地址，例如 `http://192.168.1.31:8787`
4. 注册/登录后即可使用

## 发布 APK

Android Studio → **Build → Generate Signed Bundle / APK**，选择 APK 并按向导签名。

可选：构建前在 `.env` 设置默认服务器：

```env
VITE_API_BASE_URL=http://192.168.1.31:8787
```
