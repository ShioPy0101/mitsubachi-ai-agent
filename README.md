# mitsubachi-ai-agent

Cloudflare Workers上で動作する、公共交通機関の案内放送向けDiscord Botです。許可されたサーバーで `/platform-ai-agent audio:<attachment>` を実行すると、WAV/MP3は無音区間で分割してからWorkers AI Whisperで文字起こしし、GeminiのSafety判定と交通案内判定を通過した音声だけをD1へ保存・メタデータ化します。鉄道、地下鉄、路面電車、路線・高速バス、船舶、航空機の運行・乗降案内を対象とします。検索は `/platform-search query:<text>` です。

## Setup

1. `pnpm install`
2. `wrangler.jsonc` のD1 `database_id` を実値に変更
3. D1 database、`mitsubachi-audio-jobs` Queue、DLQを作成
4. `pnpm wrangler secret put DISCORD_APPLICATION_ID`、`DISCORD_BOT_TOKEN`、`DISCORD_PUBLIC_KEY`、`GEMINI_API_KEY`
   - 任意: `pnpm wrangler secret put DISCORD_ALERT_CHANNEL_ID` を設定すると、処理エラーの詳細をそのDiscordチャンネルへ通知します。
   - `DISCORD_CONTROL_USER_IDS` を、Botオーナー（およびサーバー利用可否を変更できるユーザー）のDiscord user IDのJSON配列（例: `["123456789012345678"]`）に設定します。空配列・不正なJSONの場合は誰も管理操作とdemoを実行できません。
5. `pnpm wrangler types`
6. `pnpm wrangler d1 migrations apply mitsubachi-ai-agent --remote`
7. `pnpm stations:sql` の後、`pnpm wrangler d1 execute mitsubachi-ai-agent --remote --file stations-import.sql`
8. `.dev.vars` にDiscord用環境変数を設定して `pnpm discord:register`（コマンドが `.dev.vars` を自動で読み込みます）
   - 本番のグローバルコマンド登録は `pnpm discord:register -- --global` を使用します。`DISCORD_DEV_GUILD_ID` が設定されていても `--global` が優先されます。
9. `pnpm deploy:dry-run`、`pnpm deploy`

デプロイ後、許可ユーザーが対象サーバー内で `/platform-ai-agent-allow` を実行すると音声解析と検索が有効になります。停止は `/platform-ai-agent-deny` です。どちらもサーバー内でのみ実行でき、応答は実行者にだけ表示されます。

`/platform-ai-agent-demo audio:<attachment>` は `DISCORD_CONTROL_USER_IDS` に明示したオーナー専用です。通常の文字起こし・Gemini補正・入力サイズ制限を使いますが、guildの許可リストと通常利用制限は参照せず、ジョブ、callback token、文字起こし、clip、利用記録、処理ログをD1へ書き込みません。駅候補データはD1から読み取ります。オーナーIDが未設定、不正、または実行者と不一致なら、添付取得、Queue送信、外部AI呼び出しより前に拒否します。

### Discord上の管理コマンド権限

`platform-ai-agent-allow`、`platform-ai-agent-deny`、`platform-ai-agent-demo` は独立したトップレベルコマンドで、登録時の `default_member_permissions` は `"0"`、DMは無効です。`platform-ai-agent` と `platform-search` は従来どおり公開コマンドです。

コマンド登録後、各サーバーの「サーバー設定 → 連携サービス（Integrations）→ このBot → コマンド」で、3つの管理コマンドそれぞれにオーナー本人（またはオーナー専用ロール）を個別に許可してください。`default_member_permissions: "0"` でもDiscordのAdministrator権限保持者はコマンドを利用できる場合がありますが、Workerが `DISCORD_CONTROL_USER_IDS` を再照合するため、ID不一致なら処理は開始されません。Discord側の個別許可だけでも実行権限は付与されません。

`pnpm discord:register` は対象guildのコマンド一覧をbulk overwriteし、`pnpm discord:register -- --global` はグローバル一覧をbulk overwriteします。旧サブコマンドや旧トップレベル登録を整理するには、過去に登録した各scope（開発guildとglobal）でそれぞれ再登録してください。反映後に上記の個別許可を設定し直します。

ローカル用secretは `.dev.vars.example` を `.dev.vars` にコピーして設定します。実値はcommitしません。

## Checks

```text
pnpm typecheck
pnpm test
pnpm deploy:dry-run
```

設計判断と既知の制約は [architecture.md](architecture.md) を参照してください。
