import type { AnnouncementAnalysis, SequenceRole, StationMention } from "./service";
import type { MentionStationCandidate, RoutePathCandidate, StationCandidate } from "../stations/types";

export type StopSequenceContext = {
  id: number;
  role: SequenceRole;
  mentions: StationMention[];
  contextMentions: StationMention[];
  stationCandidates: readonly StationCandidate[];
  mentionCandidates: readonly (readonly MentionStationCandidate[])[];
  routeHypotheses: readonly RoutePathCandidate[];
};

export function buildGeminiNormalizationPrompt(
  transcription: string,
  analysis: AnnouncementAnalysis,
  sequences: readonly StopSequenceContext[],
): string {
  const structure = {
    mentions: analysis.mentions,
    sequences: sequences.map((sequence) => {
      const searchMentions = [...sequence.mentions, ...sequence.contextMentions];
      return ({
        id: sequence.id,
        role: sequence.role,
        rawMentions: sequence.mentions.map(({ text, role }) => ({ text, role })),
        contextMentions: sequence.contextMentions.map(({ text, role }) => ({ text, role })),
        mentionCandidates: sequence.mentionCandidates.map((candidates, mentionIndex) => ({
          mentionIndex,
          rawMention: searchMentions[mentionIndex]?.text ?? "",
          candidates: candidates.map((candidate) => ({
            stationName: candidate.station.name,
            kana: candidate.station.kana,
            lineName: candidate.station.lineName,
            lexicalScore: Number(candidate.lexicalScore.toFixed(3)),
            phoneticSimilarity: Number(candidate.phoneticSimilarity.toFixed(3)),
            globallyReconciled: candidate.bound,
            matchStrength: candidate.matchStrength,
            routeHypothesisIds: candidate.routeHypothesisIds,
            bestRouteScore: candidate.bestRouteScore === null ? null : Number(candidate.bestRouteScore.toFixed(3)),
            finalScore: Number(candidate.finalScore.toFixed(3)),
          })),
        })),
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
          exactAnchorCoverage: route.exactAnchorCoverage ?? null,
          hardAnchorViolations: route.hardAnchorViolations ?? null,
          source: route.source,
          mentionMatches: route.mentionMatches?.map((match) => ({
            mentionIndex: match.mentionIndex,
            rawMention: match.mentionText,
            stationName: match.station.name,
            lexicalSimilarity: Number(match.lexicalSimilarity.toFixed(3)),
          })),
        })),
      });
    }),
  };

  return `あなたは公共交通案内の文字起こし補正器です。

Gemini #1が抽出した意味構造と、アプリが役割別sequenceごとに検索した駅・経路候補を参考に、normalizedTranscriptionを生成してください。
文章全体について、音声認識由来の文法的な崩れ、重複、不自然な助詞、語尾、文の切れ方、時刻表現、句読点は、原意を変えない範囲で自然な駅放送へ補正して構いません。
各言語を元の言語のまま、放送順を維持してください。知識による情報の追加は禁止です。

厳守事項:
- 駅候補・経路仮説は補正を支持する「証拠」であり、採用必須の制約や答えではない
- 高スコアの経路仮説でも、音声認識結果と矛盾する場合は無理に採用しない
- 経路情報だけを根拠に駅名を新規追加しない
- 駅名・路線名・列車名・行先などの固有名詞は、経路上に存在するという理由だけで変更しない
- 駅名・行先・路線名・列車名などの鉄道固有名詞は、対応するrawMentionのmentionCandidatesに正式名称がある場合、その正式表記を強く優先する
- 候補の正式名称を採用できる十分な音韻・文字列・経路根拠がある場合、候補外の似た中間的名称を独自生成しない
- 例: 原文「岩大津」に対する有力な正式候補が「伊予大洲」なら、「伊予大津」のような候補外表記を生成しない。候補の根拠が弱い場合は原文を維持する
- 固有名詞の変更には、原文との音韻・文字列上の類似性、前後の駅候補、sequence内の順序、direction / destination / stopsの関係を併せて要求する
- 複数駅が連続して誤認識されているように見えても、候補経路だけを根拠に停車駅列全体を再構成しない
- 各補正は、元文字列との音韻的または文字列的対応が十分強い場合だけ行う
- destination、direction、transfer、stop、service_change_pointの役割を混同しない
- direction sequenceは停車駅列とは断定せず、方向を示す経路証拠としてのみ扱う
- directionのcontextMentionsにdestinationがある場合、同じ経路方向を支持するか評価してよい
- 各補正では、そのsequenceに対応するmentionCandidatesとrouteHypothesesだけを参照する
- globallyReconciled=trueは全sequence探索後に十分な根拠で選ばれた同一rawMentionの共通解を示し、明確な矛盾がない限り同じ駅名を使う
- phoneticSimilarityは弱い補助証拠であり、それだけで駅名を変更しない。表記類似または経路・駅順の整合も要求する
- routeSupported=falseの候補や候補外の駅名で、崩れた駅名列を組み立てない
- exact matchでも、同じsequenceの経路順と矛盾する場合は絶対的な正解として扱わない
- 長距離で接続可能なだけの経路、長大な迂回経路、乗換の多い経路を補正根拠にしない
- 候補が不十分、役割が不明、または確信が持てない箇所は元のtranscriptionを維持する
- 判断できない固有名詞は元の表記を維持する
- normalizedTranscriptionは空にしない
- entitiesには、normalizedTranscriptionに出現する駅名・路線名・列車名・列車種別・行先・その他の固有名詞を出現順で漏れなく返す
- entities.textはnormalizedTranscriptionに実在する連続部分にする
- normalizedTranscriptionで補正した固有名詞とentities.textは必ず同じ正式表記にする
- 元のtranscription内の文字列を補正した固有名詞はsourceTextに元文字列を返し、元文字列がない場合だけnullにする
- 同じ言語の同一案内が連続して完全に繰り返される場合だけ1回へまとめてよい。異なる言語や内容差のある繰り返しは残す

局所的で確実な補正例:
- 「鶴ヶ方面」→「敦賀方面」
- 「黄色い展示ブロック」→「黄色い点字ブロック」

入力:
${JSON.stringify({ transcription, structure })}`;
}
