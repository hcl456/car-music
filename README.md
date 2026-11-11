# Car Music

在 iPhone Safari 上播放 **Google Drive** 與 **手機 / iCloud** 音樂檔的網頁 App。
支援播放清單、隨機、循環、離線播放，以及鎖定畫面與車機上的歌名和上一首/下一首控制。

## 1. Google Cloud 設定（取得 Client ID）

1. 到 <https://console.cloud.google.com> 建立專案。
2. 「API 和服務」→「程式庫」→ 啟用 **Google Drive API**。
3. 設定 **OAuth 同意畫面**（Google Auth Platform）：
   - 使用者類型：**外部**。
   - 發布狀態維持 **測試中 (Testing)**。
   - 在 **測試使用者** 加入自己的 Google 帳號。
4. 「憑證」→ 建立 **OAuth 用戶端 ID**，類型選 **網頁應用程式**：
   - **已授權的 JavaScript 來源**：
     - `https://你的帳號.github.io`
     - `http://localhost:8080`
   - **已授權的重新導向 URI**（必填，一定要和實際網址完全一樣，**結尾要有 `/`**）：
     - `https://你的帳號.github.io/car-music/`
     - `http://localhost:8080/`
5. 把 Client ID 填進 [config.js](config.js) 的 `CLIENT_ID`。

> 權限範圍是 `drive.readonly`（只讀）。測試模式下自己用不需要 Google 審核。
> 登入一次的有效時間約 1 小時；過期只影響「同步」，已下載的歌照常播放。

## 2. 部署到 GitHub Pages

1. 在 GitHub 建立一個 **public** repo，名稱用 `car-music`。
2. 把 `car-music` 資料夾裡的所有檔案放在 repo 的根目錄並推上去。
3. repo 的 Settings → Pages → Source 選 `main` 分支、`/ (root)`。
4. 幾分鐘後打開 `https://你的帳號.github.io/car-music/`。

## 3. 在 iPhone 上使用

**請直接用 Safari 開，不要「加入主畫面」。** 原因有兩個：

- iOS 上主畫面 App 和 Safari 的資料是分開存的，捷徑的「打開 URL」只會開到 Safari。
- 在 Safari 分頁裡播放，背景和鎖定畫面播放通常比較穩。

步驟：

1. 用 Safari 打開網址，點「登入 Google」。
2. 點「＋ Google Drive 資料夾」，選放音樂的資料夾，它會自動下載所有歌曲到手機。
3. 也可以用「＋ 手機 / iCloud 檔案」從「檔案」App 挑歌。這裡也看得到 Google Drive，但要一首一首挑。
4. Drive 上加了新歌之後，按清單的「同步」，只會下載新增或有修改的歌。

## 4. 捷徑自動化：連上車子藍牙就打開

1. 打開「捷徑」→「自動化」→「＋」→「藍牙」，選你的車機（有 CarPlay 就選 CarPlay）。
2. 選「立即執行」，關掉「執行時通知」。
3. 加入動作「**打開 URL**」：`https://你的帳號.github.io/car-music/?autoplay=1`

`?autoplay=1` 會嘗試從上次的位置繼續播放。**iOS 通常會擋下沒有經過點擊的自動播放**，這時畫面會出現一個大圓形按鈕，點一下就開始播放。

> 小技巧：如果上次下車時 Safari 分頁沒被關掉，很多車機連上藍牙時送出的「播放」指令，可能會讓它直接繼續播放，連點都不用點。

## 本機測試（Windows）

在專案上一層的資料夾執行：

```bash
python serve.py
```

然後打開 <http://localhost:8080/>。Windows 內建的 `python -m http.server` 會把 `.js` 當成純文字送出，所以要用 `serve.py`。

## 檔案說明

| 檔案 | 用途 |
|---|---|
| `index.html` / `style.css` | 介面 |
| `app.js` | 主程式：播放清單、同步、選資料夾 |
| `player.js` | 播放器：隨機、循環、Media Session（鎖定畫面 / 車機控制） |
| `drive.js` | Google Drive API（列出資料夾、下載檔案） |
| `auth.js` | Google 登入（OAuth 重新導向方式，不需要 Client Secret） |
| `db.js` | IndexedDB：存播放清單和離線音樂檔 |
| `sw.js` | Service Worker：讓網頁本身在沒網路時也能打開 |
| `config.js` | **填 Client ID 的地方** |

## 已知限制

- iOS 不允許網頁在沒有點擊的情況下自動出聲，所以上車後大多要點一下。
- Safari 如果超過 7 天沒開這個網站，可能會清掉下載的音樂，需要重新同步。
- 音樂格式建議用 MP3 或 M4A（AAC）。
