export const discordCommands = [
  {
    name: "platform-ai-agent",
    description: "駅放送の音声を解析・整理します",
    type: 1,
    options: [
      {
        name: "audio",
        description: "解析する駅放送の音声ファイル",
        type: 11,
        required: true,
      },
    ],
  },
  {
    name: "platform-search",
    description: "解析済みの駅放送を検索します",
    type: 1,
    options: [{ name: "query", description: "駅名・路線・行先など", type: 3, required: true }],
  },
] as const;
