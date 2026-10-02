# mitsubachi-ai-agent

Cloudflare Workers上で動作する公共交通放送向けDiscord Botです。Whisperのraw transcriptionを保持し、Gemini #1が意味・event・mentionを抽出、StaticRailwayRepositoryとStationCorrectionEngineが駅候補・順序付き経路の材料を生成、Gemini #2が自然な文章へ再構成します。駅・路線・経路マスタはWorkerの静的データ、D1はjob・clip・access・callback・monitorの運用状態です。

本番デプロイなしで補正を検証できます。[ローカル検証ガイド](docs/local-validation.md)と[改修・計測報告](docs/implementation-report.md)を参照してください。

## Setup

1. `pnpm install`
2. `wrangler.jsonc` のD1 `database_id` を実値に変更
3. D1 database、`mitsubachi-audio-jobs` Queue、DLQを作成
4. `pnpm wrangler secret put DISCORD_APPLICATION_ID`、`DISCORD_BOT_TOKEN`、`DISCORD_PUBLIC_KEY`、`GEMINI_API_KEY`
   - 任意: `pnpm wrangler secret put DISCORD_ALERT_CHANNEL_ID` を設定すると、処理エラーの詳細をそのDiscordチャンネルへ通知します。
   - 任意: `ADMIN_JOBS_CHANNEL_ID` を管理用チャンネルIDに設定すると、AudioJobごとの進行状況と停止ボタンを同じメッセージ上に表示します。停止操作はそのチャンネル内かつAdministratorまたはManage Guild権限を持つメンバーに限定されます。`ADMIN_GUILD_ID` は不要です。
   - `DISCORD_CONTROL_USER_IDS` を、Botオーナー（およびサーバー利用可否を変更できるユーザー）のDiscord user IDのJSON配列（例: `["123456789012345678"]`）に設定します。空配列・不正なJSONの場合は誰も管理操作とdemoを実行できません。
5. `pnpm wrangler types`
6. `pnpm generate:railway-data`（source of truthは `data/stations.csv`）
7. ローカル確認: `pnpm verify:local`、`pnpm test`。本番migrationは検証後の別操作として `pnpm wrangler d1 migrations apply mitsubachi-ai-agent --remote`
8. `.dev.vars` にDiscord用環境変数を設定して `pnpm discord:register`（コマンドが `.dev.vars` を自動で読み込みます）
   - 本番のグローバルコマンド登録は `pnpm discord:register -- --global` を使用します。`DISCORD_DEV_GUILD_ID` が設定されていても `--global` が優先されます。
9. `pnpm deploy:dry-run`、`pnpm deploy`

デプロイ後、許可ユーザーが対象サーバー内で `/platform-ai-agent-allow` を実行すると音声解析と検索が有効になります。停止は `/platform-ai-agent-deny` です。どちらもサーバー内でのみ実行でき、応答は実行者にだけ表示されます。

`/platform-ai-agent-demo audio:<attachment>` は `DISCORD_CONTROL_USER_IDS` に明示したオーナー専用です。publicと同じpipeline・StaticRailwayRepositoryを使い、job/clip/checkpointも通常保存します。表示だけが詳細diagnostics付きになります。guild許可リストを迂回できるのはこの明示オーナーだけです。モードはpublic/demoの2種類です。

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
