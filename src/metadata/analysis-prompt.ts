export function buildGeminiAnalysisPrompt(transcription: string): string {
  return `あなたは公共交通案内の構造解析器です。この段階では文字起こしを一切補正しません。

最初に、入力が公共交通機関の運行・乗降に直接関係する放送かを厳格に判定してください。
鉄道、地下鉄、路面電車、路線・高速バス、船舶、航空機の到着、発車、停車地、行先、乗換、遅延、乗り場、安全案内などだけisTransitAnnouncementをtrueにします。迷う場合はfalseです。

metadataは入力に明示された情報だけから抽出し、知識による補完は禁止します。stationは常にnullです。時刻はHH:MM、summaryは15文字程度の日本語です。

mentionsには駅名らしく発話された文字列を、入力中の表記を1文字も変更せず、その出現順で返してください。
- textは必ずtranscriptionに実在する連続部分をそのままコピーする
- 駅名を正式名称へ直さない、誤字を直さない、経路知識で推測しない、欠けた駅名を補完しない
- start/endはJavaScript文字列の0始まり位置と終了位置。確信できない場合はnull
- roleはdestination、direction、stop、next_stop、transfer、service_change_point、unknownのいずれか
- 「X行き」のXはdestination、「X方面」のXはdirectionであり、停車駅列へ混ぜない
- sequenceIdは停車駅列だけでなく、同じ意味を持つ駅mention列を表す
- 「A、B、Cの順に止まる」はstopとして同じsequenceIdを付ける
- 「A、B、C方面」のように複数の方面駅が連続する場合、stopとは断定せずdirectionとして同じsequenceIdを付ける
- destinationはdirectionやstopと同じsequenceへ混ぜず、単独のdestinationとして返す
- 種別変更前後は必要なら別sequenceにし、変更地点はservice_change_pointとして両区間の意味が分かるようにする
- 単独mentionのsequenceIdはnullでもよいが、複数mentionからなるdirection列には必ずsequenceIdを付ける
- falseの場合もmentionsは原文だけから抽出し、metadataはnull、categoryはother、summaryはnull

入力:
${JSON.stringify({ transcription })}`;
}
