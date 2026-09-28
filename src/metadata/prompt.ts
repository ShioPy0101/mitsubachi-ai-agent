import type { StationCandidate } from "../stations/types";

export function buildGeminiPrompt(transcription: string, candidates: readonly StationCandidate[]): string {
  const stationCandidates = candidates.map(({ station, score }) => ({
    name: station.name,
    kana: station.kana,
    lineName: station.lineName,
    prefecture: station.prefecture,
    prevStation: station.prevStation,
    nextStation: station.nextStation,
    score: Number(score.toFixed(3)),
  }));
  return `これは日本の鉄道駅構内放送の文字起こしです。

放送には日本語、英語、中国語、韓国語など複数言語が含まれる場合があります。
normalizedTranscriptionでは各言語を元の言語のまま保持し、翻訳したり日本語へ置き換えたりしないでください。
同じ案内内容でも言語が異なるブロックは削除せず、放送された順序を維持してください。
metadataは、どの言語で明示された情報でも利用できますが、知識による補完はしないでください。

明示されている情報のみ抽出してください。知識による補完は禁止です。
例えば「根室行き」だからといって、路線名を花咲線と推測してはいけません。
駅名・路線名・種別・行先・時刻・番線などは、文字起こしから十分判断できる場合のみ返してください。
ASR誤認識を修正する場合も、文脈上かなり確実な場合に限定してください。
departureTime / arrivalTime は HH:MM。時刻が明示されていなければ null です。
summaryは15文字程度の日本語で、文学的な文章ではなく放送内容を端的に表現してください。
例: 次は西和田 / 釧路到着 / 13時25分発 / 3番線接近 / ワンマン乗降案内

stationCandidates は駅マスタ data/stations.csv から検索した候補です。
駅名を自由生成しないでください。
stationCandidates の候補と文字起こしが十分一致すると判断できる場合のみ、候補の正式な name を station として返してください。
十分な候補がない場合は null を返してください。
候補の lineName / prevStation / nextStation は判断材料として利用できますが、それだけを根拠に駅名を推測してはいけません。
ASRに軽微な読み間違い・表記揺れがある場合は、候補との音韻的類似性が十分高ければ正式名称へ正規化して構いません。
normalizedTranscriptionには、確実な軽微補正だけを反映した全文を返してください。rawを書き換える用途には使いません。
normalizedTranscriptionは必ず空文字にせず、補正できない場合も入力のtranscription全文をそのまま返してください。
鉄道文脈と発音からほぼ確実な同音・近音の誤変換は、実在する自然な表記へ直してください。
例: 「鶴ヶ方面」→「敦賀方面」、「梅田難波天王寺方面中本行」→「梅田・なんば・天王寺方面、なかもず行」、「黄色い展示ブロック」→「黄色い点字ブロック」。
ただし確信できない固有名詞を知識だけで補完してはいけません。
同じ言語の同一文または案内ブロックが連続して完全に繰り返されている場合、normalizedTranscriptionでは1回にまとめてください。
異なる言語による同内容の案内は重複とみなさないでください。
時刻・番線・行先などが異なる繰り返しは削除しないでください。句読点と不要な空白も読みやすく整えてください。

入力:
${JSON.stringify({ transcription, stationCandidates })}`;
}
