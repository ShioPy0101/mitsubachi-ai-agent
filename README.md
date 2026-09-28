# mitsubachi-ai-agent

Cloudflare Workers上で動作する、日本の鉄道駅構内放送向けDiscord Botです。`/platform-ai-agent audio:<attachment>` で音声を受け取り、Workers AI Whisperで文字起こしし、D1の駅マスタ候補とGemini structured outputでメタデータ化します。検索は `/platform-search query:<text>` です。

## Setup

1. `pnpm install`
2. `wrangler.jsonc` のD1 `database_id` を実値に変更
3. D1 database、`mitsubachi-audio-jobs` Queue、DLQを作成
4. Cloudflare Dashboard の AI Gateway で `mitsubachi-guardrails`（または `GUARDRAILS_GATEWAY_ID` と同じID）を作成し、Guardrails の **Prompts** に対して危険カテゴリを `Block` に設定
   - 最低限 `P1` (Prompt Injection)、`S1` (Violent Crimes)、`S2` (Non-Violent Crimes)、`S3` (Sex-Related Crimes)、`S4` (Child Sexual Exploitation)、`S9` (Indiscriminate Weapons)、`S10` (Hate)、`S11` (Suicide & Self-Harm)、`S12` (Sexual Content) を `Block` にします。
   - Responses 側はこの判定専用リクエストでは使用しないため `Ignore` にします。
   - Worker は判定リクエストに `collectLog: false` と `skipCache: true` を指定し、文字起こし本文を AI Gateway のログやキャッシュに保存しません。
   - Block カテゴリが1つ以上設定されている場合、Cloudflare の判定モデル障害時も Gateway 自体が block します。Worker 側も未知のエラーを許可せず処理を終了します。
   - Cloudflare の[対応言語](https://developers.cloudflare.com/ai-gateway/features/guardrails/usage-considerations/#additional-considerations)には現時点で日本語が明記されていません。日本語音声での検出品質は本番投入前に検証し、要件に足りない場合は日本語対応のモデレーション層を追加してください。
5. `pnpm wrangler secret put DISCORD_APPLICATION_ID`、`DISCORD_BOT_TOKEN`、`DISCORD_PUBLIC_KEY`、`GEMINI_API_KEY`
   - 任意: `pnpm wrangler secret put DISCORD_ALERT_CHANNEL_ID` を設定すると、処理エラーの詳細をそのDiscordチャンネルへ通知します。
6. `pnpm wrangler types`
7. `pnpm wrangler d1 migrations apply mitsubachi-ai-agent --remote`
8. `pnpm stations:sql` の後、`pnpm wrangler d1 execute mitsubachi-ai-agent --remote --file stations-import.sql`
9. 環境変数を設定して `pnpm discord:register`
10. `pnpm deploy:dry-run`、`pnpm deploy`

ローカル用secretは `.dev.vars.example` を `.dev.vars` にコピーして設定します。実値はcommitしません。

## Checks

```text
pnpm typecheck
pnpm test
pnpm deploy:dry-run
```

設計判断と既知の制約は [architecture.md](architecture.md) を参照してください。
