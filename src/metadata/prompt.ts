import type { AnnouncementAnalysis, StationMention } from "./service";
import type { RoutePathCandidate, StationCandidate } from "../stations/types";

export type StopSequenceContext = {
  id: number;
  mentions: StationMention[];
  stationCandidates: readonly StationCandidate[];
  routeHypotheses: readonly RoutePathCandidate[];
};

export function buildGeminiNormalizationPrompt(
  transcription: string,
  analysis: AnnouncementAnalysis,
  sequences: readonly StopSequenceContext[],
): string {
  const structure = {
    mentions: analysis.mentions,
    stopSequences: sequences.map((sequence) => ({
      id: sequence.id,
      rawMentions: sequence.mentions.map(({ text, role }) => ({ text, role })),
      stationCandidates: sequence.stationCandidates.map((candidate) => ({
        stationName: candidate.station.name,
        kana: candidate.station.kana,
        lineName: candidate.station.lineName,
        prefecture: candidate.station.prefecture,
        prevStation: candidate.station.prevStation,
        nextStation: candidate.station.nextStation,
        routeSupported: candidate.routeSupported,
        routeCandidateIds: candidate.routeCandidateIds,
        bestRouteRank: candidate.bestRouteRank,
        routeIndex: candidate.routeIndex,
        routeOrderConsistent: candidate.routeOrderConsistent,
        anchor: candidate.anchor,
        score: Number(candidate.score.toFixed(3)),
      })),
      routeHypotheses: sequence.routeHypotheses.map((route, rank) => ({
        rank,
        stations: route.stations.map(({ station }) => station.name),
        anchorCoverage: route.anchorCoverage,
        orderConsistency: route.orderConsistency,
        transferCount: route.transferCount,
        pathLength: route.pathLength,
        score: route.score,
      })),
    })),
  };

  return `あなたは公共交通案内の文字起こし補正器です。

Gemini #1が抽出した意味構造と、アプリがstop sequenceごとに検索した駅・経路候補を参考に、normalizedTranscriptionだけを生成してください。
全文の句読点や不要な空白を整えて構いませんが、知識による補完は禁止です。各言語を元の言語のまま、放送順を維持してください。

厳守事項:
- 駅候補・経路候補は参考情報であり、経路上で自然という理由だけで駅名を変更しない
- 複数駅が連続して誤認識されているように見えても、候補経路だけを根拠に停車駅列全体を再構成しない
- 各補正は、元文字列との音韻的または文字列的対応が十分強い場合だけ行う
- destination、direction、transfer、stop、service_change_pointの役割を混同しない
- stop sequenceの補正では、そのsequenceに対応するstationCandidatesとrouteHypothesesだけを参照する
- routeSupported=falseの候補や候補外の駅名で、崩れた駅名列を組み立てない
- exact matchでも、同じsequenceの経路順と矛盾する場合は絶対的な正解として扱わない
- 長距離で接続可能なだけの経路、長大な迂回経路、乗換の多い経路を補正根拠にしない
- 候補が不十分、役割が不明、または確信が持てない箇所は元のtranscriptionを維持する
- normalizedTranscriptionは空にしない
- 同じ言語の完全に同一な案内ブロックが連続する場合だけ1回にまとめてよい。異なる言語や内容差のある繰り返しは残す

局所的で確実な補正例:
- 「鶴ヶ方面」→「敦賀方面」
- 「黄色い展示ブロック」→「黄色い点字ブロック」

入力:
${JSON.stringify({ transcription, structure })}`;
}
