export const discordCommands = [
  {
    name: "platform-ai-agent",
    description: "案内放送を登録",
    type: 1,
    options: [
      {
        name: "audio",
        description: "音声ファイル",
        type: 11,
        required: true,
      },
    ],
  },
  {
    name: "platform-ai-agent-allow",
    description: "このサーバーでコマンドを有効化",
    type: 1,
  },
  {
    name: "platform-ai-agent-deny",
    description: "このサーバーでコマンドを無効化",
    type: 1,
  },
  {
    name: "platform-search",
    description: "登録した案内放送を検索",
    type: 1,
    options: [{ name: "query", description: "検索キーワード", type: 3, required: true }],
  },
] as const;
