export const discordCommands = [
  {
    name: "platform-ai-agent",
    description: "公共交通の案内音声を解析・整理します",
    type: 1,
    options: [
      {
        name: "audio",
        description: "解析する交通案内の音声ファイル",
        type: 11,
        required: true,
      },
    ],
  },
  {
    name: "platform-ai-agent-allow",
    description: "このサーバーで交通案内AIの利用を許可します",
    type: 1,
  },
  {
    name: "platform-ai-agent-deny",
    description: "このサーバーで交通案内AIの利用を停止します",
    type: 1,
  },
  {
    name: "platform-search",
    description: "解析済みの交通案内を検索します",
    type: 1,
    options: [{ name: "query", description: "駅名・路線・行先など", type: 3, required: true }],
  },
] as const;
