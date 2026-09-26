# mitsubachi-ai-agent

Cloudflare Workers上で動作する、日本の鉄道駅構内放送向けDiscord Botです。`/platform-ai-agent audio:<attachment>` で音声を受け取り、Workers AI Whisperで文字起こしし、D1の駅マスタ候補とGemini structured outputでメタデータ化します。検索は `/platform-search query:<text>` です。

## Setup

1. `pnpm install`
2. `wrangler.jsonc` のD1 `database_id` を実値に変更
3. D1 database、`mitsubachi-audio-jobs` Queue、DLQを作成
4. `pnpm wrangler secret put DISCORD_APPLICATION_ID`、`DISCORD_BOT_TOKEN`、`DISCORD_PUBLIC_KEY`、`GEMINI_API_KEY`
5. `pnpm wrangler types`
6. `pnpm wrangler d1 migrations apply mitsubachi-ai-agent --remote`
7. `pnpm stations:sql` の後、`pnpm wrangler d1 execute mitsubachi-ai-agent --remote --file stations-import.sql`
8. 環境変数を設定して `pnpm discord:register`
9. `pnpm deploy:dry-run`、`pnpm deploy`

ローカル用secretは `.dev.vars.example` を `.dev.vars` にコピーして設定します。実値はcommitしません。

## Checks

```text
pnpm typecheck
pnpm test
pnpm deploy:dry-run
```

設計判断と既知の制約は [architecture.md](architecture.md) を参照してください。
